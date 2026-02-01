import { useEffect, useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { BulkEvent, Clinic, Doctor, Notification, QueueState, QueueToken, SessionOut, Slot, SlotsOut, Urgency } from './types'
import {
  addWalkIn,
  adminCreateClinic,
  adminCreateDoctor,
  arriveToken,
  bookSlot,
  cancelToken,
  createSession,
  dismissNotification,
  getQueueState,
  getSessionSlots,
  intake,
  listClinics,
  listDoctors,
  listNotifications,
  skipToken,
  triggerEmergency,
} from './api'
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

function getStoredDoctorContext(): { clinic_id: string; doctor_id: string } {
  try {
    const raw = localStorage.getItem('opd_doctor_ctx_v1')
    if (!raw) return { clinic_id: 'default', doctor_id: 'default' }
    const parsed = JSON.parse(raw)
    const clinic_id = String(parsed?.clinic_id || 'default')
    const doctor_id = String(parsed?.doctor_id || 'default')
    return { clinic_id, doctor_id }
  } catch {
    return { clinic_id: 'default', doctor_id: 'default' }
  }
}

function setStoredDoctorContext(v: { clinic_id: string; doctor_id: string }) {
  try {
    localStorage.setItem('opd_doctor_ctx_v1', JSON.stringify(v))
  } catch {
    return
  }
}

function App() {
  const online = useOnline()

  const [mode, setMode] = useState<Mode>('patient')
  const [pin, setPin] = useState<string>(() => getStoredPin())
  const [pinDraft, setPinDraft] = useState<string>('')
  const [staffStep, setStaffStep] = useState<'pin' | 'doctor' | 'dashboard'>(() => (getStoredPin() ? 'doctor' : 'pin'))

  const [session, setSession] = useState<SessionOut | null>(null)
  const [queue, setQueue] = useState<QueueState | null>(null)
  const [error, setError] = useState<string>('')
  const [notice, setNotice] = useState<string>('')
  const [busy, setBusy] = useState<boolean>(false)

  const [clinics, setClinics] = useState<Clinic[]>([])
  const [doctors, setDoctors] = useState<Doctor[]>([])
  const [selectedClinicId, setSelectedClinicId] = useState<string>(() => getStoredDoctorContext().clinic_id)
  const [selectedDoctorId, setSelectedDoctorId] = useState<string>(() => getStoredDoctorContext().doctor_id)

  const [adminClinicId, setAdminClinicId] = useState('')
  const [adminClinicName, setAdminClinicName] = useState('')
  const [adminDoctorClinicId, setAdminDoctorClinicId] = useState('')
  const [adminDoctorId, setAdminDoctorId] = useState('')
  const [adminDoctorName, setAdminDoctorName] = useState('')

  const [walkPhone, setWalkPhone] = useState('')
  const [walkName, setWalkName] = useState('')
  const [walkUrgency, setWalkUrgency] = useState<Urgency>('low')

  const [pPhone, setPPhone] = useState('')
  const [pName, setPName] = useState('')
  const [pComplaint, setPComplaint] = useState('')
  const [pDateKey, setPDateKey] = useState(() => new Date().toISOString().slice(0, 10))
  const [pSlots, setPSlots] = useState<SlotsOut | null>(null)
  const [pSelectedSlot, setPSelectedSlot] = useState<number | null>(null)
  const [pNotifs, setPNotifs] = useState<Notification[]>([])
  const [pIntake, setPIntake] = useState<{
    urgency: Urgency
    intake_summary: string
    risk_score: number
    model_used: string
  } | null>(null)
  const [pBooked, setPBooked] = useState<{
    token_no: number
    arrival_window_start: string
    arrival_window_end: string
    scheduled_start_local?: string
    scheduled_end_local?: string
  } | null>(null)

  const pPhoneOk = pPhone.trim().length >= 6
  const walkPhoneOk = walkPhone.trim().length >= 6

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
    const s = await createSession({
      date_key: new Date().toISOString().slice(0, 10),
      clinic_id: selectedClinicId,
      doctor_id: selectedDoctorId,
    })
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
      setNotice('')
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
    listClinics()
      .then((x) => setClinics(x.clinics || []))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!selectedClinicId) return
    listDoctors(selectedClinicId)
      .then((x) => setDoctors(x.doctors || []))
      .catch(() => setDoctors([]))
  }, [selectedClinicId])

  useEffect(() => {
    if (mode !== 'patient') return
    setError('')
    createSession({ date_key: pDateKey, clinic_id: selectedClinicId, doctor_id: selectedDoctorId })
      .then((s) => {
        setSession(s)
        setPSelectedSlot(null)
        setPBooked(null)
      })
      .catch((e: any) => setError(e?.message || 'Failed to load'))
  }, [mode, pDateKey, selectedClinicId, selectedDoctorId])

  useEffect(() => {
    if (mode !== 'patient') return
    if (!session) return
    getSessionSlots(session.id)
      .then((x) => {
        setPSlots(x)
      })
      .catch(() => {})
  }, [mode, session])

  useEffect(() => {
    if (mode !== 'patient') return
    if (!pPhoneOk) {
      setPNotifs([])
      return
    }

    let stopped = false
    const load = async () => {
      try {
        const res = await listNotifications(pPhone.trim())
        if (!stopped) setPNotifs(res.notifications || [])
      } catch {
        return
      }
    }

    load().catch(() => {})
    const t = window.setInterval(() => {
      load().catch(() => {})
    }, 5000)
    return () => {
      stopped = true
      window.clearInterval(t)
    }
  }, [mode, pPhoneOk, pPhone])

  useEffect(() => {
    if (mode !== 'staff') return
    const t = window.setInterval(() => {
      refreshAll().catch((e: any) => {
        setError(e?.message || 'Failed to refresh')
      })
    }, 3000)
    return () => window.clearInterval(t)
  }, [mode])

  useEffect(() => {
    if (mode !== 'staff') return
    trySyncOffline().catch(() => {})
  }, [mode, online, session])

  const queued = getQueuedCount()
  const serving = queue?.serving || null
  const upcoming: QueueToken[] = queue?.upcoming || []

  function stateBadge(state: string) {
    const s = (state || '').toUpperCase()
    const cfg: Record<string, { bg: string; fg: string; border: string }> = {
      ARRIVED: { bg: 'rgba(143, 200, 188, 0.22)', fg: 'rgba(223, 255, 248, 0.96)', border: 'rgba(143, 200, 188, 0.55)' },
      SKIPPED: { bg: 'rgba(214, 186, 120, 0.22)', fg: 'rgba(255, 245, 220, 0.96)', border: 'rgba(214, 186, 120, 0.55)' },
      BOOKED: { bg: 'rgba(255,255,255,0.06)', fg: 'rgba(255,255,255,0.75)', border: 'rgba(255,255,255,0.10)' },
      SERVING: { bg: 'rgba(120, 160, 214, 0.18)', fg: 'rgba(160, 195, 255, 0.95)', border: 'rgba(120, 160, 214, 0.35)' },
      CANCELLED: { bg: 'rgba(255, 120, 120, 0.12)', fg: 'rgba(255,200,200,0.95)', border: 'rgba(255, 120, 120, 0.25)' },
      COMPLETED: { bg: 'rgba(255,255,255,0.05)', fg: 'rgba(255,255,255,0.65)', border: 'rgba(255,255,255,0.08)' },
    }
    const c = cfg[s] || { bg: 'rgba(255,255,255,0.06)', fg: 'rgba(255,255,255,0.75)', border: 'rgba(255,255,255,0.10)' }
    return (
      <span
        style={{
          display: 'inline-block',
          background: c.bg,
          color: c.fg,
          border: `1px solid ${c.border}`,
          borderRadius: 999,
          padding: '2px 8px',
          fontSize: 11,
          lineHeight: '16px',
          fontWeight: 600,
        }}
      >
        {s}
      </span>
    )
  }

  function enqueueOrCall(eventType: BulkEvent['event_type'], payload: Record<string, unknown>) {
    enqueueEvent(makeEvent(eventType, payload))
  }

  const shell = (
    <div className="min-h-full">
      {busy ? (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            height: 3,
            background: 'linear-gradient(90deg, rgba(214, 186, 120, 0.0), rgba(214, 186, 120, 0.95), rgba(214, 186, 120, 0.0))',
            opacity: 0.9,
            zIndex: 50,
            animation: 'omPulse 1.1s ease-in-out infinite',
          }}
        />
      ) : null}
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

        {notice ? (
          <div className="mt-4 om-card-strong px-4 py-3 text-sm" style={{ color: 'rgba(143, 200, 188, 0.95)' }}>
            {notice}
          </div>
        ) : null}

        <div className="mt-4">{mode === 'staff' ? renderStaff() : renderPatient()}</div>
      </div>
    </div>
  )

  function renderStaff() {
    if (!pin || staffStep === 'pin') {
      return (
        <div className="om-card mx-auto max-w-md px-5 py-5">
          <div className="om-serif text-xl">Clinic Login</div>
          <div className="mt-2 text-sm" style={{ color: 'var(--om-muted)' }}>
            Enter the clinic PIN to access staff operations.
          </div>

          <div className="mt-4">
            <select
              value={selectedClinicId}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                const v = e.target.value
                setSelectedClinicId(v)
                setSelectedDoctorId('default')
                setStoredDoctorContext({ clinic_id: v, doctor_id: 'default' })
              }}
              className="om-input mb-2 w-full px-4 py-3 text-sm outline-none"
            >
              {(clinics.length ? clinics : [{ clinic_id: 'default', clinic_name: 'Default Clinic' }]).map((c) => (
                <option key={c.clinic_id} value={c.clinic_id}>
                  {c.clinic_name || c.clinic_id}
                </option>
              ))}
            </select>
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
                  setStaffStep('doctor')
                })
              }
            >
              Continue
            </button>
          </div>

          <div className="mt-4 text-xs" style={{ color: 'var(--om-muted)' }}>
            If you forget the PIN, ask the clinic owner. This MVP uses a shared PIN (Option A).
          </div>
        </div>
      )
    }

    if (staffStep === 'doctor') {
      return (
        <div className="om-card mx-auto max-w-3xl px-5 py-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="om-serif text-xl">Doctor Setup</div>
              <div className="mt-2 text-sm" style={{ color: 'var(--om-muted)' }}>
                Select which clinic/doctor queue you want to operate.
              </div>
            </div>
            <button
              className="om-button px-3 py-2 text-xs"
              onClick={() =>
                run(async () => {
                  clearStoredPin()
                  setPin('')
                  setPinDraft('')
                  setStaffStep('pin')
                  setQueue(null)
                  setSession(null)
                })
              }
            >
              Logout
            </button>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-2">
            <select
              value={selectedClinicId}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                const v = e.target.value
                setSelectedClinicId(v)
                setSelectedDoctorId('default')
                setStoredDoctorContext({ clinic_id: v, doctor_id: 'default' })
              }}
              className="om-input px-3 py-3 text-sm outline-none"
            >
              {(clinics.length ? clinics : [{ clinic_id: 'default', clinic_name: 'Default Clinic' }]).map((c) => (
                <option key={c.clinic_id} value={c.clinic_id}>
                  {c.clinic_name || c.clinic_id}
                </option>
              ))}
            </select>
            <select
              value={selectedDoctorId}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                const v = e.target.value
                setSelectedDoctorId(v)
                setStoredDoctorContext({ clinic_id: selectedClinicId, doctor_id: v })
              }}
              className="om-input px-3 py-3 text-sm outline-none"
            >
              {(doctors.length ? doctors : [{ clinic_id: 'default', doctor_id: 'default', doctor_name: 'Default Doctor' }]).map((d) => (
                <option key={`${d.clinic_id}_${d.doctor_id}`} value={d.doctor_id}>
                  {d.doctor_name || d.doctor_id}
                </option>
              ))}
            </select>
          </div>

          <div className="mt-4 om-card-strong px-4 py-4">
            <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--om-muted)' }}>
              Admin: Create clinics & doctors
            </div>
            <div className="mt-2 text-xs" style={{ color: 'var(--om-muted)' }}>
              Use this to onboard new clinics/doctors. Codes will appear in the notice banner.
            </div>

            <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-3">
              <input
                value={adminClinicId}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setAdminClinicId(e.target.value)}
                placeholder="Clinic ID (e.g. aura_main)"
                className="om-input px-3 py-3 text-sm outline-none"
              />
              <input
                value={adminClinicName}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setAdminClinicName(e.target.value)}
                placeholder="Clinic name"
                className="om-input px-3 py-3 text-sm outline-none"
              />
              <button
                disabled={busy || !adminClinicId.trim()}
                className="om-button-primary px-3 py-3 text-sm font-semibold disabled:opacity-60"
                onClick={() =>
                  run(async () => {
                    const r = await adminCreateClinic({ clinic_id: adminClinicId.trim(), clinic_name: adminClinicName.trim() })
                    setNotice(`Clinic created: ${r.clinic_id} • Clinic code: ${r.clinic_code} • Clinic PIN: ${r.clinic_pin}`)
                    setAdminDoctorClinicId(r.clinic_id)
                    const x = await listClinics()
                    setClinics(x.clinics || [])
                  })
                }
              >
                Create clinic
              </button>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-4">
              <input
                value={adminDoctorClinicId}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setAdminDoctorClinicId(e.target.value)}
                placeholder="Clinic ID"
                className="om-input px-3 py-3 text-sm outline-none"
              />
              <input
                value={adminDoctorId}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setAdminDoctorId(e.target.value)}
                placeholder="Doctor ID (e.g. dr_singh)"
                className="om-input px-3 py-3 text-sm outline-none"
              />
              <input
                value={adminDoctorName}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setAdminDoctorName(e.target.value)}
                placeholder="Doctor name"
                className="om-input px-3 py-3 text-sm outline-none"
              />
              <button
                disabled={busy || !adminDoctorClinicId.trim() || !adminDoctorId.trim()}
                className="om-button-primary px-3 py-3 text-sm font-semibold disabled:opacity-60"
                onClick={() =>
                  run(async () => {
                    const r = await adminCreateDoctor({
                      clinic_id: adminDoctorClinicId.trim(),
                      doctor_id: adminDoctorId.trim(),
                      doctor_name: adminDoctorName.trim(),
                    })
                    setNotice(`Doctor created: ${r.doctor_id} (${r.clinic_id}) • Doctor code: ${r.doctor_code}`)
                    const d = await listDoctors(adminDoctorClinicId.trim())
                    setDoctors(d.doctors || [])
                  })
                }
              >
                Create doctor
              </button>
            </div>
          </div>

          <div className="mt-4">
            <button
              disabled={busy || !selectedClinicId || !selectedDoctorId}
              className="om-button-primary w-full px-4 py-3 text-sm font-semibold disabled:opacity-60"
              onClick={() =>
                run(async () => {
                  setStaffStep('dashboard')
                  await refreshAll()
                })
              }
            >
              Continue to dashboard
            </button>
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

        <div className="mt-3 flex items-center justify-between">
          <div className="text-xs" style={{ color: 'var(--om-muted)' }}>
            Active: {selectedClinicId} / {selectedDoctorId}
          </div>
          <button className="om-button px-3 py-2 text-xs" onClick={() => setStaffStep('doctor')}>
            Change doctor
          </button>
        </div>

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
                        <span className="mr-2">{stateBadge(t.state)}</span>
                        {t.scheduled_start_local ? (
                          <span>
                            {t.scheduled_start_local}
                            {t.scheduled_end_local ? `–${t.scheduled_end_local}` : ''} •{' '}
                          </span>
                        ) : null}
                        {t.urgency}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      disabled={busy || !session}
                      className="om-button px-3 py-2 text-xs"
                      onClick={() =>
                        run(async () => {
                          if (!online) {
                            enqueueOrCall('ARRIVE', { token_id: t.id })
                            setNotice('Queued Arrived action (offline). It will sync when online.')
                            return
                          }
                          await arriveToken(t.id)
                          setQueue((prev) => {
                            if (!prev) return prev
                            return {
                              ...prev,
                              upcoming: prev.upcoming.map((x) => (x.id === t.id ? { ...x, state: 'ARRIVED' } : x)),
                            }
                          })
                          setNotice(`Marked token #${t.token_no} as ARRIVED`)
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
                            setNotice('Queued Skip action (offline). It will sync when online.')
                            return
                          }
                          await skipToken(session.id, t.id)
                          setQueue((prev) => {
                            if (!prev) return prev
                            return {
                              ...prev,
                              upcoming: prev.upcoming.map((x) => (x.id === t.id ? { ...x, state: 'SKIPPED' } : x)),
                            }
                          })
                          setNotice(`Skipped token #${t.token_no}`)
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
                            setNotice('Queued Cancel action (offline). It will sync when online.')
                            return
                          }
                          await cancelToken(session.id, t.id)
                          setQueue((prev) => {
                            if (!prev) return prev
                            return {
                              ...prev,
                              upcoming: prev.upcoming.filter((x) => x.id !== t.id),
                            }
                          })
                          setNotice(`Cancelled token #${t.token_no}`)
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
              disabled={busy || !session || !walkPhoneOk}
              className="om-button-primary px-3 py-3 text-sm font-semibold disabled:opacity-60"
              onClick={() =>
                run(async () => {
                  if (!session) return
                  if (!walkPhoneOk) {
                    throw new Error('Enter a valid phone number (min 6 digits).')
                  }
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

          <div className="mt-4 om-card-strong px-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--om-muted)' }}>
                Pick a time slot
              </div>
              <input
                type="date"
                value={pDateKey}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setPDateKey(e.target.value)}
                className="om-input px-3 py-2 text-xs outline-none"
              />
            </div>

            <div className="mt-3 flex items-center justify-between">
              <div className="text-xs" style={{ color: 'var(--om-muted)' }}>
                Clinic / Doctor selection
              </div>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
              <select
                value={selectedClinicId}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                  const v = e.target.value
                  setSelectedClinicId(v)
                  setSelectedDoctorId('default')
                  setStoredDoctorContext({ clinic_id: v, doctor_id: 'default' })
                  setPSelectedSlot(null)
                }}
                className="om-input px-3 py-3 text-sm outline-none"
              >
                {(clinics.length ? clinics : [{ clinic_id: 'default', clinic_name: 'Default Clinic' }]).map((c) => (
                  <option key={c.clinic_id} value={c.clinic_id}>
                    {c.clinic_name || c.clinic_id}
                  </option>
                ))}
              </select>
              <select
                value={selectedDoctorId}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                  const v = e.target.value
                  setSelectedDoctorId(v)
                  setStoredDoctorContext({ clinic_id: selectedClinicId, doctor_id: v })
                  setPSelectedSlot(null)
                }}
                className="om-input px-3 py-3 text-sm outline-none"
              >
                {(doctors.length ? doctors : [{ clinic_id: 'default', doctor_id: 'default', doctor_name: 'Default Doctor' }]).map((d) => (
                  <option key={`${d.clinic_id}_${d.doctor_id}`} value={d.doctor_id}>
                    {d.doctor_name || d.doctor_id}
                  </option>
                ))}
              </select>
            </div>
            <div className="mt-2 text-xs" style={{ color: 'var(--om-muted)' }}>
              Booked slots are disabled. Breaks are shown for doctor fatigue release.
            </div>

            <div className="mt-3 grid grid-cols-3 gap-2 md:grid-cols-4">
              {(pSlots?.slots || []).length === 0 ? (
                <div className="col-span-3 text-sm" style={{ color: 'var(--om-muted)' }}>
                  Loading slots…
                </div>
              ) : (
                (pSlots?.slots || []).map((s: Slot, idx: number) => {
                  const isBreak = s.type === 'BREAK'
                  const isBooked = !!s.booked
                  const isSelected = !isBreak && !isBooked && s.slot_index === pSelectedSlot
                  const disabled = isBreak || isBooked

                  const label = isBreak ? `Break` : `${s.start_local}`
                  return (
                    <button
                      key={`${s.type}_${s.slot_index ?? 'b'}_${idx}`}
                      disabled={disabled}
                      className="om-button px-3 py-2 text-xs disabled:opacity-60"
                      style={
                        isBreak
                          ? { opacity: 0.65 }
                          : isBooked
                            ? { opacity: 0.55, filter: 'blur(0.7px)' }
                            : isSelected
                              ? { outline: '2px solid rgba(214, 186, 120, 0.6)' }
                              : undefined
                      }
                      onClick={() => {
                        if (disabled) return
                        setPSelectedSlot(s.slot_index as number)
                      }}
                      title={isBreak ? `${s.start_local} – ${s.end_local}` : `${s.start_local} – ${s.end_local}`}
                    >
                      <div className="text-xs font-semibold">{label}</div>
                      <div className="text-[10px]" style={{ color: 'var(--om-muted)' }}>
                        {s.end_local}
                      </div>
                    </button>
                  )
                })
              )}
            </div>

            <div className="mt-3 text-xs" style={{ color: 'var(--om-muted)' }}>
              Selected: {pSelectedSlot === null ? 'None' : `#${pSelectedSlot + 1}`}
            </div>
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
              disabled={busy || !pPhoneOk || !pComplaint.trim()}
              className="om-button px-4 py-3 text-sm font-semibold disabled:opacity-60"
              onClick={() =>
                run(async () => {
                  if (!pPhoneOk) {
                    throw new Error('Enter a valid phone number (min 6 digits).')
                  }
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
              disabled={busy || !pPhoneOk || !pComplaint.trim() || pSelectedSlot === null}
              className="om-button-primary px-4 py-3 text-sm font-semibold disabled:opacity-60"
              onClick={() =>
                run(async () => {
                  if (!pPhoneOk) {
                    throw new Error('Enter a valid phone number (min 6 digits).')
                  }
                  if (pSelectedSlot === null) {
                    throw new Error('Select a time slot first.')
                  }
                  setPBooked(null)
                  const r = await bookSlot({
                    phone: pPhone.trim(),
                    name: pName.trim(),
                    complaint_text: pComplaint.trim(),
                    slot_index: pSelectedSlot,
                    session_id: session?.id,
                  })
                  setPBooked({
                    token_no: r.token_no,
                    arrival_window_start: r.arrival_window_start,
                    arrival_window_end: r.arrival_window_end,
                    scheduled_start_local: r.scheduled_start_local,
                    scheduled_end_local: r.scheduled_end_local,
                  })

                  if (session) {
                    try {
                      const x = await getSessionSlots(session.id)
                      setPSlots(x)
                    } catch {
                      return
                    }
                  }
                })
              }
            >
              Book selected slot
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
              <div className="mt-1 text-sm" style={{ color: 'var(--om-text)' }}>
                Risk score (1–10): <span className="font-semibold">{pIntake.risk_score}</span>
                <span className="ml-2 text-xs" style={{ color: 'var(--om-muted)' }}>
                  ({pIntake.model_used})
                </span>
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
              {pBooked.scheduled_start_local ? (
                <div className="mt-1 text-sm" style={{ color: 'var(--om-text)' }}>
                  Your time slot: {pBooked.scheduled_start_local} – {pBooked.scheduled_end_local || ''}
                </div>
              ) : null}
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
          <div className="om-serif text-xl">Notifications</div>
          <div className="mt-2 text-sm" style={{ color: 'var(--om-muted)' }}>
            Updates for your phone number will appear here.
          </div>

          {!pPhoneOk ? (
            <div className="mt-4 text-sm" style={{ color: 'var(--om-muted)' }}>
              Enter your phone number to see notifications.
            </div>
          ) : pNotifs.length === 0 ? (
            <div className="mt-4">
              <div className="text-sm" style={{ color: 'var(--om-muted)' }}>
                No new notifications.
              </div>
              <div className="mt-2 om-card-strong px-4 py-4">
                <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--om-muted)' }}>
                  Notes
                </div>
                <div className="mt-2 text-sm" style={{ color: 'var(--om-muted)' }}>
                  Your time slot may shift due to urgent cases and real OPD conditions.
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              {pNotifs.map((n: Notification) => (
                <div key={n.id} className="om-card-strong px-4 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold" style={{ color: 'var(--om-text)' }}>
                        {n.title || 'Update'}
                      </div>
                      <div className="mt-1 whitespace-pre-wrap text-xs" style={{ color: 'var(--om-muted)' }}>
                        {n.body}
                      </div>
                      <div className="mt-2 text-[10px]" style={{ color: 'var(--om-muted)' }}>
                        {n.created_at}
                      </div>
                    </div>
                    <button
                      className="om-button px-3 py-2 text-xs"
                      onClick={() =>
                        run(async () => {
                          await dismissNotification(n.id, pPhone.trim())
                          setPNotifs((prev) => prev.filter((x) => x.id !== n.id))
                        })
                      }
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="mt-6 om-card px-4 py-4">
            <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--om-muted)' }}>
              How it works
            </div>
            <div className="mt-2 text-sm" style={{ color: 'var(--om-muted)' }}>
              Breaks are automatically inserted (10 min after every 5 slots) for doctor fatigue release.
            </div>
          </div>
        </div>
      </div>
    )
  }

  return shell
}

export default App
