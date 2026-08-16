import { createContext, useContext, useEffect, useMemo, useState } from 'react'

const STORAGE_KEY = 'dbcanvas_labs_theme'

export const THEMES = [
  { id: 'dark', label: 'Dark', swatch: '#6366f1' },
  { id: 'light', label: 'Light', swatch: '#4f46e5' },
  { id: 'midnight', label: 'Midnight', swatch: '#7c5cff' },
]

const ThemeCtx = createContext(null)

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) || 'dark'
    } catch {
      return 'dark'
    }
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try {
      localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      /* private mode */
    }
  }, [theme])

  const value = useMemo(() => ({ theme, setTheme, themes: THEMES }), [theme])
  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>
}

export function useTheme() {
  return useContext(ThemeCtx)
}
