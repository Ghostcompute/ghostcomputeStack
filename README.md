<div align="center">

<img src="public/__l5e/assets-v1/86682dfb-d8c8-48ad-a17a-1b938b6ff02b/ghost-logo.png" alt="Ghost Compute" width="140" />

# Ghost Compute

**A confidential GPU compute network on Solana.**

Run AI inference on decentralized GPUs with hardware-verified trust, cryptographic proof of execution, and end-to-end confidential settlement.

[![Solana](https://img.shields.io/badge/Solana-Anchor-9945FF?logo=solana&logoColor=white)](https://solana.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![Rust](https://img.shields.io/badge/Rust-Programs-000000?logo=rust&logoColor=white)](https://www.rust-lang.org)

</div>

---

## Overview

Ghost Compute is a marketplace for verifiable, private AI inference. Clients send
requests to an OpenAI-compatible API; jobs are routed to a fleet of independent GPU
workers running [vLLM](https://github.com/vllm-project/vllm). Every job can be
cryptographically attested, proven, and settled on-chain — without exposing the
prompt, the output, or the payment amount.

It is built for three levels of trust, selectable per request:

| Tier | Guarantee | What it means |
|------|-----------|---------------|
| **Standard** | Throughput | Plaintext job, routed to any available worker. |
| **High** | Hardware trust | Requires a worker running inside a verified **TEE** (Trusted Execution Environment), checked against an on-chain attestation. |
| **MaxTrustSplit** | Cryptographic privacy | Computation is split across **Arcium MPC** with homomorphically-encrypted (FHE) output — no single party sees the data. |

## Key features

- **OpenAI-compatible inference API** — drop-in `/v1/chat/completions` with streaming and tool calling.
- **Pay-per-token metering** — usage settled with the [x402](https://www.x402.org) payment standard on Solana devnet (GHST Token-2022).
- **Operator console** — live fleet KPIs, inference chat with wallet x402, attestation feed, dark pool, and points leaderboard at `/dashboard`.
- **TEE attestation** — workers prove they run trusted hardware before they can serve `High`-tier jobs.
- **TOPLOC proof of inference** — each completion carries a compact commitment that ties the output to the model and worker.
- **Confidential dark pool** — GHST/USDC order book with in-process matching and optional on-chain settlement via the `dark_pool` program.
- **Chain indexer** — devnet program activity indexed to Postgres for the live explorer feed.
- **Confidential settlement** — worker payouts and fills use Token-2022 confidential transfers; amounts are encrypted end-to-end.
- **On-chain coordination** — a worker registry, job router, staking, fee distribution, attestation, and governance, all as Anchor programs.

## Architecture

```
   client
     │  POST /v1/chat/completions   (x402 payment header)
     ▼
 ┌─────────────┐      job:new       ┌──────────────┐
 │ Orchestrator │ ─────────────────▶ │  GPU worker  │  vLLM + TEE
 │  (router)    │ ◀───────────────── │ (attested)   │  streaming tokens
 └─────────────┘    job:token        └──────────────┘
     │                                      │
     │  TOPLOC commitment stored            │ proof of inference
     ▼                                      ▼
 ┌─────────────┐   batched relayer   ┌──────────────┐
 │ Settlement   │ ─────────────────▶ │   Solana     │  confidential payout
 │ (Jito bundle)│                     │  programs    │
 └─────────────┘                     └──────────────┘
```

## Tech stack

| Area | Technology |
|------|-----------|
| Web app | React 19, TanStack Start, Vite, Tailwind CSS, Radix UI / shadcn |
| Backend | TypeScript, Socket.io, Supabase (Postgres) |
| On-chain | Solana, Anchor (Rust) |
| Inference | vLLM, OpenAI-compatible gateway |
| Privacy | TEE attestation, Arcium MPC, FHE, zero-knowledge proofs, Token-2022 confidential transfers |
| Runtime | Bun |

## Repository structure

```
.
├── apps/web/            Web app + server services
│   └── src/server/      orchestrator · inference · darkpool · settlement · tokenomics · indexer · fleet
├── worker/              GPU inference agent (vLLM client, TEE attestation, benchmarks)
├── programs/            Solana on-chain programs (Anchor, Rust)
│                        worker_registry · job_router · dark_pool · ghst_staking · fee_collector · attestation
├── packages/
│   ├── crypto/          TEE sealing, TOPLOC verifier, ZK helpers, FHE
│   ├── shared/          Shared types, DTOs, and Zod schemas
│   └── solana/          Anchor IDL clients, PDA helpers, RPC
└── supabase/            Postgres schema and migrations
```

## Getting started

> Requires [Bun](https://bun.sh), a Solana toolchain with [Anchor](https://www.anchor-lang.com),
> and a Postgres database (e.g. [Supabase](https://supabase.com)). A vLLM endpoint is needed to run a worker locally.

```bash
# 1. Install dependencies
bun install

# 2. Configure environment variables for your deployment
#    (Solana RPC, database connection, and service keys)

# 3. Start the web app
bun dev

# 4. Start the orchestrator (separate terminal)
bun run orchestrator

# 5. Start a GPU worker (needs a vLLM endpoint)
bun run worker:dev

# 6. Apply database migrations
supabase db push

# 7. Verify the stack (orchestrator must be running)
pnpm verify:stack

# 8. Optional integration tests
pnpm test:x402:settlement
pnpm test:chain-indexer
pnpm test:darkpool-onchain
```

Build and deploy the on-chain programs:

```bash
anchor build
anchor deploy --provider.cluster devnet
```

## Privacy by design

Ghost Compute treats data confidentiality as a hard constraint, not a feature:

- **No plaintext payloads** are persisted — the system stores ciphertext, commitments, and proofs only.
- **Hardware attestation** gates sensitive workloads to verified enclaves.
- **Confidential transfers** keep settlement amounts encrypted on-chain.

---

<div align="center">

<img src="public/__l5e/assets-v1/86682dfb-d8c8-48ad-a17a-1b938b6ff02b/ghost-logo.png" alt="Ghost Compute" width="48" />

**Ghost Compute** — verifiable, private compute.

</div>
