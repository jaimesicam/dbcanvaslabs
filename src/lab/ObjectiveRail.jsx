import { Button, ProgressBar } from '../components/ui.jsx'
import { Icon } from '../components/Icons.jsx'
import { Markdown } from '../components/Markdown.jsx'
import { Verification } from './Verification.jsx'
import { TASK_STATUS, scoreLabel } from '../store/progress.js'
import { clockDuration } from '../lib/format.js'

/**
 * The objective rail. Instructions scroll; verification and the actions are pinned, so
 * the learner can always see the definition of done and act on it.
 *
 * Grading is manual and asynchronous: nothing checks itself in the background. A
 * "Check Solution" click runs the real check against the real cluster; only once it
 * passes does "Next objective" become available. Two deliberate clicks, not an auto-jump.
 *
 * Clicking a number in the stepper both switches the view and reopens that objective's
 * briefing (onBrief) — a learner who dismissed it and lost the thread gets the same
 * orientation back from the most obvious place to click.
 */
export function ObjectiveRail({
  play,
  tasks,
  current,
  viewing,
  onView,
  onBrief,
  now,
  reviewResults,
  checking,
  onCheck,
  onAdvance,
  onHint,
  onSolution,
}) {
  const shown = viewing ?? current
  const isCurrent = shown === current
  const task = play.tasks[shown]
  const state = tasks[shown]

  const limitMs = task.limitSec * 1000
  const elapsed = state?.startedAt ? now - state.startedAt : 0
  const overtime = isCurrent && elapsed > limitMs
  const pct = Math.min(100, (elapsed / limitMs) * 100)

  const result = reviewResults[shown]
  const allMet = isCurrent && !!result?.ok
  const hasBeenChecked = isCurrent && result !== undefined
  const metCount = (result?.checks ?? []).filter((c) => c.ok).length
  const remaining = task.criteria.length - metCount
  const isLast = shown === play.tasks.length - 1

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      {/* stepper */}
      <div className="flex shrink-0 items-center gap-1 px-2 py-2 rule-b">
        {play.tasks.map((t, i) => {
          const st = tasks[i]
          const done = st?.status === TASK_STATUS.passed || st?.status === TASK_STATUS.late
          const failed = st?.status === TASK_STATUS.timeout
          const locked = i > current
          const on = i === shown
          return (
            <button
              key={t.id}
              disabled={locked}
              onClick={() => {
                onView(i === current ? null : i)
                onBrief?.(i)
              }}
              title={locked ? `Objective ${i + 1} — locked` : `${i + 1}. ${t.title} — opens the briefing`}
              className={`tnum h-6 flex-1 border text-[10px] font-semibold transition ${
                on ? 'border-primary text-primary' : 'border-border text-muted'
              } ${locked ? 'cursor-default opacity-45' : 'hover:border-primary/60 hover:text-fg'}`}
              style={{
                background: on
                  ? 'color-mix(in srgb, var(--primary) 14%, transparent)'
                  : done
                    ? 'color-mix(in srgb, var(--status-ok) 16%, transparent)'
                    : failed
                      ? 'color-mix(in srgb, var(--status-crit) 16%, transparent)'
                      : 'transparent',
                color: done && !on ? 'var(--status-ok)' : failed && !on ? 'var(--status-crit)' : undefined,
              }}
            >
              {locked ? <Icon.Lock size={9} className="mx-auto" /> : i + 1}
            </button>
          )
        })}
      </div>

      {/* objective header + instructions (task.brief is the popup, not this) */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-2.5 py-2 rule-b">
          <div className="flex items-center gap-2">
            <span className="microlabel">
              Objective {shown + 1} of {play.tasks.length}
            </span>
            {!isCurrent && (
              <button
                onClick={() => onView(null)}
                className="ml-auto text-[10px] text-primary transition hover:underline"
              >
                back to current
              </button>
            )}
            {task.brief && (
              <button
                onClick={() => onBrief?.(shown)}
                title="Reopen this objective's briefing"
                className={`flex items-center gap-1 text-[10px] text-muted transition hover:text-primary ${
                  isCurrent ? 'ml-auto' : ''
                }`}
              >
                <Icon.Info size={12} /> Briefing
              </button>
            )}
          </div>
          <h3 className="mt-0.5 text-[13px] font-semibold leading-snug">{task.title}</h3>

          {isCurrent ? (
            <div className="mt-2 flex items-center gap-2">
              <ProgressBar
                value={pct}
                height="h-[3px]"
                tone={overtime ? 'danger' : pct > 75 ? 'warning' : 'primary'}
                className="flex-1"
              />
              <span
                className="tnum shrink-0 text-[10px]"
                style={{ color: overtime ? 'var(--status-crit)' : 'var(--muted)' }}
              >
                {overtime ? `+${clockDuration(elapsed - limitMs)}` : clockDuration(limitMs - elapsed)}
              </span>
            </div>
          ) : (
            state && (
              <p className="mt-1.5 text-[10.5px] text-muted">
                {scoreLabel(state)} · {clockDuration(state.timeSpentMs)} · {state.points ?? 0}%
              </p>
            )
          )}
          {overtime && (
            <p className="mt-1 text-[10.5px]" style={{ color: 'var(--status-crit)' }}>
              past the limit — solving it now scores 60%
            </p>
          )}
        </div>

        <div className="px-2.5 py-2.5">
          <Markdown text={task.instructions} />
        </div>

        {isCurrent && state?.hintUsed && (
          <div className="mx-2.5 mb-2.5 border-l-2 bg-warning/8 px-2.5 py-2" style={{ borderColor: 'var(--warning)' }}>
            <p className="microlabel mb-1" style={{ color: 'var(--warning)' }}>
              Hint
            </p>
            <Markdown text={task.hint} />
          </div>
        )}
        {isCurrent && state?.solutionUsed && (
          <div className="mx-2.5 mb-2.5 border-l-2 bg-danger/8 px-2.5 py-2" style={{ borderColor: 'var(--danger)' }}>
            <p className="microlabel mb-1" style={{ color: 'var(--danger)' }}>
              Solution · this objective scores 0%
            </p>
            <Markdown text={`\`\`\`\n${task.solution}\n\`\`\``} />
          </div>
        )}
      </div>

      {/* pinned verification + actions */}
      <div className="shrink-0 rule-t">
        <div className="p-2">
          <Verification criteria={task.criteria} result={result} dimmed={!isCurrent} />
        </div>
        {isCurrent && (
          <div className="flex flex-wrap items-center gap-1.5 px-2 pb-2">
            {allMet ? (
              <Button size="sm" onClick={onAdvance} variant="success" className="ready-glow">
                {isLast ? 'Finish lab' : 'Next objective'}
                <Icon.Chevron size={13} />
              </Button>
            ) : (
              <Button size="sm" onClick={onCheck} disabled={checking} variant="subtle">
                {checking ? (
                  <>
                    <Icon.Refresh size={13} className="animate-spin" /> Checking…
                  </>
                ) : (
                  <>
                    <Icon.Check size={13} /> Check solution
                  </>
                )}
              </Button>
            )}
            {hasBeenChecked && !allMet && !checking && (
              <span className="text-[10.5px] text-muted">
                {remaining} criteri{remaining === 1 ? 'on' : 'a'} to go
              </span>
            )}
            {!state?.hintUsed && (
              <Button
                size="sm"
                variant="outline"
                onClick={onHint}
                disabled={allMet}
                title={allMet ? 'Already met every criterion — nothing left to hint at' : undefined}
              >
                <Icon.Bulb size={13} /> Hint
                <span className="text-muted">−15%</span>
              </Button>
            )}
            {!state?.solutionUsed && (
              <Button
                size="sm"
                variant="ghost"
                onClick={onSolution}
                disabled={allMet}
                title={allMet ? 'Already met every criterion — nothing left to reveal' : undefined}
              >
                <Icon.Eye size={13} /> Solution
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
