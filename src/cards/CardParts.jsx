import { Icon } from '../components/Icons.jsx'
import { parseInline } from '../components/Markdown.jsx'
import { navigate } from '../lib/router.js'
import { BY_ID } from '../labs/index.js'
import { commandsForLab } from '../reference/index.js'
import { CARD_KINDS } from './index.js'
import { STATE_META, cardState, isDue } from './review.js'

/**
 * The pieces a card is drawn from, shared by the browse grid (pages/Cards.jsx) and the study
 * session (StudySession.jsx) so a card looks the same wherever it is shown.
 */

/**
 * Which half of the material a card came from. Deliberately monochrome: on this page colour
 * carries review state (see StateDot), and spending it on a taxonomy as well would leave two
 * unrelated colour languages on the same card.
 */
export function KindBadge({ kind }) {
  const meta = CARD_KINDS[kind]
  if (!meta) return null
  return (
    <span className="microlabel shrink-0 rounded-sm border border-border px-1.5 py-0.5 text-muted" title={meta.hint}>
      {meta.label}
    </span>
  )
}

/** The mark for one review state — filled for a card with history, hollow for an untouched one. */
export function StateSwatch({ state }) {
  const meta = STATE_META[state]
  return (
    <span
      className="block h-2 w-2 shrink-0 rounded-full"
      style={{ background: meta.filled ? meta.color : 'transparent', border: `1px solid ${meta.color}` }}
    />
  )
}

/** Where this card sits in the Leitner boxes: new, learning, or known — plus whether it is due. */
export function StateDot({ entry, now }) {
  const state = cardState(entry)
  const meta = STATE_META[state]
  const due = isDue(entry, now)
  return (
    <span
      className="flex shrink-0 items-center gap-1"
      title={due && state !== 'new' ? `${meta.label} · due now` : `${meta.label} — ${meta.hint}`}
    >
      <StateSwatch state={state} />
      {due && state !== 'new' && <span className="microlabel text-muted">due</span>}
    </span>
  )
}

const HIT_STYLE = {
  background: 'color-mix(in srgb, var(--status-warn) 30%, transparent)',
  color: 'var(--fg)',
  borderRadius: '2px',
}

/** Plain text with every occurrence of `q` marked. */
export function Highlight({ text, q }) {
  if (!q) return text
  const parts = []
  const lower = text.toLowerCase()
  let from = 0
  for (;;) {
    const at = lower.indexOf(q, from)
    if (at < 0) break
    if (at > from) parts.push(text.slice(from, at))
    parts.push(
      <span key={at} style={HIT_STYLE}>
        {text.slice(at, at + q.length)}
      </span>,
    )
    from = at + q.length
  }
  if (from < text.length) parts.push(text.slice(from))
  return parts
}

/**
 * A card's question. Uses Markdown's own inline decomposition so `code` and **bold** read the
 * same here as they do in the answer — but renders code as plain `<code>`, never as
 * Markdown's copy button, because the question sits inside the button that reveals the card
 * and a button cannot contain another one.
 */
export function FrontText({ text, q = '' }) {
  return parseInline(text).map((run, i) => {
    if (run.kind === 'code') {
      return (
        <code key={i} className="rounded bg-surface2 px-1 py-0.5 font-mono text-[0.85em] text-accent">
          {run.text}
        </code>
      )
    }
    if (run.kind === 'bold') {
      return (
        <strong key={i} className="font-semibold">
          <Highlight text={run.text} q={q} />
        </strong>
      )
    }
    return <Highlight key={i} text={run.text} q={q} />
  })
}

/**
 * The labs a card came from — what turns a card you cannot answer into the lab that teaches it.
 *
 * With `withReference`, a card that cites exactly one lab also gets a link to that lab's
 * commands in the Command Reference: the fuller treatment of the same material, with the real
 * output a card has no room for. Only for single-lab cards, because with two the link would
 * have to pick one of them, and a link that quietly picks is worse than one more click through
 * the lab chip.
 */
export function LabChips({ labIds, withReference = false }) {
  if (!labIds?.length) return null
  const only = labIds.length === 1 ? labIds[0] : null
  const commands = only && withReference ? commandsForLab(only) : []

  return (
    <div className="flex flex-wrap items-center gap-1">
      {labIds.map((id) => {
        const lab = BY_ID[id]
        return (
          <button
            key={id}
            onClick={() => navigate(`lab/${id}`)}
            className="data rounded-sm border px-1.5 py-0.5 text-[10px] text-muted transition hover:border-primary/50 hover:text-primary"
            title={lab ? `Go to ${lab.title}` : id}
          >
            {lab ? lab.title : id}
          </button>
        )
      })}
      {commands.length > 0 && (
        <button
          onClick={() => navigate(`reference/${commands[0].refId}/lab/${only}`)}
          className="data flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10px] text-muted transition hover:border-primary/50 hover:text-primary"
          title={`The ${commands.length} commands from this lab, with their real output`}
        >
          <Icon.Book size={10} /> {commands.length} commands
        </button>
      )}
    </div>
  )
}
