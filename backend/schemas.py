from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


Urgency = Literal["low", "medium", "high"]


class SessionCreate(BaseModel):
    clinic_id: str = "default"
    doctor_id: str = "default"
    date_key: str | None = None
    start_time_local: str = "17:00"
    end_time_local: str = "20:00"


class SessionOut(BaseModel):
    id: int
    clinic_id: str
    doctor_id: str
    date_key: str
    start_time_local: str
    end_time_local: str
    slot_minutes: int
    micro_buffer_minutes: int
    break_every_n: int
    break_minutes: int
    emergency_reserve_minutes: int
    planned_leave: bool
    unplanned_closed: bool
    emergency_debt_minutes: int


class IntakeRequest(BaseModel):
    phone: str = Field(min_length=6, max_length=32)
    name: str = ""
    complaint_text: str = Field(default="", max_length=2000)


class IntakeResult(BaseModel):
    urgency: Urgency
    intake_summary: str
    risk_score: int = Field(ge=1, le=10, default=5)
    model_used: str = "rules"


class TokenOut(BaseModel):
    id: int
    token_no: int
    phone: str
    name: str
    urgency: str
    state: str
    arrival_window_start: str
    arrival_window_end: str
    slot_index: int | None = None
    scheduled_start_local: str = ""
    scheduled_end_local: str = ""


class BookSlotRequest(BaseModel):
    phone: str = Field(min_length=6, max_length=32)
    name: str = ""
    complaint_text: str = Field(default="", max_length=2000)
    slot_index: int = Field(ge=0)


class QueueStateToken(BaseModel):
    id: int
    token_no: int
    name: str
    phone: str
    urgency: str
    state: str
    slot_index: int | None = None
    scheduled_start_local: str = ""
    scheduled_end_local: str = ""


class QueueStateOut(BaseModel):
    session_id: int
    now_iso: str
    serving: QueueStateToken | None
    upcoming: list[QueueStateToken]
    stats: dict[str, Any]


class WalkInRequest(BaseModel):
    phone: str = Field(min_length=6, max_length=32)
    name: str = ""
    complaint_text: str = ""
    urgency: Urgency = "low"


class EmergencyRequest(BaseModel):
    minutes: int = Field(ge=5, le=60)


class BulkEvent(BaseModel):
    event_id: str
    event_type: str
    payload: dict[str, Any] = {}
    created_at_iso: str | None = None


class BulkEventsRequest(BaseModel):
    client_id: str
    session_id: int
    events: list[BulkEvent]


class SlotOut(BaseModel):
    slot_index: int | None
    start_local: str
    end_local: str
    type: Literal["SLOT", "BREAK"]
    booked: bool


class SlotsOut(BaseModel):
    session_id: int
    date_key: str
    slots: list[SlotOut]


class NotificationOut(BaseModel):
    id: int
    session_id: int | None
    token_id: int | None
    phone: str
    audience: str
    kind: str
    title: str
    body: str
    created_at: str
    dismissed_at: str | None


class NotificationListOut(BaseModel):
    notifications: list[NotificationOut]


class ClinicOut(BaseModel):
    clinic_id: str
    clinic_name: str


class ClinicListOut(BaseModel):
    clinics: list[ClinicOut]


class DoctorOut(BaseModel):
    clinic_id: str
    doctor_id: str
    doctor_name: str


class DoctorListOut(BaseModel):
    doctors: list[DoctorOut]


class DoctorLoginRequest(BaseModel):
    clinic_code: str
    doctor_code: str


class DoctorLoginOut(BaseModel):
    clinic_id: str
    clinic_name: str
    doctor_id: str
    doctor_name: str


class ClinicCreateRequest(BaseModel):
    clinic_id: str = Field(min_length=1, max_length=64)
    clinic_name: str = ""


class ClinicCreateOut(BaseModel):
    clinic_id: str
    clinic_name: str
    clinic_code: str
    clinic_pin: str


class DoctorCreateRequest(BaseModel):
    clinic_id: str = Field(min_length=1, max_length=64)
    doctor_id: str = Field(min_length=1, max_length=64)
    doctor_name: str = ""


class DoctorCreateOut(BaseModel):
    clinic_id: str
    doctor_id: str
    doctor_name: str
    doctor_code: str
