export type Urgency = 'low' | 'medium' | 'high'

export type TokenState = 'BOOKED' | 'ARRIVED' | 'SERVING' | 'SKIPPED' | 'CANCELLED' | 'COMPLETED'

export type QueueToken = {
  id: number
  token_no: number
  name: string
  phone: string
  urgency: string
  state: string
  slot_index?: number | null
  scheduled_start_local?: string
  scheduled_end_local?: string
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

export type Slot = {
  slot_index: number | null
  start_local: string
  end_local: string
  type: 'SLOT' | 'BREAK'
  booked: boolean
}

export type SlotsOut = {
  session_id: number
  date_key: string
  slots: Slot[]
}

export type Notification = {
  id: number
  session_id: number | null
  token_id: number | null
  phone: string
  audience: string
  kind: string
  title: string
  body: string
  created_at: string
  dismissed_at: string | null
}

export type NotificationListOut = {
  notifications: Notification[]
}

export type Clinic = {
  clinic_id: string
  clinic_name: string
}

export type ClinicListOut = {
  clinics: Clinic[]
}

export type Doctor = {
  clinic_id: string
  doctor_id: string
  doctor_name: string
}

export type DoctorListOut = {
  doctors: Doctor[]
}

export type DoctorLoginOut = {
  clinic_id: string
  clinic_name: string
  doctor_id: string
  doctor_name: string
}

export type ClinicCreateOut = {
  clinic_id: string
  clinic_name: string
  clinic_code: string
  clinic_pin: string
}

export type DoctorCreateOut = {
  clinic_id: string
  doctor_id: string
  doctor_name: string
  doctor_code: string
}
