import type {
  ClinicCreateOut,
  ClinicListOut,
  DoctorCreateOut,
  DoctorListOut,
  DoctorLoginOut,
  NotificationListOut,
  QueueState,
  SessionOut,
  SlotsOut,
  Urgency,
} from './types'

function getClinicPin(): string {
  try {
    return localStorage.getItem('opd_clinic_pin_v1') || ''
  } catch {
    return ''
  }
}

function getClinicId(): string {
  try {
    const raw = localStorage.getItem('opd_doctor_ctx_v1')
    if (!raw) return ''
    const parsed = JSON.parse(raw) as any
    return String(parsed?.clinic_id || '')
  } catch {
    return ''
  }
}

export async function getSessionSlots(sessionId: number): Promise<SlotsOut> {
  return apiFetch<SlotsOut>(`/api/sessions/${encodeURIComponent(sessionId)}/slots`)
}

export async function listClinics(): Promise<ClinicListOut> {
  return apiFetch<ClinicListOut>('/api/clinics')
}

export async function listDoctors(clinicId: string): Promise<DoctorListOut> {
  return apiFetch<DoctorListOut>(`/api/clinics/${encodeURIComponent(clinicId)}/doctors`)
}

export async function doctorLogin(body: { clinic_code: string; doctor_code: string }): Promise<DoctorLoginOut> {
  return apiFetch<DoctorLoginOut>('/api/doctors/login', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function adminCreateClinic(body: { clinic_id: string; clinic_name?: string }): Promise<ClinicCreateOut> {
  return apiFetch<ClinicCreateOut>('/api/admin/clinics', {
    method: 'POST',
    body: JSON.stringify({ clinic_id: body.clinic_id, clinic_name: body.clinic_name || '' }),
  })
}

export async function adminCreateDoctor(body: {
  clinic_id: string
  doctor_id: string
  doctor_name?: string
}): Promise<DoctorCreateOut> {
  return apiFetch<DoctorCreateOut>('/api/admin/doctors', {
    method: 'POST',
    body: JSON.stringify({
      clinic_id: body.clinic_id,
      doctor_id: body.doctor_id,
      doctor_name: body.doctor_name || '',
    }),
  })
}

export async function createSession(body: { date_key: string; clinic_id?: string; doctor_id?: string }): Promise<SessionOut> {
  return apiFetch<SessionOut>('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      clinic_id: body.clinic_id || 'default',
      doctor_id: body.doctor_id || 'default',
      date_key: body.date_key,
    }),
  })
}

export async function bookSlot(body: {
  phone: string
  name?: string
  complaint_text: string
  slot_index: number
  session_id?: number
}): Promise<{
  id: number
  token_no: number
  phone: string
  name: string
  urgency: string
  state: string
  arrival_window_start: string
  arrival_window_end: string
  slot_index?: number | null
  scheduled_start_local?: string
  scheduled_end_local?: string
}> {
  const qs = body.session_id != null ? `?session_id=${encodeURIComponent(body.session_id)}` : ''
  return apiFetch<any>(`/api/tokens/book_slot${qs}`, {
    method: 'POST',
    body: JSON.stringify({
      phone: body.phone,
      name: body.name || '',
      complaint_text: body.complaint_text,
      slot_index: body.slot_index,
    }),
  })
}

export async function listNotifications(phone: string): Promise<NotificationListOut> {
  return apiFetch<NotificationListOut>(`/api/notifications?phone=${encodeURIComponent(phone)}`)
}

export async function dismissNotification(notificationId: number, phone: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(
    `/api/notifications/${encodeURIComponent(notificationId)}/dismiss?phone=${encodeURIComponent(phone)}`,
    {
      method: 'POST',
    },
  )
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const pin = getClinicPin()
  const clinicId = getClinicId()
  const resp = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(pin ? { 'X-Clinic-Pin': pin } : {}),
      ...(clinicId ? { 'X-Clinic-Id': clinicId } : {}),
      ...(init?.headers || {}),
    },
  })

  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(text || `Request failed: ${resp.status}`)
  }

  return (await resp.json()) as T
}

export async function getCurrentSession(): Promise<SessionOut> {
  return apiFetch<SessionOut>('/api/sessions/current')
}

export async function getQueueState(sessionId: number): Promise<QueueState> {
  return apiFetch<QueueState>(`/api/queue/state?session_id=${encodeURIComponent(sessionId)}`)
}

export async function serveNext(sessionId: number): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/queue/serve_next?session_id=${encodeURIComponent(sessionId)}`, {
    method: 'POST',
  })
}

export async function arriveToken(tokenId: number): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/tokens/${tokenId}/arrive`, { method: 'POST' })
}

export async function skipToken(sessionId: number, tokenId: number): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(
    `/api/queue/skip?session_id=${encodeURIComponent(sessionId)}&token_id=${encodeURIComponent(tokenId)}`,
    { method: 'POST' },
  )
}

export async function cancelToken(sessionId: number, tokenId: number): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(
    `/api/queue/cancel?session_id=${encodeURIComponent(sessionId)}&token_id=${encodeURIComponent(tokenId)}`,
    { method: 'POST' },
  )
}

export async function addWalkIn(sessionId: number, body: { phone: string; name: string; urgency: Urgency }): Promise<any> {
  return apiFetch<any>(`/api/queue/walkin?session_id=${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    body: JSON.stringify({
      phone: body.phone,
      name: body.name,
      urgency: body.urgency,
      complaint_text: '',
    }),
  })
}

export async function triggerEmergency(sessionId: number, minutes: number): Promise<any> {
  return apiFetch<any>(`/api/queue/emergency?session_id=${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    body: JSON.stringify({ minutes }),
  })
}

export async function intake(body: {
  phone: string
  name?: string
  complaint_text: string
}): Promise<{ urgency: Urgency; intake_summary: string; risk_score: number; model_used: string }> {
  return apiFetch<{ urgency: Urgency; intake_summary: string; risk_score: number; model_used: string }>('/api/intake', {
    method: 'POST',
    body: JSON.stringify({
      phone: body.phone,
      name: body.name || '',
      complaint_text: body.complaint_text,
    }),
  })
}

export async function bookToken(body: {
  phone: string
  name?: string
  complaint_text: string
}): Promise<{
  id: number
  token_no: number
  phone: string
  name: string
  urgency: string
  state: string
  arrival_window_start: string
  arrival_window_end: string
  slot_index?: number | null
  scheduled_start_local?: string
  scheduled_end_local?: string
}> {
  return apiFetch<any>('/api/tokens/book', {
    method: 'POST',
    body: JSON.stringify({
      phone: body.phone,
      name: body.name || '',
      complaint_text: body.complaint_text,
    }),
  })
}
