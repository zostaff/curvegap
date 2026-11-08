import bs58 from 'bs58';
import { SystemProgram } from '@solana/web3.js';
import { JITO_TIP_ACCOUNTS } from './constants.mjs';
import { config } from './config.mjs';

export function randomTipAccount() {
  return JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
}

/** SystemProgram transfer to a random Jito tip account. */
export function tipInstruction(payer, lamports) {
  return SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: randomTipAccount(),
    lamports: BigInt(lamports),
  });
}

async function jitoRpc(path, method, params, timeoutMs = 10_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.jitoUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Jito ${method}: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    if (body.error) throw new Error(`Jito ${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
    if (!res.ok) throw new Error(`Jito ${method}: HTTP ${res.status}`);
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send a bundle of signed VersionedTransactions. Returns the bundle id.
 * Transactions are base58-encoded as per the Jito block engine API.
 */
export async function sendBundle(transactions) {
  const encoded = transactions.map((tx) => bs58.encode(tx.serialize()));
  return jitoRpc('/api/v1/bundles', 'sendBundle', [encoded]);
}

/** Query landed status for bundle ids. */
export async function getBundleStatuses(bundleIds) {
  return jitoRpc('/api/v1/bundles', 'getBundleStatuses', [bundleIds]);
}

/** Query in-flight status (Pending / Failed / Landed / Invalid) for recent bundles. */
export async function getInflightBundleStatuses(bundleIds) {
  return jitoRpc('/api/v1/getInflightBundleStatuses', 'getInflightBundleStatuses', [bundleIds]);
}
