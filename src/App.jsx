import { useEffect, useRef, useState } from 'react'
import { Badge, Button } from './components/ui.jsx'
import { Icon } from './components/Icons.jsx'
import { AuthScreens } from './auth/AuthScreens.jsx'
import { initials, useAuth } from './auth/AuthProvider.jsx'
import { ThemePicker } from './theme/ThemePicker.jsx'
import { VoicePicker } from './speech/VoicePicker.jsx'
import { navigate, useRoute } from './lib/router.js'
import { Catalog } from './pages/Catalog.jsx'
import { LabDetail } from './pages/LabDetail.jsx'
import { LabPlayer } from './pages/LabPlayer.jsx'
import { Progress } from './pages/Progress.jsx'
import { Reference } from './pages/Reference.jsx'
import { Cards } from './pages/Cards.jsx'
import { Gradebook } from './pages/Gradebook.jsx'
import { ManageUsers } from './pages/ManageUsers.jsx'

const NAV = [
  { id: 'catalog', label: 'Lab Catalog', icon: Icon.Flask, hint: 'Browse and start hands-on labs' },
  { id: 'progress', label: 'My Progress', icon: Icon.Chart, hint: 'Your attempts, scores and timings' },
  { id: 'reference', label: 'Command Reference', icon: Icon.Book, hint: 'Every command the labs use, with real output' },
  { id: 'cards', label: 'Index Cards', icon: Icon.Grid, hint: 'Question-and-answer cards for the commands and the concepts' },
]
const INSTRUCTOR_NAV = [
  { id: 'gradebook', label: 'Gradebook', icon: Icon.Trophy, hint: 'Cohort results across labs' },
  { id: 'users', label: 'Manage Users', icon: Icon.Users, hint: 'Approve, suspend and promote accounts' },
]

function AccountMenu() {
  const { user, logout } = useAuth()
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    const away = (e) => !ref.current?.contains(e.target) && setOpen(false)
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [])
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-fg transition hover:opacity-90"
      >
        {initials(user)}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-1 w-52 animate-fade-in overflow-hidden rounded-sm border bg-surface shadow-xl">
          <div className="border-b px-3 py-2.5">
            <p className="truncate text-sm font-medium">{user.name}</p>
            <div className="mt-1 flex items-center gap-1.5">
              <span className="text-xs text-muted">@{user.username}</span>
              <Badge tone={user.role === 'instructor' ? 'primary' : 'muted'}>{user.role}</Badge>
            </div>
          </div>
          <button
            onClick={logout}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted transition hover:bg-surface2 hover:text-fg"
          >
            <Icon.Logout size={14} /> Sign out
          </button>
        </div>
      )}
    </div>
  )
}

function Sidebar({ active, collapsed, setCollapsed }) {
  const { isInstructor } = useAuth()
  const items = [...NAV, ...(isInstructor ? INSTRUCTOR_NAV : [])]
  return (
    <aside
      className={`flex shrink-0 flex-col border-r bg-surface transition-all duration-200 ${
        collapsed ? 'w-[68px]' : 'w-60'
      }`}
    >
      <button
        onClick={() => navigate('catalog')}
        className="flex h-14 shrink-0 items-center gap-2.5 border-b px-4 text-left"
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-primary text-sm font-bold text-primary-fg">
          D
        </div>
        {!collapsed && (
          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm font-semibold">DBCanvas Labs</p>
            <p className="truncate text-[11px] text-muted">Hands-on Database Training</p>
          </div>
        )}
      </button>

      <nav className="flex-1 space-y-1 overflow-y-auto p-2">
        {items.map((item) => {
          const on = active === item.id
          return (
            <button
              key={item.id}
              onClick={() => navigate(item.id)}
              title={collapsed ? item.label : item.hint}
              className={`flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-sm font-medium transition ${
                on ? 'bg-primary/15 text-primary' : 'text-muted hover:bg-surface2 hover:text-fg'
              }`}
            >
              <item.icon size={17} className="shrink-0" />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </button>
          )
        })}
      </nav>

      <button
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center gap-2.5 border-t px-4 py-3 text-xs text-muted transition hover:text-fg"
      >
        <Icon.Chevron size={15} className={`transition-transform ${collapsed ? '' : 'rotate-180'}`} />
        {!collapsed && 'Collapse'}
      </button>
    </aside>
  )
}

const TITLES = {
  catalog: ['Lab Catalog', 'Hands-on scenarios on a disposable database cluster'],
  lab: ['Lab Details', 'Overview, lecture notes and topology'],
  progress: ['My Progress', 'Your attempts, scores and per-task timings'],
  reference: ['Command Reference', 'Every command the labs use, with a real example and its real output'],
  cards: ['Index Cards', 'One question and a short answer, drawn from the reference and the lecture notes'],
  gradebook: ['Gradebook', 'Cohort results and per-task difficulty'],
  users: ['Manage Users', 'Approve, suspend and promote accounts'],
}

export function App() {
  const { user } = useAuth()
  const route = useRoute()
  const [collapsed, setCollapsed] = useState(() => window.innerWidth < 900)

  useEffect(() => {
    if (!location.hash) navigate('catalog')
  }, [])

  // Reclaim width on narrow viewports without fighting a manual toggle.
  useEffect(() => {
    let wasNarrow = window.innerWidth < 900
    const onResize = () => {
      const narrow = window.innerWidth < 900
      if (narrow !== wasNarrow) {
        wasNarrow = narrow
        setCollapsed(narrow)
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  if (!user) return <AuthScreens />

  // The lab player takes the whole viewport, like a real lab workspace.
  if (route.path === 'play' && route.param) {
    return <LabPlayer labId={route.param} />
  }

  const [title, hint] = TITLES[route.path] || TITLES.catalog

  let page
  if (route.path === 'lab' && route.param) page = <LabDetail labId={route.param} />
  else if (route.path === 'progress') page = <Progress />
  else if (route.path === 'reference') page = <Reference path={route.param} />
  else if (route.path === 'cards') page = <Cards path={route.param} />
  else if (route.path === 'gradebook') page = <Gradebook />
  else if (route.path === 'users') page = <ManageUsers />
  else page = <Catalog />

  return (
    <div className="flex h-full">
      <Sidebar active={route.path} collapsed={collapsed} setCollapsed={setCollapsed} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-surface px-5">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">{title}</h2>
            <p className="truncate text-[11px] text-muted">{hint}</p>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => navigate('catalog')} className="hidden sm:inline-flex">
              <Icon.Flask size={14} /> Labs
            </Button>
            <VoicePicker />
            <ThemePicker />
            <AccountMenu />
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-auto">
          <div key={route.raw} className="animate-fade-in">
            {page}
          </div>
        </main>
      </div>
    </div>
  )
}
