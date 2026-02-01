export type Urgency = 'low' | 'medium' | 'high'

export type TokenState = 'BOOKED' | 'ARRIVED' | 'SERVING' | 'SKIPPED' | 'CANCELLED' | 'COMPLETED'

export type QueueToken = {
  id: number
  token_no: number
  name: string
  phone: string
  urgency: string
  state: string
}

export type QueueState = {
  session_id: number
  now_iso: string
  serving: QueueToken | null
  upcoming: QueueToken[]
  stats: Record<string, unknown>
}

export type SessionOut = {
  id: number
  clinic_id: string
  doctor_id: string
  date_key: string
  start_time_local: string
  end_time_local: string
  slot_minutes: number
  micro_buffer_minutes: number
  break_every_n: number
  break_minutes: number
  emergency_reserve_minutes: number
  planned_leave: boolean
  unplanned_closed: boolean
  emergency_debt_minutes: number
}

export type BulkEvent = {
  event_id: string
  event_type: 'ARRIVE' | 'SERVE_NEXT' | 'SKIP' | 'CANCEL' | 'EMERGENCY'
  payload: Record<string, unknown>
  created_at_iso?: string
}
