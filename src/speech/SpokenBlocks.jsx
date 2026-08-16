import { useEffect, useRef } from 'react'
import { Icon } from '../components/Icons.jsx'
import { useSpeech } from './SpeechProvider.jsx'
import { runSegments, wordAt, wordRanges } from './speakable.js'

/**
 * Renders speakable blocks and highlights the word being pronounced.
 *
 * The blocks carry the same runs the plain renderer draws, and a block's spoken text is
 * exactly their concatenation — so a character offset from the synthesizer maps straight
 * onto a word span here, with no fuzzy matching.
 *
 * `offset` exists because one narration can be spread across separate places on a page
 * (the lab detail page speaks its title, then its description, then its lecture notes,
 * which live in three different cards). Each region renders its own slice and says where
 * that slice starts in the whole reading.
 */

/** One run, cut at word boundaries, with the live word lit up. */
function runWords(run, base, ranges, activeWord) {
  return runSegments(run, base, ranges).map((seg, i) => (
    <span key={i} className={seg.word >= 0 && seg.word === activeWord ? 'speaking-word' : undefined}>
      {seg.text}
    </span>
  ))
}

function BlockBody({ block, charIndex, live }) {
  const ranges = wordRanges(block.text)
  const activeWord = live ? wordAt(ranges, charIndex) : -1
  const parts = []
  let base = 0
  block.runs.forEach((run, i) => {
    const words = runWords(run, base, ranges, activeWord)
    if (run.kind === 'code') {
      parts.push(
        <code key={i} className="rounded bg-surface2 px-1.5 py-0.5 font-mono text-[0.85em] text-accent">
          {words}
        </code>,
      )
    } else if (run.kind === 'bold') {
      parts.push(
        <strong key={i} className="font-semibold text-fg">
          {words}
        </strong>,
      )
    } else {
      parts.push(<span key={i}>{words}</span>)
    }
    base += run.text.length
  })
  return parts
}

export function SpokenBlocks({ speechKey, blocks, offset = 0, className = '', plain = false }) {
  const { active } = useSpeech()

  // `plain` renders the words with no block wrapper at all, for callers that already own
  // the typography around them (a criterion inside its own <li>, say).
  if (plain) {
    return blocks.map((block, i) => {
      const live = active?.key === speechKey && active.block === offset + i
      return <BlockBody key={i} block={block} charIndex={live ? active.charIndex : -1} live={live} />
    })
  }

  return (
    <div className={`space-y-2.5 ${className}`}>
      {blocks.map((block, i) => {
        const live = active?.key === speechKey && active.block === offset + i
        const charIndex = live ? active.charIndex : -1
        const body = <BlockBody block={block} charIndex={charIndex} live={live} />

        if (block.heading) {
          return (
            <h4 key={i} className="pt-1 text-sm font-semibold text-fg">
              {body}
            </h4>
          )
        }
        if (block.bullet) {
          return (
            <div key={i} className="flex gap-2 pl-1 text-sm leading-relaxed text-muted">
              <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60" />
              <span className="min-w-0">{body}</span>
            </div>
          )
        }
        return (
          <p key={i} className="text-sm leading-relaxed text-muted">
            {body}
          </p>
        )
      })}
    </div>
  )
}

/**
 * The per-region control: speak this, or mute it.
 *
 * Renders nothing at all when narration is off in settings — the settings toggle is the
 * master switch, so there is no half-state where a mute button implies sound that will
 * never come.
 */
export function SpeechControl({ speechKey, blocks, label = 'Read aloud', className = '' }) {
  const { supported, enabled, speak, stop, isSpeaking } = useSpeech()
  if (!supported || !enabled || !blocks?.length) return null

  const speaking = isSpeaking(speechKey)
  return (
    <button
      type="button"
      onClick={() => (speaking ? stop() : speak(speechKey, blocks))}
      title={speaking ? 'Mute' : label}
      aria-label={speaking ? 'Mute' : label}
      className={`flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-1 text-[10px] transition ${
        speaking ? 'text-primary' : 'text-muted hover:text-fg'
      } ${className}`}
    >
      {speaking ? <Icon.SpeakerOff size={13} /> : <Icon.Speaker size={13} />}
      {speaking ? 'Mute' : label}
    </button>
  )
}

/**
 * Speaks a target when it appears, if narration is enabled — the "it just reads it to
 * you" behaviour.
 *
 * Start and stop are one effect on purpose. Stopping in the cleanup means a closed modal
 * or a page the learner navigated away from goes quiet immediately, and it is also what
 * makes this survive StrictMode: the dev-only mount → cleanup → mount replay cancels and
 * re-speaks rather than latching a "already said this" flag that would leave the second,
 * real mount silent. `speak` itself is idempotent per key, so an extra render cannot
 * stack two voices.
 *
 * `blocks` must be memoized by the caller — a fresh array every render would restart the
 * reading every render.
 */
export function useAutoSpeak(speechKey, blocks, when = true) {
  const { supported, enabled, voicesReady, speak, stop } = useSpeech()
  const stopRef = useRef(stop)
  stopRef.current = stop

  useEffect(() => {
    if (!supported || !enabled || !voicesReady || !when || !speechKey || !blocks?.length) return
    speak(speechKey, blocks)
    return () => stopRef.current()
  }, [supported, enabled, voicesReady, when, speechKey, blocks, speak])
}
