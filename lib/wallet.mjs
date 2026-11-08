import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

/**
 * Load a keypair from:
 *  - a base58 encoded 64-byte secret key
 *  - a JSON array of 64 numbers ("[12,34,...]")
 *  - a path to a Solana CLI keypair file
 */
export function loadKeypair(input) {
  if (!input) throw new Error('WALLET_PRIVATE_KEY is not set');
  const value = input.trim();

  if (value.startsWith('[')) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(value)));
  }

  if (value.endsWith('.json') || value.includes(path.sep)) {
    const file = path.resolve(value);
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }

  const bytes = bs58.decode(value);
  if (bytes.length !== 64) throw new Error(`Invalid secret key length: ${bytes.length} (expected 64)`);
  return Keypair.fromSecretKey(bytes);
}

/** Try to load the wallet; return null instead of throwing (used in dry-run). */
export function tryLoadKeypair(input) {
  try {
    return loadKeypair(input);
  } catch {
    return null;
  }
}

export function generateKeypair() {
  const kp = Keypair.generate();
  return { keypair: kp, publicKey: kp.publicKey.toBase58(), secretBase58: bs58.encode(kp.secretKey) };
}

// CLI: node lib/wallet.mjs --generate
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href && process.argv.includes('--generate')) {
  const { publicKey, secretBase58 } = generateKeypair();
  console.log(`Public key : ${publicKey}`);
  console.log(`Secret key : ${secretBase58}`);
  console.log('\nPut the secret key into WALLET_PRIVATE_KEY in your .env. Never share it.');
}
