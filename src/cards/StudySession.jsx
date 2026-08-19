import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, ProgressBar, ScoreRing } from '../components/ui.jsx'
import { Icon } from '../components/Icons.jsx'
import { Markdown } from '../components/Markdown.jsx'
import { FrontText, KindBadge, LabChips } from './CardParts.jsx'
import { shuffle } from './review.js'

/**
 * A study session: one card at a time, shuffled, graded by the learner.
 *
 * This is the half of the page that browsing cannot do. Reading a grid of questions tells you
 * what you recognise; being handed one card with nothing else on screen, committing to an
 * answer and then finding out, tells you what you know. Everything here follows from that:
 *
 * - The answer is hidden until you ask for it, and grading is only offered afterwards, so the
 *   commitment happens before the reveal rather than alongside it.
 * - Grades are written the moment they are given, not at the end. A learner who leaves halfway
 *   keeps the work they did.
 * - The summary leads with what was missed, and every missed card carries the labs it came
 *   from — a card you cannot answer is a lab you have not finished with.
 */
export function StudySession({ label, cards, onGrade, onExit, onStudy }) {
  const queue = useMemo(() => shuffle(cards), [cards])
  const [i, setI] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [answers, setAnswers] = useState(() => ({}))

  const card = queue[i]
  const done = i >= queue.length

  const grade = useCallback(
    (got) => {
      if (!card) return
      onGrade(card.id, got)
      setAnswers((prev) => ({ ...prev, [card.id]: got }))
      setRevealed(false)
      setI((n) => n + 1)
    },
    [card, onGrade],
  )

  // Space reveals, then 1 and 2 grade — the whole loop stays under one hand. Escape leaves,
  // which is safe because every grade so far is already recorded.
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'Escape') return onExit()
      if (done) return
      if (e.key === ' ' || e.key === 'Enter') {
        // Only swallowed while the answer is hidden. Once it is showing, Space belongs to
        // whichever grading button has focus.
        if (!revealed) {
          e.preventDefault()
          setRevealed(true)
        }
        return
      }
      if (!revealed) return
      if (e.key === '1') grade(false)
      if (e.key === '2') grade(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [revealed, done, grade, onExit])

  /* ------------------------------------------------------------------- summary */

  if (done) {
    const graded = queue.filter((c) => c.id in answers)
    const missed = graded.filter((c) => !answers[c.id])
    const right = graded.length - missed.length
    const pct = graded.length ? (right / graded.length) * 100 : 0

    return (
      <div className="mx-auto max-w-3xl space-y-4 p-5">
        <div className="panel flex items-center gap-4 px-4 py-4">
          <ScoreRing value={pct} size={86} stroke={8} label="recalled" />
          <div className="min-w-0">
            <p className="microlabel">Session complete</p>
            <h3 className="text-base font-semibold">{label}</h3>
            <p className="data mt-1 text-muted">
              {right} of {graded.length} recalled · {missed.length} to revisit
            </p>
          </div>
        </div>

        {missed.length > 0 && (
          <div className="panel">
            <div className="flex items-center gap-2 px-3 py-1.5 rule-b">
              <span className="microlabel">Missed</span>
              <span className="ml-auto text-[10px] text-muted">
                back in box 1 — each one links to the lab that teaches it
              </span>
            </div>
            {missed.map((c, n) => (
              <div key={c.id} className={`space-y-1.5 px-3 py-2.5 ${n ? 'rule-t' : ''}`}>
                <p className="text-[12.5px] font-medium leading-snug">
                  <FrontText text={c.front} />
                </p>
                <div className="text-[12px] leading-relaxed text-muted">
                  <Markdown text={c.back} />
                </div>
                <LabChips labIds={c.usedIn} withReference />
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap justify-center gap-2 pb-4">
          {missed.length > 0 && (
            <Button size="sm" onClick={() => onStudy(missed, `${missed.length} missed`)}>
              <Icon.Refresh size={14} /> Study the {missed.length} you missed
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={onExit}>
            Back to the deck
          </Button>
        </div>
      </div>
    )
  }

  /* ---------------------------------------------------------------------- card */

  return (
    <div className="mx-auto max-w-3xl space-y-3 p-5">
      <div className="flex items-center gap-3">
        <div className="min-w-0">
          <p className="microlabel">Studying</p>
          <h3 className="truncate text-sm font-semibold">{label}</h3>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span className="tnum text-[11px] text-muted">
            {i + 1} of {queue.length}
          </span>
          <Button size="xs" variant="ghost" onClick={onExit} title="Leave — everything graded so far is kept">
            <Icon.X size={13} /> End session
          </Button>
        </div>
      </div>

      <ProgressBar value={(i / queue.length) * 100} height="h-[3px]" />

      <div className="panel flex min-h-[19rem] flex-col gap-3 p-5">
        <KindBadge kind={card.kind} />

        <p className="text-[17px] font-medium leading-snug">
          <FrontText text={card.front} />
        </p>

        {/* The answer's box is reserved whether or not it is showing, so revealing does not
            move the buttons out from under the pointer. */}
        <div className="min-h-[6.5rem] rule-t pt-3">
          {revealed ? (
            <div className="space-y-2.5 text-[13.5px] leading-relaxed">
              <Markdown text={card.back} />
              <LabChips labIds={card.usedIn} withReference />
            </div>
          ) : (
            <p className="text-xs italic text-muted">Answer it in your head first — then show the card.</p>
          )}
        </div>

        <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
          {revealed ? (
            <>
              <Button size="sm" variant="outline" onClick={() => grade(false)}>
                <Icon.X size={14} /> Missed it <span className="text-muted">1</span>
              </Button>
              <Button size="sm" variant="success" onClick={() => grade(true)}>
                <Icon.Check size={14} /> Got it <span className="opacity-70">2</span>
              </Button>
              <span className="ml-auto text-[10.5px] text-muted">
                Honest answers make the schedule mean something
              </span>
            </>
          ) : (
            <Button size="sm" onClick={() => setRevealed(true)}>
              <Icon.Eye size={14} /> Show answer <span className="opacity-70">space</span>
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
