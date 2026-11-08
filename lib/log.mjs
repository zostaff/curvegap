// Tiny ANSI color + formatting helpers (no dependencies).
const enabled = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (open, close) => (s) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
  bgGreen: wrap('42;30', '49;39'),
  bgRed: wrap('41;97', '49;39'),
  bgYellow: wrap('43;30', '49;39'),
};

const ts = () => new Date().toISOString().slice(11, 23);

export const log = {
  info: (...a) => console.log(c.gray(ts()), c.cyan('INFO'), ...a),
  ok: (...a) => console.log(c.gray(ts()), c.green(' OK '), ...a),
  warn: (...a) => console.log(c.gray(ts()), c.yellow('WARN'), ...a),
  error: (...a) => console.error(c.gray(ts()), c.red('ERR '), ...a),
  debug: (...a) => process.argv.includes('--verbose') && console.log(c.gray(ts()), c.magenta('DBG '), ...a),
  raw: (...a) => console.log(...a),
};

/** Format lamports (BigInt) as SOL string with fixed decimals. */
export function fmtSol(lamports, decimals = 6) {
  const neg = lamports < 0n;
  const abs = neg ? -lamports : lamports;
  const whole = abs / 1_000_000_000n;
  const frac = (abs % 1_000_000_000n).toString().padStart(9, '0').slice(0, decimals);
  return `${neg ? '-' : ''}${whole}${decimals ? '.' + frac : ''}`;
}

/** Format basis points (BigInt or number) as a percent string. */
export function fmtBps(bps, decimals = 2) {
  return `${(Number(bps) / 100).toFixed(decimals)}%`;
}

/** Format a raw token amount (6 decimals) compactly. */
export function fmtTokens(raw) {
  const n = Number(raw) / 1e6;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(2);
}

/** Format a SOL-per-token price (given as lamports per raw token, float). */
export function fmtPrice(p) {
  if (!Number.isFinite(p) || p <= 0) return '—';
  // lamports/raw-token == SOL/token (both scale 1e9 / 1e6 → factor 1e-3)
  const solPerToken = p * 1e-3;
  return solPerToken.toExponential(4);
}

export const shortKey = (k) => {
  const s = typeof k === 'string' ? k : k.toBase58();
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
};
