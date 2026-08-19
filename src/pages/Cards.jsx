import { useEffect, useMemo, useState } from 'react'
import { Badge, Button, Card, ConfirmButton, Empty, useCopy } from '../components/ui.jsx'
import { Icon } from '../components/Icons.jsx'
import { Markdown } from '../components/Markdown.jsx'
import { navigate } from '../lib/router.js'
import { useAuth } from '../auth/AuthProvider.jsx'
import { BY_ID } from '../labs/index.js'
import { CARD_KINDS, DECKS, deckSize, findCard, getDeck } from '../cards/index.js'
import { FrontText, KindBadge, LabChips, StateDot, StateSwatch } from '../cards/CardParts.jsx'
import { StudySession } from '../cards/StudySession.jsx'
import { STATE_META, dueCards, forgetCards, gradeCard, loadReview, shuffle, statsFor } from '../cards/review.js'

/**
 * Index Cards — one question and a short answer per card, written from the same material as
 * the Command Reference and the labs' lecture notes (see CLAUDE.md, "Index card contract").
 *
 * The page has two halves. **Browsing** is a grid of face-down cards you can search and turn
 * over one at a time; it answers "what is in here". **Studying** hands you one card at a time
 * with nothing else on screen and asks you to commit before revealing (StudySession.jsx); it
 * answers "what do I actually know". Review state is Leitner boxes in localStorage
 * (review.js), so the second half remembers what the first half cannot.
 *
 * Two structural rules follow from the deck being large (224 cards across 15 groups):
 *
 * - **Groups start collapsed**, so the deck opens as an index of its subjects rather than a
 *   single unreadable scroll. Searching or filtering opens the groups that still have
 *   matches, and clearing the filter returns to the index.
 * - **Revealing never moves anything.** The answer is drawn over the card's own box rather
 *   than growing it, because in a grid a card that grows pushes every card below it — the
 *   one you were about to read included.
 *
 * Decks are per technology and the page is generic over them: a second technology is a
 * module in src/cards/ and an entry in DECKS, with nothing to change here.
 */

/** One sitting. Long enough to be worth doing, short enough to finish — 224 due cards in a
 *  single run is a chore, and a chore gets abandoned halfway. */
const SESSION_SIZE = 20

/* ------------------------------------------------------------------- searching */

/**
 * Which part of a card a query matched, or null for no match. The distinction matters on
 * screen: a card can match on text the learner cannot see, and a hit whose reason is
 * invisible reads as a bug.
 */
function matchOf(card, q) {
  if (!q) return 'none'
  if (card.front.toLowerCase().includes(q)) return 'front'
  if (card.back.toLowerCase().includes(q)) return 'back'
  const inLab = (card.usedIn || []).some(
    (id) => id.toLowerCase().includes(q) || (BY_ID[id]?.title || '').toLowerCase().includes(q),
  )
  return inLab ? 'lab' : null
}

/* ----------------------------------------------------------------------- card */

/**
 * One card, with two faces in the same box. The front is a single button — the whole
 * question is the control that turns it over. The back is drawn over it, so the card never
 * changes size and the grid never reflows, and it repeats the question quietly above the
 * answer, because checking yourself needs both at once.
 */
function IndexCard({ card, revealed, onToggle, q, matchedOn, entry, now, deckId, linked }) {
  const [copied, copy] = useCopy()
  return (
    <div
      id={`card-${card.id}`}
      className={`panel relative flex min-h-[12rem] scroll-mt-28 flex-col ${
        linked ? 'border-primary' : ''
      }`}
    >
      <button
        onClick={onToggle}
        aria-hidden={revealed}
        className={`flex flex-1 flex-col gap-2 p-3 text-left transition ${
          revealed ? 'invisible' : 'hover:bg-surface2/40'
        }`}
      >
        <div className="flex items-start justify-between gap-2">
          <span className="flex items-center gap-1.5">
            <StateDot entry={entry} now={now} />
            <KindBadge kind={card.kind} />
          </span>
          {matchedOn === 'back' && (
            <span className="microlabel shrink-0 text-muted" title="Your search matched this card's answer">
              matches the answer
            </span>
          )}
          {matchedOn === 'lab' && (
            <span className="microlabel shrink-0 text-muted" title="Your search matched a lab this card came from">
              matches a lab
            </span>
          )}
        </div>

        <p className="text-[13px] font-medium leading-snug text-fg">
          <FrontText text={card.front} q={q} />
        </p>

        <span className="mt-auto flex items-center gap-1 text-[11px] text-muted">
          <Icon.Eye size={12} /> Reveal answer
        </span>
      </button>

      {revealed && (
        <div className="absolute inset-0 flex flex-col gap-2 border border-primary/40 bg-surface p-3">
          <div className="flex items-start justify-between gap-2">
            <KindBadge kind={card.kind} />
            <span className="flex shrink-0 items-center gap-2">
              <button
                onClick={() => copy(`${location.origin}${location.pathname}#/cards/${deckId}/card/${card.id}`)}
                title="Copy a link straight to this card"
                className="flex items-center gap-1 text-[11px] text-muted transition hover:text-fg"
              >
                {copied ? <Icon.Check size={11} /> : <Icon.Copy size={11} />}
                {copied ? 'Copied' : 'Link'}
              </button>
              <button
                onClick={onToggle}
                className="flex items-center gap-1 text-[11px] text-muted transition hover:text-fg"
              >
                <Icon.X size={11} /> Hide
              </button>
            </span>
          </div>

          <p className="line-clamp-2 text-[11px] leading-snug text-muted">
            <FrontText text={card.front} />
          </p>

          <div className="min-h-0 flex-1 overflow-y-auto rule-t pt-2 text-[12px] leading-relaxed text-fg">
            <Markdown text={card.back} />
          </div>

          <LabChips labIds={card.usedIn} withReference />
        </div>
      )}
    </div>
  )
}

/* ---------------------------------------------------------------------- groups */

function GroupSection({ group, open, onToggle, revealed, onReveal, onStudy, q, review, now, deckId, linkedCard }) {
  const cards = group.cards.map((c) => c.card)
  const due = dueCards(cards, review, now).length

  return (
    <section id={`group-${group.id}`} className="scroll-mt-28">
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 text-sm font-semibold">
          <button
            onClick={onToggle}
            className="flex w-full items-center gap-2 py-1.5 text-left text-fg transition hover:text-primary"
            aria-expanded={open}
          >
            <Icon.Chevron size={14} className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
            {group.title}
            <span className="tnum text-xs font-normal text-muted">({group.cards.length})</span>
            {group.blurb && <span className="truncate text-xs font-normal text-muted">— {group.blurb}</span>}
          </button>
        </h3>
        {due > 0 && (
          <Button
            size="xs"
            variant="outline"
            onClick={() => onStudy(cards, group.title)}
            title={`Study the ${due} card${due === 1 ? '' : 's'} due in this group`}
          >
            <Icon.Bulb size={12} /> Study <span className="tnum text-muted">{due}</span>
          </Button>
        )}
      </div>

      {open && (
        <div className="mt-1 grid gap-2.5 md:grid-cols-2 xl:grid-cols-3">
          {group.cards.map(({ card, matchedOn }) => (
            <IndexCard
              key={card.id}
              card={card}
              q={q}
              matchedOn={matchedOn}
              entry={review[card.id]}
              now={now}
              deckId={deckId}
              linked={linkedCard === card.id}
              revealed={revealed.has(card.id)}
              onToggle={() => onReveal(card.id)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------ deck index */

function DeckIndex({ review, now }) {
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
        {DECKS.map((deck) => {
          const s = statsFor(deck.groups.flatMap((g) => g.cards), review, now)
          return (
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
              <p className="tnum text-[11px] text-muted">
                {s.due} due · {s.known} known · {s.learning} learning
              </p>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------ page */

/** The deck's resting state: an index, with its first group open so the page shows what a
 *  card is rather than only listing subjects. */
function restingGroups(deck) {
  return new Set(deck?.groups.length ? [deck.groups[0].id] : [])
}

/**
 * `#/cards/<deck>` browses, and two suffixes address the deck from elsewhere in the app:
 * `…/lab/<labId>` opens straight into a session on that lab's cards, and `…/card/<cardId>`
 * opens the deck with one card revealed and scrolled to. Both are built on `usedIn` and card
 * ids, which are authored and checked — nothing here has to guess at a relationship.
 */
function parsePath(path) {
  const [deckId, mode, arg] = String(path || '').split('/')
  return { deckId: deckId || null, mode: mode || null, arg: arg || null }
}

export function Cards({ path }) {
  const { user } = useAuth()
  const { deckId, mode, arg } = parsePath(path)
  const deck = deckId ? getDeck(deckId) : null

  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('all')
  const [revealed, setRevealed] = useState(() => new Set())
  const [openGroups, setOpenGroups] = useState(() => restingGroups(deck))
  const [review, setReview] = useState(() => loadReview(user.id))
  const [session, setSession] = useState(null)

  const q = query.trim().toLowerCase()
  const filtering = q !== '' || kind !== 'all'
  const now = Date.now()

  /** Groups that still have cards, each card carrying why it matched. */
  const groups = useMemo(() => {
    if (!deck) return []
    return deck.groups
      .map((g) => ({
        ...g,
        cards: g.cards
          .filter((c) => kind === 'all' || c.kind === kind)
          .map((card) => ({ card, matchedOn: matchOf(card, q) }))
          .filter((c) => c.matchedOn !== null),
      }))
      .filter((g) => g.cards.length > 0)
  }, [deck, q, kind])

  // Counted against the search but not against the kind filter, so the chips answer
  // "how many of each kind match what I typed" rather than restating their own state.
  const kindCounts = useMemo(() => {
    const hits = deck ? deck.groups.flatMap((g) => g.cards).filter((c) => matchOf(c, q) !== null) : []
    return {
      all: hits.length,
      command: hits.filter((c) => c.kind === 'command').length,
      lecture: hits.filter((c) => c.kind === 'lecture').length,
    }
  }, [deck, q])

  // Searching opens the groups that still match, so results are visible without hunting;
  // clearing the search returns the page to its index. Manual toggles survive until the
  // filter changes again.
  useEffect(() => {
    setOpenGroups(filtering ? new Set(groups.map((g) => g.id)) : restingGroups(deck))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, kind, deckId])

  /** Start a sitting on these cards: everything due, or the cards themselves when nothing is
   *  due yet, capped at one session. Shuffled *before* the cap, or a deck-wide session would
   *  be the first twenty cards in authored order every time — the whole survey group, and
   *  never the backup one. */
  const openSession = (cards, scope) => {
    const pool = dueCards(cards, review, now)
    setSession({
      cards: shuffle(pool.length ? pool : cards).slice(0, SESSION_SIZE),
      label: scope,
      // Remounts StudySession, so a second sitting started from the summary screen begins
      // clean rather than resuming the finished one.
      key: `${scope}:${Date.now()}`,
    })
  }

  // `…/lab/<labId>` — arriving from a lab's detail page or its debrief, already studying.
  // Leaving the session navigates back to the plain deck, so exiting cannot re-trigger this.
  useEffect(() => {
    if (mode !== 'lab' || !arg || !deck) return
    const forLab = deck.groups.flatMap((g) => g.cards).filter((c) => (c.usedIn || []).includes(arg))
    if (forLab.length) openSession(forLab, `${deck.title} · ${BY_ID[arg]?.title || arg}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, arg, deckId])

  // `…/card/<cardId>` — a link to one card. Open its group, turn it over, put it on screen.
  useEffect(() => {
    if (mode !== 'card' || !arg) return
    const found = findCard(arg)
    if (!found || found.deck.id !== deckId) return
    setOpenGroups((prev) => new Set(prev).add(found.group.id))
    setRevealed((prev) => new Set(prev).add(arg))
    requestAnimationFrame(() => document.getElementById(`card-${arg}`)?.scrollIntoView({ block: 'center' }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, arg, deckId])

  if (!deckId) return <DeckIndex review={review} now={now} />

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

  const allCards = deck.groups.flatMap((g) => g.cards)
  const total = allCards.length
  const visible = groups.flatMap((g) => g.cards.map((c) => c.card))
  const shown = visible.length
  const revealedHere = visible.filter((c) => revealed.has(c.id)).length
  const stats = statsFor(visible, review, now)

  if (session) {
    return (
      <StudySession
        key={session.key}
        label={session.label}
        cards={session.cards}
        onGrade={(cardId, got) => setReview(gradeCard(user.id, cardId, got))}
        onExit={() => {
          setSession(null)
          if (mode) navigate(`cards/${deckId}`)
        }}
        onStudy={(cards, scope) => setSession({ cards, label: scope, key: `${scope}:${Date.now()}` })}
      />
    )
  }

  const scopeLabel = [deck.title, query && `“${query}”`, kind !== 'all' && CARD_KINDS[kind].label]
    .filter(Boolean)
    .join(' · ')

  const toggleCard = (id) =>
    setRevealed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const toggleGroup = (id) =>
    setOpenGroups((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const jumpTo = (id) => {
    setOpenGroups((prev) => new Set(prev).add(id))
    requestAnimationFrame(() => document.getElementById(`group-${id}`)?.scrollIntoView({ block: 'start' }))
  }

  const allOpen = groups.length > 0 && groups.every((g) => openGroups.has(g.id))
  const sessionSize = Math.min(SESSION_SIZE, stats.due || shown)

  return (
    <div className="space-y-4 p-5">
      <button
        onClick={() => navigate('cards')}
        className="flex items-center gap-1 text-xs text-muted transition hover:text-fg"
      >
        <Icon.Chevron size={14} /> All decks
      </button>

      <Card title={deck.title} subtitle={deck.blurb}>
        <Markdown text={deck.intro} />
      </Card>

      {/* Where you are in the deck, and the way in. Studying is the point of the page, so it
          gets the only primary button on it. */}
      <div className="panel flex flex-wrap items-center gap-x-5 gap-y-3 p-3">
        <div className="flex items-center gap-4">
          {['new', 'learning', 'known'].map((state) => (
            <span key={state} className="flex items-center gap-1.5" title={STATE_META[state].hint}>
              <StateSwatch state={state} />
              <span className="tnum text-[12px] font-semibold">{stats[state]}</span>
              <span className="microlabel">{STATE_META[state].label}</span>
            </span>
          ))}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className="tnum text-[11px] text-muted">
            {stats.due} due{filtering ? ' here' : ''}
          </span>
          <Button size="sm" onClick={() => openSession(visible, scopeLabel)} disabled={shown === 0}>
            <Icon.Bulb size={14} />
            {stats.due > 0 ? `Study ${sessionSize} due` : `Study ${sessionSize} anyway`}
          </Button>
          {/* Only offered once there is something to lose — on a deck nobody has studied it
              would be a destructive-looking button that does nothing. */}
          {stats.new < stats.total && (
            <ConfirmButton
              size="sm"
              variant="ghost"
              confirmLabel="Erase progress?"
              onConfirm={() => setReview(forgetCards(user.id, allCards.map((c) => c.id)))}
              title="Forget every box and due date in this deck"
            >
              Reset progress
            </ConfirmButton>
          )}
        </div>
      </div>

      {/* Filters and the group jump bar stay put: at 224 cards the search box is otherwise
          several screens above whatever you are reading. */}
      <div className="sticky top-0 z-20 -mx-5 space-y-2 border-b bg-bg px-5 pb-2 pt-2">
        <div className="panel flex flex-wrap items-center gap-2 p-2.5">
          <div className="relative min-w-[14rem] flex-1">
            <Icon.Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search questions, answers and labs…"
              className="w-full rounded-sm border bg-surface2 py-1.5 pl-7 pr-7 text-xs outline-none transition focus:border-primary/50"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted transition hover:text-fg"
                aria-label="Clear search"
              >
                <Icon.X size={12} />
              </button>
            )}
          </div>

          <div className="flex items-center gap-1">
            {['all', 'command', 'lecture'].map((k) => (
              <button
                key={k}
                onClick={() => setKind(k)}
                title={k === 'all' ? 'Both kinds' : CARD_KINDS[k].hint}
                className={`tnum rounded-sm border px-2 py-1 text-[11px] transition ${
                  kind === k ? 'border-primary/60 bg-primary/10 text-primary' : 'text-muted hover:text-fg'
                }`}
              >
                {k === 'all' ? 'All' : CARD_KINDS[k].label} <span className="opacity-70">{kindCounts[k]}</span>
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setOpenGroups(allOpen ? new Set() : new Set(groups.map((g) => g.id)))}
              title={allOpen ? 'Collapse every group' : 'Expand every group'}
            >
              {allOpen ? <Icon.Collapse size={12} /> : <Icon.Expand size={12} />}
              {allOpen ? 'Collapse' : 'Expand'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setRevealed((prev) => new Set([...prev, ...visible.map((c) => c.id)]))}
              disabled={shown === 0 || revealedHere === shown}
              title="Turn over every card currently listed"
            >
              <Icon.Eye size={12} /> Reveal all
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setRevealed(new Set())}
              disabled={revealed.size === 0}
              title="Turn every card back face down"
            >
              <Icon.Refresh size={12} /> Hide all
            </Button>
          </div>

          <span className="tnum ml-auto text-[11px] text-muted">
            {shown === total ? `${total} cards` : `${shown} of ${total}`}
            {revealedHere > 0 && ` · ${revealedHere} revealed`}
          </span>
        </div>

        {groups.length > 0 && (
          <div className="flex gap-1 overflow-x-auto pb-0.5">
            {groups.map((g) => (
              <button
                key={g.id}
                onClick={() => jumpTo(g.id)}
                className={`tnum shrink-0 rounded-sm border px-2 py-1 text-[11px] transition ${
                  openGroups.has(g.id)
                    ? 'border-primary/40 text-fg'
                    : 'border-border text-muted hover:border-primary/40 hover:text-fg'
                }`}
                title={g.blurb}
              >
                {g.title} <span className="opacity-60">{g.cards.length}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {groups.length === 0 ? (
        <Card>
          <Empty icon={<Icon.Search size={28} />} title="Nothing matches">
            No card matches that filter.
          </Empty>
        </Card>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => (
            <GroupSection
              key={group.id}
              group={group}
              q={q}
              review={review}
              now={now}
              deckId={deckId}
              linkedCard={mode === 'card' ? arg : null}
              open={openGroups.has(group.id)}
              onToggle={() => toggleGroup(group.id)}
              onStudy={(cards, scope) => openSession(cards, `${deck.title} · ${scope}`)}
              revealed={revealed}
              onReveal={toggleCard}
            />
          ))}
        </div>
      )}
    </div>
  )
}
