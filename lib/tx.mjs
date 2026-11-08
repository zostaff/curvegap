import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { MAX_TX_SIZE } from './constants.mjs';

/** ComputeBudget instructions: unit limit (+ optional unit price). */
export function computeBudgetIxs(units, microLamports = 0n) {
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units })];
  if (BigInt(microLamports) > 0n) {
    ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: BigInt(microLamports) }));
  }
  return ixs;
}

/** Build and sign a v0 VersionedTransaction. */
export function buildVersionedTx({ payer, instructions, blockhash, signers, lookupTables = [] }) {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTables);
  const tx = new VersionedTransaction(message);
  tx.sign(signers);
  return tx;
}

/** Serialized size of a VersionedTransaction, or Infinity if it cannot be serialized. */
export function txSize(tx) {
  try {
    return tx.serialize().length;
  } catch {
    return Infinity;
  }
}

export function fitsInPacket(tx) {
  return txSize(tx) <= MAX_TX_SIZE;
}

/** Load an address lookup table account (cached by caller). */
export async function loadLookupTable(connection, address) {
  const res = await connection.getAddressLookupTable(address);
  if (!res.value) throw new Error(`Lookup table ${address.toString()} not found`);
  return res.value;
}

/** Instructions to create a new lookup table owned by `authority`. */
export function createLookupTableIx(authority, recentSlot) {
  return AddressLookupTableProgram.createLookupTable({
    authority,
    payer: authority,
    recentSlot,
  });
}

/** Instructions to extend a lookup table with addresses (max ~25 per tx). */
export function extendLookupTableIx(authority, lookupTable, addresses) {
  return AddressLookupTableProgram.extendLookupTable({
    authority,
    payer: authority,
    lookupTable,
    addresses,
  });
}
