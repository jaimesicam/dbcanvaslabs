import { useMemo } from 'react'
import { Button, Modal } from '../components/ui.jsx'
import { Icon } from '../components/Icons.jsx'
import { clockDuration } from '../lib/format.js'
import { compact, markdownBlocks, textBlock } from '../speech/speakable.js'
import { SpeechControl, SpokenBlocks, useAutoSpeak } from '../speech/SpokenBlocks.jsx'

/**
 * The objective briefing. It opens by itself the first time an objective becomes the
 * current one, and again whenever the learner clicks that objective in the rail's
 * stepper — same text every time, so it works as an orientation the learner can return
 * to rather than a one-shot announcement they might have dismissed too fast.
 *
 * It answers "what am I being asked to do here, and why", not "which commands do I
 * type" — the step-by-step stays in the rail, where it's readable next to a terminal.
 * `task.brief` is required content for every objective (see CLAUDE.md); a task without
 * one simply never opens this.
 *
 * When narration is on it reads itself aloud, highlighting each word — which is why the
 * body renders through SpokenBlocks rather than Markdown: the spoken text and the text
 * on screen come from one decomposition, so the highlight cannot drift.
 */
export function ObjectiveBrief({ play, index, isCurrent, onClose }) {
  const task = play.tasks[index]

  // The whole reading, in the order it appears on screen: the objective's name, its
  // brief, then what counts as done. The two sections are rendered in different parts of
  // the modal, so each records where its slice starts — that is what lets the highlight
  // walk straight across the hairline instead of restarting. Memoized so the auto-speak
  // effect sees a stable target.
  // Every block here is drawn somewhere on screen, and each section says where its slice
  // starts. That is not tidiness: a block that is spoken but never rendered is a stretch
  // of narration with nothing highlighted, which reads as the highlighting being broken.
  const speech = useMemo(() => {
    if (!task?.brief) return { blocks: [], titleSlice: [], briefSlice: [], briefStart: 0, leadStart: 0, critStart: 0 }
    const title = compact([textBlock(`Objective ${index + 1}. ${task.title}`)])
    const brief = markdownBlocks(task.brief)
    const lead = compact([textBlock('It counts as done when')])
    const crit = compact(task.criteria.map((c) => textBlock(c)))
    return {
      blocks: [...title, ...brief, ...lead, ...crit],
      titleSlice: title,
      briefSlice: brief,
      briefStart: title.length,
      leadSlice: lead,
      leadStart: title.length + brief.length,
      critStart: title.length + brief.length + lead.length,
    }
  }, [task, index])

  const speechKey = task?.brief ? `brief:${play.id}:${task.id}` : null
  useAutoSpeak(speechKey, speech.blocks, !!speechKey)

  if (!task?.brief) return null

  return (
    <Modal
      width="max-w-xl"
      // A node, not a string: the title is the first thing spoken, so it highlights in
      // place rather than being repeated in the body.
      title={<SpokenBlocks speechKey={speechKey} blocks={speech.titleSlice} plain />}
      subtitle={`${index + 1} of ${play.tasks.length} · ${clockDuration(task.limitSec * 1000)} on the objective clock`}
      onClose={onClose}
      footer={
        <Button size="sm" onClick={onClose}>
          {isCurrent ? 'Start this objective' : 'Close'}
          <Icon.Chevron size={13} />
        </Button>
      }
    >
      <div className="space-y-3">
        <div>
          <div className="mb-1.5 flex items-center gap-2">
            <p className="microlabel">What this objective asks of you</p>
            <SpeechControl speechKey={speechKey} blocks={speech.blocks} className="ml-auto" />
          </div>
          <SpokenBlocks speechKey={speechKey} blocks={speech.briefSlice} offset={speech.briefStart} />
        </div>

        <div className="rule-t pt-2.5">
          <p className="microlabel mb-1.5">
            <SpokenBlocks speechKey={speechKey} blocks={speech.leadSlice} offset={speech.leadStart} plain />
          </p>
          <ul className="space-y-1">
            {speech.blocks.slice(speech.critStart).map((block, i) => (
              <li key={task.criteria[i]} className="flex gap-2 text-[12px] leading-relaxed text-muted">
                <Icon.Check size={12} className="mt-[3px] shrink-0 text-muted" />
                <span className="min-w-0">
                  <SpokenBlocks speechKey={speechKey} blocks={[block]} offset={speech.critStart + i} plain />
                </span>
              </li>
            ))}
          </ul>
        </div>

        <p className="rule-t pt-2.5 text-[10.5px] leading-relaxed text-muted">
          The full step-by-step is in the objective rail on the left, and verification runs
          against the real cluster when you click <strong className="text-fg">Check solution</strong>.
          Reopen this briefing any time from the <Icon.Info size={11} className="inline align-[-1px]" />{' '}
          button, or by clicking this objective's number in the stepper.
        </p>
      </div>
    </Modal>
  )
}
