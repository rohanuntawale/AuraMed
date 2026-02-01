from __future__ import annotations

import os
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv(dotenv_path=Path(__file__).resolve().parents[1] / ".env")
except Exception:
    pass

from supabase import Client, create_client


def get_supabase_client() -> Client:
    url = (os.getenv("SUPABASE_URL") or "").strip()
    key = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()

    if not url or not key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (check d:/AuraMed/.env)")

    if key.startswith("sb_"):
        raise RuntimeError(
            "SUPABASE_SERVICE_ROLE_KEY looks like an sb_* key. For supabase-py you must use the JWT 'service_role' key from Supabase Dashboard -> Settings -> API (starts with eyJ...)."
        )

    if not (key.startswith("eyJ") and "." in key):
        raise RuntimeError(
            "SUPABASE_SERVICE_ROLE_KEY does not look like a JWT. Use the 'service_role' JWT key from Supabase Dashboard -> Settings -> API (starts with eyJ...)."
        )

    return create_client(url, key)
