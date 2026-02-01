-- Supabase Postgres schema for OPD Token & Patient Flow Intelligence MVP
-- Paste into Supabase SQL Editor and run.
-- This schema is intentionally minimal and operationally focused.

begin;

create table if not exists public.clinics (
  clinic_id text primary key,
  clinic_name text not null default '',
  clinic_code text not null default '',
  clinic_pin text not null default '',
  created_at timestamptz not null default now()
);

create unique index if not exists uq_clinics_code on public.clinics (clinic_code);

create table if not exists public.doctors (
  id bigserial primary key,
  clinic_id text not null references public.clinics(clinic_id) on delete cascade,
  doctor_id text not null,
  doctor_name text not null default '',
  doctor_code text not null default '',
  created_at timestamptz not null default now(),
  constraint uq_doctor_key unique (clinic_id, doctor_id)
);

create unique index if not exists uq_doctors_code on public.doctors (clinic_id, doctor_code);
create index if not exists idx_doctors_clinic on public.doctors (clinic_id, doctor_name);

insert into public.clinics (clinic_id, clinic_name, clinic_code)
values ('default', 'Default Clinic', 'CLINIC-DEFAULT')
on conflict (clinic_id) do nothing;

alter table public.clinics
  add column if not exists clinic_pin text not null default '';

update public.clinics
set clinic_pin = '0000'
where clinic_id = 'default' and (clinic_pin is null or clinic_pin = '');

insert into public.doctors (clinic_id, doctor_id, doctor_name, doctor_code)
values ('default', 'default', 'Default Doctor', 'DOC-DEFAULT')
on conflict (clinic_id, doctor_id) do nothing;

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
  break_every_n int not null default 5,
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
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'token_state' and n.nspname = 'public'
  ) then
    create type public.token_state as enum (
      'BOOKED',
      'ARRIVED',
      'SERVING',
      'SKIPPED',
      'CANCELLED',
      'COMPLETED'
    );
  end if;
end $$;

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

alter table if exists public.tokens add column if not exists slot_index int;
alter table if exists public.tokens add column if not exists scheduled_start_local text not null default '';
alter table if exists public.tokens add column if not exists scheduled_end_local text not null default '';

create index if not exists idx_tokens_session_slot on public.tokens (session_id, slot_index);

do $$
begin
  create unique index if not exists uq_active_slot
  on public.tokens (session_id, slot_index)
  where slot_index is not null and state not in ('CANCELLED','COMPLETED');
exception
  when others then null;
end $$;

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

create table if not exists public.notifications (
  id bigserial primary key,
  session_id bigint references public.sessions(id) on delete set null,
  token_id bigint references public.tokens(id) on delete set null,
  phone text not null default '',
  audience text not null default 'patient',
  kind text not null default 'INFO',
  title text not null default '',
  body text not null default '',
  created_at timestamptz not null default now(),
  dismissed_at timestamptz
);

create index if not exists idx_notifications_phone_created on public.notifications (phone, created_at);
create index if not exists idx_notifications_session_created on public.notifications (session_id, created_at);
create index if not exists idx_notifications_dismissed on public.notifications (dismissed_at);

-- NOTE on security:
-- For this MVP (Option A), the dashboard does NOT access Supabase directly.
-- Keep RLS enabled if you plan to expose tables later; for now, FastAPI should use the service role key.

commit;
