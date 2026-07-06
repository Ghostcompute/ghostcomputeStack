import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnchorProvider, Program, type Idl, Wallet } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { getProgramIds } from './program-ids.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadIdl(name: string): Idl {
  const raw = readFileSync(join(__dirname, 'idl', `${name}.json`), 'utf8');
  return JSON.parse(raw) as Idl;
}

const IDL_NAMES = [
  'worker_registry',
  'job_router',
  'dark_pool',
  'ghst_staking',
  'fee_collector',
  'attestation',
  'governance',
] as const;

export type GhostPrograms = {
  workerRegistry: Program;
  jobRouter: Program;
  darkPool: Program;
  ghstStaking: Program;
  feeCollector: Program;
  attestation: Program;
  governance: Program;
};

function readonlyWallet(): Wallet {
  return {
    publicKey: PublicKey.default,
    signTransaction: async () => {
      throw new Error('Read-only Solana client');
    },
    signAllTransactions: async () => {
      throw new Error('Read-only Solana client');
    },
  } as Wallet;
}

/** Create Anchor program clients for all Ghost Compute on-chain programs. */
export function createGhostPrograms(
  connection: Connection,
  wallet: Wallet | Keypair = readonlyWallet(),
): GhostPrograms {
  const signer = wallet instanceof Keypair ? new Wallet(wallet) : wallet;
  const provider = new AnchorProvider(connection, signer, { commitment: 'confirmed' });
  const ids = getProgramIds();

  const mk = (name: typeof IDL_NAMES[number], programId: PublicKey) =>
    new Program(loadIdl(name), provider);

  return {
    workerRegistry: mk('worker_registry', ids.WORKER_REGISTRY),
    jobRouter:      mk('job_router', ids.JOB_ROUTER),
    darkPool:       mk('dark_pool', ids.DARK_POOL),
    ghstStaking:    mk('ghst_staking', ids.GHST_STAKING),
    feeCollector:   mk('fee_collector', ids.FEE_COLLECTOR),
    attestation:    mk('attestation', ids.ATTESTATION),
    governance:     mk('governance', ids.GOVERNANCE),
  };
}

export { loadIdl, IDL_NAMES };
