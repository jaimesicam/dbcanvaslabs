const NODE_W = 132
const NODE_H = 54

const LAYOUT = {
  box: { x: 26, y: 16, w: 548, h: 96, label: 'lab-cnpg · k3d + CloudNativePG' },
  nodes: {
    'k3d-server': { x: 44, y: 40 },
    'k3d-agent-1': { x: 234, y: 40 },
    'k3d-agent-2': { x: 424, y: 40 },
  },
  viewBox: '0 0 600 226',
}

const TYPE_LABEL = {
  k3s: 'k3s node',
}

function nodeState(world, node) {
  const op = world.k8s.operator
  const c = world.k8s.cluster
  const entry = c && Object.entries(c.members).find(([, m]) => m.node === node.id)
  if (entry) {
    const [, m] = entry
    if (m.phase !== 'Running') return { tone: 'warn', role: m.phase }
    return { tone: m.role === 'primary' ? 'leader' : 'ok', role: m.role === 'primary' ? 'Primary' : 'Replica' }
  }
  if (op.pod?.node === node.id) return { tone: op.pod.phase === 'Running' ? 'ok' : 'warn', role: 'operator' }
  return { tone: 'plain', role: node.role === 'control-plane' ? 'control-plane' : 'worker' }
}

const TONES = {
  leader: { stroke: 'var(--primary)', fill: 'color-mix(in srgb, var(--primary) 14%, var(--surface))', text: 'var(--primary)' },
  ok: { stroke: 'var(--border)', fill: 'var(--surface)', text: 'var(--status-ok)' },
  warn: { stroke: 'var(--warning)', fill: 'color-mix(in srgb, var(--warning) 10%, var(--surface))', text: 'var(--warning)' },
  down: { stroke: 'var(--danger)', fill: 'color-mix(in srgb, var(--danger) 10%, var(--surface))', text: 'var(--danger)' },
  plain: { stroke: 'var(--border)', fill: 'var(--surface2)', text: 'var(--muted)' },
}

export function Topology({ world, className = '', showLegend = true }) {
  return (
    <div className={className}>
      <svg viewBox={LAYOUT.viewBox} className="w-full" style={{ maxHeight: 340 }}>
        {/* cluster frame */}
        <rect
          x={LAYOUT.box.x}
          y={LAYOUT.box.y}
          width={LAYOUT.box.w}
          height={LAYOUT.box.h}
          rx="10"
          fill="color-mix(in srgb, var(--primary) 4%, transparent)"
          stroke="var(--border)"
          strokeDasharray="5 4"
        />
        <text x={LAYOUT.box.x + 10} y={LAYOUT.box.y - 5} fontSize="10" fill="var(--muted)" fontFamily="var(--font-mono)">
          {LAYOUT.box.label}
        </text>

        {/* nodes */}
        {world.nodes.map((node) => {
          const p = LAYOUT.nodes[node.id]
          if (!p) return null
          const st = nodeState(world, node)
          const tone = TONES[st.tone]
          return (
            <g key={node.id}>
              <rect
                x={p.x}
                y={p.y}
                width={NODE_W}
                height={NODE_H}
                rx="8"
                fill={tone.fill}
                stroke={tone.stroke}
                strokeWidth={st.tone === 'leader' ? 2 : 1.2}
              />
              <circle cx={p.x + 12} cy={p.y + 15} r="3.5" fill={tone.text} />
              <text x={p.x + 23} y={p.y + 19} fontSize="11" fontWeight="600" fill="var(--fg)">
                {node.id}
              </text>
              <text x={p.x + 12} y={p.y + 34} fontSize="9" fill="var(--muted)">
                {TYPE_LABEL[node.type] || node.type}
              </text>
              {st.role && (
                <text x={p.x + 12} y={p.y + 46} fontSize="9" fontWeight="600" fill={tone.text} fontFamily="var(--font-mono)">
                  {st.role}
                </text>
              )}
            </g>
          )
        })}
      </svg>

      {showLegend && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1 text-[11px] text-muted">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: 'var(--primary)' }} />
            Primary
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: 'var(--status-ok)' }} />
            Healthy
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: 'var(--danger)' }} />
            Stopped
          </span>
        </div>
      )}
    </div>
  )
}
