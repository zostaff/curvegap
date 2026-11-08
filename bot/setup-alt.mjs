#!/usr/bin/env node
// Creates an Address Lookup Table with every static account the arb transaction uses.
// Without it the two-leg transaction usually exceeds the 1232-byte packet limit.
//
//   node bot/setup-alt.mjs            create a new table and print ARB_LOOKUP_TABLE=...
//   node bot/setup-alt.mjs <address>  extend an existing table with missing addresses
import { PublicKey } from '@solana/web3.js';
import { config } from '../lib/config.mjs';
import { c, log } from '../lib/log.mjs';
import { getConnection, waitForSignature } from '../lib/rpc.mjs';
import { buildVersionedTx, createLookupTableIx, extendLookupTableIx } from '../lib/tx.mjs';
import { loadKeypair } from '../lib/wallet.mjs';
import { staticLookupAddresses } from './executor.mjs';

async function send(connection, wallet, ixs) {
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const tx = buildVersionedTx({ payer: wallet.publicKey, instructions: ixs, blockhash, signers: [wallet] });
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const res = await waitForSignature(connection, sig, 60_000);
  if (!res.ok) throw new Error(`tx ${sig} failed: ${JSON.stringify(res.err ?? 'not confirmed')}`);
  return sig;
}

async function main() {
  const connection = getConnection();
  const wallet = loadKeypair(config.walletKey);
  const user = wallet.publicKey;
  const unique = staticLookupAddresses(user);
  log.info(`${unique.length} static addresses`);

  let table;
  let existing = new Set();
  if (process.argv[2]) {
    table = new PublicKey(process.argv[2]);
    const alt = (await connection.getAddressLookupTable(table)).value;
    if (!alt) throw new Error('lookup table not found');
    existing = new Set(alt.state.addresses.map((a) => a.toBase58()));
    log.info(`Extending ${table.toBase58()} (${existing.size} addresses already present)`);
  } else {
    const slot = await connection.getSlot('finalized');
    const [ix, address] = createLookupTableIx(user, slot);
    table = address;
    const sig = await send(connection, wallet, [ix]);
    log.ok(`Created lookup table ${c.bold(table.toBase58())}  ${c.gray(sig)}`);
  }

  const missing = unique.filter((a) => !existing.has(a.toBase58()));
  for (let i = 0; i < missing.length; i += 20) {
    const chunk = missing.slice(i, i + 20);
    const sig = await send(connection, wallet, [extendLookupTableIx(user, table, chunk)]);
    log.ok(`Added ${chunk.length} addresses  ${c.gray(sig)}`);
  }

  log.raw(`\nAdd this to your .env:\n\n  ${c.bold(`ARB_LOOKUP_TABLE=${table.toBase58()}`)}\n`);
}

main().catch((e) => {
  log.error(e.stack ?? e.message);
  process.exit(1);
});
