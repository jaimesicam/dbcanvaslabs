import { useMemo, useState } from 'react'
import { Badge, Button, Card, Empty, inputCls } from '../components/ui.jsx'
import { Icon } from '../components/Icons.jsx'
import { LectureNotes } from '../components/Markdown.jsx'
import { navigate } from '../lib/router.js'
import { useAuth } from '../auth/AuthProvider.jsx'
import { attemptsFor } from '../store/progress.js'
import {
  CATALOG,
  DATABASE_TONE,
  DIFFICULTIES,
  DIFFICULTY_TONE,
  groupCatalog,
  searchLabs,
} from '../labs/index.js'

const DATABASES = [...new Set(CATALOG.map((l) => l.database))]

function Chip({ active, onClick, tone = 'primary', children }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-sm border px-2 py-1 text-[11px] font-medium transition ${
        active ? `border-${tone}/40 bg-${tone}/15 text-${tone}` : 'text-muted hover:bg-surface2 hover:text-fg'
      }`}
      style={active ? { borderColor: `var(--${tone})`, background: `color-mix(in srgb, var(--${tone}) 15%, transparent)`, color: `var(--${tone})` } : undefined}
    >
      {children}
    </button>
  )
}

function LabCard({ lab, attempt }) {
  const [notes, setNotes] = useState(false)
  return (
    <div className="flex flex-col rounded-sm border bg-surface transition hover:border-primary/40">
      <div className="flex items-start gap-2 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-semibold leading-snug">{lab.title}</h4>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge tone={DIFFICULTY_TONE[lab.difficulty]}>{lab.difficulty}</Badge>
            {lab.playable ? (
              <Badge tone="primary">
                <Icon.Check size={10} /> {lab.taskCount} tasks
              </Badge>
            ) : (
              <Badge tone="muted">
                {lab.taskCount} task{lab.taskCount === 1 ? '' : 's'}
              </Badge>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-3 p-4">
        <p className="text-xs leading-relaxed text-muted">{lab.description}</p>

        <div className="mt-auto space-y-2">
          <div className="flex items-center gap-1.5 text-[11px] text-muted">
            <Icon.Clock size={12} /> Time limit: {lab.timeLimitLabel}
          </div>

          <button
            onClick={() => setNotes((n) => !n)}
            className="flex items-center gap-1 text-[11px] font-medium text-primary transition hover:underline"
          >
            <Icon.Book size={12} /> Lecture notes
            <Icon.ChevronDown size={12} className={`transition-transform ${notes ? 'rotate-180' : ''}`} />
          </button>
          {notes && (
            <div className="max-h-72 overflow-y-auto rounded-sm border bg-bg p-3">
              <LectureNotes text={lab.lectureNotes} />
            </div>
          )}

          <div className="flex gap-2 pt-1">
            {lab.playable ? (
              <Button size="sm" onClick={() => navigate(`play/${lab.id}`)} className="flex-1">
                {attempt ? 'Resume Lab' : 'Start Lab'}
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => navigate(`lab/${lab.id}`)} className="flex-1">
                View details
              </Button>
            )}
            {lab.playable && (
              <Button size="sm" variant="ghost" onClick={() => navigate(`lab/${lab.id}`)} title="Lab details">
                <Icon.Info size={14} />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Collapsible({ label, count, children, defaultOpen = false, level = 0 }) {
  const [open, setOpen] = useState(defaultOpen)
  const size = level === 0 ? 'text-base font-semibold' : level === 1 ? 'text-sm font-semibold' : 'text-xs font-medium text-muted'
  return (
    <div className={level === 0 ? 'border-t pt-4 first:border-t-0 first:pt-0' : ''}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex w-full items-center gap-2 py-1.5 text-left transition hover:text-primary ${size}`}
      >
        <Icon.Chevron size={14} className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        {label}
        <span className="text-xs font-normal text-muted">({count})</span>
      </button>
      {open && <div className={level === 2 ? 'pt-2' : 'pl-4'}>{children}</div>}
    </div>
  )
}

export function Catalog() {
  const { user } = useAuth()
  const [query, setQuery] = useState('')
  const [difficulty, setDifficulty] = useState([])
  const [database, setDatabase] = useState([])
  const [playableOnly, setPlayableOnly] = useState(false)

  const attempts = useMemo(() => attemptsFor(user.id), [user.id])
  const activeAttempts = attempts.filter((a) => !a.finishedAt)

  const filtered = useMemo(
    () => searchLabs(CATALOG, query, { difficulty, database, playableOnly }),
    [query, difficulty, database, playableOnly],
  )
  const grouped = useMemo(() => groupCatalog(filtered), [filtered])
  const playableCount = CATALOG.filter((l) => l.playable).length

  const toggle = (list, setList, v) =>
    setList(list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

  return (
    <div className="space-y-5 p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-lg font-semibold">
            <Icon.Flask size={20} className="text-primary" /> Lab Catalog
          </h3>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Hands-on scenarios on a disposable database cluster. Each task is verified against the
            cluster's actual live state — <strong className="font-medium text-fg">Check Work never grades typed answers</strong>.
          </p>
        </div>
        <div className="flex gap-2 text-xs text-muted">
          <span className="rounded-sm border bg-surface px-2.5 py-1.5">
            <strong className="text-fg">{CATALOG.length}</strong> labs
          </span>
          <span className="rounded-sm border bg-surface px-2.5 py-1.5">
            <strong className="text-primary">{playableCount}</strong> playable
          </span>
        </div>
      </div>

      {activeAttempts.length > 0 && (
        <Card
          title="Resume where you left off"
          subtitle="You have unfinished attempts — your task progress is preserved"
        >
          <div className="flex flex-wrap gap-2">
            {activeAttempts.map((a) => {
              const lab = CATALOG.find((l) => l.id === a.labId)
              if (!lab) return null
              const done = a.tasks.filter((t) => t.status === 'passed' || t.status === 'late').length
              return (
                <button
                  key={a.id}
                  onClick={() => navigate(`play/${a.labId}`)}
                  className="flex items-center gap-2.5 rounded-sm border bg-bg px-3 py-2 text-left transition hover:border-primary/50"
                >
                  <Icon.Refresh size={15} className="text-primary" />
                  <div>
                    <p className="text-xs font-medium">{lab.title}</p>
                    <p className="text-[11px] text-muted">
                      {done} of {lab.taskCount} tasks done
                    </p>
                  </div>
                </button>
              )
            })}
          </div>
        </Card>
      )}

      <div className="space-y-3 rounded-sm border bg-surface p-4">
        <div className="relative">
          <Icon.Search size={15} className="pointer-events-none absolute left-3 top-2.5 text-muted" />
          <input
            className={`${inputCls} pl-9`}
            placeholder="Search labs by title, description, database, technology, or category…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted">Level</span>
            {DIFFICULTIES.map((d) => (
              <Chip
                key={d}
                active={difficulty.includes(d)}
                tone={DIFFICULTY_TONE[d]}
                onClick={() => toggle(difficulty, setDifficulty, d)}
              >
                {d}
              </Chip>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted">Engine</span>
            {DATABASES.map((d) => (
              <Chip
                key={d}
                active={database.includes(d)}
                tone={DATABASE_TONE[d] || 'primary'}
                onClick={() => toggle(database, setDatabase, d)}
              >
                {d}
              </Chip>
            ))}
          </div>
          <Chip active={playableOnly} onClick={() => setPlayableOnly((p) => !p)}>
            Playable only
          </Chip>
          {(query || difficulty.length || database.length || playableOnly) && (
            <button
              onClick={() => {
                setQuery('')
                setDifficulty([])
                setDatabase([])
                setPlayableOnly(false)
              }}
              className="ml-auto text-xs text-muted transition hover:text-fg"
            >
              Clear filters
            </button>
          )}
        </div>
        <p className="text-xs text-muted">
          Showing {filtered.length} of {CATALOG.length} labs
        </p>
      </div>

      {filtered.length === 0 ? (
        <Card>
          <Empty icon={<Icon.Search size={28} />} title="No labs match those filters">
            Try a broader search, or clear the level and engine filters.
          </Empty>
        </Card>
      ) : (
        <div className="space-y-4">
          {grouped.map((db, dbIdx) => (
            <Collapsible key={db.name} label={db.name} count={db.count} defaultOpen={dbIdx === 0} level={0}>
              {db.techs.map((tech, tIdx) => (
                <Collapsible
                  key={tech.name}
                  label={tech.name}
                  count={tech.count}
                  defaultOpen={dbIdx === 0 && tIdx === 0}
                  level={1}
                >
                  {tech.cats.map((cat, cIdx) => (
                    <Collapsible
                      key={cat.name}
                      label={cat.name}
                      count={cat.labs.length}
                      defaultOpen={dbIdx === 0 && tIdx === 0 && cIdx === 0}
                      level={2}
                    >
                      <div className="grid gap-3 pb-2 sm:grid-cols-2 xl:grid-cols-3">
                        {cat.labs.map((lab) => (
                          <LabCard
                            key={lab.id}
                            lab={lab}
                            attempt={activeAttempts.find((a) => a.labId === lab.id)}
                          />
                        ))}
                      </div>
                    </Collapsible>
                  ))}
                </Collapsible>
              ))}
            </Collapsible>
          ))}
        </div>
      )}
    </div>
  )
}
