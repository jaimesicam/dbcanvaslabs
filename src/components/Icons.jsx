// Hand-written inline SVG only — no icon library, matching DBCanvas's constraint.

function Svg({ size = 18, children, fill = 'none', ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const Icon = {
  Flask: (p) => (
    <Svg {...p}>
      <path d="M9 3h6M10 3v5.5L4.6 18a2 2 0 0 0 1.7 3h11.4a2 2 0 0 0 1.7-3L14 8.5V3" />
      <path d="M7.2 14h9.6" />
    </Svg>
  ),
  Grid: (p) => (
    <Svg {...p}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </Svg>
  ),
  Chart: (p) => (
    <Svg {...p}>
      <path d="M3 3v18h18" />
      <path d="M7 15l3.5-4 3 2.5L20 7" />
    </Svg>
  ),
  Users: (p) => (
    <Svg {...p}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13A4 4 0 0 1 16 11" />
    </Svg>
  ),
  Terminal: (p) => (
    <Svg {...p}>
      <rect x="2.5" y="4" width="19" height="16" rx="2" />
      <path d="M6.5 9.5L9 12l-2.5 2.5M12 15h5" />
    </Svg>
  ),
  Server: (p) => (
    <Svg {...p}>
      <rect x="3" y="3.5" width="18" height="7" rx="1.6" />
      <rect x="3" y="13.5" width="18" height="7" rx="1.6" />
      <path d="M7 7h.01M7 17h.01" />
    </Svg>
  ),
  Globe: (p) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18" />
    </Svg>
  ),
  Nodes: (p) => (
    <Svg {...p}>
      <circle cx="12" cy="5" r="2.5" />
      <circle cx="5" cy="18" r="2.5" />
      <circle cx="19" cy="18" r="2.5" />
      <path d="M12 7.5v4M10.4 13.2 6.6 16M13.6 13.2 17.4 16" />
    </Svg>
  ),
  Search: (p) => (
    <Svg {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6" />
    </Svg>
  ),
  Sun: (p) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
    </Svg>
  ),
  Check: (p) => (
    <Svg {...p}>
      <path d="m4.5 12.5 5 5 10-11" />
    </Svg>
  ),
  X: (p) => (
    <Svg {...p}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  ),
  Lock: (p) => (
    <Svg {...p}>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </Svg>
  ),
  Bulb: (p) => (
    <Svg {...p}>
      <path d="M9.5 17.5h5M10 21h4" />
      <path d="M12 3a6 6 0 0 0-3.3 11c.5.4.8 1 .8 1.6h5c0-.6.3-1.2.8-1.6A6 6 0 0 0 12 3Z" />
    </Svg>
  ),
  Eye: (p) => (
    <Svg {...p}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  ),
  Clock: (p) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V12l3.2 2" />
    </Svg>
  ),
  Plus: (p) => (
    <Svg {...p}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  ),
  Chevron: (p) => (
    <Svg {...p}>
      <path d="m9 6 6 6-6 6" />
    </Svg>
  ),
  ChevronDown: (p) => (
    <Svg {...p}>
      <path d="m6 9 6 6 6-6" />
    </Svg>
  ),
  External: (p) => (
    <Svg {...p}>
      <path d="M14 4h6v6M20 4l-8.5 8.5" />
      <path d="M18 14v5a1.8 1.8 0 0 1-1.8 1.8H5.8A1.8 1.8 0 0 1 4 19V8.6A1.8 1.8 0 0 1 5.8 6.8h5" />
    </Svg>
  ),
  Copy: (p) => (
    <Svg {...p}>
      <rect x="9" y="9" width="11.5" height="11.5" rx="2" />
      <path d="M15 6.5V5.4A1.9 1.9 0 0 0 13.1 3.5H5.4A1.9 1.9 0 0 0 3.5 5.4v7.7A1.9 1.9 0 0 0 5.4 15h1.1" />
    </Svg>
  ),
  Menu: (p) => (
    <Svg {...p}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Svg>
  ),
  Expand: (p) => (
    <Svg {...p}>
      <path d="M4 9V4h5M20 15v5h-5M20 9V4h-5M4 15v5h5" />
    </Svg>
  ),
  Collapse: (p) => (
    <Svg {...p}>
      <path d="M9 4v5H4M15 20v-5h5M15 4v5h5M9 20v-5H4" />
    </Svg>
  ),
  Logout: (p) => (
    <Svg {...p}>
      <path d="M9 21H5.5A1.5 1.5 0 0 1 4 19.5v-15A1.5 1.5 0 0 1 5.5 3H9" />
      <path d="M16 8l4 4-4 4M20 12H9" />
    </Svg>
  ),
  Refresh: (p) => (
    <Svg {...p}>
      <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" />
      <path d="M20.5 4v5h-5" />
    </Svg>
  ),
  Trophy: (p) => (
    <Svg {...p}>
      <path d="M8 4h8v5a4 4 0 0 1-8 0V4Z" />
      <path d="M8 5.5H5.5A2.5 2.5 0 0 0 8 10M16 5.5h2.5A2.5 2.5 0 0 1 16 10" />
      <path d="M12 13v4M9 21h6M10 17h4" />
    </Svg>
  ),
  Warn: (p) => (
    <Svg {...p}>
      <path d="M10.3 4.3 2.6 17.7A1.9 1.9 0 0 0 4.3 20.6h15.4a1.9 1.9 0 0 0 1.7-2.9L13.7 4.3a1.9 1.9 0 0 0-3.4 0Z" />
      <path d="M12 9.5v4M12 17h.01" />
    </Svg>
  ),
  Info: (p) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </Svg>
  ),
  Book: (p) => (
    <Svg {...p}>
      <path d="M4 5.5A2 2 0 0 1 6 3.5h12.5v17H6a2 2 0 0 1-2-2Z" />
      <path d="M4 17.5h14.5" />
    </Svg>
  ),
  Skull: (p) => (
    <Svg {...p}>
      <path d="M12 3a7 7 0 0 0-7 7v3l-1 3h4v4h8v-4h4l-1-3v-3a7 7 0 0 0-7-7Z" />
      <path d="M9.5 11h.01M14.5 11h.01" />
    </Svg>
  ),
  Speaker: (p) => (
    <Svg {...p}>
      <path d="M4 9.5h3L11.5 6v12L7 14.5H4Z" />
      <path d="M15.5 9.2a4 4 0 0 1 0 5.6M18.2 6.8a7.5 7.5 0 0 1 0 10.4" />
    </Svg>
  ),
  SpeakerOff: (p) => (
    <Svg {...p}>
      <path d="M4 9.5h3L11.5 6v12L7 14.5H4Z" />
      <path d="m15.5 10 4.5 4M20 10l-4.5 4" />
    </Svg>
  ),
}
