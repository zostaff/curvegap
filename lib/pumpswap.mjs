import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import bs58 from 'bs58';
import {
  POOL_LAYOUT,
  PUMPSWAP_BUY_EVENT_DISC,
  PUMPSWAP_BUY_V2_DISC,
  PUMPSWAP_EVENT,
  PUMPSWAP_POOL_ACCOUNT_DISC,
  PUMPSWAP_PROGRAM,
  PUMPSWAP_SELL_EVENT_DISC,
  PUMPSWAP_SELL_V2_DISC,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  WSOL_MINT,
} from './constants.mjs';
import { calculateFeeTier, feeOn, PUMPSWAP_FEE_CONFIG } from './fees.mjs';
import { ceilDiv, poolAuthorityPda } from './pumpfun.mjs';
import { readTokenAmount } from './rpc.mjs';

const pda = (seeds, program = PUMPSWAP_PROGRAM) => PublicKey.findProgramAddressSync(seeds, program)[0];
const u64 = (v) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
};
const key = (buf, off) => new PublicKey(buf.subarray(off, off + 32));

// ── PDAs ────────────────────────────────────────────────────────────
export const globalConfigPda = () => pda([Buffer.from('global_config')]);
export const eventAuthorityPda = () => pda([Buffer.from('__event_authority')]);
export const userVolumeAccumulatorPda = (user) => pda([Buffer.from('user_volume_accumulator'), user.toBuffer()]);
export const feeConfigPda = () => PUMPSWAP_FEE_CONFIG;

/** Canonical pool that pump.fun creates on graduation (index 0, creator = pool authority). */
export function canonicalPoolPda(baseMint, quoteMint = WSOL_MINT) {
  const index = Buffer.alloc(2); // u16 LE = 0
  return pda([Buffer.from('pool'), index, poolAuthorityPda(baseMint).toBuffer(), baseMint.toBuffer(), quoteMint.toBuffer()]);
}

// ── State ───────────────────────────────────────────────────────────
export function decodePool(address, data) {
  if (!data || data.length < POOL_LAYOUT.MIN_LEN) return null;
  if (!data.subarray(0, 8).equals(PUMPSWAP_POOL_ACCOUNT_DISC)) return null;
  return {
    address,
    index: data.readUInt16LE(POOL_LAYOUT.INDEX),
    creator: key(data, POOL_LAYOUT.CREATOR),
    baseMint: key(data, POOL_LAYOUT.BASE_MINT),
    quoteMint: key(data, POOL_LAYOUT.QUOTE_MINT),
    lpMint: key(data, POOL_LAYOUT.LP_MINT),
    poolBaseTokenAccount: key(data, POOL_LAYOUT.POOL_BASE_TOKEN_ACCOUNT),
    poolQuoteTokenAccount: key(data, POOL_LAYOUT.POOL_QUOTE_TOKEN_ACCOUNT),
    lpSupply: data.readBigUInt64LE(POOL_LAYOUT.LP_SUPPLY),
    coinCreator: key(data, POOL_LAYOUT.COIN_CREATOR),
    isMayhemMode: data.length > POOL_LAYOUT.IS_MAYHEM_MODE && data[POOL_LAYOUT.IS_MAYHEM_MODE] === 1,
    isCashbackCoin: data.length > POOL_LAYOUT.IS_CASHBACK_COIN && data[POOL_LAYOUT.IS_CASHBACK_COIN] === 1,
    virtualQuoteReserves: readI128(data, POOL_LAYOUT.VIRTUAL_QUOTE_RESERVES),
  };
}

/** Signed i128 little-endian; 0 when the (older, shorter) account doesn't have the field. */
function readI128(data, off) {
  if (data.length < off + 16) return 0n;
  return BigInt.asIntN(128, data.readBigUInt64LE(off) | (data.readBigUInt64LE(off + 8) << 64n));
}

/** True for pools created by pump.fun migration (pool.creator == pool-authority PDA). */
export function isCanonicalPool(pool) {
  return poolAuthorityPda(pool.baseMint).equals(pool.creator);
}

/**
 * Effective reserves used by the program for pricing:
 *   base  = pool_base_token_account.amount
 *   quote = pool_quote_token_account.amount + Pool.virtual_quote_reserves (signed)
 */
export function effectiveReserves(pool, baseVaultAmount, quoteVaultAmount) {
  const quote = quoteVaultAmount + pool.virtualQuoteReserves;
  return { base: baseVaultAmount, quote: quote < 0n ? 0n : quote, vaultQuote: quoteVaultAmount };
}

/** Market cap in lamports (fee tier input). */
export function poolMarketCap(reserves, baseMintSupply) {
  if (!reserves.base) return 0n;
  return (reserves.quote * baseMintSupply) / reserves.base;
}

/** Fee schedule (lp / protocol / creator bps): tiers for canonical pools, flat fees otherwise. */
export function poolFees(pool, reserves, baseMintSupply, feeConfig, globalConfig) {
  if (feeConfig) {
    const fees = isCanonicalPool(pool)
      ? calculateFeeTier(feeConfig.tiers, poolMarketCap(reserves, baseMintSupply))
      : feeConfig.flatFees;
    if (fees) return fees;
  }
  return {
    lpFeeBps: globalConfig ? globalConfig.lpFeeBps : 20n,
    protocolFeeBps: globalConfig ? globalConfig.protocolFeeBps : 5n,
    creatorFeeBps: globalConfig ? globalConfig.coinCreatorFeeBps : 5n,
  };
}

/**
 * GlobalConfig layout:
 *   [8..40]    admin
 *   [40..48]   lp_fee_basis_points
 *   [48..56]   protocol_fee_basis_points
 *   [56]       disable_flags
 *   [57..313]  protocol_fee_recipients [Pubkey; 8]
 *   [313..321] coin_creator_fee_basis_points
 */
export function decodeGlobalConfig(data) {
  if (!data || data.length < 313) return null;
  const recipients = [];
  for (let i = 0; i < 8; i++) {
    const k = key(data, 57 + i * 32);
    if (!k.equals(PublicKey.default)) recipients.push(k);
  }
  return {
    lpFeeBps: data.readBigUInt64LE(40),
    protocolFeeBps: data.readBigUInt64LE(48),
    disableFlags: data[56],
    protocolFeeRecipients: recipients,
    coinCreatorFeeBps: data.length >= 321 ? data.readBigUInt64LE(313) : 0n,
  };
}

/** Fetch the pool + both vaults and return fresh effective reserves. */
export async function fetchReserves(connection, pool) {
  const [p, b, q] = await connection.getMultipleAccountsInfo(
    [pool.address, pool.poolBaseTokenAccount, pool.poolQuoteTokenAccount],
    { commitment: 'processed' },
  );
  const fresh = (p && decodePool(pool.address, p.data)) ?? pool;
  return effectiveReserves(fresh, readTokenAmount(b?.data) ?? 0n, readTokenAmount(q?.data) ?? 0n);
}

/**
 * Find the PumpSwap pool for a token/WSOL pair.
 * 1) canonical graduation pool PDA (cheap getAccountInfo)
 * 2) fallback getProgramAccounts by base_mint + quote_mint (any user-created pool)
 * Returns the pool with the deepest WSOL side, or null.
 */
export async function findPool(connection, baseMint, { allowScan = true } = {}) {
  const canonical = canonicalPoolPda(baseMint);
  const info = await connection.getAccountInfo(canonical, 'confirmed');
  if (info) {
    const pool = decodePool(canonical, info.data);
    if (pool) return pool;
  }
  if (!allowScan) return null;

  const accounts = await connection.getProgramAccounts(PUMPSWAP_PROGRAM, {
    commitment: 'confirmed',
    filters: [
      { memcmp: { offset: 0, bytes: bs58.encode(PUMPSWAP_POOL_ACCOUNT_DISC) } },
      { memcmp: { offset: POOL_LAYOUT.BASE_MINT, bytes: baseMint.toBase58() } },
      { memcmp: { offset: POOL_LAYOUT.QUOTE_MINT, bytes: WSOL_MINT.toBase58() } },
    ],
  });
  const pools = accounts.map((a) => decodePool(a.pubkey, a.account.data)).filter(Boolean);
  if (pools.length === 0) return null;
  if (pools.length === 1) return pools[0];

  // pick the pool with the most WSOL liquidity
  const vaults = await connection.getMultipleAccountsInfo(pools.map((p) => p.poolQuoteTokenAccount));
  let best = null;
  let bestQ = -1n;
  pools.forEach((p, i) => {
    const q = readTokenAmount(vaults[i]?.data) ?? 0n;
    if (q > bestQ) {
      bestQ = q;
      best = p;
    }
  });
  return best;
}

/** Price in lamports per raw token unit (float, display only). */
export function ammPrice(reserves) {
  if (!reserves?.base || !reserves?.quote) return 0;
  return Number(reserves.quote) / Number(reserves.base);
}

// ── Math (BigInt, constant product) ─────────────────────────────────
/** Quote needed (incl. fees) to receive exactly `baseOut` tokens. */
export function quoteBuyExactBase(reserves, baseOut, fees) {
  const { base, quote } = reserves;
  if (baseOut <= 0n || baseOut >= base) return null;
  const quoteRaw = ceilDiv(quote * baseOut, base - baseOut);
  const fee = feeOn(quoteRaw, fees);
  return { quoteRaw, fee, total: quoteRaw + fee };
}

/** Quote received (after fees) for selling exactly `baseIn` tokens. */
export function quoteSellExactBase(reserves, baseIn, fees) {
  const { base, quote } = reserves;
  if (baseIn <= 0n) return null;
  const quoteRaw = (quote * baseIn) / (base + baseIn);
  const fee = feeOn(quoteRaw, fees);
  if (quoteRaw <= fee) return null;
  return { quoteRaw, fee, net: quoteRaw - fee };
}

// ── Instructions (buy_v2 / sell_v2) ─────────────────────────────────
/**
 * Shared 17-account list for buy_v2 / sell_v2 (no remaining accounts).
 * `ctx` = { pool, baseTokenProgram, buybackFeeRecipient } — the buyback recipient
 * is passed as its WSOL associated token account.
 */
function v2Keys(ctx, user) {
  const { pool, baseTokenProgram = TOKEN_PROGRAM, buybackFeeRecipient } = ctx;
  const quoteTokenProgram = TOKEN_PROGRAM;
  return [
    { pubkey: pool.address, isSigner: false, isWritable: true },
    { pubkey: user, isSigner: true, isWritable: true },
    { pubkey: globalConfigPda(), isSigner: false, isWritable: false },
    { pubkey: pool.baseMint, isSigner: false, isWritable: false },
    { pubkey: pool.quoteMint, isSigner: false, isWritable: false },
    { pubkey: getAssociatedTokenAddressSync(pool.baseMint, user, false, baseTokenProgram), isSigner: false, isWritable: true },
    { pubkey: getAssociatedTokenAddressSync(pool.quoteMint, user, false, quoteTokenProgram), isSigner: false, isWritable: true },
    { pubkey: pool.poolBaseTokenAccount, isSigner: false, isWritable: true },
    { pubkey: pool.poolQuoteTokenAccount, isSigner: false, isWritable: true },
    { pubkey: baseTokenProgram, isSigner: false, isWritable: false },
    { pubkey: quoteTokenProgram, isSigner: false, isWritable: false },
    { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: userVolumeAccumulatorPda(user), isSigner: false, isWritable: true },
    { pubkey: PUMPSWAP_FEE_CONFIG, isSigner: false, isWritable: false },
    { pubkey: getAssociatedTokenAddressSync(pool.quoteMint, buybackFeeRecipient, true, quoteTokenProgram), isSigner: false, isWritable: true },
    { pubkey: eventAuthorityPda(), isSigner: false, isWritable: false },
    { pubkey: PUMPSWAP_PROGRAM, isSigner: false, isWritable: false },
  ];
}

/** buy_v2: receive exactly `baseAmountOut`, pay at most `maxQuoteAmountIn` WSOL (incl. fees). */
export function buyIx(ctx, user, baseAmountOut, maxQuoteAmountIn) {
  const data = Buffer.concat([PUMPSWAP_BUY_V2_DISC, u64(baseAmountOut), u64(maxQuoteAmountIn)]);
  return new TransactionInstruction({ programId: PUMPSWAP_PROGRAM, keys: v2Keys(ctx, user), data });
}

/** sell_v2: sell exactly `baseAmountIn`, receive at least `minQuoteAmountOut` WSOL (after fees). */
export function sellIx(ctx, user, baseAmountIn, minQuoteAmountOut) {
  const data = Buffer.concat([PUMPSWAP_SELL_V2_DISC, u64(baseAmountIn), u64(minQuoteAmountOut)]);
  return new TransactionInstruction({ programId: PUMPSWAP_PROGRAM, keys: v2Keys(ctx, user), data });
}

// ── Events ──────────────────────────────────────────────────────────
/** Decode a PumpSwap BuyEvent / SellEvent from a "Program data:" payload. */
export function parseSwapEvent(buf) {
  if (buf.length < PUMPSWAP_EVENT.MIN_LEN) return null;
  const disc = buf.subarray(0, 8);
  const isBuy = disc.equals(PUMPSWAP_BUY_EVENT_DISC);
  if (!isBuy && !disc.equals(PUMPSWAP_SELL_EVENT_DISC)) return null;
  return {
    venue: 'amm',
    isBuy,
    baseAmount: buf.readBigUInt64LE(PUMPSWAP_EVENT.BASE_AMOUNT),
    quoteAmount: buf.readBigUInt64LE(PUMPSWAP_EVENT.QUOTE_AMOUNT),
    poolBaseReserves: buf.readBigUInt64LE(PUMPSWAP_EVENT.POOL_BASE_RESERVES),
    poolQuoteReserves: buf.readBigUInt64LE(PUMPSWAP_EVENT.POOL_QUOTE_RESERVES),
    pool: key(buf, PUMPSWAP_EVENT.POOL),
    user: key(buf, PUMPSWAP_EVENT.USER),
  };
}
