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


class TokenOut(BaseModel):
    id: int
    token_no: int
    phone: str
    name: str
    urgency: str
    state: str
    arrival_window_start: str
    arrival_window_end: str


class QueueStateToken(BaseModel):
    id: int
    token_no: int
    name: str
    phone: str
    urgency: str
    state: str


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
