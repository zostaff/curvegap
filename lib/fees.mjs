// Dynamic fee schedule of the Pump Fees program (shared by pump.fun and PumpSwap).
//
// Fees depend on the coin's market cap in lamports:
//   curve:  marketCap = virtualSolReserves * tokenTotalSupply / virtualTokenReserves
//   pool:   marketCap = effectiveQuoteReserves * baseMintSupply / baseReserves
// Canonical (pump-migrated) pools and bonding curves use `fee_tiers`;
// permissionless pools use `flat_fees`.
import { PUMP_FEE_PROGRAM, PUMP_PROGRAM, PUMPSWAP_PROGRAM } from './constants.mjs';
import { PublicKey } from '@solana/web3.js';

export const feeConfigPda = (program) =>
  PublicKey.findProgramAddressSync([Buffer.from('fee_config'), program.toBuffer()], PUMP_FEE_PROGRAM)[0];
export const PUMP_FEE_CONFIG = feeConfigPda(PUMP_PROGRAM);
export const PUMPSWAP_FEE_CONFIG = feeConfigPda(PUMPSWAP_PROGRAM);

const readFees = (d, o) => ({
  lpFeeBps: d.readBigUInt64LE(o),
  protocolFeeBps: d.readBigUInt64LE(o + 8),
  creatorFeeBps: d.readBigUInt64LE(o + 16),
});

const readU128 = (d, o) => d.readBigUInt64LE(o) | (d.readBigUInt64LE(o + 8) << 64n);

/**
 * FeeConfig layout:
 *   [0..8]   discriminator
 *   [8]      bump
 *   [9..41]  admin
 *   [41..65] flat_fees { lp, protocol, creator } (u64 each)
 *   [65..69] fee_tiers.len (u32), then N × { threshold u128, fees (3×u64) }
 */
export function decodeFeeConfig(data) {
  if (!data || data.length < 69) return null;
  const flatFees = readFees(data, 41);
  const n = data.readUInt32LE(65);
  const tiers = [];
  let o = 69;
  for (let i = 0; i < n && o + 40 <= data.length; i++, o += 40) {
    tiers.push({ threshold: readU128(data, o), fees: readFees(data, o + 16) });
  }
  return { flatFees, tiers };
}

/** pump-fees-math::calculate_fee_tier */
export function calculateFeeTier(tiers, marketCap) {
  if (!tiers.length) return null;
  if (marketCap < tiers[0].threshold) return tiers[0].fees;
  for (let i = tiers.length - 1; i >= 0; i--) {
    if (marketCap >= tiers[i].threshold) return tiers[i].fees;
  }
  return tiers[0].fees;
}

export const totalBps = (f) => f.lpFeeBps + f.protocolFeeBps + f.creatorFeeBps;

/** Fees object from a single total (used for ARB_*_FEE_BPS overrides). */
export const flatFees = (bps) => ({ lpFeeBps: 0n, protocolFeeBps: BigInt(bps), creatorFeeBps: 0n });

const ceilDiv = (a, b) => (a + b - 1n) / b;

/** Fee charged on `amount`: each component is rounded up separately, like the programs do. */
export function feeOn(amount, fees) {
  return ceilDiv(amount * fees.lpFeeBps, 10_000n)
    + ceilDiv(amount * fees.protocolFeeBps, 10_000n)
    + ceilDiv(amount * fees.creatorFeeBps, 10_000n);
}
