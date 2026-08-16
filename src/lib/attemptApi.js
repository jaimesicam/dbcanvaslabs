// REST client for the real backend (server/) — same conventions as dbcanvas's own
// lib/api.js: same-origin JSON, throws Error with .status on non-2xx.

async function request(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } }
  if (body !== undefined) opts.body = JSON.stringify(body)

  const res = await fetch(path, opts)
  let data = null
  const text = await res.text()
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
  }
  if (!res.ok) {
    const msg = (data && data.error) || `Request failed (${res.status})`
    const err = new Error(msg)
    err.status = res.status
    throw err
  }
  return data
}

export const attemptApi = {
  create: (labId) => request('POST', '/api/attempts', { labId }),
  get: (id) => request('GET', `/api/attempts/${id}`),
  destroy: (id) => request('POST', `/api/attempts/${id}/destroy`),
  check: (id, taskId) => request('POST', `/api/attempts/${id}/check`, { taskId }),
  state: (id) => request('GET', `/api/attempts/${id}/state`),
  termURL: (id, nodeId) => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    return `${proto}://${location.host}/api/attempts/${id}/nodes/${nodeId}/term`
  },
}
