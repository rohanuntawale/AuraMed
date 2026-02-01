import type { BulkEvent } from './types'

const KEY = 'opd_offline_events_v1'

function load(): BulkEvent[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as BulkEvent[]
    if (!Array.isArray(parsed)) return []
    return parsed
  } catch {
    return []
  }
}

function save(events: BulkEvent[]) {
  localStorage.setItem(KEY, JSON.stringify(events))
}

export function enqueueEvent(event: BulkEvent) {
  const events = load()
  events.push(event)
  save(events)
}

export function getQueuedCount(): number {
  return load().length
}

export function clearQueue() {
  save([])
}

export async function flushQueue(params: { clientId: string; sessionId: number }): Promise<{ ok: boolean; accepted: number }> {
  const events = load()
  if (events.length === 0) return { ok: true, accepted: 0 }

  const resp = await fetch('/api/events/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: params.clientId,
      session_id: params.sessionId,
      events,
    }),
  })

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '')
    throw new Error(txt || 'Failed to sync offline events')
  }

  const data = (await resp.json()) as { ok: boolean; accepted: number }
  clearQueue()
  return data
}

export function makeEvent(event_type: BulkEvent['event_type'], payload: Record<string, unknown>): BulkEvent {
  return {
    event_id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    event_type,
    payload,
    created_at_iso: new Date().toISOString(),
  }
}
