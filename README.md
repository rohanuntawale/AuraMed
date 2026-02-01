# OPD Token & Patient Flow Intelligence (MVP)

This is an **offline-friendly OPD queue orchestration MVP** (not appointments, not diagnosis).

## What it includes

- FastAPI backend + SQLite
- Session-bound FIFO tokens with states:
  - BOOKED, ARRIVED, SERVING, SKIPPED, CANCELLED, COMPLETED
- Elastic arrival windows (patients never see exact times)
- Emergency absorption via "emergency debt" minutes (consumes buffers/breaks)
- Doctor fatigue protection via scheduled breaks (modeled into estimates)
- Offline-first clinic dashboard PWA:
  - Works during internet drops (actions are queued locally)
  - Auto-syncs when internet returns

## Run locally

### Backend

1. Install deps

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

2. Start server

```bash
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

### Frontend dashboard (React + TS + Tailwind)

3. Install deps

```bash
npm install
```

4. Run dev server

```bash
npm run dev -- --host 0.0.0.0 --port 5173
```

The Vite dev server proxies `/api/*` to `http://127.0.0.1:8000`.

### Open dashboard

- http://localhost:5173/

## Notes / Safety

- The patient intake endpoint returns an **urgency label** (low/medium/high) and a neutral summary.
- No diagnosis, no treatment advice, no exact-time promises.
