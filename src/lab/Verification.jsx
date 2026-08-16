import { useEffect, useRef } from 'react'
import { Icon } from '../components/Icons.jsx'

/**
 * Live verification.
 *
 * The objective's criteria are visible from the start — the learner sees the whole
 * definition of done — and each one flips itself as soon as the cluster satisfies
 * it. Submitting is a commit, not a question. This is only possible because the
 * grader reads a state model we own; it never inspects typed text.
 */
export function Verification({ criteria, result, dimmed }) {
  const prevMet = useRef(new Set())
  const justMet = useRef(new Set())

  const rows = criteria.map((label, i) => {
    const live = result?.checks?.[i]
    return {
      label,
      state: !live ? 'pending' : live.ok ? 'met' : 'unmet',
      detail: live?.detail ?? null,
    }
  })

  useEffect(() => {
    const met = new Set(rows.filter((r) => r.state === 'met').map((r) => r.label))
    justMet.current = new Set([...met].filter((l) => !prevMet.current.has(l)))
    prevMet.current = met
  })

  const metCount = rows.filter((r) => r.state === 'met').length
  const allMet = metCount === rows.length

  return (
    <div className={`panel ${dimmed ? 'opacity-60' : ''}`}>
      <div className="flex items-center gap-2 px-2.5 py-1.5 rule-b">
        <span className="microlabel">Verification</span>
        <span className="tnum ml-auto text-[10px] text-muted">
          <span style={{ color: allMet ? 'var(--status-ok)' : undefined }}>{metCount}</span>
          <span className="text-muted">/{rows.length}</span>
        </span>
        {allMet && (
          <span className="flex items-center gap-1 text-[10px] font-semibold" style={{ color: 'var(--status-ok)' }}>
            <Icon.Check size={11} /> ready
          </span>
        )}
      </div>
      <ul>
        {rows.map((r, i) => (
          <li
            key={r.label}
            className={`flex items-start gap-2 px-2.5 py-1.5 ${i ? 'rule-t' : ''} ${
              justMet.current.has(r.label) ? 'criterion-met' : ''
            }`}
          >
            <span className="mt-[3px] shrink-0">
              {r.state === 'met' ? (
                <Icon.Check size={12} style={{ color: 'var(--status-ok)' }} />
              ) : r.state === 'unmet' ? (
                <Icon.X size={12} style={{ color: 'var(--status-crit)' }} />
              ) : (
                <span className="block h-[10px] w-[10px] rounded-full border border-muted/50" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p
                className={`text-[11.5px] leading-snug ${
                  r.state === 'met' ? 'text-fg' : r.state === 'unmet' ? 'text-fg' : 'text-muted'
                }`}
              >
                {r.label}
              </p>
              {r.detail && (
                <p
                  className="data mt-0.5 break-words leading-snug"
                  style={{ color: r.state === 'met' ? 'var(--muted)' : 'var(--status-crit)' }}
                >
                  {r.detail}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
