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
