import { Button } from '../components/ui.jsx'
import { Icon } from '../components/Icons.jsx'
import { Topology } from '../services/Topology.jsx'

/**
 * Contextual inspector, opened by clicking a node in the spine or an endpoint chip.
 * Replaces the old top-level tab bar: nothing about the cluster is modal any more,
 * because the cluster itself never goes away.
 */

function Row({ k, v, tone }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-2.5 py-1.5 rule-t">
      <span className="microlabel shrink-0">{k}</span>
      <span className="data text-right" style={tone ? { color: tone } : undefined}>
        {v}
      </span>
    </div>
  )
}

function nodeFacts(world, id) {
  const node = world.node(id)
  const out = [
    ['type', node.type, null],
    ['address', node.ip, null],
    ['os', `${node.os} ${node.osVersion}`, null],
    ['k8s role', node.role, null],
  ]

  const op = world.k8s.operator
  const c = world.k8s.cluster
  if (op.pod?.node === id) {
    out.push(
      ['operator pod', op.pod.name, null],
      ['operator phase', op.pod.phase, op.pod.phase === 'Running' ? 'var(--status-ok)' : 'var(--status-warn)'],
    )
  }
  const entry = c && Object.entries(c.members).find(([, m]) => m.node === id)
  if (entry) {
    const [podName, m] = entry
    const isPrimary = m.role === 'primary'
    out.push(
      ['pod', podName, null],
      ['role', isPrimary ? 'Primary' : 'Replica', isPrimary ? 'var(--primary)' : null],
      ['phase', m.phase, m.phase === 'Running' ? 'var(--status-ok)' : 'var(--status-warn)'],
      ['pvc', podName, null],
      ['volume', m.volume, null],
    )
  }
  return out
}

const SERVICE_TITLE = {
  topology: 'Topology',
}

export function Inspector({ world, target, onClose, onOpenTerminal, hasTerminal }) {
  if (!target) return null
  const isNode = target.kind === 'node'
  const title = isNode ? target.id : SERVICE_TITLE[target.id]

  return (
    <div className="panel flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-2.5 py-1.5 rule-b">
        <span className="microlabel">{isNode ? 'Node' : 'Service'}</span>
        <span className="data truncate font-semibold">{title}</span>
        <button
          onClick={onClose}
          className="ml-auto shrink-0 rounded-sm p-1 text-muted transition hover:bg-surface2 hover:text-fg"
          title="Close inspector"
        >
          <Icon.X size={13} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {isNode ? (
          <>
            <div>
              {nodeFacts(world, target.id).map(([k, v, tone]) => (
                <Row key={k} k={k} v={v} tone={tone} />
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5 p-2.5 rule-t">
              {hasTerminal ? (
                <Button size="xs" variant="outline" onClick={() => onOpenTerminal(target.id)}>
                  <Icon.Terminal size={12} /> Open terminal
                </Button>
              ) : (
                <p className="text-[11px] text-muted">
                  This node has no shell in this lab — reach it over the network from another node.
                </p>
              )}
            </div>
            <div className="p-2.5 rule-t">
              <p className="microlabel mb-1.5">Note</p>
              <p className="text-[11px] leading-relaxed text-muted">
                This panel is read-only on purpose. Everything that changes the cluster is done
                from a terminal, which is the skill the lab is teaching.
              </p>
            </div>
          </>
        ) : (
          <div className="h-full min-h-0 p-2">{target.id === 'topology' && <Topology world={world} />}</div>
        )}
      </div>
    </div>
  )
}
