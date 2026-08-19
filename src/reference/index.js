import { cnpgReference } from './cnpg.js'

/**
 * Command references, one per technology. Same shape as labs/index.js: pure content here,
 * rendering in pages/Reference.jsx.
 */
export const REFERENCES = [cnpgReference]

const BY_ID = Object.fromEntries(REFERENCES.map((r) => [r.id, r]))

export function getReference(id) {
  return BY_ID[id] ?? null
}

/** Every command entry across every reference, flattened — used to cross-check that the
 *  labs and the reference have not drifted apart. */
export function allCommands() {
  return REFERENCES.flatMap((r) => r.groups.flatMap((g) => g.commands.map((c) => ({ ...c, refId: r.id, groupId: g.id }))))
}

/**
 * Every command entry that names this lab in `usedIn`, with the reference it belongs to.
 *
 * The same authored relationship the index cards use: a card and a command entry that cite
 * the same lab are about the same material, which is a link nothing has to guess at.
 */
export function commandsForLab(labId) {
  return REFERENCES.flatMap((r) =>
    r.groups.flatMap((g) => g.commands.filter((c) => (c.usedIn || []).includes(labId)).map((c) => ({ ...c, refId: r.id, groupId: g.id }))),
  )
}
