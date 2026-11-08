import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  CURVE_LAYOUT,
  GRADUATION_VSOL,
  PUMP_BUY_V3_DISC,
  PUMP_EVENT,
  PUMP_EVENT_AUTHORITY,
  PUMP_GLOBAL,
  PUMP_PROGRAM,
  PUMP_SELL_V3_DISC,
  PUMP_TRADE_EVENT_DISC,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  WSOL_MINT,
} from './constants.mjs';
import { calculateFeeTier, feeOn, PUMP_FEE_CONFIG } from './fees.mjs';

const pda = (seeds, program = PUMP_PROGRAM) => PublicKey.findProgramAddressSync(seeds, program)[0];
const u64 = (v) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
};
export const ceilDiv = (a, b) => (a + b - 1n) / b;

// ── PDAs ────────────────────────────────────────────────────────────
export const bondingCurvePda = (mint) => pda([Buffer.from('bonding-curve'), mint.toBuffer()]);
export const userVolumeAccumulatorPda = (user) => pda([Buffer.from('user_volume_accumulator'), user.toBuffer()]);
export const feeConfigPda = () => PUMP_FEE_CONFIG;
/** Authority that owns canonical (graduated) pools on PumpSwap. */
export const poolAuthorityPda = (mint) => pda([Buffer.from('pool-authority'), mint.toBuffer()]);

export function associatedBondingCurve(mint, tokenProgram = TOKEN_PROGRAM) {
  return getAssociatedTokenAddressSync(mint, bondingCurvePda(mint), true, tokenProgram);
}

// ── State ───────────────────────────────────────────────────────────
/**
 * Bonding curve layout (see CURVE_LAYOUT):
 *   [8]  virtualTokenReserves  [16] virtualSolReserves  [24] realTokenReserves
 *   [32] realSolReserves       [40] tokenTotalSupply    [48] complete
 *   [49] creator  [81] isMayhemMode  [82] isCashbackCoin  [83] quoteMint
 */
export function decodeBondingCurve(data) {
  if (!data || data.length < CURVE_LAYOUT.MIN_LEN) return null;
  const L = CURVE_LAYOUT;
  const has = (off, len) => data.length >= off + len;
  const quoteMint = has(L.QUOTE_MINT, 32) ? new PublicKey(data.subarray(L.QUOTE_MINT, L.QUOTE_MINT + 32)) : PublicKey.default;
  const state = {
    virtualTokenReserves: data.readBigUInt64LE(L.VIRTUAL_TOKEN_RESERVES),
    virtualSolReserves: data.readBigUInt64LE(L.VIRTUAL_SOL_RESERVES),
    realTokenReserves: data.readBigUInt64LE(L.REAL_TOKEN_RESERVES),
    realSolReserves: data.readBigUInt64LE(L.REAL_SOL_RESERVES),
    tokenTotalSupply: data.readBigUInt64LE(L.TOKEN_TOTAL_SUPPLY),
    complete: data[L.COMPLETE] === 1,
    creator: has(L.CREATOR, 32) ? new PublicKey(data.subarray(L.CREATOR, L.CREATOR + 32)) : null,
    isMayhemMode: has(L.IS_MAYHEM_MODE, 1) && data[L.IS_MAYHEM_MODE] === 1,
    isCashbackCoin: has(L.IS_CASHBACK_COIN, 1) && data[L.IS_CASHBACK_COIN] === 1,
    quoteMint,
  };
  // SOL-paired coins store Pubkey::default() (or wrapped SOL) as quote mint
  state.solPaired = quoteMint.equals(PublicKey.default) || quoteMint.equals(WSOL_MINT);
  state.graduated = state.complete || state.virtualSolReserves >= GRADUATION_VSOL;
  return state;
}

/**
 * Global account (only the fields we need):
 *   [41..73]   fee_recipient
 *   [105..113] fee_basis_points
 *   [154..162] creator_fee_basis_points
 */
export function decodeGlobal(data) {
  if (!data || data.length < 113) return null;
  return {
    feeRecipient: new PublicKey(data.subarray(41, 73)),
    feeBasisPoints: data.readBigUInt64LE(105),
    creatorFeeBasisPoints: data.length >= 162 ? data.readBigUInt64LE(154) : 0n,
  };
}

/** Market cap in lamports (fee tier input). */
export function curveMarketCap(state) {
  if (state.virtualTokenReserves === 0n) return 0n;
  return (state.virtualSolReserves * state.tokenTotalSupply) / state.virtualTokenReserves;
}

/**
 * Fee schedule { lpFeeBps, protocolFeeBps, creatorFeeBps } for a trade on this curve.
 * Uses the Pump Fees tiers when available, otherwise the Global defaults.
 */
export function curveFees(state, feeConfig, global) {
  const tier = feeConfig && calculateFeeTier(feeConfig.tiers, curveMarketCap(state));
  if (tier) return tier;
  return {
    lpFeeBps: 0n,
    protocolFeeBps: global ? global.feeBasisPoints : 95n,
    creatorFeeBps: global ? global.creatorFeeBasisPoints : 30n,
  };
}

/** Price in lamports per raw token unit (float, display only). */
export function curvePrice(state) {
  if (!state || state.virtualTokenReserves === 0n) return 0;
  return Number(state.virtualSolReserves) / Number(state.virtualTokenReserves);
}

// ── Math (BigInt) ───────────────────────────────────────────────────
/** tokensOut = (solIn * virtualTokenReserves) / (virtualSolReserves + solIn) — fee already removed. */
export function tokensOutForSol(state, solIn) {
  return (solIn * state.virtualTokenReserves) / (state.virtualSolReserves + solIn);
}

/** solOut = (tokensIn * virtualSolReserves) / (virtualTokenReserves + tokensIn) — before fees. */
export function solOutForTokens(state, tokensIn) {
  return (tokensIn * state.virtualSolReserves) / (state.virtualTokenReserves + tokensIn);
}

/**
 * Exact-output buy: lamports needed (incl. fee) to receive `tokens`.
 * Null if the curve can't supply that many tokens (we never cross into synthetic migration).
 */
export function quoteBuyExactTokens(state, tokens, fees) {
  if (tokens <= 0n || tokens >= state.realTokenReserves || tokens >= state.virtualTokenReserves) return null;
  const solRaw = ceilDiv(tokens * state.virtualSolReserves, state.virtualTokenReserves - tokens) + 1n;
  const fee = feeOn(solRaw, fees);
  return { solRaw, fee, total: solRaw + fee };
}

/** Exact-input sell: lamports received (after fee) for `tokens`. */
export function quoteSellExactTokens(state, tokens, fees) {
  if (tokens <= 0n) return null;
  const solRaw = solOutForTokens(state, tokens);
  if (solRaw > state.realSolReserves) return null;
  const fee = feeOn(solRaw, fees);
  if (solRaw <= fee) return null;
  return { solRaw, fee, net: solRaw - fee };
}

// ── Instructions (buy_v3 / sell_v3, SOL-paired coins) ───────────────
/**
 * Shared 17-account list for buy_v3 / sell_v3.
 * `ctx` = { mint, tokenProgram, buybackFeeRecipient }
 * SOL moves natively for SOL-paired coins; the WSOL accounts are passed but unused.
 */
function v3Keys(ctx, user) {
  const { mint, tokenProgram = TOKEN_PROGRAM, buybackFeeRecipient } = ctx;
  const curve = bondingCurvePda(mint);
  return [
    { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: WSOL_MINT, isSigner: false, isWritable: false },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: curve, isSigner: false, isWritable: true },
    { pubkey: getAssociatedTokenAddressSync(mint, curve, true, tokenProgram), isSigner: false, isWritable: true },
    { pubkey: getAssociatedTokenAddressSync(WSOL_MINT, curve, true, TOKEN_PROGRAM), isSigner: false, isWritable: true },
    { pubkey: user, isSigner: true, isWritable: true },
    { pubkey: getAssociatedTokenAddressSync(mint, user, false, tokenProgram), isSigner: false, isWritable: true },
    { pubkey: getAssociatedTokenAddressSync(WSOL_MINT, user, false, TOKEN_PROGRAM), isSigner: false, isWritable: true },
    { pubkey: userVolumeAccumulatorPda(user), isSigner: false, isWritable: true },
    { pubkey: PUMP_FEE_CONFIG, isSigner: false, isWritable: false },
    { pubkey: buybackFeeRecipient, isSigner: false, isWritable: true },
    { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
  ];
}

/** buy_v3: receive exactly `amount` tokens, spend at most `maxSolCost` lamports (incl. fees). */
export function buyIx(ctx, user, amount, maxSolCost) {
  // partial_fill: OptionBool(false)
  const data = Buffer.concat([PUMP_BUY_V3_DISC, u64(amount), u64(maxSolCost), Buffer.from([0])]);
  return new TransactionInstruction({ programId: PUMP_PROGRAM, keys: v3Keys(ctx, user), data });
}

/** sell_v3: sell exactly `amount` tokens, receive at least `minSolOutput` lamports (after fees). */
export function sellIx(ctx, user, amount, minSolOutput) {
  const data = Buffer.concat([PUMP_SELL_V3_DISC, u64(amount), u64(minSolOutput)]);
  return new TransactionInstruction({ programId: PUMP_PROGRAM, keys: v3Keys(ctx, user), data });
}

// ── Events ──────────────────────────────────────────────────────────
/** Decode a pump.fun TradeEvent from a "Program data:" payload. */
export function parseTradeEvent(buf) {
  if (buf.length < PUMP_EVENT.MIN_LEN || !buf.subarray(0, 8).equals(PUMP_TRADE_EVENT_DISC)) return null;
  return {
    venue: 'curve',
    mint: new PublicKey(buf.subarray(PUMP_EVENT.MINT, PUMP_EVENT.MINT + 32)),
    solAmount: buf.readBigUInt64LE(PUMP_EVENT.SOL_AMOUNT),
    tokenAmount: buf.readBigUInt64LE(PUMP_EVENT.TOKEN_AMOUNT),
    isBuy: buf[PUMP_EVENT.IS_BUY] === 1,
    user: new PublicKey(buf.subarray(PUMP_EVENT.USER, PUMP_EVENT.USER + 32)),
    virtualSolReserves: buf.readBigUInt64LE(PUMP_EVENT.VIRTUAL_SOL_RESERVES),
    virtualTokenReserves: buf.readBigUInt64LE(PUMP_EVENT.VIRTUAL_TOKEN_RESERVES),
  };
}
