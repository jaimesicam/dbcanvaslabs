import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { SEED_USERS, seedAttemptsIfEmpty } from '../store/seed.js'

// Mock accounts in localStorage. There is no server and no real authentication here —
// this exists so the app can demonstrate roles, approval and per-learner grading.

const USERS_KEY = 'dbcanvas_labs_users'
const SESSION_KEY = 'dbcanvas_labs_session'

const AuthCtx = createContext(null)

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
    /* private mode */
  }
}

export function AuthProvider({ children }) {
  const [users, setUsers] = useState(() => {
    const existing = read(USERS_KEY, null)
    if (existing?.length) return existing
    write(USERS_KEY, SEED_USERS)
    return SEED_USERS
  })
  const [userId, setUserId] = useState(() => read(SESSION_KEY, null))

  useEffect(() => {
    seedAttemptsIfEmpty()
  }, [])

  useEffect(() => write(USERS_KEY, users), [users])
  useEffect(() => write(SESSION_KEY, userId), [userId])

  const user = useMemo(() => users.find((u) => u.id === userId) ?? null, [users, userId])

  const login = useCallback(
    (username, password) => {
      const u = users.find((x) => x.username.toLowerCase() === username.trim().toLowerCase())
      if (!u) return { error: 'No account with that username.' }
      if (u.password !== password) return { error: 'Incorrect password.' }
      if (u.status === 'pending') return { error: 'Your account is awaiting instructor approval.' }
      if (u.status === 'suspended') return { error: 'This account has been suspended.' }
      setUserId(u.id)
      return { user: u }
    },
    [users],
  )

  const register = useCallback(
    ({ username, name, password }) => {
      const clean = username.trim()
      if (clean.length < 3 || clean.length > 32) return { error: 'Username must be 3–32 characters.' }
      if (password.length < 8) return { error: 'Password must be at least 8 characters.' }
      if (users.some((u) => u.username.toLowerCase() === clean.toLowerCase()))
        return { error: 'That username is already taken.' }
      const created = {
        id: Math.max(0, ...users.map((u) => u.id)) + 1,
        username: clean,
        name: name.trim() || clean,
        role: 'learner',
        status: 'pending',
        password,
        createdAt: new Date().toISOString(),
      }
      setUsers((list) => [...list, created])
      return { user: created, pending: true }
    },
    [users],
  )

  const logout = useCallback(() => setUserId(null), [])

  const updateUser = useCallback((id, patch) => {
    setUsers((list) => list.map((u) => (u.id === id ? { ...u, ...patch } : u)))
  }, [])

  const removeUser = useCallback(
    (id) => {
      setUsers((list) => list.filter((u) => u.id !== id))
      if (id === userId) setUserId(null)
    },
    [userId],
  )

  const value = useMemo(
    () => ({ user, users, login, register, logout, updateUser, removeUser, isInstructor: user?.role === 'instructor' }),
    [user, users, login, register, logout, updateUser, removeUser],
  )

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthCtx)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}

export function initials(user) {
  const src = user?.name || user?.username || '?'
  return src
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join('')
}
