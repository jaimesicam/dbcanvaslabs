// Leitner review state for the index cards.
//
// Persisted to localStorage and keyed by user id, exactly like attempts in
// store/progress.js — this is the same courseware mock, so a learner's review history lives
// in their browser and nowhere else.
//
// The scheduler is deliberately Leitner rather than SM-2. Five boxes, one interval each: a
// card you answer moves up a box and waits longer; a card you miss drops straight back to
// box 1 and is due again immediately. That is a sentence a learner can read on the page and
// predict, which matters more here than the extra accuracy of a real spaced-repetition
// curve — this deck is 224 cards of operational detail, not a language course.

const KEY = 'dbcanvas_labs_cards'
const DAY = 86400e3

export const MAX_BOX = 5

/** How long a card waits after landing in each box. Box 1 is "again today". */
export const BOX_DAYS = { 1: 0, 2: 1, 3: 3, 4: 7, 5: 16 }

/** How a card's box reads on screen. Colour here is genuine state, not decoration. */
export const STATE_META = {
  new: { label: 'New', hint: 'Not studied yet', color: 'var(--muted)', filled: false },
  learning: { label: 'Learning', hint: 'Answered, but not reliably yet', color: 'var(--status-warn)', filled: true },
  known: { label: 'Known', hint: 'Answered correctly enough to wait a week or more', color: 'var(--status-ok)', filled: true },
}

function readAll() {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function writeAll(all) {
  try {
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    /* private mode — the session still works, it just will not be remembered */
  }
}

/** One user's whole review map: `{ [cardId]: {box, dueAt, right, wrong, lastAt} }`. */
export function loadReview(userId) {
  return readAll()[userId] ?? {}
}

/**
 * Record an answer and return the user's updated review map.
 *
 * Returns a new object rather than mutating, so callers can hold it in React state and get a
 * re-render for free.
 */
export function gradeCard(userId, cardId, got, now = Date.now()) {
  const all = readAll()
  const mine = { ...(all[userId] ?? {}) }
  const prev = mine[cardId]
  // An unstudied card is already in box 1 — that is what "due now, waits nothing" means — so
  // its first correct answer promotes it to box 2. Counting a missing entry as box 0 would
  // land it back in box 1 with a zero-day wait and it would never start climbing.
  const box = got ? Math.min(MAX_BOX, (prev?.box ?? 1) + 1) : 1

  mine[cardId] = {
    box,
    dueAt: now + BOX_DAYS[box] * DAY,
    right: (prev?.right ?? 0) + (got ? 1 : 0),
    wrong: (prev?.wrong ?? 0) + (got ? 0 : 1),
    lastAt: now,
  }

  all[userId] = mine
  writeAll(all)
  return mine
}

/** Drop review history for these cards — the page's "start this deck over". */
export function forgetCards(userId, cardIds) {
  const all = readAll()
  const mine = { ...(all[userId] ?? {}) }
  for (const id of cardIds) delete mine[id]
  all[userId] = mine
  writeAll(all)
  return mine
}

export function cardState(entry) {
  if (!entry) return 'new'
  return entry.box >= 4 ? 'known' : 'learning'
}

/** A card is due when it has never been studied, or its wait has elapsed. */
export function isDue(entry, now = Date.now()) {
  return !entry || entry.dueAt <= now
}

export function dueCards(cards, review, now = Date.now()) {
  return cards.filter((c) => isDue(review[c.id], now))
}

export function statsFor(cards, review, now = Date.now()) {
  const s = { total: cards.length, new: 0, learning: 0, known: 0, due: 0 }
  for (const c of cards) {
    const entry = review[c.id]
    s[cardState(entry)] += 1
    if (isDue(entry, now)) s.due += 1
  }
  return s
}

/** Fisher-Yates. A session must shuffle: cards are authored in topic order, so neighbours
 *  give each other away — you half-answer one because the card before it set it up. */
export function shuffle(list) {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}
