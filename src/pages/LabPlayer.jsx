import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Card, Modal, ScoreRing } from '../components/ui.jsx'
import { Icon } from '../components/Icons.jsx'
import { SplitPane } from '../components/SplitPane.jsx'
import { TerminalPane } from '../terminal/TerminalPane.jsx'
import { Inspector } from '../lab/Inspector.jsx'
import { ObjectiveBrief } from '../lab/ObjectiveBrief.jsx'
import { ObjectiveRail } from '../lab/ObjectiveRail.jsx'
import { attemptApi } from '../lib/attemptApi.js'
import { clockDuration } from '../lib/format.js'
import { navigate } from '../lib/router.js'
import { useAuth } from '../auth/AuthProvider.jsx'
import { getLab, getPlayable } from '../labs/index.js'
import { ThemePicker } from '../theme/ThemePicker.jsx'
import { VoicePicker } from '../speech/VoicePicker.jsx'
import { compact, textBlock } from '../speech/speakable.js'
import { SpeechControl, SpokenBlocks, useAutoSpeak } from '../speech/SpokenBlocks.jsx'
import {
  TASK_STATUS,
  activeAttemptFor,
  attemptScore,
  newAttemptId,
  scoreLabel,
  taskPoints,
  upsertAttempt,
} from '../store/progress.js'

const EXTEND_MS = 15 * 60 * 1000

/** The extra terminal a provisioned attempt may report — server/toolbox.go's toolboxLabID. */
const TOOLBOX_TERMINAL = 'toolbox'

/** Adapts the backend's /state snapshot to the shape Inspector/Topology already read
 * (`world.nodes`, `world.node(id)`, `world.k8s.*`) — real data, same consumer contract,
 * so those components needed no changes. */
function toWorldShape(state) {
  if (!state) return null
  const nodes = (state.nodes || []).map((n) => ({ id: n.id, ip: n.ip || '', role: n.role, up: n.up, type: 'k3s' }))
  return {
    kind: 'cnpg',
    nodes,
    node(id) {
      return nodes.find((n) => n.id === id)
    },
    k8s: {
      operator: state.operator || { installed: false },
      cluster: state.cluster || null,
      storageClass: state.storageClass,
      clusterName: state.clusterName,
    },
  }
}

/* ------------------------------------------------------------------ terminals */

function TerminalDeck({ attemptId, terminals, openNodes, setOpenNodes, active, setActive }) {
  const [picker, setPicker] = useState(false)
  const unopened = terminals.filter((n) => !openNodes.includes(n))

  return (
    <div className="panel flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-0.5 px-1.5 py-1 rule-b">
        <span className="microlabel mr-1.5 pl-1">Terminal</span>
        {openNodes.map((n) => (
          <div
            key={n}
            className={`group flex items-center gap-1 border px-1.5 py-0.5 transition ${
              active === n ? 'border-primary/60 bg-primary/10' : 'border-transparent hover:bg-surface2'
            }`}
          >
            <button onClick={() => setActive(n)} className="data flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--status-ok)' }} />
              <span style={{ color: active === n ? 'var(--primary)' : 'var(--muted)' }}>{n}</span>
            </button>
            {openNodes.length > 1 && (
              <button
                onClick={() => {
                  setOpenNodes((l) => l.filter((x) => x !== n))
                  if (active === n) setActive(openNodes.find((x) => x !== n))
                }}
                className="text-muted opacity-0 transition group-hover:opacity-100"
                title={`Close ${n}`}
              >
                <Icon.X size={10} />
              </button>
            )}
          </div>
        ))}
        {unopened.length > 0 && (
          <div className="relative">
            <button
              onClick={() => setPicker((p) => !p)}
              className="px-1.5 py-1 text-muted transition hover:text-fg"
              title="Open a terminal on another node"
            >
              <Icon.Plus size={12} />
            </button>
            {picker && (
              <div className="absolute left-0 z-30 mt-1 w-40 animate-fade-in border bg-surface py-1 shadow-xl">
                {unopened.map((n) => (
                  <button
                    key={n}
                    onClick={() => {
                      setOpenNodes((l) => [...l, n])
                      setActive(n)
                      setPicker(false)
                    }}
                    className="data flex w-full items-center gap-2 px-2.5 py-1 text-left transition hover:bg-surface2"
                  >
                    <Icon.Terminal size={11} className="text-muted" /> {n}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <span className="ml-auto pr-1 text-[10px] text-muted">A real shell — history/completion are the remote bash's own</span>
      </div>
      <div className="relative min-h-0 flex-1">
        {openNodes.map((n) => (
          <TerminalPane key={n} attemptId={attemptId} nodeId={n} visible={active === n} />
        ))}
      </div>
    </div>
  )
}

/* ----------------------------------------------------------------- provisioning */

/** Exact count of a.log()/logf() calls the backend's provision() emits for each lab,
 * final "ready" included — see server/attempts.go's per-lab recipe() plus the logf sites
 * in k3d.go/cnpg.go/seaweedfs.go/toolbox.go. Deterministic (real, not simulated), so the bar tracks
 * genuine progress rather than a guessed timer — update alongside any new backend log line. */
const PROVISION_STEPS = {
  'cnpg-operator-install': 18,
  'cnpg-cluster-creation': 21,
  'cnpg-persistent-volume': 23,
  'cnpg-service-connectivity': 24,
  'cnpg-client-certificates': 25,
  'cnpg-server-certificates': 24,
  'cnpg-pgbouncer': 24,
  'cnpg-failover': 24,
  'cnpg-switchover': 26,
  'cnpg-failover-endpoint-time': 24,
  'cnpg-switchover-endpoint-time': 26,
  'cnpg-degraded-recovery': 24,
  'cnpg-pvc-deletion': 24,
  'cnpg-corrupted-pvc': 26,
  'cnpg-barman-backup': 38,
  'cnpg-volume-snapshots': 40,
  'cnpg-barman-restore': 43,
  'cnpg-pitr': 43,
  'cnpg-wal-restore': 45,
  'cnpg-operator-eviction': 24,
  'cnpg-operator-upgrade': 27,
  'cnpg-operator-ha': 24,
  'cnpg-metrics': 24,
  'cnpg-pgbouncer-metrics': 24,
  'cnpg-json-logs': 26,
  'cnpg-operator-deployment': 23,
  'cnpg-operator-configmap': 23,
  'cnpg-operator-pod-deletion': 24,
  // Same recipe shape as cnpg-json-logs (operator + cluster + plugin + client).
  'cnpg-replication-slots': 26,
  'cnpg-synchronous-replication': 26,
  // Same recipe shape as cnpg-metrics (operator + cluster + client).
  'cnpg-cluster-scaling': 24,
  // Adds a staged replica-cluster manifest to the metrics shape.
  'cnpg-replica-cluster': 25,
  // Two clusters: the second is applied and waited for, then two manifests are staged.
  'cnpg-logical-replication': 27,
  // Same recipe shape as cnpg-json-logs (operator + cluster + plugin + client).
  'cnpg-fencing': 26,
  'cnpg-hibernation': 26,
  'cnpg-config-changes': 26,
  // Adds a pre-seed of the older PostgreSQL image before the cluster is applied.
  'cnpg-rolling-update': 28,
  // Rolling-update's recipe plus a staged catalog manifest.
  'cnpg-image-catalog': 29,
  // Same recipe shape as cnpg-json-logs (operator + cluster + plugin + client).
  'cnpg-hot-standby-params': 26,
  // The barman-restore recipe with a different staged manifest at the end. Measured: 44.
  'cnpg-replica-from-backup': 44,
  // The volume-snapshots recipe plus the cnpg plugin and two staged manifests. Measured: 43.
  'cnpg-replica-from-snapshot': 43,
  // Operator plus a staged manifest only — no cluster is applied. Measured: 22.
  'cnpg-initdb': 22,
  // Same recipe shape as cnpg-json-logs (operator + cluster + plugin + client).
  'cnpg-taints-tolerations': 26,
}
const DEFAULT_PROVISION_STEPS = 19

function Provisioning({ lab, play, phaseLog, error, onRetry, onAbort, aborting }) {
  const log = phaseLog || []
  const total = PROVISION_STEPS[lab.id] ?? DEFAULT_PROVISION_STEPS
  const percent = error ? Math.round((log.length / total) * 100) : Math.min(99, Math.round((log.length / total) * 100))
  const current = log[log.length - 1]
  const env = play.environment

  // Narrated while the cluster builds: minutes of waiting is exactly when a learner can
  // listen instead of read. Not while it is failing — the error is the only thing that
  // matters then.
  const speechKey = env ? `env:${play.id}` : null
  const speech = useMemo(() => {
    if (!env) return { blocks: [], summarySlice: [], providesStart: 0, jobStart: 0 }
    const summary = compact([textBlock(env.summary)])
    const lead = compact([textBlock('Being built for you')])
    const provides = compact(env.provides.map((p) => textBlock(p)))
    const jobLead = compact([textBlock('Left for you to do')])
    const job = compact([textBlock(env.yourJob)])
    return {
      blocks: [...summary, ...lead, ...provides, ...jobLead, ...job],
      summarySlice: summary,
      leadSlice: lead,
      leadStart: summary.length,
      providesSlice: provides,
      providesStart: summary.length + lead.length,
      jobLeadSlice: jobLead,
      jobLeadStart: summary.length + lead.length + provides.length,
      jobSlice: job,
      jobStart: summary.length + lead.length + provides.length + jobLead.length,
    }
  }, [env])
  useAutoSpeak(speechKey, speech.blocks, !!speechKey && !error)

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-6">
      <Card className="w-full max-w-2xl">
        <div className="flex items-center gap-2">
          <span
            className={`h-1.5 w-1.5 rounded-full ${error ? '' : 'provision-pulse'}`}
            style={{ background: error ? 'var(--status-crit)' : 'var(--primary)' }}
          />
          <p className="microlabel">{error ? 'Provisioning failed' : 'Provisioning a real environment'}</p>
          <span className="tnum ml-auto text-[11px] text-muted">{percent}%</span>
        </div>
        <div className="mt-1 flex items-start gap-2">
          {env ? (
            <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-muted">
              <SpokenBlocks speechKey={speechKey} blocks={speech.summarySlice} plain />
            </p>
          ) : (
            <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-muted">
              A real 3-node k3d cluster, MetalLB and SeaweedFS — this takes real time, especially the
              first cold-cache image pull.
            </p>
          )}
          <SpeechControl speechKey={speechKey} blocks={speech.blocks} label="Read this" />
        </div>

        {/* What the learner will be handed, and what is deliberately left undone. Read
            while the build runs, this is the only place the starting state is spelled
            out — each lab stands on its own and assumes nothing was done in another. */}
        {env && (
          <div className="mt-3 grid gap-3 rounded-sm border bg-bg p-3 sm:grid-cols-[1.4fr_1fr]">
            <div>
              <p className="microlabel">
                <SpokenBlocks
                  speechKey={speechKey}
                  blocks={speech.leadSlice}
                  offset={speech.leadStart}
                  plain
                />
              </p>
              <ul className="mt-1.5 space-y-1">
                {speech.providesSlice.map((block, i) => (
                  <li key={env.provides[i]} className="flex gap-1.5 text-[11px] leading-relaxed text-muted">
                    <span className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-primary/60" />
                    <span className="min-w-0">
                      <SpokenBlocks
                        speechKey={speechKey}
                        blocks={[block]}
                        offset={speech.providesStart + i}
                        plain
                      />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="sm:border-l sm:pl-3">
              <p className="microlabel">
                <SpokenBlocks
                  speechKey={speechKey}
                  blocks={speech.jobLeadSlice}
                  offset={speech.jobLeadStart}
                  plain
                />
              </p>
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                <SpokenBlocks
                  speechKey={speechKey}
                  blocks={speech.jobSlice}
                  offset={speech.jobStart}
                  plain
                />
              </p>
            </div>
          </div>
        )}

        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-surface2">
          <div
            className="h-full rounded-full transition-[width] duration-700 ease-out"
            style={{ width: `${percent}%`, background: error ? 'var(--status-crit)' : 'var(--primary)' }}
          />
        </div>
        <div className="mt-1.5 flex items-center justify-between">
          <p className="data truncate pr-3 text-[11px]" style={{ color: error ? 'var(--status-crit)' : 'var(--fg)' }}>
            {error ? 'stalled' : current || 'starting…'}
          </p>
          <p className="tnum shrink-0 text-[10px] text-muted">
            step {Math.min(log.length, total)} / {total}
          </p>
        </div>

        <div className="mt-3 max-h-32 overflow-auto rounded-sm border bg-bg p-2">
          {log.map((line, i) => (
            <p key={i} className="data text-[11px] text-muted">
              {line}
            </p>
          ))}
          {!log.length && !error && <p className="data text-[11px] text-muted">starting…</p>}
        </div>
        {error && <p className="mt-2 text-[11px] text-danger">{error}</p>}

        <div className="mt-3 flex items-center gap-2">
          {error && (
            <Button size="sm" onClick={onRetry} disabled={aborting}>
              Try again
            </Button>
          )}
          {/* Destructive: aborting the provision tears the half-built environment down. */}
          <Button size="sm" variant="danger" onClick={onAbort} disabled={aborting}>
            {aborting ? 'Cancelling…' : error ? 'Back to catalog' : 'Cancel and go back'}
          </Button>
          {!error && !aborting && (
            <span className="ml-auto text-[10px] text-muted">nothing is graded until the lab starts</span>
          )}
        </div>
      </Card>
    </div>
  )
}

/* ----------------------------------------------------------------- completion */

function Debrief({ lab, play, attempt, onClose, onLeave }) {
  const score = attemptScore(attempt, play.tasks.length)
  const verified = attempt.tasks.filter((t) => t.status !== TASK_STATUS.timeout).length
  const totalTime = attempt.tasks.reduce((n, t) => n + t.timeSpentMs, 0)

  return (
    <div className="absolute inset-0 z-40 overflow-auto bg-bg/96 p-4 backdrop-blur">
      <div className="mx-auto max-w-3xl space-y-3 py-6">
        <div className="flex items-center gap-4 panel px-4 py-4">
          <ScoreRing value={score} size={86} stroke={8} label="score" />
          <div className="min-w-0">
            <p className="microlabel">Debrief</p>
            <h3 className="text-base font-semibold">{lab.title}</h3>
            <p className="data mt-1 text-muted">
              {verified} of {play.tasks.length} objectives verified · {clockDuration(totalTime)} of objective
              time
            </p>
          </div>
        </div>

        <div className="panel">
          <div className="flex items-center gap-2 px-3 py-1.5 rule-b">
            <span className="microlabel">Objectives</span>
            <span className="ml-auto text-[10px] text-muted">
              on time 100 · late 60 · hint −15 · solution or timeout 0
            </span>
          </div>
          {play.tasks.map((t, i) => {
            const st = attempt.tasks[i]
            const pts = st?.points ?? 0
            const tone = pts >= 85 ? 'var(--status-ok)' : pts > 0 ? 'var(--status-warn)' : 'var(--status-crit)'
            return (
              <div key={t.id} className={`flex items-center gap-3 px-3 py-2 ${i ? 'rule-t' : ''}`}>
                <span
                  className="tnum flex h-5 w-5 shrink-0 items-center justify-center border text-[10px] font-semibold"
                  style={{ borderColor: tone, color: tone }}
                >
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] font-medium">{t.title}</p>
                  <p className="data text-muted">
                    {st
                      ? `${scoreLabel(st)} · ${clockDuration(st.timeSpentMs)} of ${clockDuration(t.limitSec * 1000)}`
                      : 'not attempted'}
                  </p>
                </div>
                <span className="tnum shrink-0 text-sm font-semibold" style={{ color: tone }}>
                  {pts}%
                </span>
              </div>
            )
          })}
        </div>

        <div className="flex flex-wrap justify-center gap-2 pb-6 pt-1">
          <Button size="sm" onClick={() => onLeave('progress')}>
            <Icon.Chart size={14} /> My progress
          </Button>
          <Button size="sm" variant="outline" onClick={() => onLeave('catalog')}>
            Back to catalog
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Keep exploring the cluster
          </Button>
        </div>
      </div>
    </div>
  )
}

/* --------------------------------------------------------------------- player */

export function LabPlayer({ labId }) {
  const { user } = useAuth()
  const lab = getLab(labId)
  const play = getPlayable(labId)

  const [attemptId, setAttemptId] = useState(null)
  const [envStatus, setEnvStatus] = useState('provisioning') // provisioning | ready | error
  const [phaseLog, setPhaseLog] = useState([])
  const [envError, setEnvError] = useState(null)
  const [clusterState, setClusterState] = useState(null)

  const [now, setNow] = useState(Date.now())
  const [tasks, setTasks] = useState([])
  const [current, setCurrent] = useState(0)
  const [viewing, setViewing] = useState(null)
  const [briefFor, setBriefFor] = useState(null)
  const [reviewResults, setReviewResults] = useState({})
  const [checking, setChecking] = useState(false)
  const [aborting, setAborting] = useState(false)
  const [railHidden, setRailHidden] = useState(false)
  const [inspect, setInspect] = useState(null)
  const [menu, setMenu] = useState(false)
  const [confirm, setConfirm] = useState(null)
  const [done, setDone] = useState(false)
  const [extensions, setExtensions] = useState(0)
  const [openNodes, setOpenNodes] = useState(() => (play ? play.terminals.slice(0, 2) : []))
  const [activeNode, setActiveNode] = useState(() => play?.terminals[0])
  const [envNodes, setEnvNodes] = useState([])
  // Opened exactly once per attempt: a lab that names the toolbox should not make the
  // learner go and find the tab, but re-opening it after they close it would be rude.
  const toolboxOpenedRef = useRef(null)
  // The tabs the terminal deck offers: what the lab declares, plus anything else the real
  // environment turned out to have. The toolbox (server/toolbox.go) is the reason for the
  // second half — it is infrastructure every lab environment gets rather than lab content,
  // it is absent when its image has not been built, and no lab's `terminals` array should
  // have to know either of those things. Node tabs keep their declared order; extras follow.
  const terminals = useMemo(() => {
    if (!play) return []
    return [...play.terminals, ...envNodes.filter((n) => !play.terminals.includes(n))]
  }, [play, envNodes])

  // Labs that declare `usesToolbox` work in that tab, so open it as soon as the running
  // attempt reports one. It is not focused: two of these labs (the staged Pooler and the
  // staged replica cluster) start on k3d-server, where their manifest was written, and
  // stealing focus would send the learner to the wrong tab for their first objective.
  useEffect(() => {
    if (!play?.usesToolbox || !attemptId) return
    if (!envNodes.includes(TOOLBOX_TERMINAL)) return
    if (toolboxOpenedRef.current === attemptId) return
    toolboxOpenedRef.current = attemptId
    setOpenNodes((open) => (open.includes(TOOLBOX_TERMINAL) ? open : [...open, TOOLBOX_TERMINAL]))
  }, [play, attemptId, envNodes])

  const attemptRef = useRef(null)
  const startedRef = useRef(Date.now())
  const bootstrappedKeyRef = useRef(null)
  const recoveredRef = useRef(false)
  const autoBriefedRef = useRef(-1)

  /* real environment bootstrap — create or resume a real backend attempt */
  const bootstrapEnv = useCallback(() => {
    if (!play) return
    setEnvStatus('provisioning')
    setEnvError(null)
    setPhaseLog([])
    attemptApi
      .create(play.id)
      .then((a) => setAttemptId(a.id))
      .catch((err) => {
        setEnvStatus('error')
        setEnvError(err.message)
      })
  }, [play])

  useEffect(() => {
    if (!play) return
    // Guard against StrictMode's dev-only double-invoke of effects: without this,
    // attemptApi.create() (a real, expensive k3d/CNPG provisioning call) fires twice
    // on a single mount, producing two orphaned real clusters for one page load. The
    // ref persists across StrictMode's synchronous mount→cleanup→mount replay, so it
    // still correctly re-bootstraps on a genuine lab/user change.
    const key = `${labId}:${user.id}`
    if (bootstrappedKeyRef.current === key) return
    bootstrappedKeyRef.current = key
    const existing = activeAttemptFor(user.id, labId)
    if (existing?.attemptId) {
      setAttemptId(existing.attemptId)
    } else {
      bootstrapEnv()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [play, labId, user.id])

  /* poll the attempt until it's ready (or errors) — this is provisioning progress, not
     grading, so it's the one legitimate background poll in this whole page */
  useEffect(() => {
    if (!attemptId || envStatus === 'ready') return
    let cancelled = false
    const poll = () => {
      attemptApi
        .get(attemptId)
        .then((a) => {
          if (cancelled) return
          setPhaseLog(a.phaseLog || [])
          setEnvNodes(a.nodes || [])
          if (a.status === 'ready') setEnvStatus('ready')
          else if (a.status === 'error') {
            setEnvStatus('error')
            setEnvError(a.error || 'provisioning failed')
          } else {
            setTimeout(poll, 2000)
          }
        })
        .catch((err) => {
          if (cancelled) return
          // The stored attemptId may point at a cluster from a previous backend
          // process (e.g. a dev-server restart) — fall back to a fresh environment
          // rather than polling something that will never come back.
          //
          // Strictly once. Provisioning is real infrastructure, and an unbounded
          // recreate-on-any-error turned a single transient failure into a spiral of
          // half-built clusters competing for the same host. Anything past the first
          // retry is surfaced to the learner, who can decide, instead of the page
          // quietly building environments forever.
          setEnvError(err.message)
          if (recoveredRef.current) {
            setEnvStatus('error')
            return
          }
          recoveredRef.current = true
          bootstrapEnv()
        })
    }
    poll()
    return () => {
      cancelled = true
    }
  }, [attemptId, envStatus, bootstrapEnv])

  /* progress-store attempt bootstrap — unrelated to the real environment above, this is
     just per-learner task/score bookkeeping in localStorage. Gated on envStatus === 'ready'
     so the session clock (startedRef/startedAt below) starts counting once the learner can
     actually work, not while the real cluster is still provisioning. */
  useEffect(() => {
    if (!play || !attemptId || envStatus !== 'ready') return
    const existing = activeAttemptFor(user.id, labId)
    if (existing) {
      // existing.attemptId can be stale (e.g. it pointed at a real cluster from a backend
      // process that's since restarted): the bootstrap effect above already fell back to a
      // fresh attemptId in that case. Heal the persisted record so future reloads resume
      // the live attempt instead of 404ing on the dead one and provisioning yet another
      // real cluster every single time.
      attemptRef.current = existing.attemptId === attemptId ? existing : { ...existing, attemptId }
      if (existing.attemptId !== attemptId) upsertAttempt(attemptRef.current)
      startedRef.current = new Date(existing.startedAt).getTime()
      const restored = play.tasks.map((t) => {
        const found = existing.tasks.find((x) => x.taskId === t.id)
        return found
          ? { ...found, startedAt: new Date(found.startedAt).getTime() }
          : {
              taskId: t.id,
              status: TASK_STATUS.pending,
              timeSpentMs: 0,
              hintUsed: false,
              solutionUsed: false,
              checkCount: 0,
            }
      })
      const next = restored.findIndex((t) => t.status === TASK_STATUS.pending)
      const idx = next < 0 ? play.tasks.length - 1 : next
      restored[idx] = { ...restored[idx], status: TASK_STATUS.active, startedAt: Date.now() }
      setTasks(restored)
      setCurrent(idx)
      if (next < 0) setDone(true)
    } else {
      startedRef.current = Date.now()
      attemptRef.current = {
        id: newAttemptId(),
        userId: user.id,
        labId,
        attemptId,
        startedAt: new Date(startedRef.current).toISOString(),
        finishedAt: null,
        completed: false,
        tasks: [],
      }
      upsertAttempt(attemptRef.current)
      setTasks(
        play.tasks.map((t, i) => ({
          taskId: t.id,
          status: i === 0 ? TASK_STATUS.active : TASK_STATUS.pending,
          startedAt: i === 0 ? Date.now() : null,
          timeSpentMs: 0,
          hintUsed: false,
          solutionUsed: false,
          checkCount: 0,
        })),
      )
    }
  }, [play, labId, user.id, attemptId, envStatus])

  /* Every objective opens with its briefing, exactly once automatically: when the lab
     first becomes playable, on each advance, and on the objective a resumed attempt lands
     on. autoBriefedRef makes it once *per objective index* rather than once per render —
     the learner can dismiss it and get back to work, and reopen it deliberately from the
     rail (which is the only other thing that sets briefFor). */
  useEffect(() => {
    if (envStatus !== 'ready' || done) return
    // Only for an objective that is genuinely open for work — otherwise "Keep exploring the
    // cluster" out of the debrief would pop the last objective's briefing back up.
    if (tasks[current]?.status !== TASK_STATUS.active) return
    if (autoBriefedRef.current === current) return
    autoBriefedRef.current = current
    if (play.tasks[current]?.brief) setBriefFor(current)
  }, [envStatus, tasks, current, done, play])

  /* countdown clock only — no simulated cluster to tick, stops once the session ends */
  useEffect(() => {
    if (done) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [done])

  const refreshState = useCallback(() => {
    if (!attemptId || envStatus !== 'ready') return
    attemptApi
      .state(attemptId)
      .then(setClusterState)
      .catch(() => {})
  }, [attemptId, envStatus])

  useEffect(refreshState, [refreshState])

  const sessionEndsAt = startedRef.current + (lab?.timeLimitMs ?? 7200e3) + extensions * EXTEND_MS
  const expired = now > sessionEndsAt

  const persist = useCallback((list, { finished = false, completed = false } = {}) => {
    const a = attemptRef.current
    if (!a) return
    const next = {
      ...a,
      tasks: list
        .filter((t) => t.status !== TASK_STATUS.pending && t.status !== TASK_STATUS.active)
        .map((t) => ({
          ...t,
          startedAt: new Date(t.startedAt ?? Date.now()).toISOString(),
          points: t.points ?? taskPoints(t),
        })),
      finishedAt: finished ? new Date().toISOString() : null,
      completed,
    }
    attemptRef.current = next
    upsertAttempt(next)
  }, [])

  const advance = useCallback(
    (status) => {
      setTasks((list) => {
        const next = [...list]
        const st = {
          ...next[current],
          status,
          timeSpentMs: Date.now() - (next[current].startedAt ?? Date.now()),
        }
        st.points = taskPoints(st)
        next[current] = st
        const isLast = current === play.tasks.length - 1
        if (!isLast) {
          next[current + 1] = { ...next[current + 1], status: TASK_STATUS.active, startedAt: Date.now() }
        }
        persist(next, {
          finished: isLast,
          completed: isLast && next.every((t) => t.status !== TASK_STATUS.timeout),
        })
        return next
      })
      if (current === play.tasks.length - 1) setDone(true)
      else {
        setCurrent((c) => c + 1)
        setViewing(null)
      }
    },
    [current, play, persist],
  )

  /** "Check Solution" — real, on-demand, against the real cluster. No auto-advance: a
   * pass only unlocks "Next objective," matching the manual, explicit grading model. */
  const onCheck = useCallback(async () => {
    if (!attemptId) return
    setChecking(true)
    const task = play.tasks[current]
    try {
      const result = await attemptApi.check(attemptId, task.id)
      setReviewResults((r) => ({ ...r, [current]: result }))
      setTasks((list) => {
        const next = [...list]
        next[current] = { ...next[current], checkCount: (next[current].checkCount || 0) + 1 }
        return next
      })
      refreshState()
    } catch (err) {
      setReviewResults((r) => ({
        ...r,
        [current]: { ok: false, checks: [{ label: 'Check failed to run', ok: false, detail: err.message }] },
      }))
    } finally {
      setChecking(false)
    }
  }, [attemptId, current, play, refreshState])

  const onAdvance = useCallback(() => {
    const result = reviewResults[current]
    if (!result?.ok) return
    const st = tasks[current]
    const task = play.tasks[current]
    const overtime = st?.startedAt ? Date.now() > st.startedAt + task.limitSec * 1000 : false
    advance(overtime ? TASK_STATUS.late : TASK_STATUS.passed)
  }, [reviewResults, current, tasks, play, advance])

  useEffect(() => {
    if (!expired || done || !tasks.length) return
    setTasks((list) => {
      const next = list.map((t) =>
        t.status === TASK_STATUS.pending || t.status === TASK_STATUS.active
          ? { ...t, status: TASK_STATUS.timeout, points: 0, timeSpentMs: t.startedAt ? Date.now() - t.startedAt : 0 }
          : t,
      )
      persist(next, { finished: true, completed: false })
      return next
    })
    setDone(true)
  }, [expired, done, tasks.length, persist])

  const destroyEnv = useCallback(() => {
    if (attemptId) attemptApi.destroy(attemptId).catch(() => {})
  }, [attemptId])

  /** Abort while still provisioning. Waits for the teardown rather than firing and
   * navigating away: leaving mid-request is how half-built clusters got orphaned in the
   * first place, and the backend needs the call to stop its provisioner. Nothing is graded
   * yet at this point — no attempt record exists until the environment is ready — so there
   * is no score to preserve, only real infrastructure to release. */
  const abortEnv = useCallback(async () => {
    setAborting(true)
    // Stop the poller from resurrecting a fresh environment the moment this one 404s.
    bootstrappedKeyRef.current = `${labId}:${user.id}`
    recoveredRef.current = true
    try {
      if (attemptId) await attemptApi.destroy(attemptId)
    } catch {
      /* already gone, or the backend is down — either way there is nothing to wait for */
    }
    navigate('catalog')
  }, [attemptId, labId, user.id])

  if (!lab || !play) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Card>
          <p className="text-sm">This lab is not playable in this mock.</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => navigate('catalog')}>
            Back to catalog
          </Button>
        </Card>
      </div>
    )
  }

  if (envStatus !== 'ready') {
    return (
      <Provisioning
        lab={lab}
        play={play}
        phaseLog={phaseLog}
        error={envStatus === 'error' ? envError : null}
        onRetry={bootstrapEnv}
        onAbort={abortEnv}
        aborting={aborting}
      />
    )
  }
  if (!tasks.length) return <div className="p-6 text-sm text-muted">Loading…</div>

  const world = toWorldShape(clusterState)
  const verified = tasks.filter((t) => t.status === TASK_STATUS.passed || t.status === TASK_STATUS.late).length
  const remaining = Math.max(0, sessionEndsAt - now)
  const sessionTone =
    remaining < 120e3 ? 'var(--status-crit)' : remaining < 600e3 ? 'var(--status-warn)' : 'var(--fg)'

  const workspace = (
    <div className="flex h-full min-h-0 flex-col gap-1.5 p-1.5">
      <TerminalDeck
        attemptId={attemptId}
        terminals={terminals}
        openNodes={openNodes}
        setOpenNodes={setOpenNodes}
        active={activeNode}
        setActive={setActiveNode}
      />
    </div>
  )

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      {/* header */}
      <header className="flex h-11 shrink-0 items-center gap-3 border-b bg-surface px-2.5">
        <button
          onClick={() => navigate('catalog')}
          className="rounded-sm p-1 text-muted transition hover:bg-surface2 hover:text-fg"
          title="Back to catalog — the session stays open"
        >
          <Icon.Chevron size={15} className="rotate-180" />
        </button>
        <div className="flex h-6 w-6 shrink-0 items-center justify-center bg-primary text-[11px] font-bold text-primary-fg">
          D
        </div>
        <span className="truncate text-[12.5px] font-semibold">{lab.title}</span>
        <span className="microlabel hidden shrink-0 md:inline">{lab.technology}</span>

        <div className="ml-auto flex items-center gap-3.5">
          <span className="flex items-baseline gap-1.5">
            <span className="microlabel">objectives</span>
            <span className="tnum text-[12px] font-semibold">
              {verified}
              <span className="text-muted">/{play.tasks.length}</span>
            </span>
          </span>
          <span className="flex items-baseline gap-1.5">
            <span className="microlabel">session</span>
            <span className="tnum text-[12px] font-semibold" style={{ color: sessionTone }}>
              {clockDuration(remaining)}
            </span>
          </span>
          <button
            onClick={() => setExtensions((e) => e + 1)}
            className="data border px-1.5 py-0.5 text-muted transition hover:border-primary/60 hover:text-primary"
            title="Extend this session by 15 minutes"
          >
            +15m
          </button>
          <button
            onClick={refreshState}
            className="rounded-sm p-1 text-muted transition hover:bg-surface2 hover:text-fg"
            title="Refresh cluster status"
          >
            <Icon.Refresh size={15} />
          </button>
          <div className="relative">
            <button
              onClick={() => setMenu((m) => !m)}
              className="rounded-sm p-1 text-muted transition hover:bg-surface2 hover:text-fg"
              title="Layout"
            >
              <Icon.Menu size={15} />
            </button>
            {menu && (
              <div
                className="absolute right-0 z-40 mt-1 w-52 animate-fade-in border bg-surface py-1 shadow-xl"
                onMouseLeave={() => setMenu(false)}
              >
                {[
                  [railHidden ? 'Show objective rail' : 'Hide objective rail', () => setRailHidden((v) => !v)],
                  ['Open topology diagram', () => setInspect({ kind: 'service', id: 'topology' })],
                ].map(([label, fn]) => (
                  <button
                    key={label}
                    onClick={() => {
                      fn()
                      setMenu(false)
                    }}
                    className="block w-full px-2.5 py-1.5 text-left text-[11.5px] transition hover:bg-surface2"
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <VoicePicker />
          <ThemePicker />
          <Button size="xs" variant="danger" onClick={() => setConfirm('end')}>
            End lab
          </Button>
        </div>
      </header>

      {/* three zones */}
      <div className="relative flex min-h-0 flex-1">
        <div className="min-h-0 flex-1">
          <SplitPane
            collapsed={railHidden}
            initial={30}
            min={22}
            max={52}
            left={
              <ObjectiveRail
                play={play}
                tasks={tasks}
                current={current}
                viewing={viewing}
                onView={setViewing}
                onBrief={setBriefFor}
                now={now}
                reviewResults={reviewResults}
                checking={checking}
                onCheck={onCheck}
                onAdvance={onAdvance}
                onHint={() => setConfirm('hint')}
                onSolution={() => setConfirm('solution')}
              />
            }
            right={workspace}
          />
        </div>

        {inspect && world && (
          <div className="w-[420px] max-w-[46vw] shrink-0 p-1.5 pl-0">
            <Inspector world={world} target={inspect} onClose={() => setInspect(null)} />
          </div>
        )}

        {railHidden && (
          <button
            onClick={() => setRailHidden(false)}
            className="absolute left-0 top-2 z-30 flex items-center gap-1.5 border border-l-0 bg-surface px-1.5 py-2 text-[11px] text-muted shadow transition hover:text-fg"
            title="Show objective rail"
          >
            <Icon.Chevron size={13} /> Obj {current + 1}
          </button>
        )}

        {done && (
          <Debrief
            lab={lab}
            play={play}
            attempt={attemptRef.current}
            onClose={() => setDone(false)}
            onLeave={(dest) => {
              destroyEnv()
              navigate(dest)
            }}
          />
        )}
      </div>

      {/* dialogs */}
      {briefFor !== null && !done && (
        <ObjectiveBrief
          play={play}
          index={briefFor}
          isCurrent={briefFor === current}
          onClose={() => setBriefFor(null)}
        />
      )}

      {confirm === 'end' && (
        <Modal
          title={`End "${lab.title}"?`}
          subtitle="This tears down the real lab cluster and closes your terminals."
          onClose={() => setConfirm(null)}
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  const next = tasks.map((t) =>
                    t.status === TASK_STATUS.pending || t.status === TASK_STATUS.active
                      ? {
                          ...t,
                          status: TASK_STATUS.timeout,
                          points: 0,
                          timeSpentMs: t.startedAt ? Date.now() - t.startedAt : 0,
                        }
                      : t,
                  )
                  setTasks(next)
                  persist(next, { finished: true, completed: false })
                  destroyEnv()
                  setConfirm(null)
                  setDone(true)
                }}
              >
                End lab
              </Button>
            </>
          }
        >
          <p className="text-xs leading-relaxed text-muted">
            Verified objectives and your score are kept. Anything unfinished is recorded as a
            timeout. The real k3d cluster, SeaweedFS, and network for this attempt are destroyed.
            This cannot be undone.
          </p>
        </Modal>
      )}

      {confirm === 'hint' && (
        <Modal
          title="Reveal the hint?"
          onClose={() => setConfirm(null)}
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>
                Keep trying
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setTasks((list) => {
                    const next = [...list]
                    next[current] = { ...next[current], hintUsed: true }
                    return next
                  })
                  setConfirm(null)
                }}
              >
                <Icon.Bulb size={14} /> Show hint
              </Button>
            </>
          }
        >
          <p className="text-xs leading-relaxed text-muted">
            The hint points at the mechanism without doing the work for you. It costs{' '}
            <strong className="text-warning">15%</strong> of this objective.
          </p>
        </Modal>
      )}

      {confirm === 'solution' && (
        <Modal
          title="Reveal the solution?"
          onClose={() => setConfirm(null)}
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>
                Keep trying
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  setTasks((list) => {
                    const next = [...list]
                    next[current] = { ...next[current], solutionUsed: true }
                    return next
                  })
                  setConfirm(null)
                }}
              >
                Show solution
              </Button>
            </>
          }
        >
          <p className="text-xs leading-relaxed text-muted">
            This shows the exact commands. You still have to run them — verification reads the
            real cluster, not the text — but this objective will score{' '}
            <strong className="text-danger">0%</strong>.
          </p>
        </Modal>
      )}
    </div>
  )
}
