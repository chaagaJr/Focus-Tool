-- Focus — database schema (version 2).
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to run more than once, and safe to run over version 1: it only adds what's missing.

-- Tasks, info notes, people and events live in one table, told apart by `kind`.
create table if not exists public.items (
  id             uuid primary key default gen_random_uuid(),
  kind           text not null default 'task',
  title          text not null check (length(title) between 1 and 500),
  body           text not null default '',
  tags           text[] not null default '{}',
  pinned         boolean not null default false,
  priority       boolean not null default false,
  remind_at      timestamptz,             -- task: when to remind · event: when it starts
  repeat         text check (repeat in ('daily', 'weekdays', 'weekly', 'monthly')),
  nag_minutes    integer check (nag_minutes between 0 and 1440), -- null = your default, 0 = remind once
  snoozed_until  timestamptz,
  last_nagged_at timestamptz,
  nag_count      integer not null default 0,
  done_at        timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Version 2 additions
alter table public.items add column if not exists due_at         timestamptz; -- a hard deadline (tasks)
alter table public.items add column if not exists ends_at        timestamptz; -- events: when it finishes
alter table public.items add column if not exists busy           boolean not null default true; -- events: hold nags while it's on
alter table public.items add column if not exists lead_minutes   integer;     -- events: heads-up this long before
alter table public.items add column if not exists star_date      date;        -- tasks: one of "today's 3" on this day
alter table public.items add column if not exists effort_minutes integer;     -- tasks: roughly how long it takes
alter table public.items add column if not exists parent_id      uuid references public.items(id) on delete cascade; -- deadline check-ins
alter table public.items add column if not exists birthday       text;        -- people: 'MM-DD' or 'YYYY-MM-DD'
alter table public.items add column if not exists checkin_days   integer;     -- people: catch up every N days
alter table public.items add column if not exists last_contact   timestamptz; -- people: last time you were in touch
alter table public.items add column if not exists source         text;        -- which calendar it came from
alter table public.items add column if not exists source_uid     text;        -- its id in that calendar
alter table public.items add column if not exists meta           jsonb not null default '{}';

alter table public.items drop constraint if exists items_kind_check;
alter table public.items add constraint items_kind_check check (kind in ('task', 'info', 'person', 'event'));

create index if not exists items_open_tasks on public.items (kind, done_at);
create index if not exists items_source on public.items (source);
create index if not exists items_parent on public.items (parent_id);

-- Each browser/phone that has turned on notifications.
create table if not exists public.push_subs (
  endpoint     text primary key,
  subscription jsonb not null,
  device       text,
  created_at   timestamptz not null default now()
);

-- Settings, push keys, calendar links and small bits of state the server keeps.
create table if not exists public.app_config (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- Keep updated_at current.
create or replace function public.focus_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists items_touch on public.items;
create trigger items_touch before update on public.items
  for each row execute function public.focus_touch_updated_at();

-- Lock the tables down. Row Level Security is on and there are deliberately
-- NO policies, so the public API keys can't read or write anything.
-- Only your edge function (which uses the server-side secret key) can.
alter table public.items      enable row level security;
alter table public.push_subs  enable row level security;
alter table public.app_config enable row level security;
