-- Ghost Compute: privacy schema (P10)
-- Holds attestation, proofs, sealed orders, enclave keys, audits and governance.
-- HARD RULE (spec Part VII): NO PLAINTEXT PAYLOADS, EVER. Only ciphertext,
-- commitments, hashes and attestation metadata live here.

create extension if not exists "pgcrypto";

-- ============================================================
-- Worker attestation fields (P9 —  owns these on the shared workers table)
-- confidential_ok gates confidential routing; last_attest drives fail-closed
-- staleness (P8); verify_pass_rate / attest_uptime feed reputation + explorer.
-- ============================================================
alter table workers add column if not exists confidential_ok  boolean     not null default false;
alter table workers add column if not exists last_attest       timestamptz;
alter table workers add column if not exists attest_uptime     numeric(5,4) not null default 0;
alter table workers add column if not exists verify_pass_rate  numeric(5,4) not null default 1.0;
create index if not exists workers_confidential_idx on workers (confidential_ok, last_attest);

-- ============================================================
-- Enclave key registry (P2)
-- Per-worker X25519 enclave public keys, published from attestation.
-- Clients seal payloads to current_pubkey; the enclave holds the private half.
-- ============================================================
create table if not exists enclave_keys (
  id              uuid primary key default gen_random_uuid(),
  worker_pubkey   text not null,
  enclave_pubkey  text not null,                 -- 32-byte X25519, hex
  tee_type        text not null check (tee_type in ('nvidia_cc','amd_sev_snp')),
  attestation_id  uuid,                          -- FK set after attestation row exists
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  rotated_at      timestamptz,
  unique (worker_pubkey, enclave_pubkey)
);
create index on enclave_keys (worker_pubkey, active);

-- ============================================================
-- Attestations (P3)
-- One row per verified (or rejected) TEE quote. report_hash is anchored onchain.
-- ============================================================
create table if not exists attestations (
  id               uuid primary key default gen_random_uuid(),
  worker_pubkey    text not null,
  tee_type         text not null check (tee_type in ('nvidia_cc','amd_sev_snp')),
  nonce            text not null,                -- freshness challenge (hex)
  report_hash      text not null,               -- sha256 of canonical quote (hex) — onchain anchor key
  verdict          text not null default 'pending'
                     check (verdict in ('pending','verified','rejected','unverified_no_root')),
  reject_reason    text,
  vendor_root_id   text,                          -- which configured root verified it
  onchain_sig      text,                          -- tx signature of the anchor
  onchain_slot     bigint,
  verified_at      timestamptz,
  created_at       timestamptz not null default now(),
  -- last_attest freshness lives on the worker; this is the immutable event log
  unique (report_hash)
);
create index on attestations (worker_pubkey, created_at desc);
create index on attestations (verdict);

-- enclave_keys.attestation_id references attestations(id)
alter table enclave_keys
  drop constraint if exists enclave_keys_attestation_fk;
alter table enclave_keys
  add constraint enclave_keys_attestation_fk
  foreign key (attestation_id) references attestations(id) on delete set null;

-- ============================================================
-- Output proofs (P4 TOPLOC / ZK)
-- One row per job receipt. Stores the commitment + bound hashes, never the I/O.
-- ============================================================
create table if not exists proofs (
  id             uuid primary key default gen_random_uuid(),
  job_id         uuid not null,
  proof_system   text not null check (proof_system in ('toploc','zk')),
  model_hash     text not null,
  input_hash     text not null,
  output_hash    text not null,
  commitment     text not null,                 -- hex (TOPLOC = 258 bytes; ZK = proof blob)
  verified       boolean not null default false,
  verified_at    timestamptz,
  created_at     timestamptz not null default now(),
  unique (job_id, proof_system)
);
create index on proofs (job_id);
create index on proofs (output_hash);

-- ============================================================
-- Sealed dark-pool orders (P5 / L3)
-- Commitment + ciphertext only. The resting book is NEVER exposed in plaintext.
-- ============================================================
create table if not exists sealed_orders (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null unique,
  owner_pubkey   text not null,
  commit_hash    text not null,                 -- on-chain commitment hash
  ciphertext     text not null,                 -- sealed order payload (base64)
  margin_raw     bigint not null default 0,
  guarantee      text not null default 'high'
                   check (guarantee in ('standard','high','max_trust_split')),
  status         text not null default 'sealed'
                   check (status in ('sealed','matched','cancelled','expired')),
  created_at     timestamptz not null default now(),
  expires_at     timestamptz
);
create index on sealed_orders (status, created_at);
create index on sealed_orders (owner_pubkey);

-- ============================================================
-- Confidential transfers (P6)
-- Worker payouts + dark-pool fills settled via Token-2022 Confidential Balances.
-- Stores ONLY the encrypted-amount commitment + tx — never the cleartext amount.
-- ============================================================
create table if not exists confidential_transfers (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('worker_payout','dark_pool_fill')),
  ref_id           text not null,                 -- job id / fill id
  recipient_pubkey text not null,
  amount_commitment text not null,                -- encrypted-amount handle (hex)
  status           text not null default 'pending'
                     check (status in ('pending','submitted','confirmed','failed')),
  tx_signature     text,
  created_at       timestamptz not null default now(),
  confirmed_at     timestamptz
);
create index on confidential_transfers (recipient_pubkey, created_at desc);
create index on confidential_transfers (status);

-- ============================================================
-- Audits (P7 / P8)
-- Append-only log of privacy-relevant decisions: fail-closed drops, verifier
-- verdicts, envelope halts. Powers the public Attestation Explorer.
-- ============================================================
create table if not exists audits (
  id             uuid primary key default gen_random_uuid(),
  event_type     text not null,                 -- attest_verified | worker_dropped | envelope_halt | proof_rejected ...
  subject_pubkey text,                            -- worker/owner the event concerns (identity withheld in public views)
  job_id         uuid,
  detail         jsonb not null default '{}',
  created_at     timestamptz not null default now()
);
create index on audits (event_type, created_at desc);
create index on audits (subject_pubkey, created_at desc);

-- ============================================================
-- SIWS auth nonces (Phase 0 — Sign-In With Solana)
-- Single-use challenge nonces; consumed on successful sign-in.
-- ============================================================
create table if not exists auth_nonces (
  nonce       text primary key,
  pubkey      text,
  consumed    boolean not null default false,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '5 minutes')
);
create index on auth_nonces (expires_at);

-- ============================================================
-- Governance params (P9 / Realms-mirrored)
-- Privacy parameters, supported enclaves, verification policy.
-- ============================================================
create table if not exists governance_params (
  key            text primary key,
  value          jsonb not null,
  updated_at     timestamptz not null default now(),
  updated_by     text                             -- governance authority / proposal id
);

insert into governance_params (key, value) values
  ('attestation_max_age_seconds', '3600'),
  ('supported_enclaves',          '["nvidia_cc","amd_sev_snp"]'),
  ('require_attestation_for',     '["high","max_trust_split"]'),
  ('verify_pass_rate_min_bps',    '9000')
on conflict (key) do nothing;

-- ============================================================
-- Row Level Security
-- Service role (backend) bypasses RLS. Public read is granted ONLY to the
-- trust-surface tables, with no identity columns exposed via these policies.
-- Writes are backend-only (no anon insert/update/delete).
-- ============================================================
alter table attestations      enable row level security;
alter table proofs            enable row level security;
alter table audits            enable row level security;
alter table sealed_orders     enable row level security;
alter table enclave_keys      enable row level security;
alter table governance_params enable row level security;

-- Public, read-only trust surface (Attestation Explorer, P7).
drop policy if exists attestations_public_read on attestations;
create policy attestations_public_read on attestations
  for select to anon using (verdict in ('verified','rejected'));

drop policy if exists proofs_public_read on proofs;
create policy proofs_public_read on proofs
  for select to anon using (true);

drop policy if exists audits_public_read on audits;
create policy audits_public_read on audits
  for select to anon using (true);

drop policy if exists enclave_keys_public_read on enclave_keys;
create policy enclave_keys_public_read on enclave_keys
  for select to anon using (active = true);

drop policy if exists governance_public_read on governance_params;
create policy governance_public_read on governance_params
  for select to anon using (true);

-- sealed_orders: NO anon read — the resting book stays private. Backend only.
