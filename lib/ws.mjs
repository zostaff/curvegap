import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { log } from './log.mjs';

/**
 * JSON-RPC WebSocket client with automatic reconnect, keep-alive pings and
 * re-subscription of all `logsSubscribe` subscriptions after reconnect.
 *
 * Events:
 *   'logs'  (programId: string, value: { signature, err, logs }, slot)
 *   'open' / 'close' / 'error'
 */
export class LogsStream extends EventEmitter {
  constructor(url, { commitment = 'processed', pingMs = 20_000, maxBackoffMs = 30_000 } = {}) {
    super();
    this.url = url;
    this.commitment = commitment;
    this.pingMs = pingMs;
    this.maxBackoffMs = maxBackoffMs;
    this.programs = new Set();
    this.subByReq = new Map();   // request id → programId
    this.programBySub = new Map(); // subscription id → programId
    this.reqId = 1;
    this.backoff = 1_000;
    this.closed = false;
    this.reconnects = 0;
    this.messages = 0;
  }

  subscribeProgram(programId) {
    const id = programId.toString();
    this.programs.add(id);
    if (this.ws?.readyState === WebSocket.OPEN) this.#sendSubscribe(id);
  }

  connect() {
    this.closed = false;
    const ws = new WebSocket(this.url, { perMessageDeflate: false, handshakeTimeout: 15_000 });
    this.ws = ws;

    ws.on('open', () => {
      this.backoff = 1_000;
      this.programBySub.clear();
      this.subByReq.clear();
      for (const p of this.programs) this.#sendSubscribe(p);
      this.#startPing();
      this.emit('open');
    });

    ws.on('message', (buf) => {
      this.messages++;
      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch {
        return;
      }
      if (msg.id !== undefined && this.subByReq.has(msg.id)) {
        const program = this.subByReq.get(msg.id);
        this.subByReq.delete(msg.id);
        if (msg.error) {
          this.emit('error', new Error(`logsSubscribe failed for ${program}: ${msg.error.message}`));
        } else {
          this.programBySub.set(msg.result, program);
        }
        return;
      }
      if (msg.method === 'logsNotification') {
        const { subscription, result } = msg.params;
        const program = this.programBySub.get(subscription);
        if (program) this.emit('logs', program, result.value, result.context?.slot);
      }
    });

    ws.on('pong', () => {
      this.lastPong = Date.now();
    });

    ws.on('error', (err) => this.emit('error', err));

    ws.on('close', (code) => {
      this.#stopPing();
      this.emit('close', code);
      if (this.closed) return;
      this.reconnects++;
      const delay = this.backoff;
      this.backoff = Math.min(this.backoff * 2, this.maxBackoffMs);
      log.warn(`WebSocket closed (${code}), reconnecting in ${delay} ms`);
      setTimeout(() => this.connect(), delay);
    });
  }

  close() {
    this.closed = true;
    this.#stopPing();
    this.ws?.close();
  }

  #sendSubscribe(programId) {
    const id = this.reqId++;
    this.subByReq.set(id, programId);
    this.ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'logsSubscribe',
      params: [{ mentions: [programId] }, { commitment: this.commitment }],
    }));
  }

  #startPing() {
    this.#stopPing();
    this.lastPong = Date.now();
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastPong > this.pingMs * 3) {
        log.warn('WebSocket ping timeout, forcing reconnect');
        this.ws.terminate();
        return;
      }
      try {
        this.ws.ping();
      } catch { /* ignore */ }
    }, this.pingMs);
  }

  #stopPing() {
    clearInterval(this.pingTimer);
  }
}

/** Extract base64 payloads from "Program data: ..." log lines. */
export function extractProgramData(logs) {
  const out = [];
  for (const line of logs ?? []) {
    if (line.startsWith('Program data: ')) {
      try {
        out.push(Buffer.from(line.slice(14), 'base64'));
      } catch { /* ignore */ }
    }
  }
  return out;
}
