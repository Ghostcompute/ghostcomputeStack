/** Quick smoke test for @ghost-compute/solana IDL clients. */
import './load-env.js';
import { Connection } from '@solana/web3.js';
import { createGhostPrograms, getProgramIds, findFeeVaultPda } from '@ghost-compute/solana';

const conn = new Connection(process.env.SOLANA_RPC!, 'confirmed');
const programs = createGhostPrograms(conn);
const ids = getProgramIds();
const [feeVault] = findFeeVaultPda();

console.log('worker_registry:', programs.workerRegistry.programId.toBase58());
console.log('env match:      ', programs.workerRegistry.programId.equals(ids.WORKER_REGISTRY));
console.log('fee vault PDA:  ', feeVault.toBase58());
console.log('job_router ix:  ', programs.jobRouter.idl.instructions.map((i) => i.name).join(', '));
console.log('✓ IDL clients OK');
