import { useMemo, useState } from 'react'
import { Badge, Card, Empty } from '../components/ui.jsx'
import { Icon } from '../components/Icons.jsx'
import { useAuth } from '../auth/AuthProvider.jsx'
import { TASK_STATUS, attemptScore, loadAttempts, taskStats } from '../store/progress.js'
import { BY_ID, PLAYABLE } from '../labs/index.js'
import { clockDuration } from '../lib/format.js'

const PLAY_IDS = Object.keys(PLAYABLE)

/** Colour for a per-task cell: green solved on time, amber late/hinted, red timeout. */
function cellStyle(task) {
  if (!task) return { background: 'var(--surface2)', color: 'var(--muted)' }
  if (task.status === TASK_STATUS.timeout)
    return { background: 'color-mix(in srgb, var(--status-crit) 26%, transparent)', color: 'var(--status-crit)' }
  if (task.status === TASK_STATUS.late || task.hintUsed)
    return { background: 'color-mix(in srgb, var(--status-warn) 30%, transparent)', color: 'var(--fg)' }
  return { background: 'color-mix(in srgb, var(--status-ok) 26%, transparent)', color: 'var(--status-ok)' }
}

export function Gradebook() {
  const { users } = useAuth()
  const [labId, setLabId] = useState(PLAY_IDS[0])
  const attempts = useMemo(() => loadAttempts(), [])

  const lab = BY_ID[labId]
  const play = PLAYABLE[labId]
  const rows = useMemo(() => {
    const learners = users.filter((u) => u.role === 'learner')
    return learners
      .map((u) => {
        const forLab = attempts.filter((a) => a.userId === u.id && a.labId === labId)
        const best = forLab.reduce(
          (acc, a) => {
            const s = attemptScore(a, play.tasks.length)
            return !acc || s > acc.score ? { attempt: a, score: s } : acc
          },
          null,
        )
        return { user: u, attempts: forLab, best }
      })
      .sort((a, b) => (b.best?.score ?? -1) - (a.best?.score ?? -1))
  }, [users, attempts, labId, play])

  const stats = useMemo(() => taskStats(labId, play.tasks), [labId, play])
  const attempted = rows.filter((r) => r.best)
  const mean = attempted.length
    ? Math.round(attempted.reduce((n, r) => n + r.best.score, 0) / attempted.length)
    : 0

  return (
    <div className="space-y-5 p-5">
      <div className="flex flex-wrap items-center gap-2">
        {PLAY_IDS.map((id) => (
          <button
            key={id}
            onClick={() => setLabId(id)}
            className={`rounded-sm border px-3 py-1.5 text-xs font-medium transition ${
              labId === id ? 'border-primary bg-primary/15 text-primary' : 'text-muted hover:bg-surface2 hover:text-fg'
            }`}
          >
            {BY_ID[id].title}
          </button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        {[
          { label: 'Learners attempted', value: `${attempted.length} / ${rows.length}` },
          { label: 'Mean best score', value: `${mean}%` },
          { label: 'Tasks in lab', value: play.tasks.length },
          {
            label: 'Total timeouts',
            value: stats.reduce((n, s) => n + s.timeouts, 0),
          },
        ].map((s) => (
          <div key={s.label} className="rounded-sm border bg-surface px-4 py-3">
            <p className="text-[11px] uppercase tracking-wide text-muted">{s.label}</p>
            <p className="mt-1 text-xl font-semibold">{s.value}</p>
          </div>
        ))}
      </div>

      <Card
        title="Per-learner results"
        subtitle={`${lab.title} — best attempt per learner, task by task`}
        bodyClass="p-0"
      >
        {rows.length === 0 ? (
          <Empty icon={<Icon.Users size={28} />} title="No learners enrolled" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-sm">
              <thead className="border-b text-[11px] uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Learner</th>
                  {play.tasks.map((t, i) => (
                    <th key={t.id} className="px-1 py-2 text-center font-medium" title={t.title}>
                      {i + 1}
                    </th>
                  ))}
                  <th className="px-4 py-2 text-right font-medium">Score</th>
                  <th className="px-4 py-2 text-right font-medium">Time</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ user, best }) => {
                  const total = best ? best.attempt.tasks.reduce((n, t) => n + t.timeSpentMs, 0) : 0
                  return (
                    <tr key={user.id} className="border-b last:border-0">
                      <td className="px-4 py-2">
                        <p className="text-xs font-medium">{user.name}</p>
                        <p className="text-[11px] text-muted">@{user.username}</p>
                      </td>
                      {play.tasks.map((t) => {
                        const st = best?.attempt.tasks.find((x) => x.taskId === t.id)
                        return (
                          <td key={t.id} className="px-1 py-2 text-center">
                            <span
                              className="inline-flex h-6 w-8 items-center justify-center rounded font-mono text-[10px] font-semibold"
                              style={cellStyle(st)}
                              title={
                                st
                                  ? `${t.title}\n${st.points}% · ${clockDuration(st.timeSpentMs)}${st.hintUsed ? ' · hint used' : ''}`
                                  : `${t.title}\nnot reached`
                              }
                            >
                              {st ? st.points : '—'}
                            </span>
                          </td>
                        )
                      })}
                      <td className="px-4 py-2 text-right">
                        {best ? (
                          <span
                            className="font-mono text-sm font-semibold"
                            style={{
                              color:
                                best.score >= 80
                                  ? 'var(--status-ok)'
                                  : best.score >= 50
                                    ? 'var(--status-warn)'
                                    : 'var(--status-crit)',
                            }}
                          >
                            {best.score}%
                          </span>
                        ) : (
                          <span className="text-xs text-muted">not attempted</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-muted">
                        {best ? clockDuration(total) : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Which tasks are too hard?"
        subtitle="Pass rate, mean time against the limit, and how often learners needed help"
        bodyClass="p-0"
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b text-[11px] uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Task</th>
                <th className="px-3 py-2 text-right font-medium">Attempted</th>
                <th className="px-3 py-2 text-right font-medium">Pass rate</th>
                <th className="px-3 py-2 text-right font-medium">Mean time</th>
                <th className="px-3 py-2 text-right font-medium">Limit</th>
                <th className="px-3 py-2 text-right font-medium">Hints</th>
                <th className="px-4 py-2 text-right font-medium">Timeouts</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((s) => {
                const overBudget = s.meanTimeMs > s.limitSec * 1000
                return (
                  <tr key={s.taskId} className="border-b last:border-0">
                    <td className="px-4 py-2">
                      <p className="text-xs font-medium">
                        <span className="mr-1.5 text-muted">{s.index}.</span>
                        {s.title}
                      </p>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-muted">{s.attempted}</td>
                    <td className="px-3 py-2 text-right">
                      {s.passRate === null ? (
                        <span className="text-xs text-muted">—</span>
                      ) : (
                        <span
                          className="font-mono text-xs font-semibold"
                          style={{
                            color:
                              s.passRate >= 80
                                ? 'var(--status-ok)'
                                : s.passRate >= 50
                                  ? 'var(--status-warn)'
                                  : 'var(--status-crit)',
                          }}
                        >
                          {s.passRate}%
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <span className={`font-mono text-xs ${overBudget ? 'font-semibold text-warning' : 'text-muted'}`}>
                        {s.meanTimeMs ? clockDuration(s.meanTimeMs) : '—'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-muted">
                      {clockDuration(s.limitSec * 1000)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-muted">{s.hints}</td>
                    <td className="px-4 py-2 text-right">
                      {s.timeouts > 0 ? (
                        <Badge tone="danger">{s.timeouts}</Badge>
                      ) : (
                        <span className="font-mono text-xs text-muted">0</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="border-t px-4 py-2.5">
          <p className="text-[11px] leading-relaxed text-muted">
            A pass rate well under 100% paired with a mean time above the limit is the signal that a
            task's time budget is wrong rather than the learners being slow.
          </p>
        </div>
      </Card>
    </div>
  )
}
