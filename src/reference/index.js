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
