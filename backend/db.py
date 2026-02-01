from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


def make_engine(sqlite_path: str):
    engine = create_engine(
        f"sqlite:///{sqlite_path}",
        connect_args={"check_same_thread": False},
        future=True,
    )
    return engine


def make_session_local(engine):
    return sessionmaker(autocommit=False, autoflush=False, bind=engine, future=True)
