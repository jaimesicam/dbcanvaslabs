# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

DBCanvas Labs — a hands-on CloudNativePG (CNPG) lab platform. A React/Vite frontend
(courseware, gradebook, terminal UI) and a **stdlib-only Go backend** (`server/`) that
provisions a *real* disposable k3d + MetalLB + SeaweedFS + CNPG environment per lab attempt
and grades by running actual `kubectl`/`psql` against it. Nothing about the cluster is
simulated; the courseware wrapper (accounts, attempts, scores) is a `localStorage` mock.

**Deployed, it is one container**: the Go binary with the built SPA embedded, serving the UI
and `/api` on one port, holding the host's Docker socket. Two processes exist only in local
development, where Vite serves the UI and proxies `/api`.

## Commands

Deployment — **Docker and Docker Compose are the only host requirements** (Go, Node and
`k3d` are all inside the image):

```bash
make up          # docker compose up --build -d  → http://localhost:8090 (creates .env if missing)
make down        # stop the app container (leaves provisioned lab environments running)
make restart
make status      # compose ps + any live dbol-* lab environments
make logs        # docker compose logs -f
make build       # build both images only
make toolbox     # (re)build the lab toolbox image — `make up` does it only when missing
make clean       # down, then remove every dbol-* cluster's containers, volume and network
```

Local development — the two-process loop, for frontend iteration without an image rebuild.
This one needs Docker, `k3d` on `$PATH`, Go 1.26+ and Node:

```bash
make dev         # backend :8090 + Vite :5174, polls until both listen
make dev-down    # stop both
make dev-logs    # tail .run/backend.log and .run/frontend.log
make dev-build   # compile server/dbonlinetest-server, install node deps
```

Open Vite's :5174 in dev — it proxies `/api` (REST **and** the terminal WebSocket) to the
backend. A natively built binary serves only `/api` plus the tracked placeholder page at
`server/web/dist/index.html`; the real SPA is embedded during the image build.

`APP_PORT` / `APP_HOST` configure the listener (`PORT` still works as a fallback). The
image sets `APP_HOST=0.0.0.0` and lets the compose publish binding decide exposure; a
native run binds 127.0.0.1.

There is no test suite, linter, or formatter configured — verification means starting the
app and playing the affected lab end to end (which provisions real infrastructure and takes
minutes). `npm run build` type-checks nothing but catches import/syntax breakage; `go build
./...` in `server/` catches the rest.

**Never run the backend with `go run .`** — it execs the real server as a child process, so
killing "the process" leaves the server listening and orphans every lab environment it owns.
The Makefile deliberately uses the compiled binary. Similarly, stopping the backend at all
orphans real clusters (`docker ps`); `make clean` reclaims them, and the backend's
`ReapOrphans` sweeps every `dbol-*` cluster at startup before it begins listening (the
attempt registry is in-memory, so any pre-existing `dbol-*` cluster is by definition
unreachable). This is *expected* in the deployed shape too: lab environments are siblings of
the app container, not children, so `docker compose down` cannot take them with it.

## Deployment shape (`Dockerfile`, `docker-compose.yml`)

Deliberately identical to `../dbcanvas`'s: one service, the daemon socket mounted, no
persistence (this app stores nothing server-side). Four build stages — SPA (node), Go build
with the SPA copied to `server/web/dist` and embedded, a static `k3d` binary fetched for
`TARGETARCH`, then `gcr.io/distroless/static-debian12`.

Things that follow from it, all of which are load-bearing:

- **Docker-out-of-Docker.** k3d nodes, SeaweedFS and networks are created on the *host*
  daemon as siblings. Nothing about this app is nested; there is no dind.
- **`k3d` is exec'd, everything else is the Engine API.** `k3dBinary()` resolves `$K3D_BIN`
  (set in the image) else `k3d` on `$PATH`. `runK3D` forces `HOME=/tmp`: k3d wants a home,
  the distroless image has none, and by default k3d would merge every throwaway cluster into
  `~/.kube/config` — which this app never reads, since `kubectl` only ever runs *inside* node
  containers.
- **No `platform:` pin.** Everything the labs run is multi-arch; emulating a foreign arch
  would make provisioning drastically slower.
- **The healthcheck is the binary itself** (`/dbonlinetest-server -healthcheck` → `GET
  /api/health`), because distroless has no shell, curl or wget.
- **`make clean` is docker-only**, never `k3d`: the host is not required to have k3d, so it
  removes a cluster's containers/volume/network by name.
- **A second image, `toolbox/`, built on the host and not by compose** (`make toolbox`,
  which `make up` runs when the tag is missing). Lab environments are siblings of the app
  container, so the toolbox has to exist where the k3d nodes do — it cannot be a stage in
  the app's own Dockerfile. The tag lives in two places (`TOOLBOX_IMAGE`/`TOOLBOX_TAG` in
  the Makefile, `toolboxImage` in `server/toolbox.go`); bump both together. Nothing builds
  or pulls it at runtime: a missing image costs the toolbox tab, not the environment.
- The SPA catch-all (`mux.Handle("/", spaHandler())`) is registered last and is the only
  non-`/api` route; it falls back to `index.html`.

## Backend architecture (`server/`)

Stdlib-only Go: no Docker SDK, no Kubernetes client library. `docker.go` is a hand-rolled
Docker Engine API client over the unix socket (including a raw HTTP hijack for
`HijackExec`, because `net/http` can't reclaim a connection after a 101/200 upgrade). `k3d`
is the one exception — invoked as a subprocess. `kubectl` is never run on the host; it's
exec'd *inside* a node container (`K3D.Kubectl`). Routes live in `main.go` using Go 1.22+
pattern `ServeMux`, no router library.

The unit of work is an **attempt** (`attempts.go`): one attempt = one Docker network + one
3-node k3d cluster (`dbol-<id>`) + MetalLB + a SeaweedFS container + a toolbox container +
CNPG staged or applied. Key invariants encoded there, all learned the hard way — read the
comments before changing:

- `Create(labID)` is **idempotent per lab**: it returns the already-live attempt rather than
  building a second cluster. React StrictMode double-invokes, HMR remounts and retries would
  otherwise start competing clusters that starve each other until k3d gives up.
- `provisionSem` (size 1) serializes the expensive provisioning phase; `maxConcurrentAttempts`
  (2) caps *live* environments. Two are separate limits on purpose.
- `Destroy` cancels the provisioning goroutine and waits on `finished` before removing
  anything, otherwise the provisioner recreates what teardown just deleted.
- A failed provision must call `teardownFailed`: a leaked Docker network permanently holds a
  /16 from the daemon's 16-network default pool, so a run of failures makes all further
  cluster creation impossible.
- `Attempt` embeds a mutex — never copy by value; use `view()` / the `*Snap()` accessors.
- Anything attached to the attempt's network must be removed on **all three** teardown paths
  (`Destroy`, `teardownFailed`, `ReapOrphans`) or `NetworkRemove` fails and the /16 leaks.
  SeaweedFS and the toolbox are both in all three; `ReapOrphans` finds them by name, since
  the registry that held their container IDs is gone by definition.

`toolbox.go` is the odd one out and worth reading before touching: one Ubuntu sibling
container per attempt, offered to the learner as a fourth terminal tab (`toolbox`), carrying
the tools the minimal `rancher/k3s` image lacks — `jq`, `curl`, `psql`, `openssl`, `yq`. The
part that is not obvious is the networking — a sibling container has no route to Pod
(`10.42.x.x`) or Service (`10.43.x.x`) addresses, and four static routes plus `NET_ADMIN`
give it both. See `toolbox/README.md`, and `toolbox/entrypoint.sh` for why they work.

**Provisioning it is best-effort; three labs now require it.** A missing image or a failed
route logs and skips the tab rather than failing the provision — `Deploy` guarantees it
returns either a *running* container or nothing, so a broken toolbox is indistinguishable
from an unbuilt one. But `cnpg-json-logs` (jq), `cnpg-metrics` and `cnpg-pgbouncer-metrics`
(curl) now teach commands that exist only there, and their instructions name the tab. Those
labs are unplayable without it. `make up` builds the image when the tag is missing, so the
gap only opens on a native `make dev` run that never ran `make toolbox` — where the
provisioning log says exactly that. Any *new* lab is free to depend on the toolbox; say so
in its `brief`, as those three do.

Per-lab provisioning recipes are the `switch a.labID` in `recipe()`, each a list of named
steps `provision()` runs in order. The rule: a lab's
precondition is achieved by *really running* the commands server-side once; the thing the lab
actually teaches is left undone (operator staged-but-unapplied for the install lab, Cluster
manifest staged but not applied for the creation lab).

Versions are pinned deliberately (`k3sImage`, `cnpgVersion`, `cnpgPostgresImage`,
`metalLBVersion`) — labs grade real command output, which must not drift. `PreseedImages`
pulls those images to the host and imports them into all 3 nodes, because k3d nodes share no
image cache and would otherwise each pull ~500MB independently.

`state.go` (cluster snapshot for the UI) and `check.go` (grading) are distinct and both
**on demand only** — there is no background polling anywhere except the provisioning-progress
poll in `LabPlayer`.

## Grading contract (the important cross-cutting one)

No grading logic exists in the frontend. `check.go`'s `RunCheck` dispatches on
`(labID, taskID)` and returns `{ok, checks:[{label, ok, detail}]}`. Checks read live cluster
state and learner-produced artifacts (`readFileAnyNode` looks for `/root/*.txt` on all 3
nodes, so the learner may answer from whichever terminal tab they are in) — never text the
learner typed.

`Verification.jsx` pairs the lab definition's `criteria[i]` with `result.checks[i]` **by
index**. So a task's `criteria` array in `src/labs/*.js` must have the same length and order
as the `[]CheckItem` its `check.go` branch returns, with matching wording — otherwise
learners watch the wrong criterion flip. Changing either side requires changing both.

Scoring lives in `src/store/progress.js`: on time 100, late 60, hint −15, solution revealed
or timeout 0.

## Lab content contract (the other cross-cutting one)

Every playable lab in `src/labs/*.js` must satisfy all three rules below. They are not
style preferences — the UI reads these fields, and learners get lost without them.

**1. Labs are independent and do not know each other exists.** A lab is entered directly
from the catalog, in any order, by someone who has played none of the others. So no lab
may say "as in the previous lab", "the next lab", "you already installed…", or imply any
ordering, in `instructions`, `brief`, `hint`, `solution`, `catalog.json` `description`, or
`lectureNotes`. Whatever a lab needs already present, *its own* entry in `recipe()` builds
(the operator is installed by every recipe except the operator-install lab's, and by
neither the learner nor a prior lab), and the content states that as its own given —
"installed while this environment was built" — never as someone else's leftovers. The same
mechanism may therefore be re-explained across labs; that redundancy is correct.

**2. `environment` — the provisioning brief.** Alongside `id`/`terminals`, each lab module
exports an `environment` object, rendered by `Provisioning` in `LabPlayer.jsx` while the
real cluster builds (minutes of otherwise dead time, and the only place the starting state
is spelled out):

```js
environment: {
  summary: 'prose: what is being built, that it is real and disposable, why it takes a while',
  provides: ['one bullet per real thing that will exist when the build finishes'],
  yourJob: 'prose: what is deliberately left undone — i.e. what the learner does',
}
```

`provides` must match what that lab's `recipe()` branch in `attempts.go` actually
does, including pinned versions, and must name anything staged-but-not-applied and *which
node* it was staged on (`StageOperator`/`StageClusterManifest` write to the server node
only). `yourJob` is the same boundary from the other side. Changing a provisioning recipe
means changing `provides` in the same commit.

`terminals` lists only the lab's own node tabs. The player appends any *extra* terminal the
running attempt reports (currently just `toolbox`), so no lab has to know whether that
image was built — but every lab's `provides` carries a bullet describing it, because it is
part of the environment the learner is handed.

A lab whose content sends the learner to the toolbox also sets **`usesToolbox: true`**
alongside `terminals`. The player opens that tab automatically as soon as the attempt
reports one (once per attempt, tracked by `toolboxOpenedRef`) so nobody has to go and find
it. It deliberately does **not** focus it: `cnpg-pgbouncer-metrics` and `cnpg-replica-cluster`
begin on `k3d-server`, where their manifest was staged, and stealing focus would put the
learner in the wrong tab for their first objective. Set the flag whenever the instructions,
`brief` or `yourJob` name the tab — 13 labs do.

**3. `brief` — the per-objective popup.** Each entry in `tasks[]` carries a `brief`
markdown string alongside `title`/`limitSec`/`criteria`/`instructions`/`hint`/`solution`.
`lab/ObjectiveBrief.jsx` shows it in a modal automatically when that objective becomes
current (once per objective, tracked by `autoBriefedRef`), and again whenever the learner
clicks that objective's number in the rail's stepper or its **Briefing** button — the same
text every time, so it is an orientation to come back to, not a one-shot announcement.

A `brief` answers *what am I being asked to do here, and why it matters* in 2–4 short
paragraphs: the goal, which terminal tab to work in if it matters, and the idea being
taught. It does **not** repeat the commands — `instructions` owns those, next to the
terminal where they are usable. The modal already lists `criteria` underneath, so a brief
never restates them either. A task with no `brief` silently never pops, which is a bug, not
an opt-out.

**4. All of it can be read aloud.** Narration (`src/speech/`, the browser's own
`speechSynthesis`) is **off by default** and switched on from the header's speaker control;
once on, it speaks `brief` + `criteria` when the
objective popup opens, `environment` while the cluster provisions, and `description` +
`lectureNotes` on the detail page. Two consequences for anyone writing content:

- **Fenced code blocks are never spoken** — reading backticks and shell syntax aloud is
  noise. So prose must stand on its own without them: "apply it with `--server-side`"
  survives; "run the command below" leaves a listener with nothing.
- Inline `` `code` `` and `**bold**` *are* read as their plain text, so keep inline code to
  short identifiers (`pg-cluster`, `/root/primary.txt`) rather than whole pipelines.

Nothing else is required of the content — the speech layer derives everything from the
same fields.

## Command reference contract (the third cross-cutting one)

`src/reference/` backs the **Command Reference** page (sidebar entry, `#/reference`, then
`#/reference/cnpg`): the same material the labs teach, arranged by command instead of by
scenario, so it can be looked up outside a running lab. `reference/cnpg.js` is pure content,
`reference/index.js` exposes `REFERENCES`/`getReference`, `pages/Reference.jsx` renders it.

**Every command a lab hands a learner is recorded here, in the same change that adds it to
the lab.** A command that only exists inside an `instructions` block is findable only by
replaying that lab, which is exactly the problem this page exists to solve.

```js
{ id, name,               // name: the command in its general form (placeholders in <angles>)
  summary,                // what it answers, and why the lab uses it
  usedIn: ['cnpg-…'],     // lab ids — rendered as links to each lab's detail page
  examples: [{ run, out, note }],   // run: verbatim from the lab. out: its real output
  notes: ['…'] }          // gotchas, flags that bite, why the obvious variant is wrong
```

- **`out` is captured, never written.** Same rule as lab content: real runs against real
  infrastructure, keystroke for keystroke. Object names, UUIDs, IPs and ages are whatever
  that run produced — the intro says so, so they read as shape rather than as values to
  expect. Eliding columns from a wide table is fine; say so in that example's `note`.
- An example may carry `run` with no `out` when printing the output would be wrong (a
  password) or meaningless (a key that scrolls). Say which in `note`.
- `usedIn` ids must exist in `catalog.json`; the page links them and a wrong id renders as a
  bare id.
- Grouping is by task (`survey`, `operator`, `cluster`, `services`, `connect`, `sql`, `tls`,
  `pooling`, `failover`), not by binary — a learner looks for "how do I see who is primary",
  not for "kubectl".
- The page is **not narrated** and has no speech blocks, so the fenced-code rule that governs
  lab content does not apply to it.

## Index card contract (the fourth cross-cutting one)

`src/cards/` backs the **Index Cards** page (sidebar entry, `#/cards`, then `#/cards/cnpg`):
one question and a short answer per card, for testing recall rather than reading. Decks are
**per technology** — `cards/cnpg.js` today, and a second technology is a new module plus an
entry in `DECKS`, with nothing else to change. `cards/index.js` exposes
`DECKS`/`getDeck`/`allCards`/`CARD_KINDS`/`deckSize`; `pages/Cards.jsx` renders it.

**Index cards are written for both halves of a lab's material: the command reference entry
and the lecture notes.** They are authored, not generated — a card asks a narrower question
than a reference `summary` answers, and compressing is the work. So adding a command to
`reference/cnpg.js` or writing `lectureNotes` in `catalog.json` means adding the cards that
cover them, in the same change.

```js
{ id,                     // unique across the deck
  kind: 'command',        // 'command' from the Command Reference, 'lecture' from lectureNotes
  front,                  // the question, one sentence
  back,                   // the answer, one to three lines — markdown, inline code fine
  usedIn: ['cnpg-…'] }    // lab ids, rendered as links; required, and must exist in catalog.json
```

- **A card is a recall prompt, not a summary.** If the answer needs a paragraph, the question
  is too broad — split it, or leave the material to the reference and the lecture notes.
- **Same honesty rule as everywhere else**: every fact on a `back` was observed in a real run
  or is the plain reading of a spec field the labs set. Nothing illustrative.
- `kind` is the *source*, not the difficulty: `command` for what to type and what comes back,
  `lecture` for why the system behaves as it does. The page filters on it.
- `usedIn` is not optional here (it is what turns a card you cannot answer into the lab that
  teaches it), and a wrong id renders as a bare id.
- Grouping mirrors the reference's task-shaped groups (`survey`, `operator`, `cluster`,
  `services`, `tls`, `pooling`, `replication`, `lifecycle`, `failover`, `backup`,
  `observability`) so the two pages can be read side by side.
- Cards default to **face down** — the page reveals a `back` only on click. That is the point
  of the page; do not add a mode that renders it as a flat list of answers.
- The page is **not narrated**, so the fenced-code rule that governs lab content does not
  apply. Keep `back` to prose and short inline code regardless — a card with a code block in
  it is too big.

## Frontend architecture (`src/`)

React 19 + Vite + Tailwind v4 (CSS-first, **no config file** — tokens and utilities are all in
`src/index.css`) + `@xterm/xterm`. No other runtime dependencies: hash-based navigation via
`lib/router.js` (no router library), hand-written inline SVG in `components/Icons.jsx`, no
component library, no state library.

- `labs/` — `catalog.json` (metadata + `lectureNotes` for the detail page) plus one module per
  playable lab: pure content (`id`, `terminals`, `environment`, `tasks[]` of `title`/`limitSec`/
  `criteria`/`brief`/`instructions`/`hint`/`solution` — see the lab content contract above).
  `labs/index.js` joins the two and exposes `CATALOG`/`PLAYABLE`.
- `reference/` + `pages/Reference.jsx` — the Command Reference page; see the command
  reference contract above.
- `cards/` + `pages/Cards.jsx` — the Index Cards page: one deck per technology, cards written
  from the reference entries and the lecture notes; see the index card contract above.
- `pages/LabPlayer.jsx` — the whole workspace, and where the real complexity is: attempt
  bootstrap/resume, provisioning UI, the objective clock, the briefing popup, manual
  check → advance flow.
- `lab/ObjectiveRail.jsx` + `lab/Verification.jsx` — objectives, criteria, Check Solution.
- `lab/ObjectiveBrief.jsx` — the per-objective briefing modal (`task.brief`).
- `speech/` — narration on `window.speechSynthesis`. No dependency, no bytes shipped, no
  network; voices come from the learner's OS. `SpeechProvider` owns the settings (off by
  default — absent `dbcanvas_labs_voice` means off, only an explicit `on` enables it — plus
  the chosen voice, persisted as `dbcanvas_labs_voice*` exactly like the theme) and
  the queue; `VoicePicker` is the header control next to `ThemePicker`; `speakable.js`
  turns content into blocks; `SpokenBlocks` renders them and lights up the spoken word.
  The default voice is chosen by **operating system**, not browser (`PLATFORM_VOICES`):
  Samantha on macOS, Microsoft Zira on Windows, best local en-US elsewhere — matched by
  name prefix, falling back through any en-US → any English when that voice is not
  installed. A learner's own pick always wins and clears back via `resetVoice`.
- **Network voices are filtered out** (`usableVoices`, applied where the voice list is
  read, so nothing downstream can reach one). They fire no word boundaries in Chrome, they
  send lab text to a vendor's servers, and they fail without internet — none of which suits
  an app that otherwise runs fully self-contained. The single exception is a machine with
  no local voices at all, where an imperfect voice beats silence.
- `terminal/TerminalPane.jsx` — one xterm per node, kept mounted (hidden via `visibility`) so
  scrollback survives tab switches; raw bytes both directions, the remote shell owns echo,
  history and completion.
- `lib/attemptApi.js` — the only place that talks to the backend.
- `auth/`, `store/` — `localStorage` mock accounts (`SEED_USERS` in `store/seed.js`), attempts
  and scores. Demo logins: `learner`/`learner1`, `instructor`/`instructor`.

Player-specific things that will bite:

- `bootstrappedKeyRef` guards StrictMode's double-invoke of the bootstrap effect — without it
  one page load provisions two real clusters. `recoveredRef` bounds the "stale attemptId →
  create a fresh one" recovery to exactly once.
- `PROVISION_STEPS` in `LabPlayer.jsx` is a hard-coded count of the `a.log()` calls each lab's
  backend `provision()` path emits. Adding or removing a backend log line changes the progress
  bar's denominator — update it in the same change.
- `autoBriefedRef` makes the objective briefing open once per objective *index*, not once per
  render, so a dismissed brief stays dismissed until the learner advances or reopens it. The
  rail is the only other thing that sets `briefFor`.
- Narration's word highlighting only works because the spoken text and the drawn text come
  from **one** decomposition: `Markdown.jsx` exports `parseBlocks`/`parseInline`, and
  `speakable.js` builds each block's utterance as the exact concatenation of the runs
  `SpokenBlocks` draws. Word boundaries are computed per *block*, never per run — a word can
  straddle a run boundary (inline code then a full stop), and splitting per run leaves half
  of it unhighlighted. Never let a second parser creep in.
- `useAutoSpeak` starts and stops in one effect, and waits for `voicesReady`: the voice list
  arrives asynchronously in Chrome, and a "spoken once" latch would leave StrictMode's second
  mount silent in dev.
- `toWorldShape()` adapts `/api/.../state` into the `world.nodes`/`world.node(id)`/`world.k8s.*`
  shape `Inspector`/`Topology` consume.

UI conventions: the lab workspace is styled as an operations console — `.panel`, `.rule-t/-b`
hairlines, `.microlabel`, `.data` (mono for anything the system owns), `.tnum`; color via CSS
custom properties (`var(--status-ok)` etc.) reserved for state, never decoration. Themes are
`data-theme` on `<html>` (dark default, plus light and midnight).

## Adding a lab

`LABORATORY.md` holds the CNPG roadmap and is the authority on this pipeline:

1. If the mechanism is new, prove it against `../dbcanvas` first — its **running instance**
   (`http://localhost:8080`, `admin`/`dudedude`) is the reference for real CNPG behavior.
   `../dbcanvas` is read-only: never modify it, and treat its source as reference only.
2. Implement the provisioning step for real in `server/` (`attempts.go` recipe + whatever
   `cnpg.go`/`k3d.go`/`seaweedfs.go` method it needs), and add `labID` to `validLabs`.
3. Add real checks to `check.go` (real `kubectl -o json`, `cat`, `psql` reads).
4. Author content in `src/labs/` + an entry in `catalog.json`, with `criteria` index-aligned to
   the checks, and register it in `labs/index.js`. Satisfy the lab content contract above:
   self-contained (no reference to any other lab), an `environment` block matching step 2's
   recipe, and a `brief` on every task.
5. Record every command the lab hands the learner in `src/reference/cnpg.js`, with its real
   captured output — see the command reference contract above.
6. Add the index cards for it in `src/cards/cnpg.js` — cards covering both the commands you
   just recorded and the concepts in the lab's `lectureNotes`, with `usedIn` naming the lab.
   See the index card contract above.
7. Update `PROVISION_STEPS` and tick the box in `LABORATORY.md`.

Never invent shell transcripts, timings or object names in lab content — they come from real
runs against real infrastructure.

`catalog.json`'s `lectureNotes` and `description` are learner-facing and must describe what the
backend actually does; its `steps[]` array is legacy and is **not rendered** for playable labs
(`LabDetail` renders `play.tasks` instead), so it silently rots — keep it in sync anyway or
delete it if a lab's shape changes.
