import { cnpgCards } from './cnpg.js'

/**
 * Index card decks, one per technology — the same shape as reference/index.js and
 * labs/index.js: pure content in the deck modules, rendering in pages/Cards.jsx.
 *
 * CloudNativePG is the only deck today. A second technology adds its module here and
 * nothing else changes: the page lists whatever DECKS contains and routes to `#/cards/<id>`.
 */
export const DECKS = [cnpgCards]

const BY_ID = Object.fromEntries(DECKS.map((d) => [d.id, d]))

export function getDeck(id) {
  return BY_ID[id] ?? null
}

/** The two halves of the material a deck is written from. */
export const CARD_KINDS = {
  command: { label: 'Command', hint: 'From the Command Reference — what to type, and what comes back' },
  lecture: { label: 'Lecture', hint: "From the labs' lecture notes — why the system behaves as it does" },
}

/** Every card across every deck, flattened, each carrying its deck and group id. Used to
 *  cross-check that the decks have not drifted from the labs they cite. */
export function allCards() {
  return DECKS.flatMap((d) => d.groups.flatMap((g) => g.cards.map((c) => ({ ...c, deckId: d.id, groupId: g.id }))))
}

export function deckSize(deck) {
  return deck.groups.reduce((n, g) => n + g.cards.length, 0)
}

/**
 * Every card that names this lab in `usedIn`, with the deck it belongs to.
 *
 * `usedIn` is authored per card and checked against `catalog.json`, which makes it the one
 * relationship between a card and the rest of the app that is known to be right — so it is
 * what the cross-links are built on, here and in reference/index.js.
 */
export function cardsForLab(labId) {
  return DECKS.flatMap((d) =>
    d.groups.flatMap((g) => g.cards.filter((c) => (c.usedIn || []).includes(labId)).map((c) => ({ ...c, deckId: d.id, groupId: g.id }))),
  )
}

/** The deck and group a card id belongs to — what a link to a single card resolves against. */
export function findCard(cardId) {
  for (const deck of DECKS) {
    for (const group of deck.groups) {
      const card = group.cards.find((c) => c.id === cardId)
      if (card) return { card, deck, group }
    }
  }
  return null
}
