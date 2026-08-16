import { useEffect, useState } from 'react'

// Hash navigation, no router library — same approach DBCanvas takes.

export function currentRoute() {
  const raw = location.hash.replace(/^#\/?/, '')
  const [path, ...rest] = raw.split('/')
  return { path: path || 'catalog', param: rest.join('/') || null, raw }
}

export function navigate(to) {
  location.hash = `#/${String(to).replace(/^#?\/?/, '')}`
}

export function useRoute() {
  const [route, setRoute] = useState(currentRoute)
  useEffect(() => {
    const onHash = () => setRoute(currentRoute())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return route
}
