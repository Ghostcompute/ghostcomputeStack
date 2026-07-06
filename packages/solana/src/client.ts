import { Connection, PublicKey, Transaction, VersionedTransaction, Commitment } from '@solana/web3.js';

export function createConnection(rpcUrl: string, commitment: Commitment = 'confirmed'): Connection {
  return new Connection(rpcUrl, { commitment, wsEndpoint: rpcUrl.replace('https', 'wss') });
}

export async function getRecentBlockhash(connection: Connection): Promise<string> {
  const { blockhash } = await connection.getLatestBlockhash('finalized');
  return blockhash;
}

export async function sendAndConfirm(
  connection: Connection,
  tx: Transaction | VersionedTransaction,
  signers: Parameters<Transaction['sign']>[0][],
  opts?: { skipPreflight?: boolean },
): Promise<string> {
  if (tx instanceof Transaction) {
    tx.sign(...(signers as any[]));
  }
  const raw = tx.serialize();
  const sig = await connection.sendRawTransaction(raw, {
    skipPreflight: opts?.skipPreflight ?? false,
  });
  await connection.confirmTransaction(sig, 'confirmed');
  return sig;
}

export async function getTokenBalance(
  connection: Connection,
  tokenAccount: PublicKey,
): Promise<bigint> {
  const info = await connection.getTokenAccountBalance(tokenAccount);
  return BigInt(info.value.amount);
}
