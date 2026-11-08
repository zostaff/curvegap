#!/usr/bin/env node
// curvegap — atomic arbitrage between pump.fun bonding curves and PumpSwap AMM pools.
//
//   node bot/arbitrage.mjs              live trading (Jito bundles)
//   node bot/arbitrage.mjs --dry-run    scan + log opportunities, never trade
//   node bot/arbitrage.mjs --dry-run --simulate   also simulate the arb tx via RPC
//   node bot/arbitrage.mjs --simulate   simulate before every live send
//   add --verbose for debug logs
import { config, maskUrl } from '../lib/config.mjs';
import { c, fmtBps, fmtSol, log, shortKey } from '../lib/log.mjs';
import { BlockhashCache, getConnection } from '../lib/rpc.mjs';
import { tryLoadKeypair } from '../lib/wallet.mjs';
import { Executor } from './executor.mjs';
import { formatSpreadLine, Scanner } from './scanner.mjs';

const PRINT_THROTTLE_MS = 5_000;

function banner(wallet) {
  const mode = config.dryRun
    ? c.bgYellow(config.simulate ? ' DRY-RUN + SIMULATE ' : ' DRY-RUN ')
    : c.bgRed(' LIVE ');
  log.raw(`
${c.bold(c.cyan('  ┌─ curvegap ───────────────────────────────────────────┐'))}
${c.bold(c.cyan('  │'))}  pump.fun bonding curve  ${c.gray('⇄')}  PumpSwap AMM  ·  Jito    ${c.bold(c.cyan('│'))}
${c.bold(c.cyan('  └──────────────────────────────────────────────────────┘'))}
  mode        ${mode}
  rpc         ${c.gray(maskUrl(config.rpcUrl))}
  wallet      ${wallet ? wallet.publicKey.toBase58() : c.gray('none')}
  min spread  ${fmtBps(config.minSpreadBps)}   max size ${fmtSol(config.maxSolLamports, 3)} SOL   tip ${fmtSol(config.jitoTipLamports)} SOL
  slippage    ${fmtBps(config.maxSlippageBps)}   min liq ${fmtSol(config.minLiquidityLamports, 2)} SOL   min profit ${fmtSol(config.minProfitLamports)} SOL
  cooldown    ${config.cooldownMs / 1000}s   scan every ${config.scanIntervalMs} ms
`);
}

async function main() {
  const connection = getConnection();
  const wallet = tryLoadKeypair(config.walletKey);
  if (!wallet && (!config.dryRun || config.simulate)) {
    log.error('WALLET_PRIVATE_KEY is missing or invalid (required for live trading and --simulate).');
    process.exit(1);
  }
  banner(wallet);

  const startBalance = wallet ? BigInt(await connection.getBalance(wallet.publicKey, 'confirmed')) : null;
  if (wallet) {
    log.info(`Balance ${c.bold(fmtSol(startBalance, 4))} SOL`);
    const need = config.maxSolLamports + config.jitoTipLamports + 5_000_000n;
    if (!config.dryRun && startBalance < need) {
      log.warn(`Balance below max trade size + tip + rent (${fmtSol(need, 4)} SOL); large trades will fail.`);
    }
  }

  const blockhash = new BlockhashCache(connection);
  await blockhash.start();

  const scanner = new Scanner({ connection });
  await scanner.init();
  const executor = new Executor({ connection, wallet, fees: scanner.fees, blockhash });
  await executor.init();

  scanner.on('pair', (p) => log.ok(`Tracking ${c.bold(p.mintStr)}  pool ${shortKey(p.pool.address)}`));

  scanner.on('spread', (info) => {
    const p = info.pair;
    const now = Date.now();
    if (p.lastPrintedBps === info.spreadBps && now - p.lastPrintedAt < PRINT_THROTTLE_MS) return;
    p.lastPrintedBps = info.spreadBps;
    p.lastPrintedAt = now;
    log.raw(`${c.gray(new Date().toISOString().slice(11, 23))}  ${formatSpreadLine(info)}`);
  });

  scanner.on('opportunity', (info) => {
    if (!executor.canTrade(info.pair.mintStr)) return;
    executor.execute(info);
  });

  scanner.start();

  // periodic status line
  const t0 = Date.now();
  const status = setInterval(() => {
    const s = scanner.stats;
    const e = executor.stats;
    const sec = (Date.now() - t0) / 1000;
    log.info(c.gray(
      `curve ${(s.curveEvents / sec).toFixed(0)} ev/s · amm ${(s.ammEvents / sec).toFixed(0)} ev/s · ` +
      `pairs ${scanner.pairs.size} · spreads ${s.spreadsSeen} · opps ${s.opportunities} · ` +
      `sent ${e.sent} · landed ${e.landed} · best ${fmtBps(s.bestSpreadBps)}`,
    ));
  }, 30_000);

  // ── SIGINT: session stats ─────────────────────────────────────────
  let stopping = false;
  process.on('SIGINT', async () => {
    if (stopping) process.exit(1);
    stopping = true;
    clearInterval(status);
    scanner.stop();
    blockhash.stop();

    const s = scanner.stats;
    const e = executor.stats;
    const mins = ((Date.now() - t0) / 60_000).toFixed(1);
    let balanceLine = '';
    if (wallet) {
      try {
        const end = BigInt(await connection.getBalance(wallet.publicKey, 'confirmed'));
        const d = end - startBalance;
        balanceLine = `  balance Δ        ${(d >= 0n ? c.green : c.red)(fmtSol(d))} SOL  (${fmtSol(startBalance, 4)} → ${fmtSol(end, 4)})\n`;
      } catch { /* ignore */ }
    }
    const row = (k, v) => `  ${k.padEnd(17)}${v}\n`;
    log.raw(
      `\n${c.bold(c.cyan('  ── Session stats ─────────────────────────────'))}\n` +
      row('runtime', `${mins} min`) +
      row('curve events', s.curveEvents) +
      row('AMM events', s.ammEvents) +
      row('tracked pairs', `${scanner.pairs.size}  (graduated skipped ${s.graduatedSeen})`) +
      row('evaluations', s.evaluations) +
      row('spreads ≥ min', s.spreadsSeen) +
      row('best spread', `${fmtBps(s.bestSpreadBps)}${s.bestSpreadMint ? `  ${s.bestSpreadMint}` : ''}`) +
      row('opportunities', s.opportunities) +
      row('attempts', `${e.attempts}  (stale ${e.stale}, too large ${e.tooLarge})`) +
      row('simulations', `${c.green(e.simOk)} ok / ${c.red(e.simFail)} failed`) +
      row('bundles sent', `${e.sent}  (errors ${e.sendErrors})`) +
      row('landed', `${c.green(e.landed)}  failed on-chain ${e.failedOnChain}  not landed ${e.notLanded}`) +
      row('expected profit', `${fmtSol(e.expectedProfit)} SOL`) +
      row('realized PnL', `${(e.realizedPnl >= 0n ? c.green : c.red)(fmtSol(e.realizedPnl))} SOL`) +
      balanceLine,
    );
    process.exit(0);
  });
}

main().catch((e) => {
  log.error(e.stack ?? e.message);
  process.exit(1);
});
