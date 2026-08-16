import { useMemo, useState } from 'react'
import { Badge, Button, Card, Empty } from '../components/ui.jsx'
import { Icon } from '../components/Icons.jsx'
import { Markdown } from '../components/Markdown.jsx'
import { navigate } from '../lib/router.js'
import { BY_ID } from '../labs/index.js'
import { CARD_KINDS, DECKS, deckSize, getDeck } from '../cards/index.js'

/**
 * Index Cards — one question and a short answer per card, written from the same material as
 * the Command Reference and the labs' lecture notes (see CLAUDE.md, "Index card contract").
 *
 * The page is a study aid, so the default state is *unrevealed*: a card shows its question
 * and nothing else until it is clicked. That is the whole reason it is not simply another
 * view of the reference — being able to fail to answer is the point.
 *
 * Decks are per technology and the page is generic over them: a second technology is a
 * module in src/cards/ and an entry in DECKS, with nothing to change here.
 */

function KindBadge({ kind }) {
  const meta = CARD_KINDS[kind]
  if (!meta) return null
  return (
    <span
      className="microlabel shrink-0 rounded-sm border px-1.5 py-0.5"
      style={{
        color: kind === 'command' ? 'var(--primary)' : 'var(--status-warn)',
        borderColor: kind === 'command' ? 'color-mix(in oklab, var(--primary) 40%, transparent)' : 'color-mix(in oklab, var(--status-warn) 40%, transparent)',
      }}
      title={meta.hint}
    >
      {meta.label}
    </span>
  )
}

function LabChips({ labIds }) {
  if (!labIds?.length) return null
  return (
    <div className="flex flex-wrap items-center gap-1">
      {labIds.map((id) => {
        const lab = BY_ID[id]
        return (
          <button
            key={id}
            onClick={(e) => {
              e.stopPropagation()
              navigate(`lab/${id}`)
            }}
            className="data rounded-sm border px-1.5 py-0.5 text-[10px] text-muted transition hover:border-primary/50 hover:text-primary"
            title={lab ? `Go to ${lab.title}` : id}
          >
            {lab ? lab.title : id}
          </button>
        )
      })}
    </div>
  )
}

/** One card. Click anywhere to flip; `forced` lets the page reveal or hide everything. */
function IndexCard({ card, forced }) {
  const [open, setOpen] = useState(false)
  const revealed = forced === null ? open : forced

  return (
    <button
      onClick={() => setOpen((o) => (forced === null ? !o : !forced))}
      className={`panel group flex min-h-[9.5rem] w-full flex-col gap-2 p-3 text-left transition ${
        revealed ? 'border-primary/40' : 'hover:border-primary/30'
      }`}
      aria-expanded={revealed}
    >
      <div className="flex items-start justify-between gap-2">
        <KindBadge kind={card.kind} />
        <span className="microlabel shrink-0 opacity-0 transition group-hover:opacity-100">
          {revealed ? 'Hide' : 'Reveal'}
        </span>
      </div>

      <p className="text-[13px] font-medium leading-snug text-fg">{card.front}</p>

      {revealed ? (
        <div className="rule-t pt-2 text-[12px] leading-relaxed text-muted">
          <Markdown text={card.back} />
        </div>
      ) : (
        <div className="flex flex-1 items-end">
          <span className="text-[11px] italic text-muted/70">Click to reveal</span>
        </div>
      )}

      {revealed && <div className="mt-auto pt-1"><LabChips labIds={card.usedIn} /></div>}
    </button>
  )
}

function matches(card, q) {
  if (!q) return true
  return `${card.front} ${card.back} ${(card.usedIn || []).join(' ')}`.toLowerCase().includes(q)
}

function DeckIndex() {
  return (
    <div className="space-y-5 p-5">
      <Card
        title="Index Cards"
        subtitle="One question, one short answer — written from the Command Reference and the labs' lecture notes"
      >
        <p className="text-[13px] leading-relaxed text-muted">
          Pick a technology to study. Cards start face down: each shows its question until you
          click it, so you can find out what you actually know rather than what looks familiar.
        </p>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2">
        {DECKS.map((deck) => (
          <button
            key={deck.id}
            onClick={() => navigate(`cards/${deck.id}`)}
            className="panel flex flex-col gap-2 p-4 text-left transition hover:border-primary/40"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-fg">{deck.title}</span>
              <Badge tone="primary">{deckSize(deck)} cards</Badge>
            </div>
            <p className="text-xs leading-relaxed text-muted">{deck.blurb}</p>
          </button>
        ))}
      </div>
    </div>
  )
}

export function Cards({ deckId }) {
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('all')
  const [forced, setForced] = useState(null) // null = each card decides for itself
  const deck = deckId ? getDeck(deckId) : null
  const q = query.trim().toLowerCase()

  const groups = useMemo(() => {
    if (!deck) return []
    return deck.groups
      .map((g) => ({
        ...g,
        cards: g.cards.filter((c) => (kind === 'all' || c.kind === kind) && matches(c, q)),
      }))
      .filter((g) => g.cards.length > 0)
  }, [deck, q, kind])

  if (!deckId) return <DeckIndex />

  if (!deck) {
    return (
      <div className="p-5">
        <Card>
          <Empty icon={<Icon.Warn size={28} />} title="No such deck">
            There is no index card deck with the id <code className="font-mono">{deckId}</code>.
          </Empty>
          <div className="flex justify-center">
            <Button size="sm" variant="outline" onClick={() => navigate('cards')}>
              Back to decks
            </Button>
          </div>
        </Card>
      </div>
    )
  }

  const total = deckSize(deck)
  const shown = groups.reduce((n, g) => n + g.cards.length, 0)

  return (
    <div className="space-y-5 p-5">
      <button
        onClick={() => navigate('cards')}
        className="flex items-center gap-1 text-xs text-muted transition hover:text-fg"
      >
        <Icon.Chevron size={14} /> All decks
      </button>

      <Card title={deck.title} subtitle={deck.blurb}>
        <Markdown text={deck.intro} />
      </Card>

      <div className="panel flex flex-wrap items-center gap-2 p-2.5">
        <div className="relative min-w-[14rem] flex-1">
          <Icon.Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search questions and answers…"
            className="w-full rounded-sm border bg-surface2 py-1.5 pl-7 pr-2 text-xs outline-none transition focus:border-primary/50"
          />
        </div>

        <div className="flex items-center gap-1">
          {['all', 'command', 'lecture'].map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              title={k === 'all' ? 'Both kinds' : CARD_KINDS[k].hint}
              className={`rounded-sm border px-2 py-1 text-[11px] transition ${
                kind === k ? 'border-primary/60 bg-primary/10 text-primary' : 'text-muted hover:text-fg'
              }`}
            >
              {k === 'all' ? 'All' : CARD_KINDS[k].label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1">
          <Button size="sm" variant="outline" onClick={() => setForced(forced === true ? null : true)}>
            <Icon.Eye size={12} /> {forced === true ? 'Cards decide' : 'Reveal all'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setForced(false)}>
            <Icon.Refresh size={12} /> Reset
          </Button>
        </div>

        <span className="tnum ml-auto text-[11px] text-muted">
          {shown === total ? `${total} cards` : `${shown} of ${total}`}
        </span>
      </div>

      {groups.length === 0 ? (
        <Card>
          <Empty icon={<Icon.Search size={28} />} title="Nothing matches">
            No card matches that filter.
          </Empty>
        </Card>
      ) : (
        groups.map((group) => (
          <section key={group.id} className="space-y-2.5">
            <div>
              <h3 className="text-sm font-semibold text-fg">{group.title}</h3>
              {group.blurb && <p className="text-xs text-muted">{group.blurb}</p>}
            </div>
            <div className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-3">
              {group.cards.map((card) => (
                <IndexCard key={card.id} card={card} forced={forced} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  )
}
