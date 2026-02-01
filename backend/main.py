from __future__ import annotations

import json
from datetime import datetime

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func, select
from sqlalchemy.orm import Session as OrmSession

from .db import make_engine, make_session_local
from .messaging import OutboundMessage, format_delay_notice, format_session_cancelled, format_token_confirmation, send_message
from .models import Base, ClientEvent, Session, Token, TokenState
from .queue_logic import compute_arrival_window, get_next_eligible_token, get_serving_token, get_upcoming_tokens
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


app = FastAPI(title="OPD Queue Orchestrator MVP", version="0.1")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"]
)


ENGINE = make_engine("/root/iiit/opd.sqlite3")
SessionLocal = make_session_local(ENGINE)
Base.metadata.create_all(bind=ENGINE)


def db_dep():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


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


def _get_or_create_session(db: OrmSession, clinic_id: str, doctor_id: str, date_key: str | None) -> Session:
    dk = date_key or _today_key()
    q = select(Session).where(Session.clinic_id == clinic_id, Session.doctor_id == doctor_id, Session.date_key == dk)
    s = db.execute(q).scalars().first()
    if s:
        return s

    s = Session(clinic_id=clinic_id, doctor_id=doctor_id, date_key=dk)
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


@app.get("/api/health")
def health():
    return {"ok": True}


@app.post("/api/sessions", response_model=SessionOut)
def create_session(body: SessionCreate, db: OrmSession = Depends(db_dep)):
    s = _get_or_create_session(db, body.clinic_id, body.doctor_id, body.date_key)
    if s.planned_leave:
        raise HTTPException(status_code=409, detail="Planned leave: bookings disabled")
    return SessionOut(**s.__dict__)


@app.get("/api/sessions/current", response_model=SessionOut)
def get_current_session(clinic_id: str = "default", doctor_id: str = "default", db: OrmSession = Depends(db_dep)):
    s = _get_or_create_session(db, clinic_id, doctor_id, None)
    return SessionOut(**s.__dict__)


@app.post("/api/intake", response_model=IntakeResult)
def intake(body: IntakeRequest):
    return _intake_stub(body)


@app.post("/api/tokens/book", response_model=TokenOut)
def book_token(body: IntakeRequest, clinic_id: str = "default", doctor_id: str = "default", db: OrmSession = Depends(db_dep)):
    s = _get_or_create_session(db, clinic_id, doctor_id, None)
    if s.planned_leave or s.unplanned_closed:
        raise HTTPException(status_code=409, detail="OPD is closed")

    phone = body.phone.strip()

    existing_q = select(Token).where(
        Token.session_id == s.id,
        Token.phone == phone,
        Token.state.in_([TokenState.BOOKED, TokenState.ARRIVED, TokenState.SERVING, TokenState.SKIPPED]),
    )
    existing = db.execute(existing_q).scalars().first()
    if existing:
        now = datetime.now()
        position_index = max(0, existing.token_no - 1)
        w = compute_arrival_window(s, position_index, now)
        return TokenOut(
            id=existing.id,
            token_no=existing.token_no,
            phone=existing.phone,
            name=existing.name,
            urgency=existing.urgency,
            state=existing.state.value,
            arrival_window_start=_fmt_time(w.start),
            arrival_window_end=_fmt_time(w.end),
        )

    max_no = db.execute(select(func.max(Token.token_no)).where(Token.session_id == s.id)).scalar()
    next_no = int(max_no or 0) + 1

    intake_res = _intake_stub(body)

    t = Token(
        session_id=s.id,
        token_no=next_no,
        phone=phone,
        name=(body.name or "").strip(),
        urgency=intake_res.urgency,
        complaint_text=(body.complaint_text or "").strip(),
        intake_summary=intake_res.intake_summary,
        state=TokenState.BOOKED,
        last_state_change_at=datetime.utcnow(),
    )
    db.add(t)
    db.commit()
    db.refresh(t)

    now = datetime.now()
    w = compute_arrival_window(s, position_index=max(0, t.token_no - 1), now=now)

    msg = OutboundMessage(phone=t.phone, text=format_token_confirmation(t.token_no, _fmt_time(w.start), _fmt_time(w.end)))
    send_message(msg)

    return TokenOut(
        id=t.id,
        token_no=t.token_no,
        phone=t.phone,
        name=t.name,
        urgency=t.urgency,
        state=t.state.value,
        arrival_window_start=_fmt_time(w.start),
        arrival_window_end=_fmt_time(w.end),
    )


@app.post("/api/tokens/{token_id}/arrive")
def mark_arrived(token_id: int, db: OrmSession = Depends(db_dep)):
    t = db.get(Token, token_id)
    if not t:
        raise HTTPException(status_code=404, detail="Token not found")
    if t.state in [TokenState.CANCELLED, TokenState.COMPLETED]:
        return {"ok": True}

    t.state = TokenState.ARRIVED
    t.arrived_at = t.arrived_at or datetime.utcnow()
    t.last_state_change_at = datetime.utcnow()
    db.commit()
    return {"ok": True}


@app.get("/api/queue/state", response_model=QueueStateOut)
def queue_state(session_id: int, db: OrmSession = Depends(db_dep)):
    s = db.get(Session, session_id)
    if not s:
        raise HTTPException(status_code=404, detail="Session not found")

    serving = get_serving_token(db, session_id)
    upcoming = get_upcoming_tokens(db, session_id, limit=12)

    def to_token(x: Token) -> QueueStateToken:
        return QueueStateToken(
            id=x.id,
            token_no=x.token_no,
            name=x.name,
            phone=x.phone,
            urgency=x.urgency,
            state=x.state.value,
        )

    stats = {
        "emergency_debt_minutes": s.emergency_debt_minutes,
        "unplanned_closed": s.unplanned_closed,
        "planned_leave": s.planned_leave,
    }

    return QueueStateOut(
        session_id=s.id,
        now_iso=datetime.utcnow().isoformat(),
        serving=to_token(serving) if serving else None,
        upcoming=[to_token(x) for x in upcoming],
        stats=stats,
    )


@app.post("/api/queue/serve_next")
def serve_next(session_id: int, db: OrmSession = Depends(db_dep)):
    s = db.get(Session, session_id)
    if not s:
        raise HTTPException(status_code=404, detail="Session not found")
    if s.unplanned_closed:
        raise HTTPException(status_code=409, detail="OPD closed")

    current = get_serving_token(db, session_id)
    if current:
        current.state = TokenState.COMPLETED
        current.completed_at = datetime.utcnow()
        current.last_state_change_at = datetime.utcnow()

    nxt = get_next_eligible_token(db, session_id)
    if not nxt:
        db.commit()
        return {"ok": True, "served": None}

    if nxt.state == TokenState.BOOKED:
        nxt.state = TokenState.SKIPPED
        nxt.last_state_change_at = datetime.utcnow()
        db.commit()
        return {"ok": True, "served": None, "note": "next token not arrived; skipped"}

    nxt.state = TokenState.SERVING
    nxt.serving_at = datetime.utcnow()
    nxt.last_state_change_at = datetime.utcnow()
    db.commit()
    return {"ok": True, "served": {"token_id": nxt.id, "token_no": nxt.token_no}}


@app.post("/api/queue/skip")
def skip_token(session_id: int, token_id: int, db: OrmSession = Depends(db_dep)):
    t = db.get(Token, token_id)
    if not t or t.session_id != session_id:
        raise HTTPException(status_code=404, detail="Token not found")
    if t.state in [TokenState.CANCELLED, TokenState.COMPLETED]:
        return {"ok": True}
    if t.state == TokenState.SERVING:
        t.state = TokenState.SKIPPED
        t.last_state_change_at = datetime.utcnow()
    elif t.state == TokenState.BOOKED:
        t.state = TokenState.SKIPPED
        t.last_state_change_at = datetime.utcnow()
    db.commit()
    return {"ok": True}


@app.post("/api/queue/cancel")
def cancel_token(session_id: int, token_id: int, db: OrmSession = Depends(db_dep)):
    t = db.get(Token, token_id)
    if not t or t.session_id != session_id:
        raise HTTPException(status_code=404, detail="Token not found")
    t.state = TokenState.CANCELLED
    t.last_state_change_at = datetime.utcnow()
    db.commit()
    return {"ok": True}


@app.post("/api/queue/walkin")
def add_walkin(session_id: int, body: WalkInRequest, db: OrmSession = Depends(db_dep)):
    s = db.get(Session, session_id)
    if not s:
        raise HTTPException(status_code=404, detail="Session not found")

    max_no = db.execute(select(func.max(Token.token_no)).where(Token.session_id == s.id)).scalar()
    next_no = int(max_no or 0) + 1

    t = Token(
        session_id=s.id,
        token_no=next_no,
        phone=body.phone.strip(),
        name=(body.name or "").strip(),
        urgency=body.urgency,
        complaint_text=(body.complaint_text or "").strip(),
        intake_summary="Walk-in added by staff. No diagnosis provided.",
        state=TokenState.ARRIVED,
        arrived_at=datetime.utcnow(),
        last_state_change_at=datetime.utcnow(),
    )
    db.add(t)
    db.commit()
    db.refresh(t)
    return {"ok": True, "token_id": t.id, "token_no": t.token_no}


@app.post("/api/queue/emergency")
def trigger_emergency(session_id: int, body: EmergencyRequest, db: OrmSession = Depends(db_dep)):
    s = db.get(Session, session_id)
    if not s:
        raise HTTPException(status_code=404, detail="Session not found")

    s.emergency_debt_minutes += body.minutes
    db.commit()

    send_message(OutboundMessage(phone="", text=format_delay_notice()))

    return {"ok": True, "emergency_debt_minutes": s.emergency_debt_minutes}


@app.post("/api/sessions/{session_id}/close_now")
def close_now(session_id: int, db: OrmSession = Depends(db_dep)):
    s = db.get(Session, session_id)
    if not s:
        raise HTTPException(status_code=404, detail="Session not found")

    s.unplanned_closed = True

    q = select(Token).where(
        Token.session_id == session_id,
        Token.state.in_([TokenState.BOOKED, TokenState.ARRIVED, TokenState.SERVING, TokenState.SKIPPED]),
    )
    tokens = list(db.execute(q).scalars().all())
    for t in tokens:
        t.state = TokenState.CANCELLED
        t.last_state_change_at = datetime.utcnow()
        if t.phone:
            send_message(OutboundMessage(phone=t.phone, text=format_session_cancelled()))

    db.commit()
    return {"ok": True, "cancelled": len(tokens)}


@app.post("/api/events/bulk")
def bulk_events(body: BulkEventsRequest, db: OrmSession = Depends(db_dep)):
    s = db.get(Session, body.session_id)
    if not s:
        raise HTTPException(status_code=404, detail="Session not found")

    accepted = 0
    for e in body.events:
        existing = db.execute(
            select(ClientEvent).where(ClientEvent.client_id == body.client_id, ClientEvent.event_id == e.event_id)
        ).scalars().first()
        if existing:
            continue

        ce = ClientEvent(
            session_id=body.session_id,
            client_id=body.client_id,
            event_id=e.event_id,
            event_type=e.event_type,
            payload_json=json.dumps(e.payload or {}),
        )
        db.add(ce)

        if e.event_type == "ARRIVE":
            token_id = int((e.payload or {}).get("token_id"))
            if token_id:
                t = db.get(Token, token_id)
                if t and t.session_id == body.session_id:
                    if t.state not in [TokenState.CANCELLED, TokenState.COMPLETED]:
                        t.state = TokenState.ARRIVED
                        t.arrived_at = t.arrived_at or datetime.utcnow()
                        t.last_state_change_at = datetime.utcnow()
        elif e.event_type == "SERVE_NEXT":
            serve_next(body.session_id, db)
        elif e.event_type == "SKIP":
            token_id = int((e.payload or {}).get("token_id"))
            if token_id:
                skip_token(body.session_id, token_id, db)
        elif e.event_type == "CANCEL":
            token_id = int((e.payload or {}).get("token_id"))
            if token_id:
                cancel_token(body.session_id, token_id, db)
        elif e.event_type == "EMERGENCY":
            minutes = int((e.payload or {}).get("minutes") or 10)
            s.emergency_debt_minutes += minutes

        accepted += 1

    db.commit()
    return {"ok": True, "accepted": accepted}
