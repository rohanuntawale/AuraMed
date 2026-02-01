from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session as OrmSession

from .models import Session, Token, TokenState


@dataclass
class ArrivalWindow:
    start: datetime
    end: datetime


def _breaks_before_position(session: Session, position_index: int) -> int:
    if session.break_every_n <= 0:
        return 0
    return position_index // session.break_every_n


def estimate_call_time(session: Session, position_index: int, now: datetime) -> datetime:
    per_patient = session.slot_minutes + session.micro_buffer_minutes
    breaks = _breaks_before_position(session, position_index)

    minutes = position_index * per_patient + breaks * session.break_minutes

    reserve = session.emergency_reserve_minutes
    debt = max(0, session.emergency_debt_minutes)
    absorbed = min(reserve, debt)
    remaining_debt = debt - absorbed

    minutes += remaining_debt

    return now + timedelta(minutes=minutes)


def compute_arrival_window(session: Session, position_index: int, now: datetime) -> ArrivalWindow:
    call_time = estimate_call_time(session, position_index, now)

    base_width = 20
    if session.emergency_debt_minutes > 0:
        base_width = 30

    start = call_time - timedelta(minutes=base_width // 2)
    end = call_time + timedelta(minutes=base_width // 2)

    if end < now + timedelta(minutes=5):
        start = now + timedelta(minutes=5)
        end = start + timedelta(minutes=base_width)

    return ArrivalWindow(start=start, end=end)


def get_serving_token(db: OrmSession, session_id: int) -> Token | None:
    q = select(Token).where(Token.session_id == session_id, Token.state == TokenState.SERVING)
    return db.execute(q).scalars().first()


def get_next_eligible_token(db: OrmSession, session_id: int) -> Token | None:
    q = (
        select(Token)
        .where(
            Token.session_id == session_id,
            Token.state.in_([TokenState.ARRIVED, TokenState.BOOKED, TokenState.SKIPPED]),
        )
        .order_by(Token.token_no.asc())
    )
    return db.execute(q).scalars().first()


def get_upcoming_tokens(db: OrmSession, session_id: int, limit: int = 12) -> list[Token]:
    q = (
        select(Token)
        .where(
            Token.session_id == session_id,
            Token.state.in_([TokenState.ARRIVED, TokenState.BOOKED, TokenState.SKIPPED]),
        )
        .order_by(Token.token_no.asc())
        .limit(limit)
    )
    return list(db.execute(q).scalars().all())
