/**
 * Launch GHST on pump.fun devnet using @pump-fun/pump-sdk.
 *
 * Creates a Token-2022 coin on the pump bonding curve (createV2) with an
 * optional initial buy. Writes GHST_MINT to .env on success.
 *
 * Usage:
 *   pnpm launch:ghst
 *   PUMP_INITIAL_BUY_SOL=0.05 pnpm launch:ghst
 */
import { createRequire } from 'node:module';
import {
  Connection,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import BN from 'bn.js';
import { loadDevWallet } from '@ghost-compute/solana';
import {
  getRpcUrl,
  patchEnvFile,
  syncDevWalletFile,
} from './solana-lib.js';

const require = createRequire(import.meta.url);
const {
  OnlinePumpSdk,
  PumpSdk,
  getBuyTokenAmountFromSolAmount,
} = require('@pump-fun/pump-sdk');

const TOKEN_NAME = process.env.GHST_TOKEN_NAME ?? 'Ghost Compute';
const TOKEN_SYMBOL = process.env.GHST_TOKEN_SYMBOL ?? 'GHST';
const TOKEN_URI =
  process.env.GHST_TOKEN_URI ??
  'https://ghostcompute.com/ghst-metadata.json';
const INITIAL_BUY_SOL = Number(process.env.PUMP_INITIAL_BUY_SOL ?? '0.01');

async function main() {
  syncDevWalletFile();
  const wallet = loadDevWallet();
  const connection = new Connection(getRpcUrl(), 'confirmed');
  const onlineSdk = new OnlinePumpSdk(connection);
  const offlineSdk = new PumpSdk();

  const balance = await connection.getBalance(wallet.publicKey);
  console.log(`Wallet: ${wallet.publicKey.toBase58()}`);
  console.log(`Balance: ${(balance / 1e9).toFixed(4)} SOL`);

  if (balance < 0.05 * 1e9) {
    throw new Error('Wallet needs at least ~0.05 SOL on devnet for create + fees');
  }

  const mint = Keypair.generate();
  console.log(`\nLaunching ${TOKEN_NAME} (${TOKEN_SYMBOL}) on pump.fun devnet…`);
  console.log(`Mint (pre-launch): ${mint.publicKey.toBase58()}`);

  const global = await onlineSdk.fetchGlobal();
  const solAmount = new BN(Math.floor(INITIAL_BUY_SOL * 1e9));

  let instructions;
  if (INITIAL_BUY_SOL > 0) {
    const amount = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig: null,
      mintSupply: null,
      bondingCurve: null,
      amount: solAmount,
    });
    instructions = await offlineSdk.createV2AndBuyInstructions({
      global,
      mint: mint.publicKey,
      name: TOKEN_NAME,
      symbol: TOKEN_SYMBOL,
      uri: TOKEN_URI,
      creator: wallet.publicKey,
      user: wallet.publicKey,
      amount,
      solAmount,
      mayhemMode: false,
      cashback: false,
    });
    console.log(`Including initial buy: ${INITIAL_BUY_SOL} SOL`);
  } else {
    const createIx = await offlineSdk.createV2Instruction({
      mint: mint.publicKey,
      name: TOKEN_NAME,
      symbol: TOKEN_SYMBOL,
      uri: TOKEN_URI,
      creator: wallet.publicKey,
      user: wallet.publicKey,
      mayhemMode: false,
      cashback: false,
    });
    instructions = [createIx];
  }

  const tx = new Transaction().add(...instructions);
  const sig = await sendAndConfirmTransaction(connection, tx, [wallet, mint], {
    commitment: 'confirmed',
  });

  const mintAddress = mint.publicKey.toBase58();
  console.log('\n✓ GHST launched on pump.fun devnet');
  console.log(`  Signature: ${sig}`);
  console.log(`  Mint:      ${mintAddress}`);
  console.log(`  Explorer:  https://solscan.io/token/${mintAddress}?cluster=devnet`);
  console.log(`  Pump:      https://devnet.pump.fun/coin/${mintAddress}`);

  patchEnvFile({ GHST_MINT: mintAddress });
  console.log('\n✓ Updated .env → GHST_MINT');
}

main().catch((err) => {
  console.error('\nLaunch failed:', err);
  process.exit(1);
});
