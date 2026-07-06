/**
 * Dev mock attestation pipeline test.
 * Usage: DEV_MOCK_ATTESTATION=true pnpm test:attestation
 */
import './load-env.js';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { loadDevWallet } from '@ghost-compute/solana';

const ORCHESTRATOR = process.env.ORCHESTRATOR_URL ?? 'http://localhost:3001';
const WORKER = loadDevWallet().publicKey.toBase58();

async function main() {
  if (process.env.DEV_MOCK_ATTESTATION !== 'true') {
    throw new Error('Set DEV_MOCK_ATTESTATION=true for this test');
  }

  const enclavePubkey = crypto.randomBytes(32).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');
  const reportBytes = Buffer.from(`mock-nvidia_cc-${nonce}`).toString('base64');

  const quote = {
    worker_pubkey: WORKER,
    tee_type: 'nvidia_cc',
    nonce,
    enclave_pubkey: enclavePubkey,
    report_bytes: reportBytes,
    certificate_chain: [] as string[],
    timestamp: Date.now(),
  };

  console.log(`Orchestrator: ${ORCHESTRATOR}`);
  console.log(`Worker:       ${WORKER}\n`);

  const res = await fetch(`${ORCHESTRATOR}/api/attestation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quote, expectedNonce: nonce }),
  });
  const result = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(result));

  console.log(`Verdict:      ${result.verdict}`);
  console.log(`Report hash:  ${result.report_hash}`);

  if (result.verdict !== 'verified') {
    throw new Error(`Expected verified, got ${result.verdict}: ${result.reject_reason ?? ''}`);
  }

  const db = createClient(
    process.env.SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE ?? '',
  );
  const { data: row } = await db.from('attestations')
    .select('verdict, tee_type, onchain_sig')
    .eq('report_hash', result.report_hash)
    .single();

  if (!row || row.verdict !== 'verified') {
    throw new Error('Attestation row missing or not verified in Supabase');
  }

  console.log(`DB verdict:   ${row.verdict}`);
  console.log(`On-chain sig: ${row.onchain_sig ?? '(none — relayer may be unset)'}`);
  console.log('\n✅ Mock attestation pipeline verified');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
