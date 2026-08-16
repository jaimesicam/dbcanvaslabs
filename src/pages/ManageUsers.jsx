import { useMemo } from 'react'
import { Badge, Button, Card, ConfirmButton } from '../components/ui.jsx'
import { Icon } from '../components/Icons.jsx'
import { useAuth } from '../auth/AuthProvider.jsx'
import { loadAttempts } from '../store/progress.js'

const STATUS_TONE = { approved: 'success', pending: 'warning', suspended: 'danger' }

export function ManageUsers() {
  const { user: me, users, updateUser, removeUser } = useAuth()
  const attempts = useMemo(() => loadAttempts(), [])
  const pending = users.filter((u) => u.status === 'pending')

  return (
    <div className="space-y-5 p-5">
      {pending.length > 0 && (
        <Card
          title={`${pending.length} account${pending.length === 1 ? '' : 's'} awaiting approval`}
          subtitle="New registrations cannot sign in until approved"
        >
          <div className="space-y-2">
            {pending.map((u) => (
              <div key={u.id} className="flex flex-wrap items-center gap-3 rounded-sm border bg-warning/5 p-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{u.name}</p>
                  <p className="text-[11px] text-muted">
                    @{u.username} · registered {new Date(u.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <Button size="sm" variant="success" onClick={() => updateUser(u.id, { status: 'approved' })}>
                  <Icon.Check size={14} /> Approve
                </Button>
                <ConfirmButton size="sm" variant="outline" confirmLabel="Reject?" onConfirm={() => removeUser(u.id)}>
                  Reject
                </ConfirmButton>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card title="All accounts" subtitle={`${users.length} total`} bodyClass="p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b text-[11px] uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2 text-left font-medium">User</th>
                <th className="px-3 py-2 text-left font-medium">Role</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Attempts</th>
                <th className="px-3 py-2 text-left font-medium">Registered</th>
                <th className="px-4 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const isMe = u.id === me.id
                const count = attempts.filter((a) => a.userId === u.id).length
                return (
                  <tr key={u.id} className={`border-b last:border-0 ${u.status === 'pending' ? 'bg-warning/5' : ''}`}>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <p className="text-xs font-medium">{u.name}</p>
                        {isMe && <Badge tone="primary">you</Badge>}
                      </div>
                      <p className="text-[11px] text-muted">@{u.username}</p>
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge tone={u.role === 'instructor' ? 'primary' : 'muted'}>{u.role}</Badge>
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge tone={STATUS_TONE[u.status]}>{u.status}</Badge>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-xs text-muted">{count}</td>
                    <td className="px-3 py-2.5 text-[11px] text-muted">
                      {new Date(u.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {u.status === 'pending' && (
                          <Button size="xs" variant="success" onClick={() => updateUser(u.id, { status: 'approved' })}>
                            Approve
                          </Button>
                        )}
                        {u.status === 'approved' && !isMe && (
                          <Button size="xs" variant="outline" onClick={() => updateUser(u.id, { status: 'suspended' })}>
                            Suspend
                          </Button>
                        )}
                        {u.status === 'suspended' && (
                          <Button size="xs" variant="outline" onClick={() => updateUser(u.id, { status: 'approved' })}>
                            Reinstate
                          </Button>
                        )}
                        {!isMe && (
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() =>
                              updateUser(u.id, { role: u.role === 'instructor' ? 'learner' : 'instructor' })
                            }
                          >
                            Make {u.role === 'instructor' ? 'learner' : 'instructor'}
                          </Button>
                        )}
                        {!isMe && (
                          <ConfirmButton
                            size="xs"
                            variant="ghost"
                            confirmLabel="Delete?"
                            onConfirm={() => removeUser(u.id)}
                          >
                            <Icon.X size={12} />
                          </ConfirmButton>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="border-t px-4 py-2.5">
          <p className="text-[11px] leading-relaxed text-muted">
            This is a mock: accounts live in this browser's localStorage and no real authentication
            or credential storage is involved.
          </p>
        </div>
      </Card>
    </div>
  )
}
