-- L8 chain indexer: persist program activity for explorer + points hooks.

create table if not exists chain_events (
  id           uuid primary key default gen_random_uuid(),
  signature    text not null unique,
  slot         bigint,
  program_id   text not null,
  instruction  text,
  meta         jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists chain_events_slot_idx on chain_events (slot desc nulls last);
create index if not exists chain_events_program_idx on chain_events (program_id);

alter table dark_matches
  add column if not exists on_chain_sig text;
