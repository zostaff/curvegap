import { PublicKey, SystemProgram } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { config } from '../lib/config.mjs';
import * as K from '../lib/constants.mjs';
import { BPS, MAX_TX_SIZE, TOKEN_PROGRAM, WSOL_MINT } from '../lib/constants.mjs';
import { tipInstruction, sendBundle } from '../lib/jito.mjs';
import { c, fmtBps, fmtSol, fmtTokens, log, shortKey } from '../lib/log.mjs';
import * as pumpfun from '../lib/pumpfun.mjs';
import * as pumpswap from '../lib/pumpswap.mjs';
import { getMultipleAccounts, readTokenAmount, simulateTx, waitForSignature } from '../lib/rpc.mjs';
import { buildVersionedTx, computeBudgetIxs, loadLookupTable, txSize } from '../lib/tx.mjs';
import { PUMP_FEE_CONFIG, PUMPSWAP_FEE_CONFIG } from '../lib/fees.mjs';
import { computeSpread, findBestTrade, pairFees } from './scanner.mjs';

/**
 * Every static (token-independent) account used by the arb transaction.
 * Put into an Address Lookup Table by bot/setup-alt.mjs to fit the 1232-byte limit.
 */
export function staticLookupAddresses(user) {
  const addresses = [
    K.SYSTEM_PROGRAM, K.TOKEN_PROGRAM, K.TOKEN_2022_PROGRAM, K.ASSOCIATED_TOKEN_PROGRAM, K.COMPUTE_BUDGET_PROGRAM, K.WSOL_MINT,
    K.PUMP_PROGRAM, K.PUMP_GLOBAL, K.PUMP_EVENT_AUTHORITY, PUMP_FEE_CONFIG, pumpfun.userVolumeAccumulatorPda(user),
    K.PUMPSWAP_PROGRAM, pumpswap.globalConfigPda(), pumpswap.eventAuthorityPda(), PUMPSWAP_FEE_CONFIG,
    pumpswap.userVolumeAccumulatorPda(user),
    getAssociatedTokenAddressSync(K.WSOL_MINT, user, false, K.TOKEN_PROGRAM),
    ...K.BUYBACK_FEE_RECIPIENTS,
    ...K.BUYBACK_FEE_RECIPIENTS.map((r) => getAssociatedTokenAddressSync(K.WSOL_MINT, r, true, K.TOKEN_PROGRAM)),
    ...K.JITO_TIP_ACCOUNTS,
  ];
  return [...new Map(addresses.map((a) => [a.toBase58(), a])).values()];
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const mulBps = (v, bps) => (v * bps) / BPS;
const maxBig = (a, b) => (a > b ? a : b);

/**
 * Builds the atomic two-leg arbitrage transaction and ships it as a Jito bundle:
 *
 *   [ComputeBudget] + [setup] + [buy leg] + [sell leg] + [cleanup] + [Jito tip]
 *
 * Both legs live in ONE v0 transaction, so they either both execute or neither does.
 * The sell leg's min-out is raised to (cost + tip + fees + ARB_MIN_PROFIT), turning
 * slippage protection into an on-chain profit guard.
 */
export class Executor {
  constructor({ connection, wallet, fees, blockhash, dryRun = config.dryRun, simulate = config.simulate }) {
    this.connection = connection;
    this.wallet = wallet;
    this.fees = fees;
    this.blockhash = blockhash;
    this.dryRun = dryRun;
    this.simulate = simulate;
    this.lookupTables = [];
    this.cooldown = new Map(); // mint → until
    this.busy = false;
    this.stats = {
      attempts: 0, stale: 0, built: 0, tooLarge: 0, simOk: 0, simFail: 0,
      sent: 0, sendErrors: 0, landed: 0, failedOnChain: 0, notLanded: 0,
      expectedProfit: 0n, realizedPnl: 0n,
    };
  }

  async init() {
    if (config.lookupTable) {
      const alt = await loadLookupTable(this.connection, new PublicKey(config.lookupTable));
      this.lookupTables = [alt];
      log.info(`Lookup table ${shortKey(config.lookupTable)} loaded (${alt.state.addresses.length} addresses)`);
    }
  }

  canTrade(mint) {
    return !this.busy && (this.cooldown.get(mint) ?? 0) <= Date.now();
  }

  /** Execute (or dry-run) an opportunity emitted by the scanner. */
  async execute({ pair }) {
    if (!this.canTrade(pair.mintStr)) return null;
    this.busy = true;
    this.cooldown.set(pair.mintStr, Date.now() + config.cooldownMs);
    this.stats.attempts++;
    try {
      return await this.#run(pair);
    } catch (e) {
      log.error(`executor ${shortKey(pair.mintStr)}: ${e.message}`);
      return null;
    } finally {
      this.busy = false;
    }
  }

  async #run(pair) {
    const user = this.wallet?.publicKey;
    const tokenProgram = pair.tokenProgram ?? TOKEN_PROGRAM;
    const tokenAta = user && getAssociatedTokenAddressSync(pair.mint, user, false, tokenProgram);
    const wsolAta = user && getAssociatedTokenAddressSync(WSOL_MINT, user, false, TOKEN_PROGRAM);

    // ── 1) fresh state right before building ──────────────────────
    const keys = [pair.curveAddress, pair.pool.address, pair.pool.poolBaseTokenAccount, pair.pool.poolQuoteTokenAccount];
    if (user) keys.push(tokenAta);
    const infos = await getMultipleAccounts(this.connection, keys, 'processed');
    const curve = pumpfun.decodeBondingCurve(infos[0]?.data);
    const pool = infos[1] && pumpswap.decodePool(pair.pool.address, infos[1].data);
    const baseVault = readTokenAmount(infos[2]?.data);
    const quoteVault = readTokenAmount(infos[3]?.data);
    const tokenAtaExisted = Boolean(user && infos[4]);
    if (!curve || curve.complete || !pool || baseVault === null || quoteVault === null) {
      this.stats.stale++;
      return null;
    }
    const reserves = pumpswap.effectiveReserves(pool, baseVault, quoteVault);

    const spread = computeSpread(curve, reserves);
    if (!spread || spread.spreadBps < config.minSpreadBps) {
      this.stats.stale++;
      log.debug(`${shortKey(pair.mintStr)} spread closed before execution`);
      return null;
    }
    const fees = pairFees(this.fees, { ...pair, pool }, curve, reserves);
    const trade = findBestTrade(spread.direction, curve, reserves, fees);
    if (!trade || trade.net < config.minProfitLamports) {
      this.stats.stale++;
      return null;
    }

    const banner = `${c.bold(shortKey(pair.mintStr))} ${spread.direction === 'CURVE_TO_AMM' ? 'CURVE→AMM' : 'AMM→CURVE'} ` +
      `spread ${c.yellow(fmtBps(spread.spreadBps))}  size ${fmtSol(trade.cost, 4)} SOL / ${fmtTokens(trade.tokens)} tok  ` +
      `expected net ${c.green('+' + fmtSol(trade.net))} SOL`;

    if (this.dryRun && !this.simulate) {
      log.raw(`${c.bgYellow(' DRY ')} ${banner}`);
      return { dryRun: true, trade, spread };
    }
    if (!user) throw new Error('wallet required for simulation/live trading');

    // ── 2) instructions ───────────────────────────────────────────
    const buyback = pick(K.BUYBACK_FEE_RECIPIENTS);
    const pumpCtx = { mint: pair.mint, tokenProgram, buybackFeeRecipient: buyback };
    const ammCtx = { pool, baseTokenProgram: tokenProgram, buybackFeeRecipient: buyback };

    const slip = config.maxSlippageBps;
    const maxIn = mulBps(trade.cost, BPS + slip);
    const profitGuard = trade.cost + trade.fixed + config.minProfitLamports;
    const minOut = maxBig(mulBps(trade.proceeds, BPS - slip), profitGuard);

    const ixs = [...computeBudgetIxs(config.computeUnits, config.priorityMicroLamports)];
    // Both legs need the token ATA and the WSOL ATA to exist before the trade.
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(user, tokenAta, user, pair.mint, tokenProgram),
      createAssociatedTokenAccountIdempotentInstruction(user, wsolAta, user, WSOL_MINT, TOKEN_PROGRAM),
    );

    if (spread.direction === 'CURVE_TO_AMM') {
      // curve buy pays native SOL; AMM sell pays out WSOL
      ixs.push(
        pumpfun.buyIx(pumpCtx, user, trade.tokens, maxIn),
        pumpswap.sellIx(ammCtx, user, trade.tokens, minOut),
      );
    } else {
      // wrap SOL for the AMM buy; curve sell pays out native SOL
      ixs.push(
        SystemProgram.transfer({ fromPubkey: user, toPubkey: wsolAta, lamports: maxIn }),
        createSyncNativeInstruction(wsolAta, TOKEN_PROGRAM),
        pumpswap.buyIx(ammCtx, user, trade.tokens, maxIn),
        pumpfun.sellIx(pumpCtx, user, trade.tokens, minOut),
      );
    }
    // unwrap WSOL (and refund unused max-in), reclaim token ATA rent if we created it
    ixs.push(createCloseAccountInstruction(wsolAta, user, user, [], TOKEN_PROGRAM));
    if (!tokenAtaExisted) ixs.push(createCloseAccountInstruction(tokenAta, user, user, [], tokenProgram));
    ixs.push(tipInstruction(user, config.jitoTipLamports));

    // ── 3) transaction ────────────────────────────────────────────
    const { blockhash } = await this.blockhash.get();
    let tx = null;
    try {
      tx = buildVersionedTx({
        payer: user,
        instructions: ixs,
        blockhash,
        signers: [this.wallet],
        lookupTables: this.lookupTables,
      });
    } catch { /* message overflow → treated as too large below */ }
    const size = tx ? txSize(tx) : Infinity;
    if (size > MAX_TX_SIZE) {
      this.stats.tooLarge++;
      log.warn(`tx too large (${size === Infinity ? '>1232' : size} bytes). Create a lookup table: ${c.bold('npm run alt:create')}`);
      return null;
    }
    this.stats.built++;

    if (this.simulate) {
      const sim = await simulateTx(this.connection, tx);
      if (sim.err) {
        this.stats.simFail++;
        log.warn(`${c.bgRed(' SIM FAIL ')} ${banner}\n    ${c.red(JSON.stringify(sim.err))}`);
        for (const l of (sim.logs ?? []).filter((x) => /error|failed|exceeded/i.test(x)).slice(-5)) log.raw(c.gray(`    ${l}`));
        return null;
      }
      this.stats.simOk++;
      log.raw(`${c.bgGreen(' SIM OK ')} ${banner}  ${c.gray(`${sim.unitsConsumed} CU, ${size} B`)}`);
      if (this.dryRun) return { simulated: true, trade, spread };
    }

    // ── 4) send bundle ────────────────────────────────────────────
    const signature = bs58.encode(tx.signatures[0]);
    try {
      const bundleId = await sendBundle([tx]);
      this.stats.sent++;
      this.stats.expectedProfit += trade.net;
      log.raw(`${c.bgGreen(' SENT ')} ${banner}\n    bundle ${c.gray(bundleId)}  tx ${c.gray(signature)}`);
      this.#track(signature, trade).catch(() => {});
      return { bundleId, signature, trade, spread };
    } catch (e) {
      this.stats.sendErrors++;
      log.warn(`${c.bgRed(' JITO ')} ${e.message}`);
      return null;
    }
  }

  /** Follow the bundle's transaction and record realized PnL from balance deltas. */
  async #track(signature, trade) {
    const res = await waitForSignature(this.connection, signature, 30_000);
    if (!res.landed) {
      this.stats.notLanded++;
      log.info(c.gray(`bundle not landed: ${signature.slice(0, 16)}…`));
      return;
    }
    if (!res.ok) {
      this.stats.failedOnChain++;
      log.warn(`landed but failed: ${signature} ${JSON.stringify(res.err)}`);
      return;
    }
    this.stats.landed++;
    let txInfo = null;
    try {
      txInfo = await this.connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    } catch (e) {
      log.debug(`getTransaction ${signature}: ${e.message}`);
    }
    if (txInfo?.meta) {
      const delta = BigInt(txInfo.meta.postBalances[0]) - BigInt(txInfo.meta.preBalances[0]);
      this.stats.realizedPnl += delta;
      const col = delta >= 0n ? c.green : c.red;
      log.ok(`${c.bgGreen(' LANDED ')} ${signature.slice(0, 16)}…  realized ${col(fmtSol(delta))} SOL (expected ${fmtSol(trade.net)})`);
    }
  }
}
