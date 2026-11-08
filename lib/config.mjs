import 'dotenv/config';
import { LAMPORTS_PER_SOL } from './constants.mjs';

const argv = new Set(process.argv.slice(2));

/** Strip inline comments ("0.02   # comment") and whitespace. */
function raw(name) {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const cleaned = v.replace(/\s+#.*$/, '').trim();
  return cleaned === '' ? undefined : cleaned;
}

function num(name, def) {
  const v = raw(name);
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid number for ${name}: "${v}"`);
  return n;
}

function optNum(name) {
  const v = raw(name);
  return v === undefined ? undefined : num(name);
}

/** Convert a decimal SOL string/number to lamports without float drift. */
export function solToLamports(sol) {
  const s = String(sol);
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid SOL amount: ${s}`);
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole) * LAMPORTS_PER_SOL + BigInt((frac + '000000000').slice(0, 9));
}

/** Convert a fraction (e.g. 0.03) to basis points as BigInt. */
export function fractionToBps(f) {
  return BigInt(Math.round(Number(f) * 10_000));
}

function solEnv(name, def) {
  return solToLamports(raw(name) ?? def);
}

const heliusKey = raw('HELIUS_API_KEY');
const rpcUrl = raw('RPC_URL') ?? (heliusKey ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}` : 'https://api.mainnet-beta.solana.com');
const rpcWss = raw('RPC_WSS') ?? rpcUrl.replace(/^http/, 'ws');

export const config = Object.freeze({
  // flags
  dryRun: argv.has('--dry-run') || argv.has('--dry'),
  simulate: argv.has('--simulate'),
  verbose: argv.has('--verbose') || argv.has('-v'),

  // connectivity
  rpcUrl,
  rpcWss,
  heliusKey,
  walletKey: raw('WALLET_PRIVATE_KEY'),
  jitoUrl: (raw('JITO_BLOCK_ENGINE_URL') ?? 'https://mainnet.block-engine.jito.wtf').replace(/\/+$/, ''),
  lookupTable: raw('ARB_LOOKUP_TABLE'),

  // arbitrage parameters
  minSpreadBps: fractionToBps(num('ARB_MIN_SPREAD', 0.02)),
  maxSolLamports: solEnv('ARB_MAX_SOL', '0.5'),
  jitoTipLamports: solEnv('ARB_JITO_TIP', '0.001'),
  minLiquidityLamports: solEnv('ARB_MIN_LIQUIDITY', '1.0'),
  maxSlippageBps: fractionToBps(num('ARB_MAX_SLIPPAGE', 0.03)),
  cooldownMs: num('ARB_COOLDOWN_SEC', 3) * 1000,
  scanIntervalMs: num('ARB_SCAN_INTERVAL_MS', 2000),

  // advanced
  minProfitLamports: solEnv('ARB_MIN_PROFIT', '0.0005'),
  priorityMicroLamports: BigInt(num('ARB_PRIORITY_MICROLAMPORTS', 0)),
  computeUnits: num('ARB_COMPUTE_UNITS', 400_000),
  curveFeeBpsOverride: optNum('ARB_CURVE_FEE_BPS'),
  ammFeeBpsOverride: optNum('ARB_AMM_FEE_BPS'),
  maxPairs: num('ARB_MAX_PAIRS', 500),
  discoveryRps: num('ARB_DISCOVERY_RPS', 2),
});

export function maskUrl(url) {
  return url.replace(/(api-key=)[^&]+/i, '$1***');
}
