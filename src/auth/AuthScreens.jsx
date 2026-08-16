import { useState } from 'react'
import { Button, Field, inputCls } from '../components/ui.jsx'
import { Icon } from '../components/Icons.jsx'
import { THEMES, useTheme } from '../theme/ThemeProvider.jsx'
import { useAuth } from './AuthProvider.jsx'

function ThemeSwatches() {
  const { theme, setTheme } = useTheme()
  return (
    <div className="flex items-center gap-1.5">
      {THEMES.map((t) => (
        <button
          key={t.id}
          onClick={() => setTheme(t.id)}
          title={t.label}
          aria-label={`${t.label} theme`}
          className={`h-4 w-4 rounded-full border-2 transition ${
            theme === t.id ? 'border-fg scale-110' : 'border-transparent opacity-60 hover:opacity-100'
          }`}
          style={{ background: t.swatch }}
        />
      ))}
    </div>
  )
}

export function AuthScreens() {
  const { login, register } = useAuth()
  const [mode, setMode] = useState('login')
  const [username, setUsername] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  const submit = (e) => {
    e.preventDefault()
    setError(null)
    setNotice(null)
    if (mode === 'login') {
      const r = login(username, password)
      if (r.error) setError(r.error)
    } else {
      const r = register({ username, name, password })
      if (r.error) setError(r.error)
      else {
        setNotice('Account created. An instructor needs to approve it before you can sign in.')
        setMode('login')
        setPassword('')
      }
    }
  }

  const fillDemo = (u, p) => {
    setUsername(u)
    setPassword(p)
    setMode('login')
    setError(null)
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-bg p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-sm bg-primary text-lg font-bold text-primary-fg">
            D
          </div>
          <div className="leading-tight">
            <h1 className="text-base font-semibold">DBCanvas Labs</h1>
            <p className="text-xs text-muted">Hands-on Database Training</p>
          </div>
          <div className="ml-auto">
            <ThemeSwatches />
          </div>
        </div>

        <form onSubmit={submit} className="rounded-sm border bg-surface p-5 shadow-xl">
          <h2 className="text-sm font-semibold">{mode === 'login' ? 'Sign in' : 'Create an account'}</h2>
          <p className="mt-0.5 mb-4 text-xs text-muted">
            {mode === 'login'
              ? 'Your progress and scores are tied to your account.'
              : 'New accounts need instructor approval before their first sign-in.'}
          </p>

          <div className="space-y-3">
            <Field label="Username">
              <input
                className={inputCls}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
              />
            </Field>
            {mode === 'register' && (
              <Field label="Full name">
                <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
            )}
            <Field label="Password">
              <input
                type="password"
                className={inputCls}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              />
            </Field>
          </div>

          {error && (
            <p className="mt-3 flex items-start gap-1.5 text-xs text-danger">
              <Icon.Warn size={14} className="mt-px shrink-0" />
              {error}
            </p>
          )}
          {notice && (
            <p className="mt-3 flex items-start gap-1.5 text-xs text-success">
              <Icon.Check size={14} className="mt-px shrink-0" />
              {notice}
            </p>
          )}

          <Button type="submit" className="mt-4 w-full">
            {mode === 'login' ? 'Sign in' : 'Create account'}
          </Button>

          <button
            type="button"
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login')
              setError(null)
              setNotice(null)
            }}
            className="mt-3 w-full text-center text-xs text-muted transition hover:text-fg"
          >
            {mode === 'login' ? 'Need an account? Register' : 'Already have an account? Sign in'}
          </button>
        </form>

        <div className="mt-4 rounded-sm border border-dashed bg-surface/50 p-3">
          <p className="mb-2 text-[11px] font-medium text-muted">Demo accounts — this is a mock, no real credentials</p>
          <div className="flex flex-wrap gap-2">
            <Button size="xs" variant="outline" onClick={() => fillDemo('learner', 'learner1')}>
              Learner
            </Button>
            <Button size="xs" variant="outline" onClick={() => fillDemo('instructor', 'instructor')}>
              Instructor
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
