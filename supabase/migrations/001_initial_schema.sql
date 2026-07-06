-- Ghost Compute: initial schema
-- Enable UUID generation
create extension if not exists "pgcrypto";

-- ============================================================
-- Workers
-- ============================================================
create table if not exists workers (
  id              uuid primary key default gen_random_uuid(),
  pubkey          text not null unique,
  auth_token_hash text not null,
  model           text not null,
  tok_per_sec     numeric(10,2) not null default 0,
  vram_gb         integer not null default 0,
  gpu_model       text not null default '',
  tee_type        text not null default 'none' check (tee_type in ('nvidia_cc','amd_sev_snp','none')),
  status          text not null default 'offline' check (status in ('offline','idle','busy','draining')),
  jobs_completed  integer not null default 0,
  reputation      numeric(5,4) not null default 1.0,
  registered_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now()
);

create index on workers (status);
create index on workers (pubkey);

-- ============================================================
-- Jobs
-- ============================================================
create table if not exists jobs (
  id               uuid primary key default gen_random_uuid(),
  status           text not null default 'pending' check (status in ('pending','routing','running','completed','failed','cancelled')),
  guarantee        text not null default 'standard' check (guarantee in ('standard','high','max_trust_split')),
  worker_id        uuid references workers(id),
  model            text not null,
  tokens_generated integer not null default 0,
  prompt_tokens    integer not null default 0,
  x402_receipt     text,
  toploc_commit    text,
  error            text,
  created_at       timestamptz not null default now(),
  started_at       timestamptz,
  completed_at     timestamptz,
  caller_ip        text
);

create index on jobs (status);
create index on jobs (worker_id);
create index on jobs (created_at desc);

-- ============================================================
-- Worker earnings
-- ============================================================
create table if not exists worker_earnings (
  id                  uuid primary key default gen_random_uuid(),
  worker_id           uuid not null references workers(id),
  job_id              uuid not null references jobs(id),
  ghst_amount_raw     bigint not null,
  settled             boolean not null default false,
  jito_bundle_id      text,
  settled_at          timestamptz,
  created_at          timestamptz not null default now()
);

create index on worker_earnings (worker_id, settled);

-- ============================================================
-- Worker payouts (batched settlement)
-- ============================================================
create table if not exists worker_payouts (
  id              uuid primary key default gen_random_uuid(),
  worker_id       uuid not null references workers(id),
  total_raw       bigint not null,
  tx_signature    text,
  jito_bundle_id  text,
  status          text not null default 'pending' check (status in ('pending','submitted','confirmed','failed')),
  created_at      timestamptz not null default now(),
  confirmed_at    timestamptz
);

-- ============================================================
-- GHST staking
-- ============================================================
create table if not exists stakers (
  id              uuid primary key default gen_random_uuid(),
  pubkey          text not null unique,
  staked_raw      bigint not null default 0,
  rewards_raw     bigint not null default 0,
  staked_at       timestamptz,
  updated_at      timestamptz not null default now()
);

create index on stakers (pubkey);

-- ============================================================
-- Dark pool orders
-- ============================================================
create table if not exists dark_orders (
  id            uuid primary key default gen_random_uuid(),
  side          text not null check (side in ('buy','sell')),
  base_mint     text not null,
  quote_mint    text not null,
  amount_raw    bigint not null,
  price_raw     bigint not null,
  owner_pubkey  text not null,
  guarantee     text not null default 'standard',
  zk_proof      text,
  status        text not null default 'open' check (status in ('open','matched','cancelled','expired')),
  match_id      uuid,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz
);

create index on dark_orders (status, created_at);
create index on dark_orders (base_mint, quote_mint, status);

-- ============================================================
-- Dark pool matches
-- ============================================================
create table if not exists dark_matches (
  id              uuid primary key default gen_random_uuid(),
  buy_order_id    uuid not null references dark_orders(id),
  sell_order_id   uuid not null references dark_orders(id),
  fill_amount_raw bigint not null,
  fill_price_raw  bigint not null,
  jito_bundle_id  text,
  settled         boolean not null default false,
  created_at      timestamptz not null default now(),
  settled_at      timestamptz
);

-- ============================================================
-- Points & indexer events
-- ============================================================
create table if not exists points_ledger (
  id          uuid primary key default gen_random_uuid(),
  pubkey      text not null,
  event_type  text not null,
  points      bigint not null default 0,
  ref_id      text,
  created_at  timestamptz not null default now()
);

create index on points_ledger (pubkey);
create index on points_ledger (created_at desc);

-- ============================================================
-- API keys (for inference access)
-- ============================================================
create table if not exists api_keys (
  id           uuid primary key default gen_random_uuid(),
  key_hash     text not null unique,
  owner_pubkey text not null,
  label        text,
  credits_raw  bigint not null default 0,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);

create index on api_keys (key_hash);

-- ============================================================
-- Canary / anti-fake events
-- ============================================================
create table if not exists canary_events (
  id          uuid primary key default gen_random_uuid(),
  worker_id   uuid not null references workers(id),
  passed      boolean not null,
  latency_ms  integer,
  created_at  timestamptz not null default now()
);

create index on canary_events (worker_id, created_at desc);
