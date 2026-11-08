import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import { config, maskUrl } from '../lib/config.mjs';
import { BPS, PUMP_GLOBAL, PUMP_PROGRAM, PUMPSWAP_PROGRAM, WSOL_MINT } from '../lib/constants.mjs';
import { decodeFeeConfig, flatFees, PUMP_FEE_CONFIG, PUMPSWAP_FEE_CONFIG, totalBps } from '../lib/fees.mjs';
import { c, fmtBps, fmtPrice, fmtSol, fmtTokens, log, shortKey } from '../lib/log.mjs';
import * as pumpfun from '../lib/pumpfun.mjs';
import * as pumpswap from '../lib/pumpswap.mjs';
import { getConnection, getMultipleAccounts, RateLimiter, readTokenAmount } from '../lib/rpc.mjs';
import { extractProgramData, LogsStream } from '../lib/ws.mjs';

const POOL_NEGATIVE_TTL_MS = 30 * 60_000;
const DISCOVERY_QUEUE_MAX = 200;
const EVENT_DEBOUNCE_MS = 150;

// ── Fees ────────────────────────────────────────────────────────────
/** Load fee parameters of both programs (globals + Pump Fees tier configs). */
export async function loadFees(connection) {
  const [pg, pfc, ag, afc] = await connection.getMultipleAccountsInfo([
    PUMP_GLOBAL, PUMP_FEE_CONFIG, pumpswap.globalConfigPda(), PUMPSWAP_FEE_CONFIG,
  ]);
  return {
    pumpGlobal: pumpfun.decodeGlobal(pg?.data),
    pumpFeeConfig: decodeFeeConfig(pfc?.data),
    ammGlobal: pumpswap.decodeGlobalConfig(ag?.data),
    ammFeeConfig: decodeFeeConfig(afc?.data),
    loadedAt: Date.now(),
  };
}

/** Fee schedules for one pair at its current state (ARB_*_FEE_BPS overrides win). */
export function pairFees(ctx, pair, curve, reserves) {
  const curveFees = config.curveFeeBpsOverride !== undefined
    ? flatFees(config.curveFeeBpsOverride)
    : pumpfun.curveFees(curve, ctx.pumpFeeConfig, ctx.pumpGlobal);
  const ammFees = config.ammFeeBpsOverride !== undefined
    ? flatFees(config.ammFeeBpsOverride)
    : pumpswap.poolFees(pair.pool, reserves, curve.tokenTotalSupply, ctx.ammFeeConfig, ctx.ammGlobal);
  return { curve: curveFees, amm: ammFees };
}

// ── Spread / sizing (BigInt) ────────────────────────────────────────
/**
 * Spread between venues in basis points using exact cross-multiplication:
 *   priceCurve = vSol / vTok, priceAMM = quote / base
 *   spread = |pA - pC| / min(pA, pC)
 */
export function computeSpread(curve, reserves) {
  const x = curve.virtualSolReserves * reserves.base; // ∝ priceCurve
  const y = reserves.quote * curve.virtualTokenReserves; // ∝ priceAMM
  if (x === 0n || y === 0n) return null;
  const lo = x < y ? x : y;
  const diff = x > y ? x - y : y - x;
  return {
    spreadBps: (diff * BPS) / lo,
    direction: x < y ? 'CURVE_TO_AMM' : 'AMM_TO_CURVE', // buy on the cheaper venue
  };
}

/** Gross profit (lamports) and quotes for trading `tokens` along `direction`. */
function evalSize(direction, curve, reserves, fees, tokens) {
  if (direction === 'CURVE_TO_AMM') {
    const buy = pumpfun.quoteBuyExactTokens(curve, tokens, fees.curve);
    const sell = buy && pumpswap.quoteSellExactBase(reserves, tokens, fees.amm);
    if (!buy || !sell) return null;
    return { tokens, cost: buy.total, proceeds: sell.net, gross: sell.net - buy.total };
  }
  const buy = pumpswap.quoteBuyExactBase(reserves, tokens, fees.amm);
  const sell = buy && pumpfun.quoteSellExactTokens(curve, tokens, fees.curve);
  if (!buy || !sell) return null;
  return { tokens, cost: buy.total, proceeds: sell.net, gross: sell.net - buy.total };
}

/** Fixed per-trade costs: Jito tip + signature fee + priority fee. */
export function fixedCosts() {
  const priority = (config.priorityMicroLamports * BigInt(config.computeUnits)) / 1_000_000n;
  return config.jitoTipLamports + 5_000n + priority;
}

/**
 * Find the token amount maximising net profit, constrained by ARB_MAX_SOL.
 * Both venues are constant-product curves, so gross profit is concave in size:
 * binary search the size cap, then ternary search the optimum.
 */
export function findBestTrade(direction, curve, reserves, fees) {
  const upper = direction === 'CURVE_TO_AMM' ? curve.realTokenReserves - 1n : reserves.base - 1n;
  if (upper <= 0n) return null;

  // smallest meaningful size: tokens worth ~0.001 SOL (tiny sizes round to zero output)
  let lo = (1_000_000n * curve.virtualTokenReserves) / (curve.virtualSolReserves || 1n);
  if (lo < 1n) lo = 1n;
  if (lo > upper) return null;
  let hi = upper;
  // 1) largest size whose cost stays within ARB_MAX_SOL
  const first = evalSize(direction, curve, reserves, fees, lo);
  if (!first || first.cost > config.maxSolLamports) return null;
  const floor = lo;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    const r = evalSize(direction, curve, reserves, fees, mid);
    if (r && r.cost <= config.maxSolLamports) lo = mid;
    else hi = mid - 1n;
  }
  const cap = lo;

  // 2) ternary search on gross profit over [floor, cap]
  let a = floor;
  let b = cap;
  const g = (t) => evalSize(direction, curve, reserves, fees, t)?.gross ?? -(1n << 62n);
  while (b - a > 2n) {
    const m1 = a + (b - a) / 3n;
    const m2 = b - (b - a) / 3n;
    if (g(m1) < g(m2)) a = m1;
    else b = m2;
  }
  let best = null;
  for (let t = a; t <= b; t++) {
    const r = evalSize(direction, curve, reserves, fees, t);
    if (r && (!best || r.gross > best.gross)) best = r;
  }
  if (!best) return null;

  const fixed = fixedCosts();
  return { direction, ...best, fixed, net: best.gross - fixed };
}

// ── Scanner ─────────────────────────────────────────────────────────
/**
 * Tracks tokens that trade on BOTH a pump.fun bonding curve and a PumpSwap pool.
 *
 * Events:
 *   'spread'      ({ pair, spreadBps, direction, trade })  every evaluation above ARB_MIN_SPREAD
 *   'opportunity' ({ pair, spreadBps, trade })              profitable + tradable
 *   'pair'        (pair)                                    new dual-venue token discovered
 */
export class Scanner extends EventEmitter {
  constructor({ connection = getConnection(), includeGraduated = false } = {}) {
    super();
    this.connection = connection;
    this.includeGraduated = includeGraduated;
    this.pairs = new Map(); // mint → pair
    this.poolCache = new Map(); // pool address → { mint } | null
    this.noPool = new Map(); // mint → expiresAt (negative cache)
    this.discoveryQueue = new Set(); // mints waiting for a getProgramAccounts pool lookup
    this.poolQueue = new Set(); // pools waiting to be resolved
    this.pending = new Map(); // mint → debounce timer
    this.limiter = new RateLimiter(config.discoveryRps);
    this.stats = {
      curveEvents: 0, ammEvents: 0, evaluations: 0, spreadsSeen: 0, opportunities: 0,
      bestSpreadBps: 0n, bestSpreadMint: null, graduatedSeen: 0, cashbackSkipped: 0,
    };
  }

  async init() {
    this.fees = await loadFees(this.connection);
    const f = this.fees;
    const tiers = (fc) => (fc ? `${fc.tiers.length} tiers` : c.red('missing'));
    log.info(
      `Fee schedule: curve ${tiers(f.pumpFeeConfig)}, AMM ${tiers(f.ammFeeConfig)}` +
      (f.ammFeeConfig ? `, permissionless pools ${fmtBps(totalBps(f.ammFeeConfig.flatFees))}` : '') +
      (config.curveFeeBpsOverride !== undefined ? `  ·  curve override ${config.curveFeeBpsOverride} bps` : '') +
      (config.ammFeeBpsOverride !== undefined ? `  ·  AMM override ${config.ammFeeBpsOverride} bps` : ''),
    );
  }

  /** Re-read fee tiers periodically (they are admin-updatable). */
  async #reloadFees() {
    const next = await loadFees(this.connection);
    Object.assign(this.fees, next);
  }

  start() {
    this.stream = new LogsStream(config.rpcWss);
    this.stream.subscribeProgram(PUMP_PROGRAM);
    this.stream.subscribeProgram(PUMPSWAP_PROGRAM);
    this.stream.on('open', () => log.ok(`WebSocket connected ${c.gray(maskUrl(config.rpcWss))}`));
    this.stream.on('error', (e) => log.warn(`WebSocket: ${e.message}`));
    this.stream.on('logs', (program, value) => this.#onLogs(program, value));
    this.stream.connect();

    this.timers = [
      setInterval(() => this.refreshAll().catch((e) => log.warn(`refresh: ${e.message}`)), config.scanIntervalMs),
      setInterval(() => this.#drainPools().catch((e) => log.warn(`pool resolve: ${e.message}`)), 250),
      setInterval(() => this.#drainDiscovery().catch((e) => log.debug(`discovery: ${e.message}`)), 1000 / Math.max(config.discoveryRps, 0.1)),
      setInterval(() => this.#reloadFees().catch(() => {}), 5 * 60_000),
    ];
  }

  stop() {
    this.stream?.close();
    for (const t of this.timers ?? []) clearInterval(t);
    for (const t of this.pending.values()) clearTimeout(t);
  }

  // ── Event intake ──────────────────────────────────────────────────
  #onLogs(program, value) {
    if (value.err) return;
    for (const buf of extractProgramData(value.logs)) {
      if (program === PUMP_PROGRAM.toBase58()) {
        const ev = pumpfun.parseTradeEvent(buf);
        if (ev) this.#onCurveTrade(ev);
      } else {
        const ev = pumpswap.parseSwapEvent(buf);
        if (ev) this.#onAmmTrade(ev);
      }
    }
  }

  #onCurveTrade(ev) {
    this.stats.curveEvents++;
    const mint = ev.mint.toBase58();
    const pair = this.pairs.get(mint);
    if (pair) {
      pair.lastActivity = Date.now();
      this.#schedule(mint);
      return;
    }
    // Unknown token: look for a PumpSwap pool (rate-limited, negative-cached)
    const exp = this.noPool.get(mint);
    if (exp && exp > Date.now()) return;
    if (this.discoveryQueue.size >= DISCOVERY_QUEUE_MAX) {
      this.discoveryQueue.delete(this.discoveryQueue.values().next().value);
    }
    this.discoveryQueue.add(mint);
  }

  #onAmmTrade(ev) {
    this.stats.ammEvents++;
    const poolKey = ev.pool.toBase58();
    if (!this.poolCache.has(poolKey)) {
      this.poolQueue.add(poolKey);
      return;
    }
    const entry = this.poolCache.get(poolKey);
    if (!entry) return;
    const pair = this.pairs.get(entry.mint);
    if (pair) {
      pair.lastActivity = Date.now();
      this.#schedule(entry.mint);
    }
  }

  #schedule(mint) {
    if (this.pending.has(mint)) return;
    this.pending.set(mint, setTimeout(() => {
      this.pending.delete(mint);
      const pair = this.pairs.get(mint);
      if (pair) this.refreshPairs([pair]).catch((e) => log.debug(`refresh ${shortKey(mint)}: ${e.message}`));
    }, EVENT_DEBOUNCE_MS));
  }

  // ── Discovery ─────────────────────────────────────────────────────
  /** Resolve pools seen in AMM events → base mint → check for a bonding curve. */
  async #drainPools() {
    if (this.poolQueue.size === 0) return;
    const keys = [...this.poolQueue].slice(0, 100);
    keys.forEach((k) => this.poolQueue.delete(k));
    const infos = await getMultipleAccounts(this.connection, keys.map((k) => new PublicKey(k)), 'confirmed');

    const candidates = [];
    infos.forEach((info, i) => {
      const pool = info && pumpswap.decodePool(new PublicKey(keys[i]), info.data);
      if (!pool || !pool.quoteMint.equals(WSOL_MINT)) {
        this.poolCache.set(keys[i], null);
        return;
      }
      this.poolCache.set(keys[i], { mint: pool.baseMint.toBase58() });
      if (!this.pairs.has(pool.baseMint.toBase58())) candidates.push(pool);
    });
    if (candidates.length) await this.#attachCurves(candidates);
  }

  /** For mints seen on the curve without a known pool: getProgramAccounts lookup. */
  async #drainDiscovery() {
    const mint = this.discoveryQueue.values().next().value;
    if (!mint) return;
    this.discoveryQueue.delete(mint);
    await this.limiter.wait();
    const pool = await pumpswap.findPool(this.connection, new PublicKey(mint));
    if (!pool) {
      this.noPool.set(mint, Date.now() + POOL_NEGATIVE_TTL_MS);
      return;
    }
    this.poolCache.set(pool.address.toBase58(), { mint });
    await this.#attachCurves([pool]);
  }

  /** Given pools, fetch their bonding curves + mint accounts and register pairs. */
  async #attachCurves(pools) {
    const keys = [];
    for (const p of pools) keys.push(pumpfun.bondingCurvePda(p.baseMint), p.baseMint);
    const infos = await getMultipleAccounts(this.connection, keys, 'confirmed');

    pools.forEach((pool, i) => {
      const curveInfo = infos[i * 2];
      const mintInfo = infos[i * 2 + 1];
      if (!curveInfo || !curveInfo.owner.equals(PUMP_PROGRAM) || !mintInfo) return; // not a pump.fun token
      const curve = pumpfun.decodeBondingCurve(curveInfo.data);
      if (!curve || !curve.solPaired) return;
      // v3 / v2 trades reject cashback coins; legacy instructions are not supported here
      if (curve.isCashbackCoin || pool.isCashbackCoin) {
        this.stats.cashbackSkipped++;
        return;
      }
      if (curve.complete) {
        this.stats.graduatedSeen++;
        if (!this.includeGraduated) return;
      }
      this.#addPair(pool, curve, mintInfo.owner);
    });
  }

  #addPair(pool, curve, tokenProgram) {
    const mint = pool.baseMint.toBase58();
    if (this.pairs.has(mint)) return;
    if (this.pairs.size >= config.maxPairs) this.#evictOne();
    const pair = {
      mint: pool.baseMint,
      mintStr: mint,
      curveAddress: pumpfun.bondingCurvePda(pool.baseMint),
      pool,
      tokenProgram,
      creator: curve.creator,
      curve,
      reserves: null,
      lastActivity: Date.now(),
      lastPrintedBps: -1n,
      lastPrintedAt: 0,
    };
    this.pairs.set(mint, pair);
    this.emit('pair', pair);
    this.refreshPairs([pair]).catch(() => {});
  }

  #evictOne() {
    let oldest = null;
    for (const p of this.pairs.values()) if (!oldest || p.lastActivity < oldest.lastActivity) oldest = p;
    if (oldest) this.pairs.delete(oldest.mintStr);
  }

  // ── Refresh + evaluate ────────────────────────────────────────────
  async refreshAll() {
    if (this.pairs.size === 0) return;
    await this.refreshPairs([...this.pairs.values()]);
  }

  /** Batch-fetch curve + pool + both vaults for the given pairs, then evaluate. */
  async refreshPairs(pairs) {
    const keys = [];
    for (const p of pairs) keys.push(p.curveAddress, p.pool.address, p.pool.poolBaseTokenAccount, p.pool.poolQuoteTokenAccount);
    const infos = await getMultipleAccounts(this.connection, keys, 'processed');
    pairs.forEach((p, i) => {
      const [ci, pi, bi, qi] = infos.slice(i * 4, i * 4 + 4);
      const curve = pumpfun.decodeBondingCurve(ci?.data);
      const pool = pi && pumpswap.decodePool(p.pool.address, pi.data);
      const base = readTokenAmount(bi?.data);
      const quote = readTokenAmount(qi?.data);
      if (!curve || !pool || base === null || quote === null) return;
      p.curve = curve;
      p.pool = pool;
      p.creator = curve.creator ?? p.creator;
      p.reserves = pumpswap.effectiveReserves(pool, base, quote);
      p.updatedAt = Date.now();
      if (curve.complete && !this.includeGraduated) {
        this.pairs.delete(p.mintStr);
        this.stats.graduatedSeen++;
        return;
      }
      this.evaluate(p);
    });
  }

  /** Compute spread + optimal trade for a pair and emit events. */
  evaluate(pair) {
    this.stats.evaluations++;
    const { curve, reserves } = pair;
    if (!curve || !reserves || reserves.base === 0n || reserves.quote === 0n) return null;

    const s = computeSpread(curve, reserves);
    if (!s) return null;
    pair.spreadBps = s.spreadBps;
    pair.direction = s.direction;
    if (s.spreadBps > this.stats.bestSpreadBps) {
      this.stats.bestSpreadBps = s.spreadBps;
      this.stats.bestSpreadMint = pair.mintStr;
    }
    if (s.spreadBps < config.minSpreadBps) return null;

    this.stats.spreadsSeen++;
    const liquidityOk = reserves.quote >= config.minLiquidityLamports && curve.realSolReserves >= config.minLiquidityLamports;
    const tradable = !curve.complete && liquidityOk;
    const fees = pairFees(this.fees, pair, curve, reserves);
    pair.fees = fees;
    const trade = tradable ? findBestTrade(s.direction, curve, reserves, fees) : null;
    pair.lastTrade = trade;

    const info = { pair, spreadBps: s.spreadBps, direction: s.direction, trade, tradable, liquidityOk };
    this.emit('spread', info);
    if (trade && trade.net >= config.minProfitLamports) {
      this.stats.opportunities++;
      this.emit('opportunity', info);
    }
    return info;
  }
}

// ── Display helpers (shared with arbitrage.mjs) ─────────────────────
export function formatSpreadLine({ pair, spreadBps, direction, trade, tradable, liquidityOk }) {
  const pc = pumpfun.curvePrice(pair.curve);
  const pa = pumpswap.ammPrice(pair.reserves);
  const dir = direction === 'CURVE_TO_AMM'
    ? `${c.green('CURVE')}→${c.magenta('AMM')}`
    : `${c.magenta('AMM')}→${c.green('CURVE')}`;
  const spread = spreadBps >= 1000n ? c.bgYellow(` ${fmtBps(spreadBps)} `) : c.yellow(fmtBps(spreadBps));
  let tail;
  if (pair.curve.complete) tail = c.dim('curve closed (graduated)');
  else if (!liquidityOk) tail = c.dim(`low liquidity (AMM ${fmtSol(pair.reserves.quote, 2)} / curve ${fmtSol(pair.curve.realSolReserves, 2)} SOL)`);
  else if (!trade) tail = c.dim('no feasible size');
  else {
    const net = trade.net >= 0n ? c.green(`+${fmtSol(trade.net)}`) : c.red(fmtSol(trade.net));
    tail = `size ${c.bold(fmtSol(trade.cost, 4))} SOL (${fmtTokens(trade.tokens)} tok)  net ${net} SOL`;
  }
  return `${c.bold(shortKey(pair.mintStr))}  ${dir}  curve ${fmtPrice(pc)}  amm ${fmtPrice(pa)}  spread ${spread}  ${tail}`;
}

// ── Standalone: node bot/scanner.mjs [--include-graduated] ──────────
async function main() {
  const includeGraduated = process.argv.includes('--include-graduated');
  log.raw(c.bold(c.cyan('\n  curvegap scanner')) + c.gray('  —  pump.fun curve ⇄ PumpSwap AMM\n'));
  log.info(`RPC ${c.gray(maskUrl(config.rpcUrl))}`);
  log.info(`Min spread ${fmtBps(config.minSpreadBps)}  ·  max size ${fmtSol(config.maxSolLamports, 3)} SOL  ·  graduated ${includeGraduated ? 'shown' : 'hidden'}`);

  const scanner = new Scanner({ includeGraduated });
  await scanner.init();
  scanner.on('pair', (p) => log.ok(`Dual-venue token ${c.bold(p.mintStr)} pool ${shortKey(p.pool.address)}${p.curve.complete ? c.dim(' (graduated)') : ''}`));
  scanner.on('spread', (info) => {
    const p = info.pair;
    const now = Date.now();
    if (p.lastPrintedBps === info.spreadBps && now - p.lastPrintedAt < 10_000) return;
    p.lastPrintedBps = info.spreadBps;
    p.lastPrintedAt = now;
    log.raw(`${c.gray(new Date().toISOString().slice(11, 19))}  ${formatSpreadLine(info)}`);
  });
  scanner.start();

  const t0 = Date.now();
  const status = setInterval(() => {
    const s = scanner.stats;
    const sec = (Date.now() - t0) / 1000;
    log.info(
      c.gray(`events curve ${(s.curveEvents / sec).toFixed(0)}/s  amm ${(s.ammEvents / sec).toFixed(0)}/s  ·  ` +
      `pairs ${scanner.pairs.size}  ·  graduated skipped ${s.graduatedSeen}  ·  cashback skipped ${s.cashbackSkipped}  ·  discovery queue ${scanner.discoveryQueue.size}`),
    );
  }, 15_000);

  process.on('SIGINT', () => {
    clearInterval(status);
    scanner.stop();
    const s = scanner.stats;
    log.raw(`\n${c.bold('Scanner stats')}: curve events ${s.curveEvents}, AMM events ${s.ammEvents}, pairs ${scanner.pairs.size}, ` +
      `spreads ≥ min ${s.spreadsSeen}, opportunities ${s.opportunities}, best spread ${fmtBps(s.bestSpreadBps)}` +
      `${s.bestSpreadMint ? ` (${s.bestSpreadMint})` : ''}`);
    process.exit(0);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    log.error(e.stack ?? e.message);
    process.exit(1);
  });
}
