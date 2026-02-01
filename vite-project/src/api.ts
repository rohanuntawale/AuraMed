import type { QueueState, SessionOut, Urgency } from './types'

function getClinicPin(): string {
  try {
    return localStorage.getItem('opd_clinic_pin_v1') || ''
  } catch {
    return ''
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const pin = getClinicPin()
  const resp = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(pin ? { 'X-Clinic-Pin': pin } : {}),
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

export async function intake(body: { phone: string; name?: string; complaint_text: string }): Promise<{ urgency: Urgency; intake_summary: string }> {
  return apiFetch<{ urgency: Urgency; intake_summary: string }>('/api/intake', {
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
