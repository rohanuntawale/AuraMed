from __future__ import annotations

from dataclasses import dataclass
import os

import httpx


@dataclass
class OutboundMessage:
    phone: str
    text: str


def format_token_confirmation(token_no: int, window_start: str, window_end: str) -> str:
    return (
        f"Your token is confirmed: #{token_no}.\n"
        f"Please arrive between {window_start} and {window_end}.\n"
        "Times may vary depending on consultation duration and urgent cases."
    )


def format_delay_notice() -> str:
    return "There may be a delay of approximately 10–15 minutes due to a high-priority case."


def format_session_cancelled() -> str:
    return "Today’s OPD has been closed. Your token is cancelled. Please contact the clinic for next steps."


def send_message(_msg: OutboundMessage) -> None:
    api_key = (os.getenv("SMSMODE_API_KEY") or "").strip()
    if not api_key:
        return

    base_url = (os.getenv("SMSMODE_BASE_URL") or "https://rest.smsmode.com").strip().rstrip("/")
    url = f"{base_url}/sms/v1/messages"

    phone = (_msg.phone or "").strip()
    text = (_msg.text or "").strip()
    if not phone or not text:
        return

    payload = {
        "recipient": {"to": phone},
        "body": {"text": text},
    }

    try:
        with httpx.Client(timeout=10.0) as client:
            resp = client.post(
                url,
                headers={
                    "X-Api-Key": api_key,
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                json=payload,
            )
            resp.raise_for_status()
    except Exception:
        # Do not break core flows if SMS provider fails.
        return
