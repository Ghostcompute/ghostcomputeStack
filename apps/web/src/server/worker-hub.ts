/**
 * WorkerHub — central job dispatcher for Ghost Compute.
 * Adapted from Gridlock's ws/hub.ts pattern, upgraded for Socket.io + TEE/Guarantee routing.
 *
 * Manages:
 *  - Socket.io session state per worker
 *  - Job queue with TEE-preference routing
 *  - Pending-job promises with timeout + requeue on disconnect
 *  - REST poll path for native/desktop workers
 *  - Stats broadcast to all connected workers
 */

import { randomUUID } from 'node:crypto';
import type { Server as IOServer, Socket } from 'socket.io';
import { Guarantee, WorkerStatus, TeeType } from '@ghost-compute/shared';

export type WorkerConnectionType = 'browser' | 'native' | 'desktop';

export interface HubWorkerSession {
  socketId: string;
  pubkey: string;
  type: WorkerConnectionType;
  model: string;
  tokPerSec: number;
  teeType: TeeType;
  attestationVerified: boolean;
  status: 'idle' | 'busy';
  connectedAt: number;
}

export interface DispatchPayload {
  jobId: string;
  model: string;
  messages: unknown[];
  tools?: unknown[];
  think?: boolean;
  guarantee: Guarantee;
  maxTokens?: number;
  customerId?: string;
  confidential?: boolean;
  /** When set, dispatch to this socket instead of re-picking. */
  preferredSocketId?: string;
}

export type RegisterHandler = (
  socket: Socket,
  dto: Record<string, unknown>,
) => Promise<{ workerId: string } | { error: string }>;

export type JobEventSink = (event: string, payload: unknown) => void;

export type DisconnectHandler = (socketId: string) => void;

export interface JobResult {
  content: string;
  tokensGenerated: number;
  ttftMs: number;
  tpotMs: number;
  toploc?: string | null;
  attestationHash?: string | null;
}

interface PendingJob {
  payload: DispatchPayload;
  resolve: (r: JobResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  assignedSocketId?: string;
}

interface QueuedJob {
  payload: DispatchPayload;
  assignedSocketId?: string;
}

const JOB_TIMEOUT_MS = 180_000;

class WorkerHub {
  private io: IOServer | null = null;
  private sessions = new Map<string, HubWorkerSession>(); // socketId → session
  private pending = new Map<string, PendingJob>();         // jobId → pending
  private queue: QueuedJob[] = [];
  private registerHandler: RegisterHandler | null = null;
  private disconnectHandler: DisconnectHandler | null = null;
  private jobEventSink: JobEventSink | null = null;

  setRegisterHandler(handler: RegisterHandler) {
    this.registerHandler = handler;
  }

  setDisconnectHandler(handler: DisconnectHandler) {
    this.disconnectHandler = handler;
  }

  setJobEventSink(sink: JobEventSink) {
    this.jobEventSink = sink;
  }

  init(io: IOServer) {
    this.io = io;
    io.on('connection', (socket: Socket) => {
      socket.on('disconnect', () => this.onDisconnect(socket));
      socket.on('worker:register', (dto: any, cb: Function) => {
        void this.onRegister(socket, dto, cb);
      });
      socket.on('worker:unregister', () => this.onDisconnect(socket));
      socket.on('job:complete', (data: any) => this.onJobComplete(socket, data));
      socket.on('job:error', (data: any) => this.onJobError(socket, data));
      socket.on('job:token', (data: any) => {
        const jobId = String(data.jobId ?? data.job_id ?? '');
        if (!jobId) return;
        this.jobEventSink?.(`job:token:${jobId}`, { token: String(data.token ?? '') });
      });
      socket.on('job:tool_call', (data: any) => {
        io.to(`job:${data.jobId}`).emit('job:tool_call', data);
      });
      socket.on('ping', () => socket.emit('pong', { ts: Date.now() }));
    });
  }

  private sessionFromDto(socket: Socket, dto: any): HubWorkerSession {
    const caps = dto.capabilities ?? {};
    return {
      socketId: socket.id,
      pubkey: String(dto.pubkey ?? ''),
      type: (dto.worker_type as WorkerConnectionType) ?? 'native',
      model: String(dto.model ?? 'unknown'),
      tokPerSec: Number(dto.tok_per_sec ?? caps.tok_per_sec ?? 0),
      teeType: (caps.tee_type as TeeType) ?? TeeType.None,
      attestationVerified: !!dto.attestation,
      status: 'idle',
      connectedAt: Date.now(),
    };
  }

  private async onRegister(socket: Socket, dto: any, cb: Function) {
    if (!this.registerHandler) {
      cb?.({ error: 'Orchestrator not ready' });
      return;
    }

    const result = await this.registerHandler(socket, dto);
    if ('error' in result) {
      cb?.({ error: result.error });
      return;
    }

    const session = this.sessionFromDto(socket, dto);
    this.sessions.set(socket.id, session);
    cb?.({ workerId: result.workerId });
    this.broadcastStats();
    this.tryDispatchIdle(socket.id);
  }

  private onDisconnect(socket: Socket) {
    const session = this.sessions.get(socket.id);
    if (!session) return;
    this.sessions.delete(socket.id);
    this.disconnectHandler?.(socket.id);
    this.requeueWorkerJobs(socket.id);
    this.broadcastStats();
  }

  private onJobComplete(socket: Socket, data: any) {
    const jobId = String(data.jobId ?? data.job_id ?? '');
    const pending = this.pending.get(jobId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(jobId);

    const session = this.sessions.get(socket.id);
    if (session) session.status = 'idle';

    pending.resolve({
      content: String(data.content ?? data.response ?? ''),
      tokensGenerated: Number(data.tokens_generated ?? data.tokensGenerated ?? 0),
      ttftMs: Number(data.ttft_ms ?? data.ttftMs ?? 0),
      tpotMs: Number(data.tpot_ms ?? data.tpotMs ?? 0),
      toploc: data.toploc ?? null,
      attestationHash: data.attestation_hash ?? data.attestationHash ?? null,
    });
    this.tryDispatchAllIdle();
    this.broadcastStats();
  }

  private onJobError(socket: Socket, data: any) {
    const jobId = String(data.jobId ?? data.job_id ?? '');
    const pending = this.pending.get(jobId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(jobId);

    const session = this.sessions.get(socket.id);
    if (session) session.status = 'idle';

    pending.reject(new Error(String(data.error ?? 'Job failed')));
    this.tryDispatchAllIdle();
    this.broadcastStats();
  }

  /** Dispatch a job — routes to best idle worker or queues. */
  dispatch(payload: DispatchPayload): Promise<JobResult> {
    let sid = payload.preferredSocketId;
    if (sid) {
      const session = this.sessions.get(sid);
      if (!session || session.status !== 'idle') sid = undefined;
    }
    sid ??= this.pickIdleWorkerSocket(payload.guarantee, payload.confidential) ?? undefined;
    if (sid) return this.assignToWorker(sid, payload);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(payload.jobId);
        const idx = this.queue.findIndex(q => q.payload.jobId === payload.jobId);
        if (idx >= 0) this.queue.splice(idx, 1);
        reject(new Error('Job timed out waiting for worker'));
      }, JOB_TIMEOUT_MS);

      this.pending.set(payload.jobId, { payload, resolve, reject, timer });
      this.queue.push({ payload });
      this.broadcastStats();
    });
  }

  private assignToWorker(socketId: string, payload: DispatchPayload): Promise<JobResult> {
    return new Promise((resolve, reject) => {
      const session = this.sessions.get(socketId)!;
      const timer = setTimeout(() => {
        this.pending.delete(payload.jobId);
        session.status = 'idle';
        reject(new Error('Job timed out'));
        this.tryDispatchAllIdle();
      }, JOB_TIMEOUT_MS);

      this.pending.set(payload.jobId, {
        payload, resolve, reject, timer, assignedSocketId: socketId,
      });

      session.status = 'busy';
      this.pushJobToSocket(socketId, payload);
      this.broadcastStats();
    });
  }

  private pushJobToSocket(socketId: string, payload: DispatchPayload) {
    this.io?.to(socketId).emit('job:new', {
      jobId: payload.jobId,
      model: payload.model,
      messages: payload.messages,
      tools: payload.tools,
      think: payload.think ?? false,
      guarantee: payload.guarantee,
      maxTokens: payload.maxTokens,
      confidential: payload.confidential ?? false,
    });
  }

  /** REST poll — for native/desktop workers that poll instead of keeping a socket open. */
  registerRestSession(params: {
    socketId: string;
    pubkey: string;
    model: string;
    tokPerSec: number;
    teeType: TeeType;
    attestationVerified: boolean;
  }) {
    this.sessions.set(params.socketId, {
      socketId: params.socketId,
      pubkey: params.pubkey,
      type: 'desktop',
      model: params.model,
      tokPerSec: params.tokPerSec,
      teeType: params.teeType,
      attestationVerified: params.attestationVerified,
      status: 'idle',
      connectedAt: Date.now(),
    });
  }

  pollNext(socketId: string): DispatchPayload | null {
    const session = this.sessions.get(socketId);
    if (!session) return null;

    for (const pending of this.pending.values()) {
      if (pending.assignedSocketId === socketId) {
        return pending.payload;
      }
    }

    if (session.status !== 'idle') return null;

    // Try direct assignment first
    const directIdx = this.queue.findIndex(q => q.assignedSocketId === socketId);
    if (directIdx >= 0) {
      const item = this.queue.splice(directIdx, 1)[0]!;
      return item.payload;
    }

    const idx = this.queue.findIndex(q => {
      if (q.assignedSocketId) return false;
      if (q.payload.confidential && !session.attestationVerified) return false;
      if (q.payload.guarantee === Guarantee.High && !session.attestationVerified) return false;
      return true;
    });
    if (idx < 0) return null;

    const item = this.queue.splice(idx, 1)[0]!;
    item.assignedSocketId = socketId;
    session.status = 'busy';
    this.pushJobToSocket(socketId, item.payload);
    return item.payload;
  }

  /** REST token stream — forwards to inference SSE clients */
  tokenFromRest(jobId: string, socketId: string, token: string): boolean {
    const pending = this.pending.get(jobId);
    if (!pending) return false;
    if (pending.assignedSocketId && pending.assignedSocketId !== socketId) return false;
    if (!token) return false;
    this.jobEventSink?.(`job:token:${jobId}`, { token });
    return true;
  }

  /** REST complete — same as socket job:complete */
  completeFromRest(
    jobId: string,
    socketId: string,
    body: { ttft_ms: number; tpot_ms: number; output_tokens: number; response?: string; attestation_hash?: string | null; toploc?: string | null },
  ): boolean {
    const pending = this.pending.get(jobId);
    if (!pending) return false;
    if (pending.assignedSocketId && pending.assignedSocketId !== socketId) return false;

    const fakeSocket = { id: socketId } as Socket;
    this.onJobComplete(fakeSocket, {
      jobId,
      content: body.response ?? '',
      tokens_generated: body.output_tokens,
      ttft_ms: body.ttft_ms,
      tpot_ms: body.tpot_ms,
      attestation_hash: body.attestation_hash ?? null,
      toploc: body.toploc ?? null,
    });
    return true;
  }

  assignedSocketForJob(jobId: string): string | null {
    return this.pending.get(jobId)?.assignedSocketId ?? null;
  }

  pickIdleWorkerSocket(guarantee: Guarantee, confidential = false): string | null {
    const candidates = [...this.sessions.entries()].filter(([, s]) => {
      if (s.status !== 'idle') return false;
      if (confidential && !s.attestationVerified) return false;
      if (guarantee === Guarantee.High && !s.attestationVerified) return false;
      if (guarantee === Guarantee.MaxTrustSplit && !s.attestationVerified) return false;
      return true;
    });
    if (!candidates.length) return null;
    // Prefer highest tok/s
    candidates.sort(([, a], [, b]) => b.tokPerSec - a.tokPerSec);
    return candidates[0]![0];
  }

  isConnected(socketId: string): boolean {
    return this.sessions.has(socketId);
  }

  getStats() {
    const sessions = [...this.sessions.values()];
    return {
      ws_workers_online: sessions.length,
      ws_workers_busy: sessions.filter(s => s.status === 'busy').length,
      ws_tee_verified: sessions.filter(s => s.attestationVerified).length,
      jobs_in_queue: this.queue.length,
      jobs_in_flight: this.pending.size,
    };
  }

  private tryDispatchIdle(socketId: string) {
    const session = this.sessions.get(socketId);
    if (!session || session.status !== 'idle') return;

    const idx = this.queue.findIndex(q => {
      if (q.assignedSocketId && q.assignedSocketId !== socketId) return false;
      if (q.payload.confidential && !session.attestationVerified) return false;
      if (q.payload.guarantee === Guarantee.High && !session.attestationVerified) return false;
      return true;
    });
    if (idx < 0) return;

    const item = this.queue.splice(idx, 1)[0]!;
    const pending = this.pending.get(item.payload.jobId);
    if (!pending) return;

    pending.assignedSocketId = socketId;
    session.status = 'busy';
    this.pushJobToSocket(socketId, item.payload);
  }

  private tryDispatchAllIdle() {
    for (const socketId of this.sessions.keys()) {
      this.tryDispatchIdle(socketId);
    }
  }

  private requeueWorkerJobs(socketId: string) {
    for (const [jobId, pending] of this.pending) {
      if (pending.assignedSocketId === socketId) {
        clearTimeout(pending.timer);
        this.pending.delete(jobId);
        pending.reject(new Error('Worker disconnected'));
        this.queue.push({ payload: pending.payload });
      }
    }
  }

  private broadcastStats() {
    if (!this.io) return;
    const stats = this.getStats();
    this.io.emit('stats:update', stats);
  }
}

export const workerHub = new WorkerHub();

export function makeDispatchPayload(
  partial: Omit<DispatchPayload, 'jobId'> & { jobId?: string },
): DispatchPayload {
  return { ...partial, jobId: partial.jobId ?? randomUUID() };
}
