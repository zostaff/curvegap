# curvegap

Atomic arbitrage bot between **pump.fun bonding curves** and the **PumpSwap AMM** on Solana.

When the same token trades on a pump.fun bonding curve *and* in a PumpSwap pool, the two
venues price it independently. `curvegap` watches both programs in real time, measures the
spread, sizes the trade optimally against both constant-product curves, and executes **both
legs in a single v0 transaction** shipped as a **Jito bundle** — either both legs land, or
nothing does.

```
Path 1  (curve cheaper):  buy on bonding curve  →  sell on PumpSwap
Path 2  (AMM cheaper):    buy on PumpSwap       →  sell on bonding curve

[ComputeBudget] + [ATA setup] + [buy leg] + [sell leg] + [unwrap / close] + [Jito tip]
```

> **Status:** experimental software. Read [Reality check](#reality-check) before funding a wallet.

---

## Features

- Dual WebSocket `logsSubscribe` on pump.fun and PumpSwap with auto-reconnect and keep-alive
- Discovery of tokens that are live on **both** venues (from AMM events → curve, and from
  curve events → `getProgramAccounts` pool lookup, rate-limited and negative-cached)
- Exact on-chain math in `BigInt` (lamports and raw 6-decimal token units)
- Dynamic fee schedule from the **Pump Fees** program (market-cap tiers for curves and canonical
  pools, flat fees for permissionless pools), rounded per component exactly like the programs
- PumpSwap **effective quote reserves** (`vault + Pool.virtual_quote_reserves`, signed `i128`)
- Optimal sizing: binary search for the `ARB_MAX_SOL` cap, then ternary search of the concave
  profit function, net of both venues' fees, Jito tip and transaction fees
- **On-chain profit guard:** the sell leg's `min_out` is raised to
  `cost + tip + fees + ARB_MIN_PROFIT`, so a stale quote reverts instead of losing money
- Uses the compact instructions: pump.fun `buy_v3` / `sell_v3` and PumpSwap `buy_v2` / `sell_v2`
  (17 accounts each, no remaining accounts)
- Optional Address Lookup Table to keep the transaction well under 1232 bytes
- `--dry-run`, `--simulate`, colored real-time spread feed, SIGINT session stats

## Requirements

- Node.js **22+**
- A Solana RPC with WebSocket support (Helius or similar; public RPC is heavily rate-limited)
- A funded wallet for live trading (≥ `ARB_MAX_SOL` + tip + ~0.01 SOL for rent/fees)

## Quick start

```bash
git clone https://github.com/zostaff/curvegap.git
cd curvegap
npm install
cp .env.example .env          # fill in RPC_URL / RPC_WSS / WALLET_PRIVATE_KEY

npm run dry-run               # scan + log opportunities, never trade
npm run simulate              # dry-run + simulate every arb tx through RPC (needs a wallet)
npm run alt:create            # optional: create a lookup table, put it in ARB_LOOKUP_TABLE
npm start                     # LIVE trading
```

Need a fresh wallet? `npm run wallet:new` prints a new keypair.

### Commands

| Command | Description |
| --- | --- |
| `node bot/arbitrage.mjs` | Live bot: monitor, size and send Jito bundles |
| `node bot/arbitrage.mjs --dry-run` | Scan spreads and log opportunities, never trade |
| `node bot/arbitrage.mjs --dry-run --simulate` | Also build, sign and RPC-simulate each arb tx |
| `node bot/arbitrage.mjs --simulate` | Live, but simulate before every send and skip failures |
| `node bot/scanner.mjs [--include-graduated]` | Standalone scanner with prices on both venues |
| `node bot/setup-alt.mjs [address]` | Create (or extend) the Address Lookup Table |
| `node lib/wallet.mjs --generate` | Generate a new keypair |

Add `--verbose` to any bot command for debug logs.

## Configuration

All settings live in `.env` (see [`.env.example`](.env.example)).

| Variable | Default | Description |
| --- | --- | --- |
| `RPC_URL` | — | HTTP RPC endpoint |
| `RPC_WSS` | derived from `RPC_URL` | WebSocket endpoint |
| `HELIUS_API_KEY` | — | Used to build `RPC_URL` if it is not set |
| `WALLET_PRIVATE_KEY` | — | base58 secret key, JSON byte array, or path to a keypair file |
| `JITO_BLOCK_ENGINE_URL` | `https://mainnet.block-engine.jito.wtf` | Block engine (use a regional one close to you) |
| `ARB_LOOKUP_TABLE` | — | Address Lookup Table created by `npm run alt:create` |
| `ARB_MIN_SPREAD` | `0.02` | Minimum spread to consider (2%) |
| `ARB_MAX_SOL` | `0.5` | Max SOL per arbitrage |
| `ARB_JITO_TIP` | `0.001` | Jito tip per bundle (SOL) |
| `ARB_MIN_LIQUIDITY` | `1.0` | Min SOL liquidity on each venue |
| `ARB_MAX_SLIPPAGE` | `0.03` | Max slippage per leg (3%) |
| `ARB_COOLDOWN_SEC` | `3` | Pause between arbs on the same token |
| `ARB_SCAN_INTERVAL_MS` | `2000` | Full price refresh interval |
| `ARB_MIN_PROFIT` | `0.0005` | Minimum net profit after all costs (SOL) |
| `ARB_PRIORITY_MICROLAMPORTS` | `0` | Compute unit price (the Jito tip already buys inclusion) |
| `ARB_COMPUTE_UNITS` | `400000` | Compute unit limit |
| `ARB_CURVE_FEE_BPS` | on-chain | Override the pump.fun total fee (bps) |
| `ARB_AMM_FEE_BPS` | on-chain | Override the PumpSwap total fee (bps) |
| `ARB_MAX_PAIRS` | `500` | Max tracked dual-venue tokens (LRU eviction) |
| `ARB_DISCOVERY_RPS` | `2` | Max `getProgramAccounts` pool lookups per second |

## How it works

### 1. Monitoring

`lib/ws.mjs` opens one WebSocket with two `logsSubscribe` subscriptions:

- pump.fun `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` — `TradeEvent` (`bddb7fd34ee661ee`)
- PumpSwap `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` — `BuyEvent` (`67f4521f2cf57777`) and
  `SellEvent` (`3e2f370aa503dc2a`)

### 2. Discovery

- **AMM → curve:** every unknown pool from a swap event is fetched; if its base mint has a
  pump.fun bonding curve that is SOL-paired, not complete and not a cashback coin, the token
  becomes a tracked pair.
- **Curve → AMM:** unknown mints from curve trades are queued for a pool lookup: first the
  canonical pool PDA, then `getProgramAccounts` filtered by `base_mint` + WSOL quote (catches
  permissionless pools). Misses are cached for 30 minutes.

### 3. Pricing

```
priceCurve = virtualSolReserves / virtualTokenReserves
priceAMM   = effectiveQuoteReserves / baseReserves
spread     = |priceAMM − priceCurve| / min(priceAMM, priceCurve)
```

Spreads are computed with exact `BigInt` cross-multiplication. Every tracked pair is refreshed
every `ARB_SCAN_INTERVAL_MS` with one batched `getMultipleAccountsInfo` (curve, pool, both
vaults), and immediately (debounced 150 ms) whenever either venue emits a trade for it.

### 4. Sizing

For a direction and token amount `x`:

```
CURVE_TO_AMM:  profit(x) = ammSellNet(x)   − curveBuyCost(x)
AMM_TO_CURVE:  profit(x) = curveSellNet(x) − ammBuyCost(x)
net            = profit(x) − jitoTip − signatureFee − priorityFee
```

`curveBuyCost` and `ammBuyCost` include fees; `*SellNet` are after fees. Both venues are
constant-product, so `profit(x)` is concave: the bot binary-searches the largest `x` whose cost
fits `ARB_MAX_SOL`, then ternary-searches the optimum. The curve buy is capped at
`realTokenReserves` so it never crosses into a synthetic migration.

### 5. Execution

`bot/executor.mjs` re-fetches state, re-checks the spread and re-sizes the trade right before
building. It then assembles one v0 transaction:

| Path | Instructions |
| --- | --- |
| Curve → AMM | ComputeBudget · create token ATA · create WSOL ATA · `buy_v3` (native SOL) · `sell_v2` (→ WSOL) · close WSOL · close token ATA · Jito tip |
| AMM → Curve | ComputeBudget · create token ATA · create WSOL ATA · wrap SOL · `buy_v2` · `sell_v3` (→ native SOL) · close WSOL · close token ATA · Jito tip |

- Buy leg: `max_in = cost × (1 + ARB_MAX_SLIPPAGE)`
- Sell leg: `min_out = max(proceeds × (1 − ARB_MAX_SLIPPAGE), cost + tip + fees + ARB_MIN_PROFIT)`
- The token ATA is closed at the end (rent refunded) unless it already existed.
- The bundle is sent to `POST {JITO_BLOCK_ENGINE_URL}/api/v1/bundles` (`sendBundle`, base58).
  The bot then follows the signature and records realized PnL from the fee payer's balance delta.

## Project layout

```
lib/
  config.mjs      .env loading, CLI flags, defaults (amounts converted to lamports / bps)
  constants.mjs   program IDs, discriminators, account and event layouts, Jito tip accounts
  fees.mjs        Pump Fees config decoding, market-cap fee tiers, per-component fee rounding
  pumpfun.mjs     bonding curve: PDAs, state, buy_v3 / sell_v3, quotes, TradeEvent parsing
  pumpswap.mjs    PumpSwap: pool discovery, effective reserves, buy_v2 / sell_v2, quotes, events
  rpc.mjs         Connection, batched account fetch, blockhash cache, send / simulate / confirm
  tx.mjs          v0 transaction builder, ComputeBudget, lookup table helpers
  wallet.mjs      keypair load / generate
  ws.mjs          WebSocket logs stream with reconnect
  jito.mjs        Jito bundle API and tip instruction
  log.mjs         colors and formatting
bot/
  arbitrage.mjs   main bot: monitoring + arbitrage + session stats
  scanner.mjs     dual-venue discovery, spreads, optimal sizing (also runnable standalone)
  executor.mjs    builds, simulates and sends the atomic arb transaction
  setup-alt.mjs   creates the Address Lookup Table with all static accounts
```

## Reality check

Please read this before trading real funds.

- **Graduated tokens cannot be arbitraged against their old curve.** When a token graduates,
  pump.fun sets `complete = true`, zeroes the curve reserves and moves the liquidity to the
  canonical PumpSwap pool; the curve then rejects every buy and sell. The bot detects this and
  skips graduated curves (`graduated skipped` in the stats). The real opportunities are tokens
  whose curve is **still active** while a **permissionless PumpSwap pool** for the same mint
  exists. Those are rare, so expect long quiet periods in `--dry-run`.
- **Competition.** Any spread that exists is contested by other searchers. Tune `ARB_JITO_TIP`,
  use a low-latency RPC and a nearby regional block engine.
- **Protocol churn.** pump.fun and PumpSwap are upgraded often (new accounts, fee changes, new
  instruction versions). The account layouts here follow the official
  [pump-public-docs](https://github.com/pump-fun/pump-public-docs) IDLs as of November 2026.
  Use `--simulate` after any upgrade before trading live.
- **Cashback coins** reject `buy_v3`/`sell_v3`/`buy_v2`/`sell_v2` and are skipped.
- **Leg risk is limited, not zero.** Failed bundles do not land and cost nothing, and the sell
  leg's profit guard reverts unprofitable executions. The guard assumes the buy leg cost the
  quoted amount; if the cheap venue moved within `ARB_MAX_SLIPPAGE` before your bundle, the
  realized profit can be lower than the quote.
- Closing the WSOL ATA at the end of each arb also unwraps any WSOL you already held there.

## Notes on the original spec

Some values from the original specification differ from what is on-chain today; the bot uses
the on-chain values:

- `CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbCJ5tGLDMDSRp` is not a valid fee recipient; the real one is
  `CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM`, and v3/v2 trades no longer take a fee recipient.
- `62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV` is `Global.fee_recipient`, not the fee config.
  The pump.fun fee config is the PDA `8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt`.
- `d78f037c39e9b3b6` does not match any pump.fun instruction. Legacy `buy` is `66063d1201daebea`,
  legacy `sell` is `33e685a4017f83ad`; the bot uses `buy_v3` / `sell_v3`.
- `3e2f370aa503dc2a` is PumpSwap's `SellEvent` discriminator, not a fee event.
- The pump.fun fee is a market-cap tier (currently 0.95% protocol + 0.30% creator), not a flat 1%.

## Disclaimer

This software is provided as is, for research and educational purposes. Trading on-chain is
risky; you can lose funds. You are solely responsible for how you use it.

## License

MIT
