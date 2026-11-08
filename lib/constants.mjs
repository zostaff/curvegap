import { PublicKey } from '@solana/web3.js';

const pk = (s) => new PublicKey(s);

// ── Native / SPL programs ───────────────────────────────────────────
export const SYSTEM_PROGRAM = pk('11111111111111111111111111111111');
export const TOKEN_PROGRAM = pk('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM = pk('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ASSOCIATED_TOKEN_PROGRAM = pk('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const COMPUTE_BUDGET_PROGRAM = pk('ComputeBudget111111111111111111111111111111');
export const WSOL_MINT = pk('So11111111111111111111111111111111111111112');

// ── pump.fun bonding curve ──────────────────────────────────────────
export const PUMP_PROGRAM = pk('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const PUMP_GLOBAL = pk('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
// Legacy fee recipient (Global.fee_recipient is read on-chain). v3/v2 trades no longer take it.
export const PUMP_FEE_RECIPIENT = pk('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV');
export const PUMP_EVENT_AUTHORITY = pk('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');
// Pump Fees program, shared by pump.fun and PumpSwap. Fee config accounts are PDAs
// ["fee_config", <program id>] under this program:
//   pump.fun  → 8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt
//   PumpSwap  → 5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx
export const PUMP_FEE_PROGRAM = pk('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');

// Buyback fee recipients (common to both programs). Every v3 curve trade takes one
// of these wallets; every v2 PumpSwap trade takes its WSOL associated token account.
export const BUYBACK_FEE_RECIPIENTS = [
  '5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD',
  '9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7',
  'GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL',
  '3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR',
  '5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6',
  'EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL',
  '5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD',
  'A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW',
].map(pk);

// Anchor discriminators (sha256("global:<ix>")[0..8] / sha256("event:<Event>")[0..8]).
// The bot trades with the compact instructions: pump.fun buy_v3 / sell_v3 and
// PumpSwap buy_v2 / sell_v2 (17 accounts each, no remaining accounts).
export const PUMP_BUY_DISC = Buffer.from('66063d1201daebea', 'hex');     // global:buy (legacy)
export const PUMP_SELL_DISC = Buffer.from('33e685a4017f83ad', 'hex');    // global:sell (legacy)
export const PUMP_BUY_V3_DISC = Buffer.from([7, 5, 29, 196, 245, 23, 101, 80]);       // global:buy_v3
export const PUMP_SELL_V3_DISC = Buffer.from([28, 146, 222, 119, 38, 196, 105, 213]); // global:sell_v3
export const PUMP_TRADE_EVENT_DISC = Buffer.from('bddb7fd34ee661ee', 'hex'); // event:TradeEvent
export const PUMP_CURVE_ACCOUNT_DISC = Buffer.from('17b7f83760d8ac60', 'hex'); // account:BondingCurve

// Trade event layout (offsets into the decoded "Program data:" payload)
export const PUMP_EVENT = Object.freeze({
  MIN_LEN: 113,
  MINT: 8,
  SOL_AMOUNT: 40,
  TOKEN_AMOUNT: 48,
  IS_BUY: 56,
  USER: 57,
  TIMESTAMP: 89,
  VIRTUAL_SOL_RESERVES: 97,
  VIRTUAL_TOKEN_RESERVES: 105,
});

// Bonding curve account layout
export const CURVE_LAYOUT = Object.freeze({
  VIRTUAL_TOKEN_RESERVES: 8,
  VIRTUAL_SOL_RESERVES: 16,
  REAL_TOKEN_RESERVES: 24,
  REAL_SOL_RESERVES: 32,
  TOKEN_TOTAL_SUPPLY: 40,
  COMPLETE: 48,
  CREATOR: 49,
  IS_MAYHEM_MODE: 81,
  IS_CASHBACK_COIN: 82,
  QUOTE_MINT: 83, // Pubkey::default() for SOL-paired coins
  MIN_LEN: 49,
});

// Graduation threshold (virtual SOL reserves, lamports)
export const GRADUATION_VSOL = 85_000_000_000n;

// ── PumpSwap AMM ────────────────────────────────────────────────────
export const PUMPSWAP_PROGRAM = pk('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
export const PUMPSWAP_BUY_DISC = Buffer.from('66063d1201daebea', 'hex');  // global:buy (legacy)
export const PUMPSWAP_SELL_DISC = Buffer.from('33e685a4017f83ad', 'hex'); // global:sell (legacy)
export const PUMPSWAP_BUY_V2_DISC = Buffer.from([184, 23, 238, 97, 103, 197, 211, 61]);  // global:buy_v2
export const PUMPSWAP_SELL_V2_DISC = Buffer.from([93, 246, 130, 60, 231, 233, 64, 178]); // global:sell_v2
export const PUMPSWAP_BUY_EVENT_DISC = Buffer.from('67f4521f2cf57777', 'hex');  // event:BuyEvent
export const PUMPSWAP_SELL_EVENT_DISC = Buffer.from('3e2f370aa503dc2a', 'hex'); // event:SellEvent
export const PUMPSWAP_POOL_ACCOUNT_DISC = Buffer.from('f19a6d0411b16dbc', 'hex'); // account:Pool

// Pool account layout
export const POOL_LAYOUT = Object.freeze({
  BUMP: 8,
  INDEX: 9,
  CREATOR: 11,
  BASE_MINT: 43,
  QUOTE_MINT: 75,
  LP_MINT: 107,
  POOL_BASE_TOKEN_ACCOUNT: 139,
  POOL_QUOTE_TOKEN_ACCOUNT: 171,
  LP_SUPPLY: 203,
  COIN_CREATOR: 211,
  IS_MAYHEM_MODE: 243,
  IS_CASHBACK_COIN: 244,
  VIRTUAL_QUOTE_RESERVES: 245, // i128, may be negative; missing on old pools → 0
  MIN_LEN: 243,
});

// Buy/Sell event layout (identical offsets for both events)
export const PUMPSWAP_EVENT = Object.freeze({
  TIMESTAMP: 8,
  BASE_AMOUNT: 16,
  POOL_BASE_RESERVES: 48,
  POOL_QUOTE_RESERVES: 56,
  QUOTE_AMOUNT: 64,
  POOL: 120,
  USER: 152,
  MIN_LEN: 184,
});

// ── Jito ────────────────────────────────────────────────────────────
export const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
].map(pk);

// ── Units ───────────────────────────────────────────────────────────
export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const TOKEN_DECIMALS = 6;
export const BPS = 10_000n;
export const MAX_TX_SIZE = 1232;
