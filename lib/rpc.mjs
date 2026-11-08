import { Connection } from '@solana/web3.js';
import { config } from './config.mjs';

let _conn;

/** Shared Connection instance (confirmed commitment, WS disabled — we run our own). */
export function getConnection() {
  if (!_conn) {
    _conn = new Connection(config.rpcUrl, {
      commitment: 'confirmed',
      disableRetryOnRateLimit: false,
      wsEndpoint: config.rpcWss,
    });
  }
  return _conn;
}

/** getMultipleAccountsInfo with automatic chunking (100 keys per request). */
export async function getMultipleAccounts(connection, keys, commitment = 'processed') {
  const out = [];
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const res = await connection.getMultipleAccountsInfo(chunk, { commitment });
    out.push(...res);
  }
  return out;
}

/** Read the `amount` field of an SPL / Token-2022 token account (offset 64). */
export function readTokenAmount(data) {
  if (!data || data.length < 72) return null;
  return data.readBigUInt64LE(64);
}

/**
 * Keeps a fresh blockhash in the background so the hot path never waits on RPC.
 */
export class BlockhashCache {
  constructor(connection, intervalMs = 2_000) {
    this.connection = connection;
    this.intervalMs = intervalMs;
    this.value = null;
    this.timer = null;
  }

  async start() {
    await this.refresh();
    this.timer = setInterval(() => this.refresh().catch(() => {}), this.intervalMs);
    this.timer.unref?.();
  }

  async refresh() {
    this.value = await this.connection.getLatestBlockhash('confirmed');
    this.updatedAt = Date.now();
  }

  async get() {
    if (!this.value || Date.now() - this.updatedAt > 20_000) await this.refresh();
    return this.value;
  }

  stop() {
    clearInterval(this.timer);
  }
}

/** Send a signed transaction through the regular RPC (fallback path). */
export async function sendTx(connection, tx, { skipPreflight = true, maxRetries = 2 } = {}) {
  const raw = tx.serialize();
  return connection.sendRawTransaction(raw, { skipPreflight, maxRetries, preflightCommitment: 'processed' });
}

/** Simulate a VersionedTransaction and return { err, logs, unitsConsumed }. */
export async function simulateTx(connection, tx) {
  const res = await connection.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: 'processed',
  });
  return res.value;
}

/** Poll signature status until confirmed/failed or timeout. */
export async function waitForSignature(connection, signature, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: false });
    const st = value[0];
    if (st) {
      if (st.err) return { landed: true, ok: false, err: st.err, slot: st.slot };
      if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') {
        return { landed: true, ok: true, slot: st.slot };
      }
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return { landed: false, ok: false };
}

/** Simple token bucket for rate-limiting heavy RPC calls (e.g. getProgramAccounts). */
export class RateLimiter {
  constructor(perSecond) {
    this.interval = 1000 / Math.max(perSecond, 0.01);
    this.next = 0;
  }

  async wait() {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.interval;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
}
