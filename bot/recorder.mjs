// Long-running market recorder: logs what the scanner sees to JSONL files so you can
// judge, over hours or days, whether curve ⇄ PumpSwap opportunities exist at all.
//
//   node bot/recorder.mjs [--duration 6h] [--out logs] [--include-graduated]
//   node bot/recorder.mjs --report logs/scan-2026-11-08T12-00-00
//
// Output directory (one per run):
//   pairs.jsonl          every dual-venue token discovered
//   spreads.jsonl        spread samples ≥ ARB_MIN_SPREAD (per pair: on change, at most every 30 s otherwise)
//   opportunities.jsonl  one line per opportunity *episode* (consecutive profitable evaluations of a mint)
//   stats.jsonl          counter snapshot every 60 s
//   summary.json         aggregate, rewritten every 60 s and on exit (survives crashes)
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config, maskUrl } from '../lib/config.mjs';
import { c, fmtBps, fmtSol, log, shortKey } from '../lib/log.mjs';
import * as pumpfun from '../lib/pumpfun.mjs';
import * as pumpswap from '../lib/pumpswap.mjs';
import { Scanner } from './scanner.mjs';

const SAMPLE_MIN_INTERVAL_MS = 30_000;
const SNAPSHOT_INTERVAL_MS = 60_000;
const SPREAD_BUCKETS = [50, 100, 200, 300, 500, 1000, 2000, 5000]; // bps lower bounds

const lamportsToSol = (l) => Number(l) / 1e9;

/** "90s" | "30m" | "6h" | "2d" | plain seconds → milliseconds (0 = run until Ctrl+C). */
export function parseDuration(s) {
  if (!s) return 0;
  const m = /^(\d+(?:\.\d+)?)\s*([smhd]?)$/i.exec(String(s).trim());
  if (!m) throw new Error(`invalid --duration "${s}" (use e.g. 90s, 30m, 6h, 2d)`);
  const mult = { '': 1e3, s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[m[2].toLowerCase()];
  return Math.round(Number(m[1]) * mult);
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function bucketOf(bps) {
  let label = `<${SPREAD_BUCKETS[0]}`;
  for (const b of SPREAD_BUCKETS) if (bps >= b) label = `${b}+`;
  return label;
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

export class Recorder {
  constructor(scanner, dir) {
    this.scanner = scanner;
    this.dir = dir;
    this.startedAt = Date.now();
    this.mints = new Map(); // mint → per-token aggregate
    this.open = new Map(); // mint → open opportunity episode
    this.episodes = [];
    this.buckets = Object.fromEntries([`<${SPREAD_BUCKETS[0]}`, ...SPREAD_BUCKETS.map((b) => `${b}+`)].map((k) => [k, 0]));
    mkdirSync(dir, { recursive: true });
  }

  #write(file, obj) {
    appendFileSync(join(this.dir, file), `${JSON.stringify(obj)}\n`);
  }

  #mint(pair) {
    let m = this.mints.get(pair.mintStr);
    if (!m) {
      m = {
        mint: pair.mintStr, pool: pair.pool.address.toBase58(), firstSeen: Date.now(),
        samples: 0, tradableSamples: 0, maxSpreadBps: 0, maxTradableSpreadBps: 0,
        maxNetLamports: 0n, episodes: 0, graduated: !!pair.curve?.complete,
        lastSampleAt: 0, lastSampleBps: null,
      };
      this.mints.set(pair.mintStr, m);
    }
    return m;
  }

  attach() {
    const s = this.scanner;
    s.on('pair', (pair) => {
      this.#mint(pair);
      this.#write('pairs.jsonl', {
        t: new Date().toISOString(), mint: pair.mintStr, pool: pair.pool.address.toBase58(),
        canonical: pumpswap.isCanonicalPool(pair.pool), graduated: !!pair.curve?.complete,
        curveRealSol: lamportsToSol(pair.curve?.realSolReserves ?? 0n),
      });
    });
    s.on('spread', (info) => this.#onSpread(info));
    this.snapshotTimer = setInterval(() => this.snapshot(), SNAPSHOT_INTERVAL_MS);
  }

  #onSpread({ pair, spreadBps, direction, trade, tradable, liquidityOk }) {
    const now = Date.now();
    const bps = Number(spreadBps);
    const m = this.#mint(pair);
    m.graduated = !!pair.curve.complete;
    m.samples++;
    m.maxSpreadBps = Math.max(m.maxSpreadBps, bps);
    if (tradable) {
      m.tradableSamples++;
      m.maxTradableSpreadBps = Math.max(m.maxTradableSpreadBps, bps);
      this.buckets[bucketOf(bps)]++;
    }
    const net = trade?.net ?? null;
    if (net !== null && net > m.maxNetLamports) m.maxNetLamports = net;

    // Spread sample (throttled per mint)
    if (m.lastSampleBps !== bps || now - m.lastSampleAt >= SAMPLE_MIN_INTERVAL_MS) {
      m.lastSampleAt = now;
      m.lastSampleBps = bps;
      this.#write('spreads.jsonl', {
        t: new Date(now).toISOString(), mint: pair.mintStr, dir: direction, spreadBps: bps,
        tradable, liquidityOk, graduated: !!pair.curve.complete,
        curvePrice: pumpfun.curvePrice(pair.curve), ammPrice: pumpswap.ammPrice(pair.reserves),
        curveRealSol: lamportsToSol(pair.curve.realSolReserves), ammQuoteSol: lamportsToSol(pair.reserves.quote),
        sizeSol: trade ? lamportsToSol(trade.cost) : null, netSol: net !== null ? lamportsToSol(net) : null,
      });
    }

    // Opportunity episodes: open while net ≥ ARB_MIN_PROFIT, close when it drops
    const profitable = net !== null && net >= config.minProfitLamports;
    const ep = this.open.get(pair.mintStr);
    if (profitable) {
      if (!ep) {
        this.open.set(pair.mintStr, {
          mint: pair.mintStr, dir: direction, start: now, end: now, evaluations: 1,
          maxSpreadBps: bps, maxNetLamports: net, sizeAtMaxLamports: trade.cost,
        });
        log.ok(`${c.bgGreen(' OPPORTUNITY ')} ${c.bold(shortKey(pair.mintStr))} spread ${fmtBps(spreadBps)} net ${c.green(`+${fmtSol(net)}`)} SOL`);
      } else {
        ep.end = now;
        ep.evaluations++;
        ep.maxSpreadBps = Math.max(ep.maxSpreadBps, bps);
        if (net > ep.maxNetLamports) {
          ep.maxNetLamports = net;
          ep.sizeAtMaxLamports = trade.cost;
        }
      }
    } else if (ep) {
      this.#closeEpisode(ep, now);
    }
  }

  #closeEpisode(ep, now = Date.now()) {
    this.open.delete(ep.mint);
    ep.end = now;
    const rec = {
      mint: ep.mint, dir: ep.dir, start: new Date(ep.start).toISOString(), end: new Date(ep.end).toISOString(),
      durationMs: ep.end - ep.start, evaluations: ep.evaluations, maxSpreadBps: ep.maxSpreadBps,
      maxNetSol: lamportsToSol(ep.maxNetLamports), sizeAtMaxSol: lamportsToSol(ep.sizeAtMaxLamports),
    };
    this.episodes.push(rec);
    const m = this.mints.get(ep.mint);
    if (m) m.episodes++;
    this.#write('opportunities.jsonl', rec);
  }

  summary() {
    const s = this.scanner.stats;
    const elapsedMs = Date.now() - this.startedAt;
    const hours = elapsedMs / 3600e3;
    const eps = [...this.episodes, ...[...this.open.values()].map((e) => ({ maxNetSol: lamportsToSol(e.maxNetLamports), open: true }))];
    const totalNet = eps.reduce((a, e) => a + e.maxNetSol, 0);
    const tokens = [...this.mints.values()];
    const top = tokens
      .filter((t) => t.tradableSamples > 0)
      .sort((a, b) => b.maxTradableSpreadBps - a.maxTradableSpreadBps)
      .slice(0, 20)
      .map((t) => ({
        mint: t.mint, pool: t.pool, maxTradableSpreadBps: t.maxTradableSpreadBps,
        maxNetSol: lamportsToSol(t.maxNetLamports), episodes: t.episodes, samples: t.tradableSamples,
      }));
    return {
      startedAt: new Date(this.startedAt).toISOString(),
      updatedAt: new Date().toISOString(),
      elapsed: fmtDuration(elapsedMs),
      elapsedHours: Number(hours.toFixed(3)),
      settings: {
        rpc: maskUrl(config.rpcUrl), minSpreadBps: Number(config.minSpreadBps),
        maxSol: lamportsToSol(config.maxSolLamports), minProfitSol: lamportsToSol(config.minProfitLamports),
        tipSol: lamportsToSol(config.jitoTipLamports), includeGraduated: this.scanner.includeGraduated,
      },
      events: { curve: s.curveEvents, amm: s.ammEvents, curvePerSec: +(s.curveEvents / (elapsedMs / 1000)).toFixed(1), ammPerSec: +(s.ammEvents / (elapsedMs / 1000)).toFixed(1) },
      skipped: { graduated: s.graduatedSeen, cashback: s.cashbackSkipped },
      pairs: {
        discovered: tokens.length,
        tradable: tokens.filter((t) => t.tradableSamples > 0).length,
        trackedNow: this.scanner.pairs.size,
      },
      spreads: { samplesAboveMin: s.spreadsSeen, tradableHistogramBps: this.buckets },
      opportunities: {
        episodes: eps.length,
        perHour: hours > 0 ? +(eps.length / hours).toFixed(2) : 0,
        sumMaxNetSol: +totalNet.toFixed(6),
        sumMaxNetSolPerHour: hours > 0 ? +(totalNet / hours).toFixed(6) : 0,
        note: 'Upper bound: assumes every episode is captured at its best moment with zero competition.',
      },
      topPairs: top,
    };
  }

  snapshot() {
    const sum = this.summary();
    writeFileSync(join(this.dir, 'summary.json'), `${JSON.stringify(sum, null, 2)}\n`);
    this.#write('stats.jsonl', {
      t: sum.updatedAt, curveEvents: sum.events.curve, ammEvents: sum.events.amm,
      pairs: sum.pairs.discovered, tracked: sum.pairs.trackedNow, spreads: sum.spreads.samplesAboveMin,
      episodes: sum.opportunities.episodes, graduatedSkipped: sum.skipped.graduated, cashbackSkipped: sum.skipped.cashback,
    });
    return sum;
  }

  close() {
    clearInterval(this.snapshotTimer);
    for (const ep of [...this.open.values()]) this.#closeEpisode(ep);
    return this.snapshot();
  }
}

// ── Report (works on a finished or a running directory) ─────────────
function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

export function printSummary(sum, dir) {
  const o = sum.opportunities;
  log.raw(`\n${c.bold(c.cyan('  Recording summary'))}  ${c.gray(dir)}`);
  log.raw(`  Duration           ${sum.elapsed}  (started ${sum.startedAt})`);
  log.raw(`  Events             curve ${sum.events.curve} (${sum.events.curvePerSec}/s)  ·  AMM ${sum.events.amm} (${sum.events.ammPerSec}/s)`);
  log.raw(`  Skipped            graduated ${sum.skipped.graduated}  ·  cashback ${sum.skipped.cashback}`);
  log.raw(`  Dual-venue pairs   ${sum.pairs.discovered} discovered  ·  ${sum.pairs.tradable} tradable`);
  log.raw(`  Spread samples     ${sum.spreads.samplesAboveMin} ≥ ${sum.settings.minSpreadBps} bps`);
  const hist = Object.entries(sum.spreads.tradableHistogramBps).filter(([, n]) => n > 0).map(([k, n]) => `${k}: ${n}`).join('  ');
  log.raw(`  Tradable spreads   ${hist || c.dim('none')}`);
  const oppColor = o.episodes > 0 ? c.green : c.yellow;
  log.raw(`  Opportunities      ${oppColor(String(o.episodes))} episodes  (${o.perHour}/h)`);
  log.raw(`  Theoretical PnL    ${o.sumMaxNetSol} SOL  (${o.sumMaxNetSolPerHour} SOL/h)  ${c.dim('upper bound, no competition')}`);
  if (sum.topPairs.length) {
    log.raw(`\n  ${c.bold('Top pairs by tradable spread')}`);
    for (const t of sum.topPairs.slice(0, 10)) {
      log.raw(`  ${t.mint.padEnd(44)}  ${fmtBps(BigInt(t.maxTradableSpreadBps)).padStart(8)}  net ${t.maxNetSol.toFixed(6)} SOL  episodes ${t.episodes}`);
    }
  }
  log.raw('');
}

function report(dir) {
  const sumFile = join(dir, 'summary.json');
  if (!existsSync(sumFile)) throw new Error(`no summary.json in ${dir}`);
  const sum = JSON.parse(readFileSync(sumFile, 'utf8'));
  printSummary(sum, dir);
  const eps = readJsonl(join(dir, 'opportunities.jsonl'));
  if (eps.length) {
    log.raw(`  ${c.bold('Longest episodes')}`);
    for (const e of [...eps].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10)) {
      log.raw(`  ${e.start.slice(0, 19)}  ${shortKey(e.mint)}  ${e.dir}  ${(e.durationMs / 1000).toFixed(1)}s  max ${e.maxSpreadBps} bps  net ${e.maxNetSol.toFixed(6)} SOL @ ${e.sizeAtMaxSol.toFixed(4)} SOL`);
    }
    log.raw('');
  }
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  const reportDir = argValue('--report');
  if (reportDir) return report(reportDir);

  const durationMs = parseDuration(argValue('--duration'));
  const outRoot = argValue('--out') ?? 'logs';
  const dir = join(outRoot, `scan-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}`);
  const includeGraduated = process.argv.includes('--include-graduated');

  log.raw(c.bold(c.cyan('\n  curvegap recorder')) + c.gray('  —  long-run market statistics\n'));
  log.info(`RPC ${c.gray(maskUrl(config.rpcUrl))}`);
  log.info(`Writing to ${c.bold(dir)}  ·  duration ${durationMs ? fmtDuration(durationMs) : 'until Ctrl+C'}`);

  const scanner = new Scanner({ includeGraduated });
  await scanner.init();
  const rec = new Recorder(scanner, dir);
  rec.attach();
  scanner.on('pair', (p) => log.ok(`Dual-venue token ${c.bold(p.mintStr)} pool ${shortKey(p.pool.address)}`));
  scanner.start();

  const status = setInterval(() => {
    const sum = rec.summary();
    log.info(c.gray(`${sum.elapsed}  ·  events ${sum.events.curve + sum.events.amm}  ·  pairs ${sum.pairs.discovered} (${sum.pairs.tradable} tradable)  ·  ` +
      `spreads ${sum.spreads.samplesAboveMin}  ·  opportunities ${sum.opportunities.episodes}`));
  }, SNAPSHOT_INTERVAL_MS);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(status);
    scanner.stop();
    printSummary(rec.close(), dir);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (durationMs) setTimeout(stop, durationMs);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    log.error(e.stack ?? e.message);
    process.exit(1);
  });
}
