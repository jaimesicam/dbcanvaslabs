// Attempt records and scoring. Persisted to localStorage — this is a mock, so there
// is no server and no real credential handling anywhere in this app.

const ATTEMPTS_KEY = 'dbcanvas_labs_attempts'

export const SCORE = {
  onTime: 100,
  late: 60,
  hintPenalty: 15,
  solutionForfeit: 0,
  timeout: 0,
}

export const TASK_STATUS = {
  pending: 'pending',
  active: 'active',
  passed: 'passed',
  late: 'late',
  timeout: 'timeout',
}

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* private mode — attempts simply won't persist */
  }
}

export function loadAttempts() {
  return read(ATTEMPTS_KEY, [])
}

export function saveAttempts(list) {
  write(ATTEMPTS_KEY, list)
}

export function upsertAttempt(attempt) {
  const list = loadAttempts()
  const i = list.findIndex((a) => a.id === attempt.id)
  if (i >= 0) list[i] = attempt
  else list.unshift(attempt)
  saveAttempts(list)
  return attempt
}

let counter = 0
export function newAttemptId() {
  counter += 1
  return `at_${Date.now().toString(36)}_${counter}`
}

/** Points for one finished task, given how it went. */
export function taskPoints(task) {
  if (task.status === TASK_STATUS.timeout) return SCORE.timeout
  if (task.solutionUsed) return SCORE.solutionForfeit
  const base = task.status === TASK_STATUS.late ? SCORE.late : SCORE.onTime
  return Math.max(0, base - (task.hintUsed ? SCORE.hintPenalty : 0))
}

/** Overall percentage across every task in the lab, unattempted ones counting zero. */
export function attemptScore(attempt, totalTasks) {
  const n = totalTasks || attempt.tasks.length || 1
  const sum = attempt.tasks.reduce((acc, t) => acc + (t.points ?? taskPoints(t)), 0)
  return Math.round(sum / n)
}

export function scoreLabel(task) {
  if (task.status === TASK_STATUS.timeout) return 'Timed out'
  const bits = []
  bits.push(task.status === TASK_STATUS.late ? 'Solved late' : 'Solved on time')
  if (task.solutionUsed) bits.push('solution revealed')
  else if (task.hintUsed) bits.push('hint used')
  return bits.join(' · ')
}

export function attemptsFor(userId) {
  return loadAttempts().filter((a) => a.userId === userId)
}

export function activeAttemptFor(userId, labId) {
  return loadAttempts().find((a) => a.userId === userId && a.labId === labId && !a.finishedAt) ?? null
}

/** Per-task aggregates across every learner — the gradebook's difficulty signal. */
export function taskStats(labId, tasks) {
  const attempts = loadAttempts().filter((a) => a.labId === labId)
  return tasks.map((t, i) => {
    const rows = attempts.map((a) => a.tasks.find((x) => x.taskId === t.id)).filter(Boolean)
    const solved = rows.filter((r) => r.status === TASK_STATUS.passed || r.status === TASK_STATUS.late)
    const times = solved.map((r) => r.timeSpentMs).filter((n) => n > 0)
    return {
      index: i + 1,
      taskId: t.id,
      title: t.title,
      limitSec: t.limitSec,
      attempted: rows.length,
      solved: solved.length,
      timeouts: rows.filter((r) => r.status === TASK_STATUS.timeout).length,
      hints: rows.filter((r) => r.hintUsed).length,
      solutions: rows.filter((r) => r.solutionUsed).length,
      checkCalls: rows.reduce((n, r) => n + (r.checkCount || 0), 0),
      meanTimeMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0,
      passRate: rows.length ? Math.round((solved.length / rows.length) * 100) : null,
    }
  })
}
