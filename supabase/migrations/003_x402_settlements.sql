-- x402 on-chain settlement nonce dedup (prevents double-spend on orchestrator restart)

create table if not exists x402_settlements (
  nonce         text primary key,
  payer         text not null,
  amount_raw    bigint not null,
  tx_signature  text not null,
  settled_at    timestamptz not null default now()
);

create index if not exists x402_settlements_payer_idx on x402_settlements (payer);
create index if not exists x402_settlements_settled_at_idx on x402_settlements (settled_at desc);

alter table x402_settlements enable row level security;

-- Service role only (orchestrator); no public reads of payment nonces
create policy "service role full access on x402_settlements"
  on x402_settlements
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
