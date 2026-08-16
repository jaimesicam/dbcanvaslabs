// Pure time-formatting helpers, independent of the (now real, not simulated) cluster.

export function pad(n, width = 2) {
  return String(n).padStart(width, '0')
}

/** `1h 12m` style remaining-time label. */
export function humanDuration(ms) {
  if (ms <= 0) return '0s'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${sec}s`
  return `${sec}s`
}

/** `mm:ss` / `h:mm:ss` clock for countdowns. */
export function clockDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`
}
