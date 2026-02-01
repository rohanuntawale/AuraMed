import { useEffect, useMemo, useState } from 'react'
import type { BulkEvent, QueueState, QueueToken, SessionOut, Urgency } from './types'
import { addWalkIn, getCurrentSession, getQueueState, triggerEmergency } from './api'
import { enqueueEvent, flushQueue, getQueuedCount, makeEvent } from './offlineQueue'
import { useOnline } from './useOnline'

function App() {
  const online = useOnline()
  const [session, setSession] = useState<SessionOut | null>(null)
  const [queue, setQueue] = useState<QueueState | null>(null)
  const [error, setError] = useState<string>('')
  const [busy, setBusy] = useState<boolean>(false)

  const [walkPhone, setWalkPhone] = useState('')
  const [walkName, setWalkName] = useState('')
  const [walkUrgency, setWalkUrgency] = useState<Urgency>('low')

  const clientId = useMemo(() => {
    const key = 'opd_client_id_v1'
    const existing = localStorage.getItem(key)
    if (existing) return existing
    const v = `${Date.now()}_${Math.random().toString(16).slice(2)}`
    localStorage.setItem(key, v)
    return v
  }, [])

  async function refreshAll() {
    setError('')
    const s = await getCurrentSession()
    setSession(s)
    const qs = await getQueueState(s.id)
    setQueue(qs)
  }

  async function trySyncOffline() {
    if (!online) return
    if (!session) return
    const count = getQueuedCount()
    if (count === 0) return
    await flushQueue({ clientId, sessionId: session.id })
  }

  async function run(action: () => Promise<void>) {
    setBusy(true)
    try {
      await action()
      await trySyncOffline()
      await refreshAll()
    } catch (e: any) {
      setError(e?.message || 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    refreshAll().catch((e: any) => setError(e?.message || 'Failed to load'))
  }, [])

  useEffect(() => {
    const t = window.setInterval(() => {
      if (!session) return
      getQueueState(session.id)
        .then((qs) => setQueue(qs))
        .catch(() => {})
    }, 3000)
    return () => window.clearInterval(t)
  }, [session])

  useEffect(() => {
    trySyncOffline().catch(() => {})
  }, [online, session])

  const queued = getQueuedCount()

  const serving = queue?.serving || null
  const upcoming: QueueToken[] = queue?.upcoming || []

  function enqueueOrCall(eventType: BulkEvent['event_type'], payload: Record<string, unknown>) {
    enqueueEvent(makeEvent(eventType, payload))
  }

  return (
    <div className="min-h-full text-slate-100">
      <div className="mx-auto max-w-4xl px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-lg font-semibold">OPD Clinic Dashboard</div>
            <div className="text-xs text-slate-300">
              {session ? (
                <>
                  Session {session.date_key} ({session.start_time_local}–{session.end_time_local})
                </>
              ) : (
                <>Loading session…</>
              )}
            </div>
          </div>

          <div className="text-right">
            <div className={`text-xs ${online ? 'text-emerald-300' : 'text-amber-300'}`}>
              {online ? 'Online' : 'Offline'}
            </div>
            <div className="text-xs text-slate-300">Queued actions: {queued}</div>
          </div>
        </div>

        {error ? (
          <div className="mt-3 rounded-lg border border-red-400/40 bg-red-500/10 px-3 py-2 text-sm text-red-100">
            {error}
          </div>
        ) : null}

        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
          <div className="rounded-xl border border-white/10 bg-white/5 p-4 md:col-span-2">
            <div className="text-xs uppercase tracking-wide text-slate-300">Now Serving</div>
            <div className="mt-2">
              {serving ? (
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-3xl font-bold">#{serving.token_no}</div>
                    <div className="text-sm text-slate-200">{serving.name || serving.phone}</div>
                    <div className="text-xs text-slate-400">{serving.urgency}</div>
                  </div>
                  <div className="text-right text-xs text-slate-300">{serving.state}</div>
                </div>
              ) : (
                <div className="text-sm text-slate-300">No active token being served.</div>
              )}
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                disabled={busy || !session}
                className="rounded-lg bg-emerald-500/90 px-3 py-3 text-sm font-semibold text-emerald-950 disabled:opacity-60"
                onClick={() =>
                  run(async () => {
                    if (!session) return
                    if (!online) {
                      enqueueOrCall('SERVE_NEXT', {})
                      return
                    }
                    await fetch(`/api/queue/serve_next?session_id=${session.id}`, { method: 'POST' })
                  })
                }
              >
                Serve Next
              </button>

              <button
                disabled={busy || !session}
                className="rounded-lg bg-slate-200/10 px-3 py-3 text-sm font-semibold text-slate-100 disabled:opacity-60"
                onClick={() => run(async () => refreshAll())}
              >
                Refresh
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-white/10 bg-white/5 p-4">
            <div className="text-xs uppercase tracking-wide text-slate-300">Emergency</div>
            <div className="mt-2 text-sm text-slate-200">Use only after staff/doctor confirmation.</div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                disabled={busy || !session}
                className="rounded-lg bg-amber-400/90 px-3 py-3 text-sm font-semibold text-amber-950 disabled:opacity-60"
                onClick={() =>
                  run(async () => {
                    if (!session) return
                    if (!online) {
                      enqueueOrCall('EMERGENCY', { minutes: 10 })
                      return
                    }
                    await triggerEmergency(session.id, 10)
                  })
                }
              >
                +10 min
              </button>
              <button
                disabled={busy || !session}
                className="rounded-lg bg-amber-400/20 px-3 py-3 text-sm font-semibold text-amber-200 disabled:opacity-60"
                onClick={() =>
                  run(async () => {
                    if (!session) return
                    if (!online) {
                      enqueueOrCall('EMERGENCY', { minutes: 15 })
                      return
                    }
                    await triggerEmergency(session.id, 15)
                  })
                }
              >
                +15 min
              </button>
            </div>
            <div className="mt-3 text-xs text-slate-400">
              Emergency debt: {String((queue?.stats?.emergency_debt_minutes as any) ?? '')}
            </div>
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-white/10 bg-white/5 p-4">
          <div className="flex items-center justify-between">
            <div className="text-xs uppercase tracking-wide text-slate-300">Upcoming Queue</div>
            <div className="text-xs text-slate-400">Tap “Arrived” at reception</div>
          </div>

          <div className="mt-3 divide-y divide-white/5">
            {upcoming.length === 0 ? (
              <div className="py-3 text-sm text-slate-300">No upcoming tokens.</div>
            ) : (
              upcoming.map((t: QueueToken) => (
                <div key={t.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="flex items-center gap-3">
                    <div className="w-16 text-xl font-bold">#{t.token_no}</div>
                    <div>
                      <div className="text-sm text-slate-100">{t.name || t.phone}</div>
                      <div className="text-xs text-slate-400">
                        {t.state} • {t.urgency}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      disabled={busy}
                      className="rounded-md bg-emerald-500/20 px-3 py-2 text-xs font-semibold text-emerald-200 disabled:opacity-60"
                      onClick={() =>
                        run(async () => {
                          if (!online) {
                            enqueueOrCall('ARRIVE', { token_id: t.id })
                            return
                          }
                          await fetch(`/api/tokens/${t.id}/arrive`, { method: 'POST' })
                        })
                      }
                    >
                      Arrived
                    </button>
                    <button
                      disabled={busy || !session}
                      className="rounded-md bg-slate-200/10 px-3 py-2 text-xs font-semibold text-slate-100 disabled:opacity-60"
                      onClick={() =>
                        run(async () => {
                          if (!session) return
                          if (!online) {
                            enqueueOrCall('SKIP', { token_id: t.id })
                            return
                          }
                          await fetch(
                            `/api/queue/skip?session_id=${session.id}&token_id=${t.id}`,
                            { method: 'POST' },
                          )
                        })
                      }
                    >
                      Skip
                    </button>
                    <button
                      disabled={busy || !session}
                      className="rounded-md bg-red-500/20 px-3 py-2 text-xs font-semibold text-red-200 disabled:opacity-60"
                      onClick={() =>
                        run(async () => {
                          if (!session) return
                          if (!online) {
                            enqueueOrCall('CANCEL', { token_id: t.id })
                            return
                          }
                          await fetch(
                            `/api/queue/cancel?session_id=${session.id}&token_id=${t.id}`,
                            { method: 'POST' },
                          )
                        })
                      }
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-white/10 bg-white/5 p-4">
          <div className="text-xs uppercase tracking-wide text-slate-300">Add Walk-in</div>
          <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-4">
            <input
              value={walkPhone}
              onChange={(e) => setWalkPhone(e.target.value)}
              placeholder="Phone"
              className="rounded-lg border border-white/10 bg-black/20 px-3 py-3 text-sm text-slate-100 outline-none"
            />
            <input
              value={walkName}
              onChange={(e) => setWalkName(e.target.value)}
              placeholder="Name"
              className="rounded-lg border border-white/10 bg-black/20 px-3 py-3 text-sm text-slate-100 outline-none"
            />
            <select
              value={walkUrgency}
              onChange={(e) => setWalkUrgency(e.target.value as Urgency)}
              className="rounded-lg border border-white/10 bg-black/20 px-3 py-3 text-sm text-slate-100 outline-none"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
            <button
              disabled={busy || !session || !walkPhone.trim()}
              className="rounded-lg bg-sky-400/90 px-3 py-3 text-sm font-semibold text-sky-950 disabled:opacity-60"
              onClick={() =>
                run(async () => {
                  if (!session) return
                  if (!online) {
                    setError('Walk-in requires internet in this MVP.')
                    return
                  }
                  await addWalkIn(session.id, {
                    phone: walkPhone.trim(),
                    name: walkName.trim(),
                    urgency: walkUrgency,
                  })
                  setWalkPhone('')
                  setWalkName('')
                  setWalkUrgency('low')
                })
              }
            >
              Add Walk-in
            </button>
          </div>
          <div className="mt-2 text-xs text-slate-400">
            Patient-facing arrival windows are handled via backend booking APIs.
          </div>
        </div>
      </div>
    </div>
  )
}

export default App
