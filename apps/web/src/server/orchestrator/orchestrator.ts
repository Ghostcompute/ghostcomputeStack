/**
 * Ghost Compute Orchestrator
 * Upgraded with Gridlock's WorkerHub patterns:
 *  - Job queue with TEE-preference routing + requeue on disconnect
 *  - REST poll path for desktop/native workers
 *  - Worker stats recomputed after every settled job
 *  - Supabase persistence + worker KPI updates
 */

import { Server as IOServer } from 'socket.io';
import { EventEmitter } from 'node:events';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import {
  MAX_WORKERS_PER_IP, MAX_WORKERS_PER_PUBKEY,
  JOB_TIMEOUT_MS, WORKER_IDLE_TIMEOUT_MS, WORKER_AUTOGATE_MS,
  SUPABASE_URL, SUPABASE_SERVICE_ROLE,
} from './config.js';
import { Guarantee, WorkerStatus, TeeType } from '@ghost-compute/shared';
import type { WorkerRegisterDTO, JobRouteDTO, JobCompleteDTO } from '@ghost-compute/shared';
import { earningsRaw } from '@ghost-compute/shared';
import { workerHub } from '../worker-hub.js';
import { onWorkerJobSettled } from '../worker-stats.js';
import { enforceConfidentialRouting, EnvelopeHaltError } from '../attestation/fail-closed.js';
import { processAttestation } from '../attestation/service.js';
import type { AttestationQuote } from '@ghost-compute/shared';
import { toplocFromHex, verifyToploc } from '@ghost-compute/crypto';
import {
  createConnection,
  isWorkerRegistryOnChainEnabled,
  registerWorkerOnChain,
  resolveWorkerRegistryAuthority,
} from '@ghost-compute/solana';

interface WorkerRecord {
  id: string;
  socketId: string;
  pubkey: string;
  model: string;
  tokPerSec: number;
  teeType: string;
  attestationVerified: boolean;
  status: WorkerStatus;
  ip: string;
  jobsCompleted: number;
  lastSeen: number;
  autogated?: boolean;
}

export class Orchestrator extends EventEmitter {
  readonly io: IOServer;
  private db: SupabaseClient;
  private workers = new Map<string, WorkerRecord>();       // workerId → record
  private socketToWorker = new Map<string, string>();     // socketId → workerId

  constructor(io: IOServer) {
    super();
    this.io = io;
    this.db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
    workerHub.setRegisterHandler((socket, dto) => this.handleSocketRegister(socket, dto));
    workerHub.setDisconnectHandler((socketId) => this.onWorkerDisconnect(socketId));
    workerHub.setJobEventSink((event, payload) => this.emit(event, payload));
    workerHub.init(io);
    this.startHeartbeatLoop();
  }

  /** Socket.io worker registration — persists to Supabase and maps socket → workerId. */
  private async handleSocketRegister(
    socket: { id: string; handshake: { address?: string; headers?: Record<string, string> } },
    dto: Record<string, unknown>,
  ): Promise<{ workerId: string } | { error: string }> {
    const ip = socket.handshake.address
      ?? socket.handshake.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
      ?? 'unknown';

    return this.registerWorker({
      ...(dto as unknown as WorkerRegisterDTO),
      attestation: dto.attestation,
      ip,
      socketId: socket.id,
    });
  }

  private onWorkerDisconnect(socketId: string) {
    const workerId = this.socketToWorker.get(socketId);
    if (!workerId) return;

    const worker = this.workers.get(workerId);
    if (worker) {
      worker.socketId = '';
      worker.status = WorkerStatus.Offline;
      this.persistWorkerStatus(workerId, WorkerStatus.Offline, worker.jobsCompleted);
    }
    this.socketToWorker.delete(socketId);
  }

  private persistWorkerStatus(workerId: string, status: WorkerStatus, jobsCompleted?: number) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return;
    const update: Record<string, unknown> = { status };
    if (jobsCompleted !== undefined) update.jobs_completed = jobsCompleted;
    void this.db.from('workers').update(update).eq('id', workerId);
  }

  /** Called by HTTP routes when a worker registers via REST (desktop/native). */
  async registerWorker(
    dto: WorkerRegisterDTO & { attestation?: any; ip?: string; socketId?: string },
  ): Promise<{ workerId: string } | { error: string }> {
    const ip = dto.ip ?? 'unknown';

    const ipCount = [...this.workers.values()].filter(w => w.ip === ip).length;
    if (ipCount >= MAX_WORKERS_PER_IP) {
      return { error: `Too many workers from this IP (max ${MAX_WORKERS_PER_IP})` };
    }
    const pkCount = [...this.workers.values()].filter(w => w.pubkey === dto.pubkey).length;
    if (pkCount >= MAX_WORKERS_PER_PUBKEY) {
      return { error: `Too many workers for this pubkey (max ${MAX_WORKERS_PER_PUBKEY})` };
    }

    const workerId = crypto.randomUUID();
    let attestationVerified = false;

    if (dto.attestation && dto.enclave_pubkey) {
      const att = dto.attestation as Partial<AttestationQuote>;
      const teeType = att.tee_type ?? dto.capabilities?.tee_type;
      if (teeType === 'nvidia_cc' || teeType === 'amd_sev_snp') {
        const quote: AttestationQuote = {
          worker_pubkey: dto.pubkey,
          tee_type: teeType,
          nonce: String(att.nonce ?? ''),
          enclave_pubkey: dto.enclave_pubkey,
          report_bytes: String(att.report_bytes ?? ''),
          certificate_chain: att.certificate_chain ?? [],
          timestamp: typeof att.timestamp === 'number' ? att.timestamp : Date.now(),
        };
        try {
          const result = await processAttestation(quote, quote.nonce || undefined);
          attestationVerified = result.verdict === 'verified';
          if (!attestationVerified) {
            console.warn(`[orchestrator] attestation rejected for ${dto.pubkey}: ${result.reject_reason ?? result.verdict}`);
          }
        } catch (err) {
          console.error('[orchestrator] attestation pipeline failed:', (err as Error).message);
        }
      }
    }

    const record: WorkerRecord = {
      id: workerId,
      socketId: dto.socketId ?? '',
      pubkey: dto.pubkey,
      model: dto.model,
      tokPerSec: dto.tok_per_sec,
      teeType: dto.capabilities?.tee_type ?? 'none',
      attestationVerified,
      status: WorkerStatus.Idle,
      ip,
      jobsCompleted: 0,
      lastSeen: Date.now(),
    };
    this.workers.set(workerId, record);
    if (dto.socketId) this.socketToWorker.set(dto.socketId, workerId);

    // P2: publish the worker's enclave public key so clients can seal to it.
    // Only meaningful for real TEE workers (enclave_keys.tee_type is constrained
    // to the confidential vendors).
    const teeType = dto.capabilities?.tee_type ?? 'none';
    if (dto.enclave_pubkey && (teeType === 'nvidia_cc' || teeType === 'amd_sev_snp')) {
      if (SUPABASE_URL && SUPABASE_SERVICE_ROLE) {
        await this.db.from('enclave_keys')
          .update({ active: false, rotated_at: new Date().toISOString() })
          .eq('worker_pubkey', dto.pubkey).eq('active', true);
        await this.db.from('enclave_keys').upsert({
          worker_pubkey: dto.pubkey,
          enclave_pubkey: dto.enclave_pubkey,
          tee_type: teeType,
          active: true,
        }, { onConflict: 'worker_pubkey,enclave_pubkey' });
      }
    }

    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE) {
      await this.db.from('workers').upsert({
        id: workerId,
        pubkey: dto.pubkey,
        auth_token_hash: crypto.createHash('sha256').update(dto.auth_token ?? '').digest('hex'),
        model: dto.model,
        tok_per_sec: dto.tok_per_sec,
        vram_gb: dto.capabilities?.vram_gb,
        gpu_model: dto.capabilities?.gpu_model,
        tee_type: dto.capabilities?.tee_type ?? 'none',
        status: WorkerStatus.Idle,
      });
    }

    if (isWorkerRegistryOnChainEnabled()) {
      const authority = resolveWorkerRegistryAuthority(dto.pubkey);
      if (authority) {
        try {
          const rpc = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';
          await registerWorkerOnChain(
            createConnection(rpc),
            authority,
            dto.model,
            dto.tok_per_sec,
            dto.capabilities?.tee_type ?? 'none',
            dto.capabilities?.vram_gb ?? 0,
          );
        } catch (err) {
          console.error('[orchestrator] worker registry on-chain failed:', (err as Error).message);
        }
      }
    }

    return { workerId };
  }

  restSocketId(pubkey: string) {
    return `rest:${pubkey}`;
  }

  /** REST registration path for Ghost Worker desktop daemon. */
  async registerDesktopWorker(
    dto: WorkerRegisterDTO & { ip?: string },
  ): Promise<{ workerId: string } | { error: string }> {
    const socketId = this.restSocketId(dto.pubkey);
    const teeType = (dto.capabilities?.tee_type ?? 'none') as string;
    const attestationVerified = teeType === 'nvidia_cc' || teeType === 'amd_sev_snp';

    const existing = [...this.workers.values()].find(w => w.pubkey === dto.pubkey);
    if (existing) {
      existing.lastSeen = Date.now();
      existing.model = dto.model;
      existing.tokPerSec = dto.tok_per_sec;
      existing.status = WorkerStatus.Idle;
      existing.socketId = socketId;
      this.socketToWorker.set(socketId, existing.id);
      workerHub.registerRestSession({
        socketId,
        pubkey: dto.pubkey,
        model: dto.model,
        tokPerSec: dto.tok_per_sec,
        teeType: teeType as TeeType,
        attestationVerified,
      });
      return { workerId: existing.id };
    }

    const result = await this.registerWorker({ ...dto, socketId, ip: dto.ip });
    if ('error' in result) return result;

    workerHub.registerRestSession({
      socketId,
      pubkey: dto.pubkey,
      model: dto.model,
      tokPerSec: dto.tok_per_sec,
      teeType: teeType as TeeType,
      attestationVerified,
    });
    return result;
  }

  pollJobForPubkey(pubkey: string) {
    return workerHub.pollNext(this.restSocketId(pubkey));
  }

  completeJobForPubkey(
    pubkey: string,
    body: {
      jobId: string;
      content?: string;
      tokens_generated?: number;
      ttft_ms?: number;
      tpot_ms?: number;
      attestation_hash?: string | null;
      toploc?: string | null;
    },
  ) {
    const socketId = pubkey
      ? this.restSocketId(pubkey)
      : workerHub.assignedSocketForJob(body.jobId);
    if (!socketId) return false;
    return workerHub.completeFromRest(body.jobId, socketId, {
      ttft_ms: Number(body.ttft_ms ?? 0),
      tpot_ms: Number(body.tpot_ms ?? 0),
      output_tokens: Number(body.tokens_generated ?? 0),
      response: body.content ?? '',
      attestation_hash: body.attestation_hash ?? null,
      toploc: body.toploc ?? null,
    });
  }

  emitJobTokenForPubkey(pubkey: string, jobId: string, token: string) {
    const socketId = pubkey
      ? this.restSocketId(pubkey)
      : workerHub.assignedSocketForJob(jobId);
    if (!socketId) return false;
    return workerHub.tokenFromRest(jobId, socketId, token);
  }

  /** Route a job to the best available worker. Returns workerId if routed. */
  async routeJob(dto: JobRouteDTO): Promise<{ routed: boolean; workerId?: string; socketId?: string }> {
    const guarantee = dto.guarantee ?? Guarantee.Standard;
    const confidential = guarantee === Guarantee.High || guarantee === Guarantee.MaxTrustSplit;

    // Pick via WorkerHub (which has the real-time socket state)
    const socketId = workerHub.pickIdleWorkerSocket(guarantee, confidential);
    if (!socketId) return { routed: false };

    const workerId = this.socketToWorker.get(socketId);

    // P8 fail-closed: confidential tiers require an attested, fresh, confidential_ok
    // worker. Halt routing (never dispatch plaintext to an ineligible worker).
    if (confidential) {
      const pubkey = workerId ? this.workers.get(workerId)?.pubkey : undefined;
      try {
        if (!pubkey) throw new EnvelopeHaltError('no pubkey for selected worker');
        await enforceConfidentialRouting(pubkey, guarantee);
      } catch (err) {
        if (err instanceof EnvelopeHaltError) {
          if (SUPABASE_URL && SUPABASE_SERVICE_ROLE) {
            await this.db.from('jobs').update({ status: 'failed', error: err.message }).eq('id', dto.job_id);
          }
          return { routed: false };
        }
        throw err;
      }
    }

    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE) {
      await this.db.from('jobs').insert({
        id: dto.job_id,
        status: 'running',
        guarantee: dto.guarantee,
        worker_id: workerId ?? null,
        model: dto.model,
        started_at: new Date().toISOString(),
      });
    }

    if (workerId) {
      const w = this.workers.get(workerId);
      if (w) w.status = WorkerStatus.Busy;
    }

    // Dispatch via WorkerHub (handles timeout + requeue on disconnect)
    workerHub.dispatch({
      jobId: dto.job_id,
      model: dto.model,
      messages: dto.messages,
      tools: dto.tools,
      think: dto.think,
      guarantee,
      maxTokens: dto.max_tokens ?? 16384,
      confidential,
      preferredSocketId: socketId,
    }).then(result => {
      this.onJobCompleted(dto.job_id, workerId ?? '', result);
    }).catch(err => {
      if (SUPABASE_URL && SUPABASE_SERVICE_ROLE) {
        this.db.from('jobs').update({ status: 'failed', error: String(err) }).eq('id', dto.job_id);
      }
    });

    return { routed: true, workerId, socketId };
  }

  private async onJobCompleted(
    jobId: string,
    workerId: string,
    result: { content: string; tokensGenerated: number; ttftMs: number; tpotMs: number; toploc?: string | null; attestationHash?: string | null },
  ) {
    const worker = workerId ? this.workers.get(workerId) : undefined;
    if (worker) {
      worker.status = WorkerStatus.Idle;
      worker.jobsCompleted++;
      worker.lastSeen = Date.now();
    }

    // Internal event for HTTP inference clients (NOT socket.io broadcast)
    this.emit(`job:counted:${jobId}`, {
      jobId,
      tokensGenerated: result.tokensGenerated,
      content: result.content,
      toploc: result.toploc,
    });

    if (worker?.socketId) {
      this.io.to(worker.socketId).emit('job:counted', {
        jobId,
        tokensGenerated: result.tokensGenerated,
      });
    }

    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE) {
      try {
        await this.db.from('jobs').update({
        status: 'completed',
        tokens_generated: result.tokensGenerated,
        toploc_commit: result.toploc,
        attestation_hash: result.attestationHash,
        completed_at: new Date().toISOString(),
      }).eq('id', jobId);

      // P4: record the verifiable TOPLOC receipt in the proofs table (explorer).
      if (result.toploc) {
        try {
          const proof = toplocFromHex(result.toploc);
          const verified = await verifyToploc(proof);
          await this.db.from('proofs').upsert({
            job_id: jobId,
            proof_system: 'toploc',
            model_hash: proof.model_hash,
            input_hash: proof.input_hash,
            output_hash: proof.output_hash,
            commitment: result.toploc,
            verified,
            verified_at: verified ? new Date().toISOString() : null,
          }, { onConflict: 'job_id,proof_system' });
        } catch (err) {
          console.error('[orchestrator] proof record failed:', (err as Error).message);
        }
      }

      const earned = earningsRaw(result.tokensGenerated);
      if (workerId) {
        await this.db.from('worker_earnings').insert({
          worker_id: workerId,
          job_id: jobId,
          ghst_amount_raw: earned.toString(),
        });
      }

      if (workerId) await onWorkerJobSettled(workerId);

      await this.persistWorkerStatus(
        workerId,
        WorkerStatus.Idle,
        worker?.jobsCompleted ?? 0,
      );
      } catch (err) {
        console.error('[orchestrator] job persist failed:', (err as Error).message);
      }
    }
  }

  heartbeat(pubkey: string, patch?: { status?: WorkerStatus; jobsCompleted?: number; tokPerSec?: number }) {
    const w = [...this.workers.values()].find(r => r.pubkey === pubkey);
    if (!w) return false;
    w.lastSeen = Date.now();
    w.autogated = false;
    if (patch?.status !== undefined) w.status = patch.status;
    if (patch?.jobsCompleted !== undefined) w.jobsCompleted = patch.jobsCompleted;
    if (patch?.tokPerSec !== undefined) w.tokPerSec = patch.tokPerSec;
    if (w.status === WorkerStatus.Offline && patch?.status === undefined) {
      w.status = WorkerStatus.Idle;
      this.persistWorkerStatus(w.id, WorkerStatus.Idle, w.jobsCompleted);
    }
    return true;
  }

  listWorkers() {
    return [...this.workers.values()].map(w => ({
      id: w.id,
      pubkey: w.pubkey,
      model: w.model,
      tok_per_sec: w.tokPerSec,
      tee_type: w.teeType,
      attestation_verified: w.attestationVerified,
      status: w.autogated && w.status === WorkerStatus.Offline ? 'autogated' : w.status,
      jobs_completed: w.jobsCompleted,
      connected: !!w.socketId && workerHub.isConnected(w.socketId),
      last_seen_ms: Date.now() - w.lastSeen,
    }));
  }

  getFleetStats() {
    const workers = [...this.workers.values()];
    const hubStats = workerHub.getStats();
    return {
      total: workers.length,
      idle: workers.filter(w => w.status === WorkerStatus.Idle).length,
      busy: workers.filter(w => w.status === WorkerStatus.Busy).length,
      tee_verified: workers.filter(w => w.attestationVerified).length,
      avg_tok_per_sec: workers.length
        ? workers.reduce((s, w) => s + w.tokPerSec, 0) / workers.length
        : 0,
      ...hubStats,
    };
  }

  private startHeartbeatLoop() {
    setInterval(() => {
      const now = Date.now();
      for (const [id, w] of this.workers) {
        const staleMs = now - w.lastSeen;

        if (staleMs > WORKER_AUTOGATE_MS && w.status !== WorkerStatus.Offline) {
          w.status = WorkerStatus.Offline;
          w.autogated = true;
          this.persistWorkerStatus(id, WorkerStatus.Offline, w.jobsCompleted);
        }

        if (staleMs > WORKER_IDLE_TIMEOUT_MS) {
          this.workers.delete(id);
          this.socketToWorker.delete(w.socketId);
          this.persistWorkerStatus(id, WorkerStatus.Offline, w.jobsCompleted);
        }
      }
    }, 30_000);
  }
}
