-- Supabase Postgres schema for OPD Token & Patient Flow Intelligence MVP
-- Paste into Supabase SQL Editor and run.
-- This schema is intentionally minimal and operationally focused.

begin;

-- Sessions are session-bound (e.g., today's OPD for one clinic+doctor)
create table if not exists public.sessions (
  id bigserial primary key,
  clinic_id text not null default 'default',
  doctor_id text not null default 'default',
  date_key text not null,

  start_time_local text not null default '17:00',
  end_time_local text not null default '20:00',

  slot_minutes int not null default 9,
  micro_buffer_minutes int not null default 2,
  break_every_n int not null default 6,
  break_minutes int not null default 10,
  emergency_reserve_minutes int not null default 20,

  planned_leave boolean not null default false,
  unplanned_closed boolean not null default false,

  emergency_debt_minutes int not null default 0,

  created_at timestamptz not null default now(),

  constraint uq_session_day unique (clinic_id, doctor_id, date_key)
);

-- Token states are strict (not an appointment system)
-- Supabase/Postgres compatibility note:
-- Some Postgres versions do not support `CREATE TYPE IF NOT EXISTS`.
do $$
begin
  drop type if exists public.token_state;
exception
  when others then null;
end $$;

create type public.token_state as enum (
  'BOOKED',
  'ARRIVED',
  'SERVING',
  'SKIPPED',
  'CANCELLED',
  'COMPLETED'
);

create table if not exists public.tokens (
  id bigserial primary key,
  session_id bigint not null references public.sessions(id) on delete cascade,

  token_no int not null,
  phone text not null,
  name text not null default '',

  urgency text not null default 'low',
  complaint_text text not null default '',
  intake_summary text not null default '',

  state public.token_state not null default 'BOOKED',

  booked_at timestamptz not null default now(),
  arrived_at timestamptz,
  serving_at timestamptz,
  completed_at timestamptz,

  last_state_change_at timestamptz not null default now(),

  constraint uq_token_no unique (session_id, token_no)
);

create index if not exists idx_tokens_session_state_no on public.tokens (session_id, state, token_no);
create index if not exists idx_tokens_session_no on public.tokens (session_id, token_no);
create index if not exists idx_tokens_session_phone on public.tokens (session_id, phone);

-- Client events provide offline idempotency and an audit trail.
create table if not exists public.client_events (
  id bigserial primary key,
  session_id bigint not null references public.sessions(id) on delete cascade,
  client_id text not null,
  event_id text not null,
  event_type text not null,
  payload_json text not null default '{}',
  created_at timestamptz not null default now(),

  constraint uq_client_event unique (client_id, event_id)
);

create index if not exists idx_client_events_session_created on public.client_events (session_id, created_at);

-- Message outbox (delivery integration later; keeps core flow resilient)
create table if not exists public.message_outbox (
  id bigserial primary key,
  session_id bigint references public.sessions(id) on delete set null,
  token_id bigint references public.tokens(id) on delete set null,
  phone text not null default '',
  message_type text not null default 'INFO',
  text text not null,
  status text not null default 'PENDING',
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists idx_message_outbox_status_created on public.message_outbox (status, created_at);

-- NOTE on security:
-- For this MVP (Option A), the dashboard does NOT access Supabase directly.
-- Keep RLS enabled if you plan to expose tables later; for now, FastAPI should use the service role key.

commit;
