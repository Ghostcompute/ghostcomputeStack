import BN from 'bn.js';
import { Program } from '@coral-xyz/anchor';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from '@solana/web3.js';
import { createGhostPrograms } from './programs.js';
import { findOrderPda, findSealedOrderPda } from './program-ids.js';
import { guaranteeToU8, uuidToJobIdBytes } from './job-router.js';
import { loadDevWallet } from './wallet.js';

export function isDarkPoolOnChainEnabled(): boolean {
  return process.env.DARK_POOL_ONCHAIN_ENABLED === 'true';
}

export async function placeOrderOnChain(
  connection: Connection,
  owner: Keypair,
  orderId: string,
  side: 'buy' | 'sell',
  baseMint: string,
  quoteMint: string,
  amount: bigint,
  price: bigint,
  guarantee: string,
): Promise<string> {
  const programs = createGhostPrograms(connection, owner);
  const darkPool = programs.darkPool as Program;
  const idBuf = uuidToJobIdBytes(orderId);
  const idBytes = [...idBuf] as number[];
  const [orderPda] = findOrderPda(idBuf);

  const sig = await darkPool.methods
    .placeOrder({
      id: idBytes,
      side: side === 'buy' ? 0 : 1,
      amount: new BN(amount.toString()),
      price: new BN(price.toString()),
      guarantee: guaranteeToU8(guarantee),
    })
    .accounts({
      order: orderPda,
      baseMint: new PublicKey(baseMint),
      quoteMint: new PublicKey(quoteMint),
      owner: owner.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(`[dark-pool] place_order ${orderId} → ${sig}`);
  return sig;
}

export async function settleMatchOnChain(
  connection: Connection,
  oracle: Keypair,
  matchId: string,
  buyOrderId: string,
  sellOrderId: string,
  fillAmount: bigint,
  fillPrice: bigint,
): Promise<string> {
  const programs = createGhostPrograms(connection, oracle);
  const darkPool = programs.darkPool as Program;
  const [buyPda] = findOrderPda(uuidToJobIdBytes(buyOrderId));
  const [sellPda] = findOrderPda(uuidToJobIdBytes(sellOrderId));
  const matchIdBytes = [...uuidToJobIdBytes(matchId)] as number[];

  const sig = await darkPool.methods
    .settleMatch(
      matchIdBytes,
      new BN(fillAmount.toString()),
      new BN(fillPrice.toString()),
    )
    .accounts({
      buyOrder: buyPda,
      sellOrder: sellPda,
      oracle: oracle.publicKey,
    })
    .rpc();

  console.log(`[dark-pool] settle_match ${matchId} → ${sig}`);
  return sig;
}

export function resolveDarkPoolOracle(): Keypair | null {
  try {
    if (process.env.DARK_POOL_ONCHAIN_ENABLED === 'true' || process.env.DEV_X402_SIGN === 'true') {
      return loadDevWallet();
    }
  } catch {
    return null;
  }
  return null;
}

export async function sealedOrderAccountExists(
  connection: Connection,
  orderId: string,
): Promise<boolean> {
  const [pda] = findSealedOrderPda(uuidToJobIdBytes(orderId));
  const info = await connection.getAccountInfo(pda);
  return info !== null && info.data.length > 0;
}

export async function submitSealedOrderOnChain(
  connection: Connection,
  owner: Keypair,
  orderId: string,
  commitHashHex: string,
  margin: bigint,
  guarantee: string,
): Promise<string | null> {
  if (await sealedOrderAccountExists(connection, orderId)) {
    console.log(`[dark-pool] sealed order already on-chain ${orderId}`);
    return null;
  }

  const programs = createGhostPrograms(connection, owner);
  const darkPool = programs.darkPool as Program;
  const idBuf = uuidToJobIdBytes(orderId);
  const idBytes = [...idBuf] as number[];
  const [sealedPda] = findSealedOrderPda(idBuf);
  const commitBytes = [...Buffer.from(commitHashHex.padStart(64, '0').slice(0, 64), 'hex')] as number[];

  const sig = await darkPool.methods
    .submitSealedOrder({
      id: idBytes,
      commitHash: commitBytes,
      margin: new BN(margin.toString()),
      guarantee: guaranteeToU8(guarantee),
    })
    .accounts({
      sealedOrder: sealedPda,
      owner: owner.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(`[dark-pool] submit_sealed_order ${orderId} → ${sig}`);
  return sig;
}

export async function settleSealedFillOnChain(
  connection: Connection,
  oracle: Keypair,
  matchId: string,
  buyOrderId: string,
  sellOrderId: string,
  fillAmount: bigint,
  fillPrice: bigint,
): Promise<string> {
  const programs = createGhostPrograms(connection, oracle);
  const darkPool = programs.darkPool as Program;
  const [buyPda] = findSealedOrderPda(uuidToJobIdBytes(buyOrderId));
  const [sellPda] = findSealedOrderPda(uuidToJobIdBytes(sellOrderId));
  const matchIdBytes = [...uuidToJobIdBytes(matchId)] as number[];

  const sig = await darkPool.methods
    .settleSealedFill(
      matchIdBytes,
      new BN(fillAmount.toString()),
      new BN(fillPrice.toString()),
    )
    .accounts({
      buyOrder: buyPda,
      sellOrder: sellPda,
      oracle: oracle.publicKey,
    })
    .rpc();

  console.log(`[dark-pool] settle_sealed_fill ${matchId} → ${sig}`);
  return sig;
}
