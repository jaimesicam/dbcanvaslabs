import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

const XTERM_THEME = {
  background: '#0e1117',
  foreground: '#e6eaf2',
  cursor: '#6366f1',
  cursorAccent: '#0e1117',
  selectionBackground: '#33415580',
  black: '#1f2632',
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#f59e0b',
  blue: '#6366f1',
  magenta: '#a78bfa',
  cyan: '#22d3ee',
  white: '#e6eaf2',
  brightBlack: '#93a0b5',
  brightRed: '#f87171',
  brightGreen: '#4ade80',
  brightYellow: '#fbbf24',
  brightBlue: '#818cf8',
  brightMagenta: '#c4b5fd',
  brightCyan: '#67e8f9',
  brightWhite: '#ffffff',
}

/**
 * One xterm instance bound to a real WebSocket pty inside the attempt's node container
 * (`server/terminal.go`) — a real `sh`/`bash` shell, not a simulated one. The instance is
 * created once and kept alive for the life of the lab session, so scrollback survives
 * tab switches; the pane is hidden with `visibility`, never unmounted. Raw bytes pass
 * straight through both directions — the remote shell owns echo, history and tab
 * completion, so none of that needs reimplementing here.
 */
export function TerminalPane({ attemptId, nodeId, visible }) {
  const hostRef = useRef(null)
  const stateRef = useRef(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host || stateRef.current || !attemptId) return

    const term = new Terminal({
      theme: XTERM_THEME,
      fontSize: 13,
      fontFamily: 'ui-monospace, "JetBrains Mono", "SFMono-Regular", monospace',
      cursorBlink: true,
      scrollback: 3000,
      lineHeight: 1.25,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)

    const st = { term, fit, ws: null, disposed: false, opened: false, attempts: 0, timer: 0 }
    stateRef.current = st

    const sendResize = () => {
      if (st.ws && st.ws.readyState === WebSocket.OPEN) {
        st.ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    }

    // Reconnect rather than give up. Losing the socket used to leave a dead pane whose only
    // cure was reloading the page — in the middle of a timed exam, with the real cluster
    // still perfectly healthy on the other side. A drop can be a backend restart, a laptop
    // sleep, or a proxy timing the connection out; none of those should cost the session.
    //
    // Note what does NOT survive: the shell itself is a `docker exec`, so a new connection is
    // a NEW shell — working directory, shell history and exported variables (PGPASSWORD, in
    // these labs) are gone. That is said plainly in the pane rather than left for the learner
    // to discover when a command mysteriously fails.
    const MAX_RETRIES = 8
    const connect = () => {
      if (st.disposed) return
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(`${proto}://${location.host}/api/attempts/${attemptId}/nodes/${nodeId}/term`)
      ws.binaryType = 'arraybuffer'
      st.ws = ws

      ws.onmessage = (e) => {
        if (typeof e.data === 'string') return
        term.write(new Uint8Array(e.data))
      }
      ws.onopen = () => {
        if (st.attempts > 0) {
          term.write('\r\n\x1b[32m[reconnected — this is a fresh shell: re-export any variables you had set]\x1b[0m\r\n')
        }
        st.attempts = 0
        sendResize()
      }
      ws.onclose = () => {
        if (st.disposed || st.ws !== ws) return
        if (st.attempts >= MAX_RETRIES) {
          term.write('\r\n\x1b[31m[connection lost — reload the page to reconnect]\x1b[0m\r\n')
          return
        }
        // Backoff, capped: a backend that is restarting takes a few seconds, one that is
        // gone should not be hammered.
        const delay = Math.min(1000 * 2 ** st.attempts, 15000)
        st.attempts += 1
        term.write(`\r\n\x1b[33m[connection lost — reconnecting (${st.attempts}/${MAX_RETRIES})…]\x1b[0m\r\n`)
        st.timer = setTimeout(connect, delay)
      }
    }
    connect()

    const dataDisposable = term.onData((data) => {
      if (st.ws && st.ws.readyState === WebSocket.OPEN) st.ws.send(new TextEncoder().encode(data))
    })

    // Open only once the host actually has dimensions — opening early makes xterm
    // pick a narrow column count and every line written before the first fit stays
    // wrapped at that width.
    let raf = 0
    const openWhenSized = () => {
      if (st.disposed) return
      if (host.clientWidth < 40 || host.clientHeight < 40) {
        raf = requestAnimationFrame(openWhenSized)
        return
      }
      term.open(host)
      try {
        fit.fit()
      } catch {
        /* fall back to the default geometry */
      }
      st.opened = true
      sendResize()
    }
    openWhenSized()

    const ro = new ResizeObserver(() => {
      if (!st.opened) return
      try {
        fit.fit()
      } catch {
        /* host not laid out yet */
      }
      sendResize()
    })
    ro.observe(host)
    st.ro = ro

    return () => {
      st.disposed = true
      cancelAnimationFrame(raf)
      clearTimeout(st.timer)
      ro.disconnect()
      dataDisposable.dispose()
      if (st.ws) st.ws.close()
      term.dispose()
      stateRef.current = null
    }
  }, [attemptId, nodeId])

  useEffect(() => {
    if (!visible) return
    const st = stateRef.current
    if (!st) return
    // Refit and focus when this tab becomes the visible one.
    const t = setTimeout(() => {
      if (!st.opened) return
      try {
        st.fit.fit()
      } catch {
        /* not laid out */
      }
      st.term.focus()
      if (st.ws && st.ws.readyState === WebSocket.OPEN) {
        st.ws.send(JSON.stringify({ type: 'resize', cols: st.term.cols, rows: st.term.rows }))
      }
    }, 60)
    return () => clearTimeout(t)
  }, [visible])

  return (
    <div
      className={`absolute inset-0 bg-[#0e1117] px-2 py-1.5 ${
        visible ? '' : 'invisible pointer-events-none'
      }`}
    >
      <div ref={hostRef} className="xterm-host" />
    </div>
  )
}
