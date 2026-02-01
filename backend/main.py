from __future__ import annotations

import json
import os
from datetime import datetime

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .messaging import OutboundMessage, format_delay_notice, format_session_cancelled, format_token_confirmation, send_message
from .queue_logic import compute_arrival_window
from .schemas import (
    BulkEventsRequest,
    EmergencyRequest,
    IntakeRequest,
    IntakeResult,
    QueueStateOut,
    QueueStateToken,
    SessionCreate,
    SessionOut,
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

def staff_dep(x_clinic_pin: str | None = Header(default=None, alias="X-Clinic-Pin")):
    configured = os.getenv("CLINIC_PIN", "0000")
    if not configured:
        return
    if x_clinic_pin != configured:
        raise HTTPException(status_code=401, detail="Unauthorized")


def sb_dep():
    try:
        return get_supabase_client()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _today_key() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def _fmt_time(dt: datetime) -> str:
    return dt.strftime("%I:%M %p").lstrip("0")


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

    summary = (req.complaint_text or "").strip()
    if not summary:
        summary = "Patient requested OPD consultation."

    safe_summary = (
        "Patient-described concern: "
        + summary[:800]
        + "\n\n"
        + "Note: This is a descriptive intake summary. No diagnosis is provided."
    )

    return IntakeResult(urgency=urgency, intake_summary=safe_summary)


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
def intake(body: IntakeRequest):
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


@app.post("/api/queue/serve_next")
def serve_next(session_id: int, sb=Depends(sb_dep), _staff=Depends(staff_dep)):
    s = _sb_one(sb.table("sessions").select("*").eq("id", session_id).limit(1).execute())
    if not s:
        raise HTTPException(status_code=404, detail="Session not found")
    if bool(s.get("unplanned_closed")):
        raise HTTPException(status_code=409, detail="OPD closed")

    current = _sb_get_serving_token(sb, session_id)
    if current:
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
    if t.get("state") in ["SERVING", "BOOKED"]:
        _sb_update_token(sb, token_id, {"state": "SKIPPED", "last_state_change_at": datetime.utcnow().isoformat()})
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
    debt = int(s.get("emergency_debt_minutes") or 0) + int(body.minutes)
    _sb_update_session(sb, session_id, {"emergency_debt_minutes": debt})

    send_message(OutboundMessage(phone="", text=format_delay_notice()))

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
