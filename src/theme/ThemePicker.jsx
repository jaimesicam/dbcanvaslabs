import { useEffect, useRef, useState } from 'react'
import { Icon } from '../components/Icons.jsx'
import { THEMES, useTheme } from './ThemeProvider.jsx'

export function ThemePicker() {
  const { theme, setTheme } = useTheme()
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    const away = (e) => !ref.current?.contains(e.target) && setOpen(false)
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [])
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="rounded-sm p-2 text-muted transition hover:bg-surface2 hover:text-fg"
        aria-label="Theme"
      >
        <Icon.Sun size={17} />
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-1 w-40 animate-fade-in overflow-hidden rounded-sm border bg-surface py-1 shadow-xl">
          {THEMES.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                setTheme(t.id)
                setOpen(false)
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition hover:bg-surface2"
            >
              <span className="h-3 w-3 rounded-full" style={{ background: t.swatch }} />
              {t.label}
              {theme === t.id && <Icon.Check size={13} className="ml-auto text-primary" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
