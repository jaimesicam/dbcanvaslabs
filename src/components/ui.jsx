import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icons.jsx'

export const inputCls =
  'w-full rounded-sm border bg-bg px-3 py-2 text-sm text-fg placeholder:text-muted ' +
  'outline-none focus:ring-2 focus:ring-primary/30'

export function Card({ title, subtitle, action, className = '', bodyClass = 'p-4', children }) {
  const hasHeader = title || subtitle || action
  return (
    <div className={`rounded-sm border bg-surface ${className}`}>
      {hasHeader && (
        <div className="flex items-start justify-between gap-3 border-b px-3 py-2">
          <div className="min-w-0">
            {title && <h3 className="text-sm font-semibold text-fg">{title}</h3>}
            {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      <div className={bodyClass}>{children}</div>
    </div>
  )
}

const BTN_VARIANTS = {
  primary: 'bg-primary text-primary-fg hover:opacity-90',
  ghost: 'text-fg hover:bg-surface2',
  outline: 'border text-fg hover:bg-surface2',
  danger: 'bg-danger text-white hover:opacity-90',
  success: 'bg-success text-white hover:opacity-90',
  subtle: 'bg-surface2 text-fg hover:opacity-80',
}
const BTN_SIZES = {
  xs: 'text-[11px] px-2 py-1 gap-1',
  sm: 'text-xs px-2.5 py-1.5 gap-1',
  md: 'text-sm px-3.5 py-2 gap-1.5',
  lg: 'text-base px-5 py-2.5 gap-2',
}

export function Button({ variant = 'primary', size = 'md', className = '', children, ...rest }) {
  return (
    <button
      className={
        'inline-flex items-center justify-center rounded-sm font-medium transition ' +
        'active:scale-[.97] disabled:opacity-50 disabled:pointer-events-none ' +
        `${BTN_VARIANTS[variant] || BTN_VARIANTS.primary} ${BTN_SIZES[size] || BTN_SIZES.md} ${className}`
      }
      {...rest}
    >
      {children}
    </button>
  )
}

const BADGE_TONES = {
  muted: 'bg-muted/15 text-muted',
  primary: 'bg-primary/15 text-primary',
  accent: 'bg-accent/15 text-accent',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-danger/15 text-danger',
}

export function Badge({ tone = 'muted', className = '', children }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        BADGE_TONES[tone] || BADGE_TONES.muted
      } ${className}`}
    >
      {children}
    </span>
  )
}

export function Field({ label, hint, children }) {
  return (
    <label className="block">
      {label && <span className="mb-1 block text-xs font-medium text-muted">{label}</span>}
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  )
}

export function Toggle({ checked, onChange, label }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition ${
        checked ? 'bg-primary' : 'bg-surface2'
      }`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
          checked ? 'left-[22px]' : 'left-0.5'
        }`}
      />
    </button>
  )
}

export function ConfirmButton({ onConfirm, children, confirmLabel = 'Confirm?', ...props }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 2500)
    return () => clearTimeout(t)
  }, [armed])
  return (
    <Button
      {...props}
      variant={armed ? 'danger' : props.variant}
      onClick={() => (armed ? (setArmed(false), onConfirm()) : setArmed(true))}
    >
      {armed ? confirmLabel : children}
    </Button>
  )
}

export function Modal({ title, subtitle, onClose, children, footer, width = 'max-w-md' }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose?.()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={onClose}
    >
      <div
        className={`w-full ${width} animate-fade-in rounded-sm border bg-surface shadow-2xl`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b px-5 py-3.5">
          <div>
            <h3 className="text-sm font-semibold">{title}</h3>
            {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            className="-mr-1 rounded-lg p-1 text-muted transition hover:bg-surface2 hover:text-fg"
            aria-label="Close"
          >
            <Icon.X size={16} />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

/** Thin progress bar. `tone` maps to a semantic colour. */
export function ProgressBar({ value, tone = 'primary', className = '', height = 'h-1.5' }) {
  const TONE = {
    primary: 'bg-primary',
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-danger',
    accent: 'bg-accent',
  }
  return (
    <div className={`${height} w-full overflow-hidden rounded-sm bg-surface2 ${className}`}>
      <div
        className={`h-full transition-all duration-500 ${TONE[tone] || TONE.primary}`}
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  )
}

/** Circular score dial used on the completion screen and gradebook. */
export function ScoreRing({ value, size = 84, stroke = 8, label }) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const tone = value >= 80 ? 'var(--status-ok)' : value >= 50 ? 'var(--status-warn)' : 'var(--status-crit)'
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface2)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={tone}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c - (c * Math.max(0, Math.min(100, value))) / 100}
          style={{ transition: 'stroke-dashoffset .6s ease' }}
        />
      </svg>
      <div className="absolute text-center">
        <div className="text-lg font-semibold leading-none">{Math.round(value)}%</div>
        {label && <div className="mt-0.5 text-[10px] text-muted">{label}</div>}
      </div>
    </div>
  )
}

/** Copy-to-clipboard wrapper that shows a transient confirmation. */
export function useCopy() {
  const [copied, setCopied] = useState(false)
  const timer = useRef(null)
  const copy = (text) => {
    try {
      navigator.clipboard?.writeText(text)
    } catch {
      /* clipboard unavailable — the visual confirmation is still useful */
    }
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1400)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  return [copied, copy]
}

export function Empty({ icon, title, children }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
      {icon && <div className="text-muted">{icon}</div>}
      <p className="text-sm font-medium">{title}</p>
      {children && <p className="max-w-sm text-xs text-muted">{children}</p>}
    </div>
  )
}
