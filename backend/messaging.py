from __future__ import annotations

from dataclasses import dataclass


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
    # MVP stub: integrate WhatsApp/SMS later. Keep backend operational without external dependencies.
    return
