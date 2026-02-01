from __future__ import annotations

import os
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv(dotenv_path=Path(__file__).resolve().parents[1] / ".env")
except Exception:
    pass

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


def make_engine(sqlite_path: str | None = None):
    database_url = os.getenv("DATABASE_URL", "").strip()
    if database_url:
        return create_engine(database_url, future=True, pool_pre_ping=True)

    base_dir = Path(__file__).resolve().parents[1]
    local_path = sqlite_path or str(base_dir / "opd.sqlite3")

    engine = create_engine(
        f"sqlite:///{local_path}",
        connect_args={"check_same_thread": False},
        future=True,
    )
    return engine


def make_session_local(engine):
    return sessionmaker(autocommit=False, autoflush=False, bind=engine, future=True)
