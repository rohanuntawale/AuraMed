from __future__ import annotations

import enum
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Enum, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class TokenState(str, enum.Enum):
    BOOKED = "BOOKED"
    ARRIVED = "ARRIVED"
    SERVING = "SERVING"
    SKIPPED = "SKIPPED"
    CANCELLED = "CANCELLED"
    COMPLETED = "COMPLETED"


class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    clinic_id: Mapped[str] = mapped_column(String(64), default="default", index=True)
    doctor_id: Mapped[str] = mapped_column(String(64), default="default", index=True)

    date_key: Mapped[str] = mapped_column(String(16), index=True)
    start_time_local: Mapped[str] = mapped_column(String(8), default="17:00")
    end_time_local: Mapped[str] = mapped_column(String(8), default="20:00")

    slot_minutes: Mapped[int] = mapped_column(Integer, default=9)
    micro_buffer_minutes: Mapped[int] = mapped_column(Integer, default=2)
    break_every_n: Mapped[int] = mapped_column(Integer, default=6)
    break_minutes: Mapped[int] = mapped_column(Integer, default=10)
    emergency_reserve_minutes: Mapped[int] = mapped_column(Integer, default=20)

    planned_leave: Mapped[bool] = mapped_column(Boolean, default=False)
    unplanned_closed: Mapped[bool] = mapped_column(Boolean, default=False)

    emergency_debt_minutes: Mapped[int] = mapped_column(Integer, default=0)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    tokens: Mapped[list[Token]] = relationship("Token", back_populates="session")

    __table_args__ = (
        UniqueConstraint("clinic_id", "doctor_id", "date_key", name="uq_session_day"),
    )


class Token(Base):
    __tablename__ = "tokens"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"), index=True)

    token_no: Mapped[int] = mapped_column(Integer, index=True)
    phone: Mapped[str] = mapped_column(String(32), index=True)
    name: Mapped[str] = mapped_column(String(128), default="")

    urgency: Mapped[str] = mapped_column(String(16), default="low")
    complaint_text: Mapped[str] = mapped_column(Text, default="")
    intake_summary: Mapped[str] = mapped_column(Text, default="")

    state: Mapped[TokenState] = mapped_column(
        Enum(TokenState, name="token_state", native_enum=True, create_constraint=False),
        default=TokenState.BOOKED,
        index=True,
    )

    booked_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    arrived_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    serving_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    last_state_change_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    session: Mapped[Session] = relationship("Session", back_populates="tokens")

    __table_args__ = (
        UniqueConstraint("session_id", "token_no", name="uq_token_no"),
    )


class ClientEvent(Base):
    __tablename__ = "client_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[int] = mapped_column(Integer, index=True)
    client_id: Mapped[str] = mapped_column(String(64), index=True)
    event_id: Mapped[str] = mapped_column(String(64), index=True)
    event_type: Mapped[str] = mapped_column(String(64))
    payload_json: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("client_id", "event_id", name="uq_client_event"),
    )


class MessageOutbox(Base):
    __tablename__ = "message_outbox"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    token_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)

    phone: Mapped[str] = mapped_column(String(32), default="")
    message_type: Mapped[str] = mapped_column(String(32), default="INFO")
    text: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(16), default="PENDING", index=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
