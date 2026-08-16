import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Horizontal split with a draggable divider. `pct` is the left pane's width as a
 * percentage; the divider is keyboard-accessible via arrow keys.
 */
export function SplitPane({ left, right, initial = 42, min = 24, max = 72, collapsed = false }) {
  const [pct, setPct] = useState(initial)
  const [dragging, setDragging] = useState(false)
  const host = useRef(null)

  const onMove = useCallback(
    (clientX) => {
      const box = host.current?.getBoundingClientRect()
      if (!box) return
      const next = ((clientX - box.left) / box.width) * 100
      setPct(Math.max(min, Math.min(max, next)))
    },
    [min, max],
  )

  useEffect(() => {
    if (!dragging) return
    const move = (e) => {
      e.preventDefault()
      onMove(e.touches ? e.touches[0].clientX : e.clientX)
    }
    const up = () => setDragging(false)
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    window.addEventListener('touchmove', move, { passive: false })
    window.addEventListener('touchend', up)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      window.removeEventListener('touchmove', move)
      window.removeEventListener('touchend', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [dragging, onMove])

  return (
    <div ref={host} className="flex h-full min-h-0 w-full">
      {!collapsed && (
        <>
          <div className="h-full min-h-0 min-w-0" style={{ width: `${pct}%` }}>
            {left}
          </div>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-valuenow={Math.round(pct)}
            tabIndex={0}
            onMouseDown={() => setDragging(true)}
            onTouchStart={() => setDragging(true)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft') setPct((p) => Math.max(min, p - 2))
              if (e.key === 'ArrowRight') setPct((p) => Math.min(max, p + 2))
            }}
            className={`group relative w-1.5 shrink-0 cursor-col-resize bg-border/40 transition hover:bg-primary/50 focus:bg-primary/60 focus:outline-none ${
              dragging ? 'bg-primary/60' : ''
            }`}
            title="Drag to resize"
          >
            <span className="absolute left-1/2 top-1/2 h-8 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted/40 transition group-hover:bg-primary" />
          </div>
        </>
      )}
      <div className="h-full min-h-0 min-w-0 flex-1">{right}</div>
    </div>
  )
}
