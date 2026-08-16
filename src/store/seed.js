import { PLAYABLE } from '../labs/index.js'
import { TASK_STATUS, loadAttempts, saveAttempts, taskPoints } from './progress.js'

// Seeds a small cohort with plausible history so the gradebook and progress views
// have something real to show on a first run.

// Deliberately impersonal: these are fixtures in a public repository, not people. The
// `learner` account keeps its documented name and password because README.md and the login
// screen's demo buttons both point at it; the numbering carries on from there. The last one
// is `pending` on purpose, so the account-approval flow has something to act on.
export const SEED_USERS = [
  { id: 1, username: 'instructor', name: 'Instructor', role: 'instructor', status: 'approved', password: 'instructor', createdAt: '2026-07-02T09:00:00Z' },
  { id: 2, username: 'learner', name: 'Learner One', role: 'learner', status: 'approved', password: 'learner1', createdAt: '2026-07-14T09:00:00Z' },
  { id: 3, username: 'learner2', name: 'Learner Two', role: 'learner', status: 'approved', password: 'learner1', createdAt: '2026-07-15T11:20:00Z' },
  { id: 4, username: 'learner3', name: 'Learner Three', role: 'learner', status: 'approved', password: 'learner1', createdAt: '2026-07-19T14:05:00Z' },
  { id: 5, username: 'learner4', name: 'Learner Four', role: 'learner', status: 'approved', password: 'learner1', createdAt: '2026-08-01T08:40:00Z' },
  { id: 6, username: 'learner5', name: 'Learner Five', role: 'learner', status: 'pending', password: 'learner1', createdAt: '2026-08-12T16:30:00Z' },
]

/**
 * A deterministic history: later tasks are progressively harder, so timeouts and
 * hint use cluster toward the end of each lab — which is what makes the gradebook's
 * per-task heat grid say something useful.
 */
const PLAN = [
  { userId: 2, labId: 'cnpg-operator-install', daysAgo: 6, upTo: 4, hints: [3], late: [4], timeouts: [] },
  { userId: 2, labId: 'cnpg-persistent-volume', daysAgo: 3, upTo: 3, hints: [2], late: [], timeouts: [] },
  { userId: 3, labId: 'cnpg-operator-install', daysAgo: 5, upTo: 4, hints: [], late: [], timeouts: [] },
  { userId: 3, labId: 'cnpg-cluster-creation', daysAgo: 2, upTo: 2, hints: [2], late: [2], timeouts: [3] },
  { userId: 4, labId: 'cnpg-operator-install', daysAgo: 4, upTo: 3, hints: [2, 3], late: [3], timeouts: [] },
  { userId: 4, labId: 'cnpg-cluster-creation', daysAgo: 1, upTo: 2, hints: [2], late: [2], timeouts: [] },
  { userId: 5, labId: 'cnpg-persistent-volume', daysAgo: 2, upTo: 4, hints: [3, 4], late: [4], timeouts: [] },
  { userId: 5, labId: 'cnpg-operator-install', daysAgo: 1, upTo: 3, hints: [4], late: [], timeouts: [4] },
]

function buildAttempt(plan, i) {
  const lab = PLAYABLE[plan.labId]
  if (!lab) return null
  const started = Date.now() - plan.daysAgo * 86400e3
  const tasks = []
  let cursor = started

  lab.tasks.slice(0, plan.upTo).forEach((t, idx) => {
    const n = idx + 1
    const timedOut = plan.timeouts.includes(n)
    const late = plan.late.includes(n)
    const hintUsed = plan.hints.includes(n)
    const limitMs = t.limitSec * 1000
    const spent = timedOut
      ? limitMs
      : late
        ? Math.round(limitMs * (1.1 + (idx % 3) * 0.12))
        : Math.round(limitMs * (0.4 + (idx % 4) * 0.12))
    const task = {
      taskId: t.id,
      status: timedOut ? TASK_STATUS.timeout : late ? TASK_STATUS.late : TASK_STATUS.passed,
      timeSpentMs: spent,
      hintUsed,
      solutionUsed: false,
      checkCount: timedOut ? 4 : hintUsed ? 3 : 1 + (idx % 2),
      startedAt: new Date(cursor).toISOString(),
    }
    task.points = taskPoints(task)
    tasks.push(task)
    cursor += spent + 20000
  })

  const complete = plan.upTo >= lab.tasks.length && !tasks.some((t) => t.status === TASK_STATUS.timeout)
  return {
    id: `seed_${i}`,
    userId: plan.userId,
    labId: plan.labId,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(cursor).toISOString(),
    completed: complete,
    seeded: true,
    tasks,
  }
}

export function seedAttemptsIfEmpty() {
  if (loadAttempts().length) return
  const list = PLAN.map(buildAttempt).filter(Boolean)
  // Newest first, matching how the UI reads them.
  list.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
  saveAttempts(list)
}
