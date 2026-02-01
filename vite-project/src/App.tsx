import { useEffect, useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { BulkEvent, QueueState, QueueToken, SessionOut, Urgency } from './types'
import { addWalkIn, bookToken, getCurrentSession, getQueueState, intake, triggerEmergency } from './api'
import { enqueueEvent, flushQueue, getQueuedCount, makeEvent } from './offlineQueue'
import { useOnline } from './useOnline'

type Mode = 'patient' | 'staff'

function getStoredPin(): string {
  try {
    return localStorage.getItem('opd_clinic_pin_v1') || ''
  } catch {
    return ''
  }
}

function setStoredPin(pin: string) {
  try {
    localStorage.setItem('opd_clinic_pin_v1', pin)
  } catch {
    return
  }
}

function clearStoredPin() {
  try {
    localStorage.removeItem('opd_clinic_pin_v1')
  } catch {
    return
  }
}

function App() {
  const online = useOnline()

  const [mode, setMode] = useState<Mode>('patient')
  const [pin, setPin] = useState<string>(() => getStoredPin())
  const [pinDraft, setPinDraft] = useState<string>('')

  const [session, setSession] = useState<SessionOut | null>(null)
  const [queue, setQueue] = useState<QueueState | null>(null)
  const [error, setError] = useState<string>('')
  const [busy, setBusy] = useState<boolean>(false)

  const [walkPhone, setWalkPhone] = useState('')
  const [walkName, setWalkName] = useState('')
  const [walkUrgency, setWalkUrgency] = useState<Urgency>('low')

  const [pPhone, setPPhone] = useState('')
  const [pName, setPName] = useState('')
  const [pComplaint, setPComplaint] = useState('')
  const [pIntake, setPIntake] = useState<{ urgency: Urgency; intake_summary: string } | null>(null)
  const [pBooked, setPBooked] = useState<{
    token_no: number
    arrival_window_start: string
    arrival_window_end: string
  } | null>(null)

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
      if (mode === 'staff') {
        await refreshAll()
      }
    } catch (e: any) {
      setError(e?.message || 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (mode !== 'staff') return
    refreshAll().catch((e: any) => setError(e?.message || 'Failed to load'))
  }, [mode])

  useEffect(() => {
    if (mode !== 'staff') return
    const t = window.setInterval(() => {
      if (!session) return
      getQueueState(session.id)
        .then((qs) => setQueue(qs))
        .catch(() => {})
    }, 3000)
    return () => window.clearInterval(t)
  }, [mode, session])

  useEffect(() => {
    if (mode !== 'staff') return
    trySyncOffline().catch(() => {})
  }, [mode, online, session])

  const queued = getQueuedCount()
  const serving = queue?.serving || null
  const upcoming: QueueToken[] = queue?.upcoming || []

  function enqueueOrCall(eventType: BulkEvent['event_type'], payload: Record<string, unknown>) {
    enqueueEvent(makeEvent(eventType, payload))
  }

  const shell = (
    <div className="min-h-full">
      <div className="mx-auto max-w-5xl px-4 py-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="om-serif text-2xl" style={{ color: 'var(--om-text)' }}>
              Aura OPD
            </div>
            <div className="text-xs" style={{ color: 'var(--om-muted)' }}>
              Queue & flow orchestration. No diagnosis. No exact-time promises.
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              className={`om-button px-3 py-2 text-xs ${mode === 'patient' ? 'om-card-strong' : ''}`}
              onClick={() => {
                setError('')
                setMode('patient')
              }}
            >
              Patient
            </button>
            <button
              className={`om-button px-3 py-2 text-xs ${mode === 'staff' ? 'om-card-strong' : ''}`}
              onClick={() => {
                setError('')
                setMode('staff')
              }}
            >
              Staff
            </button>
          </div>
        </div>

        {error ? (
          <div className="mt-4 om-card-strong px-4 py-3 text-sm" style={{ color: 'rgba(255,200,200,0.95)' }}>
            {error}
          </div>
        ) : null}

        <div className="mt-4">{mode === 'staff' ? renderStaff() : renderPatient()}</div>
      </div>
    </div>
  )

  function renderStaff() {
    if (!pin) {
      return (
        <div className="om-card mx-auto max-w-md px-5 py-5">
          <div className="om-serif text-xl">Staff Access</div>
          <div className="mt-2 text-sm" style={{ color: 'var(--om-muted)' }}>
            Enter the clinic PIN to operate the queue. This is not patient-facing.
          </div>

          <div className="mt-4">
            <input
              value={pinDraft}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setPinDraft(e.target.value)}
              placeholder="Clinic PIN"
              className="om-input w-full px-4 py-3 text-sm outline-none"
              inputMode="numeric"
              type="password"
            />
            <button
              disabled={!pinDraft.trim()}
              className="om-button-primary mt-3 w-full px-4 py-3 text-sm font-semibold disabled:opacity-60"
              onClick={() =>
                run(async () => {
                  const v = pinDraft.trim()
                  setStoredPin(v)
                  setPin(v)
                  setPinDraft('')
                  await refreshAll()
                })
              }
            >
              Unlock Dashboard
            </button>
          </div>

          <div className="mt-4 text-xs" style={{ color: 'var(--om-muted)' }}>
            If you forget the PIN, ask the clinic owner. This MVP uses a shared PIN (Option A).
          </div>
        </div>
      )
    }

    const statsDebt = String((queue?.stats?.emergency_debt_minutes as any) ?? '')

    return (
      <div>
        <div className="flex items-start justify-between gap-3">
          <div className="text-xs" style={{ color: 'var(--om-muted)' }}>
            {session ? (
              <>
                Session {session.date_key} ({session.start_time_local}–{session.end_time_local})
              </>
            ) : (
              <>Loading session…</>
            )}
          </div>
          <div className="text-right">
            <div className="text-xs" style={{ color: online ? 'rgba(143, 200, 188, 0.95)' : 'rgba(214, 186, 120, 0.95)' }}>
              {online ? 'Online' : 'Offline'}
            </div>
            <div className="text-xs" style={{ color: 'var(--om-muted)' }}>
              Queued actions: {queued}
            </div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
          <div className="om-card px-4 py-4 md:col-span-2">
            <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--om-muted)' }}>
              Now Serving
            </div>
            <div className="mt-2">
              {serving ? (
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="om-serif text-4xl">#{serving.token_no}</div>
                    <div className="text-sm" style={{ color: 'var(--om-text)' }}>
                      {serving.name || serving.phone}
                    </div>
                    <div className="text-xs" style={{ color: 'var(--om-muted)' }}>
                      {serving.urgency}
                    </div>
                  </div>
                  <div className="text-right text-xs" style={{ color: 'var(--om-muted)' }}>
                    {serving.state}
                  </div>
                </div>
              ) : (
                <div className="text-sm" style={{ color: 'var(--om-muted)' }}>
                  No active token being served.
                </div>
              )}
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                disabled={busy || !session}
                className="om-button-primary px-3 py-3 text-sm font-semibold disabled:opacity-60"
                onClick={() =>
                  run(async () => {
                    if (!session) return
                    if (!online) {
                      enqueueOrCall('SERVE_NEXT', {})
                      return
                    }
                    await fetch(`/api/queue/serve_next?session_id=${session.id}`, { method: 'POST', headers: { 'X-Clinic-Pin': pin } })
                  })
                }
              >
                Serve Next
              </button>

              <button
                disabled={busy || !session}
                className="om-button px-3 py-3 text-sm font-semibold disabled:opacity-60"
                onClick={() => run(async () => refreshAll())}
              >
                Refresh
              </button>
            </div>
          </div>

          <div className="om-card px-4 py-4">
            <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--om-muted)' }}>
              Emergency
            </div>
            <div className="mt-2 text-sm" style={{ color: 'var(--om-text)' }}>
              Use only after staff/doctor confirmation.
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                disabled={busy || !session}
                className="om-button-primary px-3 py-3 text-sm font-semibold disabled:opacity-60"
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
                className="om-button px-3 py-3 text-sm font-semibold disabled:opacity-60"
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
            <div className="mt-3 text-xs" style={{ color: 'var(--om-muted)' }}>
              Emergency debt: {statsDebt}
            </div>
            <button
              className="om-button mt-3 w-full px-3 py-3 text-xs"
              onClick={() => {
                clearStoredPin()
                setPin('')
                setQueue(null)
                setSession(null)
              }}
            >
              Lock
            </button>
          </div>
        </div>

        <div className="mt-4 om-card px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--om-muted)' }}>
              Upcoming Queue
            </div>
            <div className="text-xs" style={{ color: 'var(--om-muted)' }}>
              Tap “Arrived” at reception
            </div>
          </div>

          <div className="mt-3 divide-y" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
            {upcoming.length === 0 ? (
              <div className="py-3 text-sm" style={{ color: 'var(--om-muted)' }}>
                No upcoming tokens.
              </div>
            ) : (
              upcoming.map((t: QueueToken) => (
                <div key={t.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="flex items-center gap-3">
                    <div className="om-serif w-16 text-2xl">#{t.token_no}</div>
                    <div>
                      <div className="text-sm" style={{ color: 'var(--om-text)' }}>
                        {t.name || t.phone}
                      </div>
                      <div className="text-xs" style={{ color: 'var(--om-muted)' }}>
                        {t.state} • {t.urgency}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      disabled={busy}
                      className="om-button px-3 py-2 text-xs font-semibold disabled:opacity-60"
                      onClick={() =>
                        run(async () => {
                          if (!online) {
                            enqueueOrCall('ARRIVE', { token_id: t.id })
                            return
                          }
                          await fetch(`/api/tokens/${t.id}/arrive`, { method: 'POST', headers: { 'X-Clinic-Pin': pin } })
                        })
                      }
                    >
                      Arrived
                    </button>
                    <button
                      disabled={busy || !session}
                      className="om-button px-3 py-2 text-xs font-semibold disabled:opacity-60"
                      onClick={() =>
                        run(async () => {
                          if (!session) return
                          if (!online) {
                            enqueueOrCall('SKIP', { token_id: t.id })
                            return
                          }
                          await fetch(`/api/queue/skip?session_id=${session.id}&token_id=${t.id}`, {
                            method: 'POST',
                            headers: { 'X-Clinic-Pin': pin },
                          })
                        })
                      }
                    >
                      Skip
                    </button>
                    <button
                      disabled={busy || !session}
                      className="om-button px-3 py-2 text-xs font-semibold disabled:opacity-60"
                      onClick={() =>
                        run(async () => {
                          if (!session) return
                          if (!online) {
                            enqueueOrCall('CANCEL', { token_id: t.id })
                            return
                          }
                          await fetch(`/api/queue/cancel?session_id=${session.id}&token_id=${t.id}`, {
                            method: 'POST',
                            headers: { 'X-Clinic-Pin': pin },
                          })
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

        <div className="mt-4 om-card px-4 py-4">
          <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--om-muted)' }}>
            Add Walk-in
          </div>
          <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-4">
            <input
              value={walkPhone}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setWalkPhone(e.target.value)}
              placeholder="Phone"
              className="om-input px-3 py-3 text-sm outline-none"
            />
            <input
              value={walkName}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setWalkName(e.target.value)}
              placeholder="Name"
              className="om-input px-3 py-3 text-sm outline-none"
            />
            <select
              value={walkUrgency}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => setWalkUrgency(e.target.value as Urgency)}
              className="om-input px-3 py-3 text-sm outline-none"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
            <button
              disabled={busy || !session || !walkPhone.trim()}
              className="om-button-primary px-3 py-3 text-sm font-semibold disabled:opacity-60"
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
        </div>
      </div>
    )
  }

  function renderPatient() {
    return (
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="om-card px-5 py-5">
          <div className="om-serif text-xl">Book an OPD token</div>
          <div className="mt-2 text-sm" style={{ color: 'var(--om-muted)' }}>
            You will get an estimated arrival window. Exact consultation times are not promised.
          </div>

          <div className="mt-4 grid grid-cols-1 gap-2">
            <input
              value={pPhone}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setPPhone(e.target.value)}
              placeholder="Phone"
              className="om-input px-4 py-3 text-sm outline-none"
              inputMode="tel"
            />
            <input
              value={pName}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setPName(e.target.value)}
              placeholder="Name (optional)"
              className="om-input px-4 py-3 text-sm outline-none"
            />
          </div>

          <div className="mt-3 om-card-strong px-4 py-4">
            <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--om-muted)' }}>
              Describe your concern
            </div>
            <div className="mt-2 text-sm" style={{ color: 'var(--om-muted)' }}>
              This is a descriptive intake only. No diagnosis is provided.
            </div>
            <textarea
              value={pComplaint}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setPComplaint(e.target.value)}
              placeholder="Type what you’re feeling…"
              className="om-input mt-3 w-full px-4 py-3 text-sm outline-none"
              rows={5}
              maxLength={2000}
            />
            <div className="mt-2 flex items-center justify-between">
              <div className="text-xs" style={{ color: 'var(--om-muted)' }}>
                “Voice” mode: tap to paste dictated text
              </div>
              <button
                className="om-button px-3 py-2 text-xs"
                onClick={() => {
                  setPComplaint((v: string) => (v ? v + '\n' : '') + '[Simulated voice-to-text] ')
                }}
              >
                Mic
              </button>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              disabled={busy || !pPhone.trim() || !pComplaint.trim()}
              className="om-button px-4 py-3 text-sm font-semibold disabled:opacity-60"
              onClick={() =>
                run(async () => {
                  setPBooked(null)
                  setPIntake(null)
                  const r = await intake({
                    phone: pPhone.trim(),
                    name: pName.trim(),
                    complaint_text: pComplaint.trim(),
                  })
                  setPIntake(r)
                })
              }
            >
              Check urgency
            </button>
            <button
              disabled={busy || !pPhone.trim() || !pComplaint.trim()}
              className="om-button-primary px-4 py-3 text-sm font-semibold disabled:opacity-60"
              onClick={() =>
                run(async () => {
                  setPBooked(null)
                  const r = await bookToken({
                    phone: pPhone.trim(),
                    name: pName.trim(),
                    complaint_text: pComplaint.trim(),
                  })
                  setPBooked({
                    token_no: r.token_no,
                    arrival_window_start: r.arrival_window_start,
                    arrival_window_end: r.arrival_window_end,
                  })
                })
              }
            >
              Book token
            </button>
          </div>

          {pIntake ? (
            <div className="mt-4 om-card px-4 py-4">
              <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--om-muted)' }}>
                Intake result
              </div>
              <div className="mt-2 text-sm" style={{ color: 'var(--om-text)' }}>
                Urgency label: <span className="font-semibold">{pIntake.urgency}</span>
              </div>
              <div className="mt-2 whitespace-pre-wrap text-xs" style={{ color: 'var(--om-muted)' }}>
                {pIntake.intake_summary}
              </div>
              {pIntake.urgency === 'high' ? (
                <div className="mt-3 text-xs" style={{ color: 'rgba(214, 186, 120, 0.95)' }}>
                  If you feel unsafe or symptoms worsen, seek urgent medical help immediately. Staff will confirm emergency priority.
                </div>
              ) : null}
            </div>
          ) : null}

          {pBooked ? (
            <div className="mt-4 om-card-strong px-4 py-4">
              <div className="om-serif text-lg">Token confirmed</div>
              <div className="mt-2 text-sm" style={{ color: 'var(--om-text)' }}>
                Token #{pBooked.token_no}
              </div>
              <div className="mt-1 text-sm" style={{ color: 'var(--om-text)' }}>
                Estimated arrival window: {pBooked.arrival_window_start} – {pBooked.arrival_window_end}
              </div>
              <div className="mt-2 text-xs" style={{ color: 'var(--om-muted)' }}>
                Times may vary depending on consultation duration and urgent cases.
              </div>
            </div>
          ) : null}
        </div>

        <div className="om-card px-5 py-5">
          <div className="om-serif text-xl">What this system does</div>
          <div className="mt-3 text-sm" style={{ color: 'var(--om-muted)' }}>
            It manages an OPD queue with flexible arrival windows.
          </div>
          <div className="mt-4 space-y-3 text-sm" style={{ color: 'var(--om-text)' }}>
            <div className="om-card-strong px-4 py-4">
              <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--om-muted)' }}>
                No diagnosis
              </div>
              <div className="mt-1 text-sm" style={{ color: 'var(--om-muted)' }}>
                This intake is only a descriptive summary for the doctor.
              </div>
            </div>
            <div className="om-card-strong px-4 py-4">
              <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--om-muted)' }}>
                No exact times
              </div>
              <div className="mt-1 text-sm" style={{ color: 'var(--om-muted)' }}>
                You’ll get a window. Actual timing may shift due to real OPD conditions.
              </div>
            </div>
            <div className="om-card-strong px-4 py-4">
              <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--om-muted)' }}>
                Emergency cases
              </div>
              <div className="mt-1 text-sm" style={{ color: 'var(--om-muted)' }}>
                High-priority cases may cause delays. Staff/doctor always confirms emergency priority.
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return shell
}

export default App
