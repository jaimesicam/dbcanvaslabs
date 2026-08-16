// Hand-rolled SVG charts — no charting library, matching DBCanvas's constraint.

/** Filled sparkline. `data` is an array of numbers, oldest first. */
export function Sparkline({ data, height = 44, tone = 'var(--accent)', showLast = true, unit = '' }) {
  const pts = data.length ? data : [0]
  const max = Math.max(...pts, 1)
  const min = Math.min(...pts, 0)
  const span = max - min || 1
  const W = 100
  const step = pts.length > 1 ? W / (pts.length - 1) : W
  const y = (v) => height - ((v - min) / span) * (height - 6) - 3
  const line = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(2)},${y(v).toFixed(2)}`).join(' ')
  const area = `${line} L${W},${height} L0,${height} Z`
  const id = `sg${tone.replace(/\W/g, '')}`

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={tone} stopOpacity="0.28" />
            <stop offset="100%" stopColor={tone} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${id})`} />
        <path d={line} fill="none" stroke={tone} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
      </svg>
      {showLast && (
        <div className="absolute right-0 top-0 font-mono text-[10px] text-muted">
          {pts[pts.length - 1].toFixed(pts[pts.length - 1] < 10 ? 1 : 0)}
          {unit}
        </div>
      )}
    </div>
  )
}

/** Small vertical bar chart, used for per-task timings. */
export function BarRow({ items, height = 90 }) {
  const max = Math.max(...items.map((i) => i.value), 1)
  return (
    <div className="flex items-end gap-1.5" style={{ height }}>
      {items.map((it, n) => (
        <div key={n} className="group relative flex flex-1 flex-col items-center justify-end gap-1">
          <div
            className="w-full rounded-t transition-all"
            style={{
              height: `${Math.max(2, (it.value / max) * (height - 18))}px`,
              background: it.tone || 'var(--primary)',
            }}
          />
          <span className="text-[10px] text-muted">{it.label}</span>
          <span className="pointer-events-none absolute -top-6 hidden whitespace-nowrap rounded border bg-surface px-1.5 py-0.5 text-[10px] shadow group-hover:block">
            {it.tip || it.value}
          </span>
        </div>
      ))}
    </div>
  )
}
