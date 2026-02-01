from __future__ import annotations

import json
import os
import secrets
from datetime import datetime, timedelta

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware

import httpx

from .messaging import OutboundMessage, format_delay_notice, format_session_cancelled, format_token_confirmation, send_message
from .queue_logic import compute_arrival_window
from .schemas import (
    BookSlotRequest,
    BulkEventsRequest,
    EmergencyRequest,
    IntakeRequest,
    IntakeResult,
    NotificationListOut,
    NotificationOut,
    ClinicListOut,
    ClinicOut,
    DoctorListOut,
    DoctorLoginOut,
    DoctorLoginRequest,
    DoctorOut,
    ClinicCreateOut,
    ClinicCreateRequest,
    DoctorCreateOut,
    DoctorCreateRequest,
    QueueStateOut,
    QueueStateToken,
    SessionCreate,
    SessionOut,
    SlotOut,
    SlotsOut,
    TokenOut,
    WalkInRequest,
)
from .supabase_client import get_supabase_client


def _sb_data(resp) -> list[dict]:
    err = getattr(resp, "error", None)
    if err:
        raise HTTPException(status_code=502, detail=f"Supabase error: {err}")
    data = getattr(resp, "data", None)
    if data is None:
        raise HTTPException(status_code=502, detail="Supabase error: empty response")
    return list(data)


def _sb_one(resp) -> dict | None:
    data = _sb_data(resp)
    return data[0] if data else None


app = FastAPI(title="OPD Queue Orchestrator MVP", version="0.1")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"]
)

def staff_dep(
    x_clinic_pin: str | None = Header(default=None, alias="X-Clinic-Pin"),
    x_clinic_id: str | None = Header(default=None, alias="X-Clinic-Id"),
    sb=Depends(lambda: get_supabase_client()),
):
    cid = (x_clinic_id or "").strip() or "default"
    row = _sb_one(sb.table("clinics").select("clinic_id,clinic_pin").eq("clinic_id", cid).limit(1).execute())
    clinic_pin = str((row or {}).get("clinic_pin") or "").strip()

    fallback = os.getenv("CLINIC_PIN", "")
    expected = clinic_pin or fallback
    if not expected:
        return
    if (x_clinic_pin or "").strip() != expected:
        raise HTTPException(status_code=401, detail="Unauthorized")


def sb_dep():
    try:
        return get_supabase_client()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _today_key() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def _fmt_time(dt: datetime) -> str:
    return dt.strftime("%H:%M")


def _parse_hhmm(s: str) -> int:
    raw = (s or "").strip()
    if not raw:
        return 0
    parts = raw.split(":")
    if len(parts) != 2:
        return 0
    try:
        h = int(parts[0])
        m = int(parts[1])
    except Exception:
        return 0
    return max(0, min(23, h)) * 60 + max(0, min(59, m))


def _fmt_hhmm(minutes_from_midnight: int) -> str:
    m = max(0, minutes_from_midnight)
    h = (m // 60) % 24
    mm = m % 60
    return f"{h:02d}:{mm:02d}"


def _sb_active_tokens(sb, session_id: int) -> list[dict]:
    return _sb_data(
        sb.table("tokens")
        .select("*")
        .eq("session_id", session_id)
        .in_("state", ["BOOKED", "ARRIVED", "SERVING", "SKIPPED"])
        .execute()
    )


def _generate_slots(session_row: dict) -> list[dict]:
    start = _parse_hhmm(str(session_row.get("start_time_local") or "09:00"))
    end = _parse_hhmm(str(session_row.get("end_time_local") or "17:00"))
    if end <= start:
        end = start + 60

    slot_minutes = int(session_row.get("slot_minutes") or 10)
    micro = int(session_row.get("micro_buffer_minutes") or 0)
    break_every = int(session_row.get("break_every_n") or 0)
    break_minutes = int(session_row.get("break_minutes") or 0)

    t = start
    slots: list[dict] = []
    slot_index = 0
    slots_since_break = 0

    while True:
        if t + slot_minutes > end:
            break

        slots.append(
            {
                "type": "SLOT",
                "slot_index": slot_index,
                "start_local": _fmt_hhmm(t),
                "end_local": _fmt_hhmm(t + slot_minutes),
            }
        )

        t = t + slot_minutes + micro
        slot_index += 1
        slots_since_break += 1

        if break_every > 0 and break_minutes > 0 and slots_since_break >= break_every:
            if t + break_minutes > end:
                break
            slots.append(
                {
                    "type": "BREAK",
                    "slot_index": None,
                    "start_local": _fmt_hhmm(t),
                    "end_local": _fmt_hhmm(t + break_minutes),
                }
            )
            t = t + break_minutes
            slots_since_break = 0

    return slots


def _sb_insert_notification(
    sb,
    *,
    session_id: int | None,
    token_id: int | None,
    phone: str,
    audience: str,
    kind: str,
    title: str,
    body: str,
) -> None:
    _sb_data(
        sb.table("notifications")
        .insert(
            {
                "session_id": session_id,
                "token_id": token_id,
                "phone": phone,
                "audience": audience,
                "kind": kind,
                "title": title,
                "body": body,
            }
        )
        .execute()
    )


def _sb_insert_message_outbox(sb, *, session_id: int | None, token_id: int | None, phone: str, text: str, message_type: str) -> None:
    _sb_data(
        sb.table("message_outbox")
        .insert(
            {
                "session_id": session_id,
                "token_id": token_id,
                "phone": phone,
                "text": text,
                "message_type": message_type,
                "status": "PENDING",
            }
        )
        .execute()
    )


def _notify_patient(sb, *, session_id: int | None, token_id: int | None, phone: str, kind: str, title: str, body: str) -> None:
    if not phone:
        return
    _sb_insert_notification(sb, session_id=session_id, token_id=token_id, phone=phone, audience="patient", kind=kind, title=title, body=body)
    _sb_insert_message_outbox(sb, session_id=session_id, token_id=token_id, phone=phone, text=f"{title}\n{body}".strip(), message_type=kind)
    send_message(OutboundMessage(phone=phone, text=f"{title}\n{body}".strip()))


def _intake_stub(req: IntakeRequest) -> IntakeResult:
    text = (req.complaint_text or "").lower()

    high_markers = [
        "chest pain",
        "difficulty breathing",
        "shortness of breath",
        "unconscious",
        "seizure",
        "bleeding",
        "severe",
        "pregnant and bleeding",
    ]
    medium_markers = ["fever", "vomit", "vomiting", "pain", "injury", "diarrhea", "dizziness"]

    urgency = "low"
    if any(m in text for m in high_markers):
        urgency = "high"
    elif any(m in text for m in medium_markers):
        urgency = "medium"

    risk_score = 3
    if urgency == "medium":
        risk_score = 6
    if urgency == "high":
        risk_score = 9

    summary = (req.complaint_text or "").strip()
    if not summary:
        summary = "Patient requested OPD consultation."

    safe_summary = (
        "Patient-described concern: "
        + summary[:800]
        + "\n\n"
        + "Note: This is a descriptive intake summary. No diagnosis is provided."
    )

    return IntakeResult(urgency=urgency, intake_summary=safe_summary, risk_score=risk_score, model_used="rules")


async def _openrouter_intake(req: IntakeRequest) -> IntakeResult | None:
    api_key = (os.getenv("OPENROUTER_API_KEY") or "").strip()
    if not api_key:
        return None

    model = (os.getenv("OPENROUTER_MODEL") or "openai/gpt-4o-mini").strip()
    prompt = {
        "role": "user",
        "content": (
            "You are an OPD front-desk triage assistant.\n"
            "Do NOT diagnose or give treatment.\n"
            "Return JSON ONLY with keys: urgency (low|medium|high), risk_score (1-10), intake_summary.\n"
            "risk_score is operational urgency/risk for queueing only.\n\n"
            f"Patient text: {req.complaint_text.strip()[:1800]}\n"
        ),
    }

    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": model,
                    "messages": [
                        {
                            "role": "system",
                            "content": "You are a safe, non-diagnostic triage summarizer for OPD queueing.",
                        },
                        prompt,
                    ],
                    "temperature": 0.2,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            content = (((data.get("choices") or [])[0] or {}).get("message") or {}).get("content")
            if not content:
                return None

            parsed = json.loads(content)
            urgency = str(parsed.get("urgency") or "low").lower()
            if urgency not in ["low", "medium", "high"]:
                urgency = "low"

            score_raw = parsed.get("risk_score")
            try:
                score = int(score_raw)
            except Exception:
                score = 5
            score = max(1, min(10, score))

            summary = str(parsed.get("intake_summary") or "").strip()
            if not summary:
                summary = "Patient requested OPD consultation."

            safe_summary = "Patient-described concern: " + summary[:800] + "\n\nNote: This is a descriptive intake summary. No diagnosis is provided."
            return IntakeResult(urgency=urgency, intake_summary=safe_summary, risk_score=score, model_used=model)
    except Exception:
        return None


class _SessionLike:
    def __init__(self, row: dict):
        for k, v in row.items():
            setattr(self, k, v)


def _sb_get_or_create_session(sb, clinic_id: str, doctor_id: str, date_key: str | None) -> dict:
    dk = date_key or _today_key()
    resp = (
        sb.table("sessions")
        .select("*")
        .eq("clinic_id", clinic_id)
        .eq("doctor_id", doctor_id)
        .eq("date_key", dk)
        .limit(1)
        .execute()
    )
    row = _sb_one(resp)
    if row:
        return row

    ins = {
        "clinic_id": clinic_id,
        "doctor_id": doctor_id,
        "date_key": dk,
    }
    created = _sb_data(sb.table("sessions").insert(ins).execute())
    return created[0]


def _sb_get_tokens(sb, session_id: int, states: list[str], limit: int | None = None) -> list[dict]:
    q = (
        sb.table("tokens")
        .select("*")
        .eq("session_id", session_id)
        .in_("state", states)
        .order("token_no", desc=False)
    )
    if limit:
        q = q.limit(limit)
    return _sb_data(q.execute())


def _sb_get_serving_token(sb, session_id: int) -> dict | None:
    resp = (
        sb.table("tokens")
        .select("*")
        .eq("session_id", session_id)
        .eq("state", "SERVING")
        .limit(1)
        .execute()
    )
    return _sb_one(resp)


def _sb_get_next_eligible(sb, session_id: int) -> dict | None:
    resp = (
        sb.table("tokens")
        .select("*")
        .eq("session_id", session_id)
        .in_("state", ["ARRIVED", "BOOKED", "SKIPPED"])
        .order("token_no", desc=False)
        .limit(1)
        .execute()
    )
    return _sb_one(resp)


def _sb_update_token(sb, token_id: int, patch: dict) -> None:
    _sb_data(sb.table("tokens").update(patch).eq("id", token_id).execute())


def _sb_update_session(sb, session_id: int, patch: dict) -> None:
    _sb_data(sb.table("sessions").update(patch).eq("id", session_id).execute())


def _sb_insert_client_event(sb, session_id: int, client_id: str, event_id: str, event_type: str, payload: dict) -> bool:
    existing = (
        sb.table("client_events")
        .select("id")
        .eq("client_id", client_id)
        .eq("event_id", event_id)
        .limit(1)
        .execute()
    )
    if _sb_one(existing):
        return False
    _sb_data(
        sb.table("client_events").insert(
        {
            "session_id": session_id,
            "client_id": client_id,
            "event_id": event_id,
            "event_type": event_type,
            "payload_json": json.dumps(payload or {}),
        }
        ).execute()
    )
    return True


@app.get("/api/health")
def health():
    return {"ok": True}


def _gen_code(prefix: str) -> str:
    raw = secrets.token_hex(4).upper()
    return f"{prefix}-{raw}"


def _gen_pin() -> str:
    return str(secrets.randbelow(9000) + 1000)


@app.get("/api/clinics", response_model=ClinicListOut)
def list_clinics(sb=Depends(sb_dep)):
    rows = _sb_data(sb.table("clinics").select("clinic_id,clinic_name").order("clinic_name", desc=False).execute())
    return ClinicListOut(
        clinics=[ClinicOut(clinic_id=str(r.get("clinic_id") or ""), clinic_name=str(r.get("clinic_name") or "")) for r in rows]
    )


@app.get("/api/clinics/{clinic_id}/doctors", response_model=DoctorListOut)
def list_doctors(clinic_id: str, sb=Depends(sb_dep)):
    cid = (clinic_id or "").strip() or "default"
    rows = _sb_data(
        sb.table("doctors")
        .select("clinic_id,doctor_id,doctor_name")
        .eq("clinic_id", cid)
        .order("doctor_name", desc=False)
        .execute()
    )
    return DoctorListOut(
        doctors=[
            DoctorOut(
                clinic_id=str(r.get("clinic_id") or ""),
                doctor_id=str(r.get("doctor_id") or ""),
                doctor_name=str(r.get("doctor_name") or ""),
            )
            for r in rows
        ]
    )


@app.post("/api/doctors/login", response_model=DoctorLoginOut)
def doctor_login(body: DoctorLoginRequest, sb=Depends(sb_dep)):
    clinic_code = (body.clinic_code or "").strip()
    doctor_code = (body.doctor_code or "").strip()
    if not clinic_code or not doctor_code:
        raise HTTPException(status_code=400, detail="Missing clinic_code or doctor_code")

    clinic = _sb_one(sb.table("clinics").select("clinic_id,clinic_name").eq("clinic_code", clinic_code).limit(1).execute())
    if not clinic:
        raise HTTPException(status_code=401, detail="Invalid clinic code")

    doc = _sb_one(
        sb.table("doctors")
        .select("clinic_id,doctor_id,doctor_name")
        .eq("clinic_id", str(clinic.get("clinic_id") or ""))
        .eq("doctor_code", doctor_code)
        .limit(1)
        .execute()
    )
    if not doc:
        raise HTTPException(status_code=401, detail="Invalid doctor code")

    return DoctorLoginOut(
        clinic_id=str(doc.get("clinic_id") or ""),
        clinic_name=str(clinic.get("clinic_name") or ""),
        doctor_id=str(doc.get("doctor_id") or ""),
        doctor_name=str(doc.get("doctor_name") or ""),
    )


@app.post("/api/admin/clinics", response_model=ClinicCreateOut)
def admin_create_clinic(body: ClinicCreateRequest, sb=Depends(sb_dep), _staff=Depends(staff_dep)):
    cid = (body.clinic_id or "").strip()
    if not cid:
        raise HTTPException(status_code=400, detail="clinic_id required")

    existing = _sb_one(
        sb.table("clinics")
        .select("clinic_id,clinic_name,clinic_code,clinic_pin")
        .eq("clinic_id", cid)
        .limit(1)
        .execute()
    )
    if existing:
        return ClinicCreateOut(
            clinic_id=str(existing.get("clinic_id") or ""),
            clinic_name=str(existing.get("clinic_name") or ""),
            clinic_code=str(existing.get("clinic_code") or ""),
            clinic_pin=str(existing.get("clinic_pin") or ""),
        )

    code = _gen_code("CLINIC")
    pin = _gen_pin()
    created = _sb_data(
        sb.table("clinics")
        .insert({"clinic_id": cid, "clinic_name": (body.clinic_name or "").strip(), "clinic_code": code, "clinic_pin": pin})
        .execute()
    )[0]

    return ClinicCreateOut(
        clinic_id=str(created.get("clinic_id") or ""),
        clinic_name=str(created.get("clinic_name") or ""),
        clinic_code=str(created.get("clinic_code") or ""),
        clinic_pin=str(created.get("clinic_pin") or ""),
    )


@app.post("/api/admin/doctors", response_model=DoctorCreateOut)
def admin_create_doctor(body: DoctorCreateRequest, sb=Depends(sb_dep), _staff=Depends(staff_dep)):
    cid = (body.clinic_id or "").strip() or "default"
    did = (body.doctor_id or "").strip()
    if not did:
        raise HTTPException(status_code=400, detail="doctor_id required")

    clinic = _sb_one(sb.table("clinics").select("clinic_id").eq("clinic_id", cid).limit(1).execute())
    if not clinic:
        raise HTTPException(status_code=404, detail="Clinic not found")

    existing = _sb_one(
        sb.table("doctors")
        .select("clinic_id,doctor_id,doctor_name,doctor_code")
        .eq("clinic_id", cid)
        .eq("doctor_id", did)
        .limit(1)
        .execute()
    )
    if existing:
        return DoctorCreateOut(
            clinic_id=str(existing.get("clinic_id") or ""),
            doctor_id=str(existing.get("doctor_id") or ""),
            doctor_name=str(existing.get("doctor_name") or ""),
            doctor_code=str(existing.get("doctor_code") or ""),
        )

    code = _gen_code("DOC")
    created = _sb_data(
        sb.table("doctors")
        .insert({
            "clinic_id": cid,
            "doctor_id": did,
            "doctor_name": (body.doctor_name or "").strip(),
            "doctor_code": code,
        })
        .execute()
    )[0]

    return DoctorCreateOut(
        clinic_id=str(created.get("clinic_id") or ""),
        doctor_id=str(created.get("doctor_id") or ""),
        doctor_name=str(created.get("doctor_name") or ""),
        doctor_code=str(created.get("doctor_code") or ""),
    )


@app.post("/api/sessions", response_model=SessionOut)
def create_session(body: SessionCreate, sb=Depends(sb_dep)):
    s = _sb_get_or_create_session(sb, body.clinic_id, body.doctor_id, body.date_key)
    if bool(s.get("planned_leave")):
        raise HTTPException(status_code=409, detail="Planned leave: bookings disabled")
    return SessionOut(**s)


@app.get("/api/sessions/current", response_model=SessionOut)
def get_current_session(clinic_id: str = "default", doctor_id: str = "default", sb=Depends(sb_dep)):
    s = _sb_get_or_create_session(sb, clinic_id, doctor_id, None)
    return SessionOut(**s)


@app.post("/api/intake", response_model=IntakeResult)
async def intake(body: IntakeRequest):
    ai = await _openrouter_intake(body)
    if ai:
        return ai
    return _intake_stub(body)


@app.post("/api/tokens/book", response_model=TokenOut)
def book_token(body: IntakeRequest, clinic_id: str = "default", doctor_id: str = "default", sb=Depends(sb_dep)):
    s = _sb_get_or_create_session(sb, clinic_id, doctor_id, None)
    if bool(s.get("planned_leave")) or bool(s.get("unplanned_closed")):
        raise HTTPException(status_code=409, detail="OPD is closed")

    phone = body.phone.strip()

    existing = (
        sb.table("tokens")
        .select("*")
        .eq("session_id", int(s["id"]))
        .eq("phone", phone)
        .in_("state", ["BOOKED", "ARRIVED", "SERVING", "SKIPPED"])
        .order("token_no", desc=False)
        .limit(1)
        .execute()
    )
    existing_row = _sb_one(existing)
    if existing_row:
        existing = existing_row
        now = datetime.now()
        position_index = max(0, int(existing["token_no"]) - 1)
        w = compute_arrival_window(_SessionLike(s), position_index, now)
        return TokenOut(
            id=int(existing["id"]),
            token_no=int(existing["token_no"]),
            phone=str(existing.get("phone") or ""),
            name=str(existing.get("name") or ""),
            urgency=str(existing.get("urgency") or "low"),
            state=str(existing.get("state") or "BOOKED"),
            arrival_window_start=_fmt_time(w.start),
            arrival_window_end=_fmt_time(w.end),
            slot_index=(int(existing.get("slot_index")) if existing.get("slot_index") is not None else None),
            scheduled_start_local=str(existing.get("scheduled_start_local") or ""),
            scheduled_end_local=str(existing.get("scheduled_end_local") or ""),
        )

    max_row = (
        sb.table("tokens")
        .select("token_no")
        .eq("session_id", int(s["id"]))
        .order("token_no", desc=True)
        .limit(1)
        .execute()
    )
    max_existing = _sb_one(max_row)
    next_no = (int(max_existing["token_no"]) + 1) if max_existing else 1

    intake_res = _intake_stub(body)

    created = (
        sb.table("tokens")
        .insert(
            {
                "session_id": int(s["id"]),
                "token_no": next_no,
                "phone": phone,
                "name": (body.name or "").strip(),
                "urgency": intake_res.urgency,
                "complaint_text": (body.complaint_text or "").strip(),
                "intake_summary": intake_res.intake_summary,
                "state": "BOOKED",
                "last_state_change_at": datetime.utcnow().isoformat(),
            }
        )
        .execute()
    )
    t = _sb_data(created)[0]

    now = datetime.now()
    w = compute_arrival_window(_SessionLike(s), position_index=max(0, int(t["token_no"]) - 1), now=now)

    msg = OutboundMessage(
        phone=str(t.get("phone") or ""),
        text=format_token_confirmation(int(t["token_no"]), _fmt_time(w.start), _fmt_time(w.end)),
    )
    send_message(msg)

    return TokenOut(
        id=int(t["id"]),
        token_no=int(t["token_no"]),
        phone=str(t.get("phone") or ""),
        name=str(t.get("name") or ""),
        urgency=str(t.get("urgency") or "low"),
        state=str(t.get("state") or "BOOKED"),
        arrival_window_start=_fmt_time(w.start),
        arrival_window_end=_fmt_time(w.end),
        slot_index=(int(t.get("slot_index")) if t.get("slot_index") is not None else None),
        scheduled_start_local=str(t.get("scheduled_start_local") or ""),
        scheduled_end_local=str(t.get("scheduled_end_local") or ""),
    )


@app.get("/api/sessions/{session_id}/slots", response_model=SlotsOut)
def session_slots(session_id: int, sb=Depends(sb_dep)):
    s = _sb_one(sb.table("sessions").select("*").eq("id", session_id).limit(1).execute())
    if not s:
        raise HTTPException(status_code=404, detail="Session not found")
    all_slots = _generate_slots(s)

    active = _sb_active_tokens(sb, session_id)
    booked_set = {int(t.get("slot_index")) for t in active if t.get("slot_index") is not None}

    out_slots: list[SlotOut] = []
    for x in all_slots:
        si = x.get("slot_index")
        is_booked = bool(si is not None and int(si) in booked_set)
        out_slots.append(
            SlotOut(
                slot_index=(int(si) if si is not None else None),
                start_local=str(x.get("start_local") or ""),
                end_local=str(x.get("end_local") or ""),
                type=str(x.get("type") or "SLOT"),
                booked=is_booked,
            )
        )

    return SlotsOut(session_id=int(s["id"]), date_key=str(s.get("date_key") or ""), slots=out_slots)


@app.post("/api/tokens/book_slot", response_model=TokenOut)
def book_slot(
    body: BookSlotRequest,
    session_id: int | None = None,
    clinic_id: str = "default",
    doctor_id: str = "default",
    sb=Depends(sb_dep),
):
    if session_id is not None:
        s = _sb_one(sb.table("sessions").select("*").eq("id", session_id).limit(1).execute())
        if not s:
            raise HTTPException(status_code=404, detail="Session not found")
    else:
        s = _sb_get_or_create_session(sb, clinic_id, doctor_id, None)
    if bool(s.get("planned_leave")) or bool(s.get("unplanned_closed")):
        raise HTTPException(status_code=409, detail="OPD is closed")

    phone = body.phone.strip()

    existing = (
        sb.table("tokens")
        .select("*")
        .eq("session_id", int(s["id"]))
        .eq("phone", phone)
        .in_("state", ["BOOKED", "ARRIVED", "SERVING", "SKIPPED"])
        .order("token_no", desc=False)
        .limit(1)
        .execute()
    )
    existing_row = _sb_one(existing)
    if existing_row:
        now = datetime.now()
        pos = max(0, int(existing_row.get("slot_index") if existing_row.get("slot_index") is not None else int(existing_row["token_no"]) - 1))
        w = compute_arrival_window(_SessionLike(s), pos, now)
        return TokenOut(
            id=int(existing_row["id"]),
            token_no=int(existing_row["token_no"]),
            phone=str(existing_row.get("phone") or ""),
            name=str(existing_row.get("name") or ""),
            urgency=str(existing_row.get("urgency") or "low"),
            state=str(existing_row.get("state") or "BOOKED"),
            arrival_window_start=_fmt_time(w.start),
            arrival_window_end=_fmt_time(w.end),
            slot_index=(int(existing_row.get("slot_index")) if existing_row.get("slot_index") is not None else None),
            scheduled_start_local=str(existing_row.get("scheduled_start_local") or ""),
            scheduled_end_local=str(existing_row.get("scheduled_end_local") or ""),
        )

    slots = _generate_slots(s)
    wanted = None
    for x in slots:
        if x.get("type") != "SLOT":
            continue
        si = x.get("slot_index")
        if si is not None and int(si) == int(body.slot_index):
            wanted = x
            break
    if not wanted:
        raise HTTPException(status_code=400, detail="Invalid slot")

    conflict = (
        sb.table("tokens")
        .select("id")
        .eq("session_id", int(s["id"]))
        .eq("slot_index", int(body.slot_index))
        .in_("state", ["BOOKED", "ARRIVED", "SERVING", "SKIPPED"])
        .limit(1)
        .execute()
    )
    if _sb_one(conflict):
        raise HTTPException(status_code=409, detail="Slot already booked")

    intake_res = _intake_stub(IntakeRequest(phone=phone, name=body.name, complaint_text=body.complaint_text))

    token_no = int(body.slot_index) + 1
    created = (
        sb.table("tokens")
        .insert(
            {
                "session_id": int(s["id"]),
                "token_no": token_no,
                "slot_index": int(body.slot_index),
                "scheduled_start_local": str(wanted.get("start_local") or ""),
                "scheduled_end_local": str(wanted.get("end_local") or ""),
                "phone": phone,
                "name": (body.name or "").strip(),
                "urgency": intake_res.urgency,
                "complaint_text": (body.complaint_text or "").strip(),
                "intake_summary": intake_res.intake_summary,
                "state": "BOOKED",
                "last_state_change_at": datetime.utcnow().isoformat(),
            }
        )
        .execute()
    )
    t = _sb_data(created)[0]

    now = datetime.now()
    w = compute_arrival_window(_SessionLike(s), position_index=max(0, int(body.slot_index)), now=now)

    _notify_patient(
        sb,
        session_id=int(s["id"]),
        token_id=int(t["id"]),
        phone=phone,
        kind="INFO",
        title="Time slot booked",
        body=f"Your slot is booked for {t.get('scheduled_start_local','')} – {t.get('scheduled_end_local','')}. Token #{token_no}.",
    )

    return TokenOut(
        id=int(t["id"]),
        token_no=int(t["token_no"]),
        phone=str(t.get("phone") or ""),
        name=str(t.get("name") or ""),
        urgency=str(t.get("urgency") or "low"),
        state=str(t.get("state") or "BOOKED"),
        arrival_window_start=_fmt_time(w.start),
        arrival_window_end=_fmt_time(w.end),
        slot_index=(int(t.get("slot_index")) if t.get("slot_index") is not None else None),
        scheduled_start_local=str(t.get("scheduled_start_local") or ""),
        scheduled_end_local=str(t.get("scheduled_end_local") or ""),
    )


@app.post("/api/tokens/{token_id}/arrive")
def mark_arrived(token_id: int, sb=Depends(sb_dep), _staff=Depends(staff_dep)):
    t = _sb_one(sb.table("tokens").select("*").eq("id", token_id).limit(1).execute())
    if not t:
        raise HTTPException(status_code=404, detail="Token not found")
    if t.get("state") in ["CANCELLED", "COMPLETED"]:
        return {"ok": True}

    patch = {
        "state": "ARRIVED",
        "arrived_at": t.get("arrived_at") or datetime.utcnow().isoformat(),
        "last_state_change_at": datetime.utcnow().isoformat(),
    }
    _sb_update_token(sb, int(t["id"]), patch)
    return {"ok": True}


@app.get("/api/queue/state", response_model=QueueStateOut)
def queue_state(session_id: int, sb=Depends(sb_dep)):
    s = _sb_one(sb.table("sessions").select("*").eq("id", session_id).limit(1).execute())
    if not s:
        raise HTTPException(status_code=404, detail="Session not found")
    serving = _sb_get_serving_token(sb, session_id)
    upcoming = _sb_get_tokens(sb, session_id, states=["ARRIVED", "BOOKED", "SKIPPED"], limit=12)

    def to_token(x: dict) -> QueueStateToken:
        return QueueStateToken(
            id=int(x["id"]),
            token_no=int(x["token_no"]),
            name=str(x.get("name") or ""),
            phone=str(x.get("phone") or ""),
            urgency=str(x.get("urgency") or "low"),
            state=str(x.get("state") or "BOOKED"),
            slot_index=(int(x.get("slot_index")) if x.get("slot_index") is not None else None),
            scheduled_start_local=str(x.get("scheduled_start_local") or ""),
            scheduled_end_local=str(x.get("scheduled_end_local") or ""),
        )

    stats = {
        "emergency_debt_minutes": s.get("emergency_debt_minutes"),
        "unplanned_closed": s.get("unplanned_closed"),
        "planned_leave": s.get("planned_leave"),
    }

    return QueueStateOut(
        session_id=int(s["id"]),
        now_iso=datetime.utcnow().isoformat(),
        serving=to_token(serving) if serving else None,
        upcoming=[to_token(x) for x in upcoming],
        stats=stats,
    )


@app.get("/api/notifications", response_model=NotificationListOut)
def list_notifications(phone: str, sb=Depends(sb_dep)):
    phone_clean = (phone or "").strip()
    if not phone_clean:
        raise HTTPException(status_code=400, detail="phone is required")

    resp = (
        sb.table("notifications")
        .select("*")
        .eq("phone", phone_clean)
        .is_("dismissed_at", "null")
        .order("created_at", desc=True)
        .limit(50)
        .execute()
    )
    rows = _sb_data(resp)
    out = []
    for r in rows:
        out.append(
            NotificationOut(
                id=int(r["id"]),
                session_id=(int(r["session_id"]) if r.get("session_id") is not None else None),
                token_id=(int(r["token_id"]) if r.get("token_id") is not None else None),
                phone=str(r.get("phone") or ""),
                audience=str(r.get("audience") or "patient"),
                kind=str(r.get("kind") or "INFO"),
                title=str(r.get("title") or ""),
                body=str(r.get("body") or ""),
                created_at=str(r.get("created_at") or ""),
                dismissed_at=(str(r.get("dismissed_at")) if r.get("dismissed_at") is not None else None),
            )
        )
    return NotificationListOut(notifications=out)


@app.post("/api/notifications/{notification_id}/dismiss", response_model=dict)
def dismiss_notification(notification_id: int, phone: str, sb=Depends(sb_dep)):
    phone_clean = (phone or "").strip()
    if not phone_clean:
        raise HTTPException(status_code=400, detail="phone is required")
    _sb_data(
        sb.table("notifications")
        .update({"dismissed_at": datetime.utcnow().isoformat()})
        .eq("id", notification_id)
        .eq("phone", phone_clean)
        .execute()
    )
    return {"ok": True}


@app.post("/api/queue/serve_next")
def serve_next(session_id: int, sb=Depends(sb_dep), _staff=Depends(staff_dep)):
    s = _sb_one(sb.table("sessions").select("*").eq("id", session_id).limit(1).execute())
    if not s:
        raise HTTPException(status_code=404, detail="Session not found")
    if bool(s.get("unplanned_closed")):
        raise HTTPException(status_code=409, detail="OPD closed")

    current = _sb_get_serving_token(sb, session_id)
    if current:
        if current.get("phone"):
            _notify_patient(
                sb,
                session_id=session_id,
                token_id=int(current["id"]),
                phone=str(current.get("phone") or ""),
                kind="INFO",
                title="Visit completed",
                body="Thank you for visiting. We hope you feel better soon.",
            )
        _sb_update_token(
            sb,
            int(current["id"]),
            {
                "state": "COMPLETED",
                "completed_at": datetime.utcnow().isoformat(),
                "last_state_change_at": datetime.utcnow().isoformat(),
            },
        )

    nxt = _sb_get_next_eligible(sb, session_id)
    if not nxt:
        return {"ok": True, "served": None}

    if nxt.get("state") == "BOOKED":
        _sb_update_token(sb, int(nxt["id"]), {"state": "SKIPPED", "last_state_change_at": datetime.utcnow().isoformat()})
        return {"ok": True, "served": None, "note": "next token not arrived; skipped"}

    _sb_update_token(
        sb,
        int(nxt["id"]),
        {"state": "SERVING", "serving_at": datetime.utcnow().isoformat(), "last_state_change_at": datetime.utcnow().isoformat()},
    )
    return {"ok": True, "served": {"token_id": int(nxt["id"]), "token_no": int(nxt["token_no"])}}


@app.post("/api/queue/skip")
def skip_token(session_id: int, token_id: int, sb=Depends(sb_dep), _staff=Depends(staff_dep)):
    t = _sb_one(sb.table("tokens").select("*").eq("id", token_id).limit(1).execute())
    if not t or int(t.get("session_id") or 0) != session_id:
        raise HTTPException(status_code=404, detail="Token not found")
    if t.get("state") in ["CANCELLED", "COMPLETED"]:
        return {"ok": True}

    if t.get("slot_index") is not None:
        s = _sb_one(sb.table("sessions").select("*").eq("id", session_id).limit(1).execute())
        if not s:
            raise HTTPException(status_code=404, detail="Session not found")
        all_slots = _generate_slots(s)
        active_other = (
            sb.table("tokens")
            .select("slot_index")
            .eq("session_id", session_id)
            .neq("id", token_id)
            .in_("state", ["BOOKED", "ARRIVED", "SERVING", "SKIPPED"])
            .execute()
        )
        booked_set = {int(x.get("slot_index")) for x in _sb_data(active_other) if x.get("slot_index") is not None}

        current_si = int(t.get("slot_index"))
        chosen = None
        for x in all_slots:
            if x.get("type") != "SLOT":
                continue
            si = int(x.get("slot_index") or -1)
            if si <= current_si:
                continue
            if si in booked_set:
                continue
            chosen = x
            break
        if not chosen:
            for x in all_slots:
                if x.get("type") != "SLOT":
                    continue
                si = int(x.get("slot_index") or -1)
                if si in booked_set:
                    continue
                chosen = x
                break
        if not chosen:
            raise HTTPException(status_code=409, detail="No free slots available")

        new_si = int(chosen.get("slot_index"))
        new_no = new_si + 1
        _sb_update_token(
            sb,
            token_id,
            {
                "state": "SKIPPED",
                "slot_index": new_si,
                "token_no": new_no,
                "scheduled_start_local": str(chosen.get("start_local") or ""),
                "scheduled_end_local": str(chosen.get("end_local") or ""),
                "last_state_change_at": datetime.utcnow().isoformat(),
            },
        )
        if t.get("phone"):
            _notify_patient(
                sb,
                session_id=session_id,
                token_id=int(t["id"]),
                phone=str(t.get("phone") or ""),
                kind="INFO",
                title="Time slot moved",
                body=f"You were skipped. Your new time slot is {chosen.get('start_local','')} – {chosen.get('end_local','')}.", 
            )
        return {"ok": True}

    max_row = (
        sb.table("tokens")
        .select("token_no")
        .eq("session_id", session_id)
        .order("token_no", desc=True)
        .limit(1)
        .execute()
    )
    max_existing = _sb_one(max_row)
    next_no = (int(max_existing["token_no"]) + 1) if max_existing else int(t.get("token_no") or 1)

    _sb_update_token(sb, token_id, {"state": "SKIPPED", "token_no": next_no, "last_state_change_at": datetime.utcnow().isoformat()})
    return {"ok": True}


@app.post("/api/queue/cancel")
def cancel_token(session_id: int, token_id: int, sb=Depends(sb_dep), _staff=Depends(staff_dep)):
    t = _sb_one(sb.table("tokens").select("*").eq("id", token_id).limit(1).execute())
    if not t or int(t.get("session_id") or 0) != session_id:
        raise HTTPException(status_code=404, detail="Token not found")
    _sb_update_token(sb, token_id, {"state": "CANCELLED", "last_state_change_at": datetime.utcnow().isoformat()})
    return {"ok": True}


@app.post("/api/queue/walkin")
def add_walkin(session_id: int, body: WalkInRequest, sb=Depends(sb_dep), _staff=Depends(staff_dep)):
    s = _sb_one(sb.table("sessions").select("*").eq("id", session_id).limit(1).execute())
    if not s:
        raise HTTPException(status_code=404, detail="Session not found")

    max_row = (
        sb.table("tokens")
        .select("token_no")
        .eq("session_id", session_id)
        .order("token_no", desc=True)
        .limit(1)
        .execute()
    )
    max_existing = _sb_one(max_row)
    next_no = (int(max_existing["token_no"]) + 1) if max_existing else 1

    created = (
        sb.table("tokens")
        .insert(
            {
                "session_id": session_id,
                "token_no": next_no,
                "phone": body.phone.strip(),
                "name": (body.name or "").strip(),
                "urgency": body.urgency,
                "complaint_text": (body.complaint_text or "").strip(),
                "intake_summary": "Walk-in added by staff. No diagnosis provided.",
                "state": "ARRIVED",
                "arrived_at": datetime.utcnow().isoformat(),
                "last_state_change_at": datetime.utcnow().isoformat(),
            }
        )
        .execute()
    )
    t = _sb_data(created)[0]
    return {"ok": True, "token_id": int(t["id"]), "token_no": int(t["token_no"]) }


@app.post("/api/queue/emergency")
def trigger_emergency(session_id: int, body: EmergencyRequest, sb=Depends(sb_dep), _staff=Depends(staff_dep)):
    s = _sb_one(sb.table("sessions").select("*").eq("id", session_id).limit(1).execute())
    if not s:
        raise HTTPException(status_code=404, detail="Session not found")
    prev_debt = int(s.get("emergency_debt_minutes") or 0)
    delta = int(body.minutes)
    debt = prev_debt + delta
    _sb_update_session(sb, session_id, {"emergency_debt_minutes": debt})

    if delta > 30:
        active = _sb_active_tokens(sb, session_id)
        for t in active:
            phone = str(t.get("phone") or "").strip()
            if not phone:
                continue
            _notify_patient(
                sb,
                session_id=session_id,
                token_id=(int(t["id"]) if t.get("id") is not None else None),
                phone=phone,
                kind="ALERT",
                title="Delay update",
                body="There is a significant delay today (30+ minutes). Please wait for updates before traveling.",
            )

    return {"ok": True, "emergency_debt_minutes": debt}


@app.post("/api/sessions/{session_id}/close_now")
def close_now(session_id: int, sb=Depends(sb_dep), _staff=Depends(staff_dep)):
    s = _sb_one(sb.table("sessions").select("*").eq("id", session_id).limit(1).execute())
    if not s:
        raise HTTPException(status_code=404, detail="Session not found")

    _sb_update_session(sb, session_id, {"unplanned_closed": True})

    tokens = _sb_get_tokens(sb, session_id, states=["BOOKED", "ARRIVED", "SERVING", "SKIPPED"], limit=None)
    for t in tokens:
        _sb_update_token(sb, int(t["id"]), {"state": "CANCELLED", "last_state_change_at": datetime.utcnow().isoformat()})
        if t.get("phone"):
            send_message(OutboundMessage(phone=str(t.get("phone") or ""), text=format_session_cancelled()))

    return {"ok": True, "cancelled": len(tokens)}


@app.post("/api/events/bulk")
def bulk_events(body: BulkEventsRequest, sb=Depends(sb_dep), _staff=Depends(staff_dep)):
    s = _sb_one(sb.table("sessions").select("*").eq("id", body.session_id).limit(1).execute())
    if not s:
        raise HTTPException(status_code=404, detail="Session not found")

    accepted = 0
    for e in body.events:
        if not _sb_insert_client_event(sb, body.session_id, body.client_id, e.event_id, e.event_type, e.payload or {}):
            continue

        if e.event_type == "ARRIVE":
            token_id = int((e.payload or {}).get("token_id"))
            if token_id:
                rows = sb.table("tokens").select("*").eq("id", token_id).limit(1).execute().data
                t = rows[0] if rows else None
                if t and int(t.get("session_id") or 0) == body.session_id:
                    if t.get("state") not in ["CANCELLED", "COMPLETED"]:
                        _sb_update_token(
                            sb,
                            token_id,
                            {
                                "state": "ARRIVED",
                                "arrived_at": t.get("arrived_at") or datetime.utcnow().isoformat(),
                                "last_state_change_at": datetime.utcnow().isoformat(),
                            },
                        )
        elif e.event_type == "SERVE_NEXT":
            serve_next(body.session_id, sb)
        elif e.event_type == "SKIP":
            token_id = int((e.payload or {}).get("token_id"))
            if token_id:
                skip_token(body.session_id, token_id, sb)
        elif e.event_type == "CANCEL":
            token_id = int((e.payload or {}).get("token_id"))
            if token_id:
                cancel_token(body.session_id, token_id, sb)
        elif e.event_type == "EMERGENCY":
            minutes = int((e.payload or {}).get("minutes") or 10)
            debt = int(s.get("emergency_debt_minutes") or 0) + minutes
            s["emergency_debt_minutes"] = debt
            _sb_update_session(sb, body.session_id, {"emergency_debt_minutes": debt})

        accepted += 1

    return {"ok": True, "accepted": accepted}
