import { useMemo } from 'react'
import { Badge, Button, Card, Empty, ScoreRing } from '../components/ui.jsx'
import { Icon } from '../components/Icons.jsx'
import { BarRow } from '../components/Charts.jsx'
import { navigate } from '../lib/router.js'
import { useAuth } from '../auth/AuthProvider.jsx'
import { TASK_STATUS, attemptScore, attemptsFor, scoreLabel } from '../store/progress.js'
import { BY_ID, PLAYABLE } from '../labs/index.js'
import { clockDuration } from '../lib/format.js'

export function Progress() {
  const { user } = useAuth()
  const attempts = useMemo(() => attemptsFor(user.id), [user.id])

  const stats = useMemo(() => {
    const finished = attempts.filter((a) => a.finishedAt)
    const scores = finished.map((a) => attemptScore(a, PLAYABLE[a.labId]?.tasks.length))
    return {
      total: attempts.length,
      completed: attempts.filter((a) => a.completed).length,
      mean: scores.length ? Math.round(scores.reduce((x, y) => x + y, 0) / scores.length) : 0,
      tasksSolved: attempts.reduce(
        (n, a) => n + a.tasks.filter((t) => t.status === TASK_STATUS.passed || t.status === TASK_STATUS.late).length,
        0,
      ),
      hints: attempts.reduce((n, a) => n + a.tasks.filter((t) => t.hintUsed).length, 0),
      timeouts: attempts.reduce((n, a) => n + a.tasks.filter((t) => t.status === TASK_STATUS.timeout).length, 0),
    }
  }, [attempts])

  if (!attempts.length) {
    return (
      <div className="p-5">
        <Card>
          <Empty icon={<Icon.Chart size={30} />} title="No attempts yet">
            Start a lab from the catalog — your per-task timings and scores will appear here.
          </Empty>
          <div className="flex justify-center">
            <Button size="sm" onClick={() => navigate('catalog')}>
              <Icon.Flask size={14} /> Browse labs
            </Button>
          </div>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-5 p-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {[
          { label: 'Mean score', value: `${stats.mean}%`, tone: 'text-fg' },
          { label: 'Labs completed', value: stats.completed, tone: 'text-success' },
          { label: 'Tasks solved', value: stats.tasksSolved, tone: 'text-fg' },
          { label: 'Hints used', value: stats.hints, tone: 'text-warning' },
          { label: 'Timeouts', value: stats.timeouts, tone: 'text-danger' },
        ].map((s) => (
          <div key={s.label} className="rounded-sm border bg-surface px-4 py-3">
            <p className="text-[11px] uppercase tracking-wide text-muted">{s.label}</p>
            <p className={`mt-1 text-xl font-semibold ${s.tone}`}>{s.value}</p>
          </div>
        ))}
      </div>

      <div className="space-y-4">
        {attempts.map((a) => {
          const lab = BY_ID[a.labId]
          const play = PLAYABLE[a.labId]
          if (!lab || !play) return null
          const score = attemptScore(a, play.tasks.length)
          const bars = play.tasks.map((t, i) => {
            const st = a.tasks.find((x) => x.taskId === t.id)
            const secs = st ? Math.round(st.timeSpentMs / 1000) : 0
            const overtime = secs > t.limitSec
            return {
              label: String(i + 1),
              value: secs,
              tone:
                !st || st.status === TASK_STATUS.timeout
                  ? 'var(--status-crit)'
                  : overtime
                    ? 'var(--status-warn)'
                    : 'var(--status-ok)',
              tip: st ? `Task ${i + 1}: ${clockDuration(st.timeSpentMs)} of ${clockDuration(t.limitSec * 1000)}` : 'not attempted',
            }
          })

          return (
            <Card key={a.id} bodyClass="p-0">
              <div className="flex flex-wrap items-center gap-4 border-b p-4">
                <ScoreRing value={score} size={68} stroke={7} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="text-sm font-semibold">{lab.title}</h4>
                    {a.completed ? (
                      <Badge tone="success">
                        <Icon.Check size={10} /> completed
                      </Badge>
                    ) : a.finishedAt ? (
                      <Badge tone="warning">ended early</Badge>
                    ) : (
                      <Badge tone="primary">in progress</Badge>
                    )}
                    {a.seeded && <Badge tone="muted">sample data</Badge>}
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    {new Date(a.startedAt).toLocaleString()} ·{' '}
                    {a.tasks.filter((t) => t.status === TASK_STATUS.passed || t.status === TASK_STATUS.late).length} of{' '}
                    {play.tasks.length} tasks verified
                  </p>
                </div>
                <div className="w-full max-w-[220px]">
                  <p className="mb-1 text-[10px] uppercase tracking-wide text-muted">Time per task</p>
                  <BarRow items={bars} height={64} />
                </div>
                {!a.finishedAt && (
                  <Button size="sm" variant="outline" onClick={() => navigate(`play/${a.labId}`)}>
                    <Icon.Refresh size={14} /> Resume
                  </Button>
                )}
              </div>
              <ul className="divide-y">
                {play.tasks.map((t, i) => {
                  const st = a.tasks.find((x) => x.taskId === t.id)
                  return (
                    <li key={t.id} className="flex items-center gap-3 px-4 py-2">
                      <span
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
                          !st
                            ? 'bg-surface2 text-muted'
                            : st.status === TASK_STATUS.timeout
                              ? 'bg-danger/15 text-danger'
                              : 'bg-success/15 text-success'
                        }`}
                      >
                        {st ? (
                          st.status === TASK_STATUS.timeout ? <Icon.X size={10} /> : <Icon.Check size={10} />
                        ) : (
                          i + 1
                        )}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs">{t.title}</span>
                      <span className="shrink-0 text-[11px] text-muted">
                        {st ? scoreLabel(st) : 'not reached'}
                      </span>
                      <span className="w-10 shrink-0 text-right font-mono text-xs font-semibold">
                        {st ? `${st.points ?? 0}%` : '—'}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
