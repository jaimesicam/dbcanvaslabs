import { useMemo, useState } from 'react'
import { Badge, Button, Card, Empty, useCopy } from '../components/ui.jsx'
import { Icon } from '../components/Icons.jsx'
import { Markdown } from '../components/Markdown.jsx'
import { navigate } from '../lib/router.js'
import { BY_ID } from '../labs/index.js'
import { REFERENCES, getReference } from '../reference/index.js'

/**
 * Command Reference — the commands the labs teach, collected in one place so they can be
 * looked up outside a running lab. Every example and every sample output here came from a
 * real run against a real cluster (see CLAUDE.md, "Command reference contract"); nothing on
 * this page is illustrative.
 */

function Snippet({ run, out, note }) {
  const [copied, copy] = useCopy()
  return (
    <div className="overflow-hidden rounded-sm border">
      <div className="group relative bg-[#0e1117]">
        <button
          onClick={() => copy(run)}
          title="Copy command"
          className={`absolute right-1.5 top-1.5 z-10 inline-flex items-center gap-1 rounded-sm border px-1.5 py-1 text-[10px] font-medium transition ${
            copied
              ? 'border-success/40 bg-success/15 text-success'
              : 'border-border bg-surface2/80 text-muted opacity-0 hover:text-fg group-hover:opacity-100'
          }`}
        >
          {copied ? <Icon.Check size={11} /> : <Icon.Copy size={11} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
        <pre className="whitespace-pre-wrap break-words px-3 py-2.5 pr-14 font-mono text-xs leading-relaxed text-[#e6eaf2]">
          {run}
        </pre>
      </div>
      {out && (
        <div className="border-t bg-surface2">
          <div className="microlabel px-3 pt-2">Output</div>
          {/* Real command output is wide and column-aligned: scroll it rather than
              wrap it, because a re-wrapped table is unreadable. */}
          <pre className="overflow-x-auto px-3 pb-2.5 pt-1 font-mono text-[11px] leading-relaxed text-muted">
            {out}
          </pre>
        </div>
      )}
      {note && <p className="border-t bg-surface px-3 py-2 text-[11px] leading-relaxed text-muted">{note}</p>}
    </div>
  )
}

function LabChips({ labIds }) {
  if (!labIds?.length) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="microlabel">Used in</span>
      {labIds.map((id) => {
        const lab = BY_ID[id]
        return (
          <button
            key={id}
            onClick={() => navigate(`lab/${id}`)}
            title={lab ? `Open ${lab.title}` : id}
            className="rounded-sm border px-1.5 py-0.5 text-[11px] text-muted transition hover:border-primary/40 hover:text-primary"
          >
            {lab?.title || id}
          </button>
        )
      })}
    </div>
  )
}

function CommandCard({ cmd }) {
  return (
    <div id={`cmd-${cmd.id}`} className="scroll-mt-5 rounded-sm border bg-surface">
      <div className="space-y-2 border-b px-4 py-3">
        <h4 className="data break-words text-sm font-semibold text-fg">{cmd.name}</h4>
        <p className="text-xs leading-relaxed text-muted">{cmd.summary}</p>
        <LabChips labIds={cmd.usedIn} />
      </div>
      <div className="space-y-3 p-4">
        {cmd.examples.map((ex, i) => (
          <Snippet key={i} {...ex} />
        ))}
        {cmd.notes?.length > 0 && (
          <ul className="space-y-1.5 pl-1">
            {cmd.notes.map((n, i) => (
              <li key={i} className="flex gap-2 text-xs leading-relaxed text-muted">
                <span className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-primary/60" />
                <span className="min-w-0">
                  <Markdown text={n} className="[&>p]:text-xs" />
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function matches(cmd, q) {
  if (!q) return true
  const hay = [cmd.name, cmd.summary, ...(cmd.notes || []), ...cmd.examples.map((e) => `${e.run} ${e.out || ''}`)]
    .join(' ')
    .toLowerCase()
  return hay.includes(q)
}

/** The landing page: one card per technology that has a reference. */
function ReferenceIndex() {
  return (
    <div className="space-y-5 p-5">
      <Card
        title="Command Reference"
        subtitle="Every command the labs use, with a real example and its real output"
      >
        <p className="text-sm leading-relaxed text-muted">
          The labs teach these commands in the middle of a scenario, where they are useful but hard
          to find again. This is the same material arranged the other way round — by command rather
          than by lab — so it can be used as a lookup while working, or read on its own.
        </p>
      </Card>
      <div className="grid gap-4 sm:grid-cols-2">
        {REFERENCES.map((ref) => (
          <button
            key={ref.id}
            onClick={() => navigate(`reference/${ref.id}`)}
            className="rounded-sm border bg-surface p-4 text-left transition hover:border-primary/40"
          >
            <div className="flex items-center gap-2">
              <Icon.Book size={16} className="text-primary" />
              <h4 className="text-sm font-semibold">{ref.title}</h4>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted">{ref.blurb}</p>
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <Badge tone="primary">{ref.groups.reduce((n, g) => n + g.commands.length, 0)} commands</Badge>
              <Badge tone="muted">{ref.groups.length} sections</Badge>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * `#/reference/<ref>` lists everything; `…/lab/<labId>` narrows it to the entries that name
 * that lab in `usedIn` — the link an index card or a lab detail page follows. `usedIn` is
 * authored and checked against the catalog, so the narrowing needs no mapping of its own.
 */
function parsePath(path) {
  const [refId, mode, arg] = String(path || '').split('/')
  return { refId: refId || null, labId: mode === 'lab' ? arg || null : null }
}

export function Reference({ path }) {
  const [query, setQuery] = useState('')
  const { refId, labId } = parsePath(path)
  const ref = refId ? getReference(refId) : null
  const q = query.trim().toLowerCase()

  const groups = useMemo(() => {
    if (!ref) return []
    return ref.groups
      .map((g) => ({
        ...g,
        commands: g.commands.filter((c) => matches(c, q) && (!labId || (c.usedIn || []).includes(labId))),
      }))
      .filter((g) => g.commands.length > 0)
  }, [ref, q, labId])

  if (!refId) return <ReferenceIndex />

  if (!ref) {
    return (
      <div className="p-5">
        <Card>
          <Empty icon={<Icon.Warn size={28} />} title="No such reference">
            There is no command reference with the id <code className="font-mono">{refId}</code>.
          </Empty>
          <div className="flex justify-center">
            <Button size="sm" variant="outline" onClick={() => navigate('reference')}>
              Back to references
            </Button>
          </div>
        </Card>
      </div>
    )
  }

  const total = ref.groups.reduce((n, g) => n + g.commands.length, 0)
  const shown = groups.reduce((n, g) => n + g.commands.length, 0)

  return (
    <div className="space-y-5 p-5">
      <button
        onClick={() => navigate('reference')}
        className="flex items-center gap-1 text-xs text-muted transition hover:text-fg"
      >
        <Icon.Chevron size={14} /> All references
      </button>

      <Card title={ref.title} subtitle={ref.blurb}>
        <Markdown text={ref.intro} />
      </Card>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
        <nav className="rounded-sm border bg-surface p-2 lg:sticky lg:top-5 lg:w-56 lg:shrink-0">
          <div className="microlabel px-2 pb-1.5 pt-1">Sections</div>
          {groups.map((g) => (
            <a
              key={g.id}
              href={`#/reference/${ref.id}`}
              onClick={(e) => {
                e.preventDefault()
                document.getElementById(`ref-${g.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }}
              className="flex items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-xs text-muted transition hover:bg-surface2 hover:text-fg"
            >
              <span className="truncate">{g.title}</span>
              <span className="tnum shrink-0 text-[10px] text-muted">{g.commands.length}</span>
            </a>
          ))}
        </nav>

        <div className="min-w-0 flex-1 space-y-5">
          {labId && (
            <div className="panel flex flex-wrap items-center gap-2 px-3 py-2">
              <Icon.Book size={14} className="shrink-0 text-primary" />
              <span className="text-xs">
                The <strong className="font-semibold">{shown}</strong> commands used in{' '}
                <button
                  onClick={() => navigate(`lab/${labId}`)}
                  className="font-semibold text-primary transition hover:underline"
                >
                  {BY_ID[labId]?.title || labId}
                </button>
              </span>
              <Button
                size="xs"
                variant="outline"
                className="ml-auto"
                onClick={() => navigate(`reference/${ref.id}`)}
              >
                Show all {total}
              </Button>
            </div>
          )}

          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Icon.Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter commands, flags, output…"
                className="w-full rounded-sm border bg-surface py-1.5 pl-8 pr-3 text-sm outline-none transition focus:border-primary/50"
              />
            </div>
            <span className="tnum shrink-0 text-[11px] text-muted">
              {shown} / {total}
            </span>
          </div>

          {groups.length === 0 ? (
            <Card>
              <Empty icon={<Icon.Search size={26} />} title="No command matches that">
                Try a shorter query — the filter searches command names, descriptions, examples and
                their output.
              </Empty>
            </Card>
          ) : (
            groups.map((g) => (
              <section key={g.id} id={`ref-${g.id}`} className="scroll-mt-5 space-y-3">
                <div className="rule-b pb-2">
                  <h3 className="text-sm font-semibold">{g.title}</h3>
                  {g.blurb && <p className="mt-1 text-xs leading-relaxed text-muted">{g.blurb}</p>}
                </div>
                {g.commands.map((cmd) => (
                  <CommandCard key={cmd.id} cmd={cmd} />
                ))}
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
