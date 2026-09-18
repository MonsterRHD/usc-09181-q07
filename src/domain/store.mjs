import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { envelope, canonicalHash, DomainError } from './events.mjs';

// 单文件 JSONL 追加日志：进程重启后整体回放即可恢复全部状态。
// 同一 stream 内 seq 连续、prevHash 串联；不同流交错落盘不影响各自链路。
export class EventStore {
  constructor(filePath, clock = () => new Date().toISOString()) {
    this.filePath = filePath;
    this.clock = clock;
    this.events = [];
    this.tails = new Map(); // stream -> { seq, hash }
    this.idempotency = new Map(); // `${stream}|${key}` -> eventId
  }

  async load() {
    if (!existsSync(this.filePath)) {
      await mkdir(dirname(this.filePath), { recursive: true });
      return;
    }
    const raw = await readFile(this.filePath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      this._ingest(event, { persist: false });
    }
  }

  _ingest(event) {
    const tail = this.tails.get(event.stream);
    if (tail) {
      if (event.seq !== tail.seq + 1) {
        throw new DomainError('EVENT_SEQ_GAP', `流 ${event.stream} 序号不连续: 期望 ${tail.seq + 1}，实际 ${event.seq}`);
      }
      if (event.prevHash !== tail.hash) {
        throw new DomainError('EVENT_CHAIN_BROKEN', `流 ${event.stream} 哈希链断裂于 seq=${event.seq}`);
      }
    } else if (event.seq !== 1) {
      throw new DomainError('EVENT_SEQ_GAP', `流 ${event.stream} 首事件序号必须为 1`);
    }
    const digest = canonicalHash({
      eventId: event.eventId, stream: event.stream, seq: event.seq, ts: event.ts,
      type: event.type, actor: event.actor, data: event.data,
      idempotencyKey: event.idempotencyKey, prevHash: event.prevHash,
    });
    if (digest !== event.hash) {
      throw new DomainError('EVENT_HASH_MISMATCH', `事件 ${event.eventId} 内容与哈希不符`);
    }
    this.events.push(event);
    this.tails.set(event.stream, { seq: event.seq, hash: event.hash });
    if (event.idempotencyKey) {
      this.idempotency.set(`${event.stream}|${event.idempotencyKey}`, event.eventId);
    }
  }

  async append({ stream, type, data, actor, ts, idempotencyKey }) {
    if (idempotencyKey) {
      const existing = this.idempotency.get(`${stream}|${idempotencyKey}`);
      if (existing) {
        const original = this.events.find((e) => e.eventId === existing);
        return { event: original, duplicate: true };
      }
    }
    const tail = this.tails.get(stream);
    const seq = tail ? tail.seq + 1 : 1;
    const event = envelope({
      stream, seq, type, data, actor,
      ts: ts ?? this.clock(),
      prevHash: tail ? tail.hash : null,
      idempotencyKey,
    });
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(event)}\n`);
    this._ingest(event);
    return { event, duplicate: false };
  }

  eventsFor(stream) {
    return this.events.filter((e) => e.stream === stream);
  }

  // 跨流幂等查询：用于“开立汇款”这类每次生成新流的命令重试。
  findIdempotency(key) {
    for (const [composite, eventId] of this.idempotency.entries()) {
      if (composite.endsWith(`|${key}`)) return this.events.find((e) => e.eventId === eventId) ?? null;
    }
    return null;
  }

  allEvents() {
    return [...this.events];
  }

  // 校验某条流（或全部流）的哈希链，供月末核账调用。
  verifyChain(stream) {
    const streams = stream ? [stream] : [...new Set(this.events.map((e) => e.stream))];
    for (const s of streams) {
      let prev = null;
      for (const e of this.eventsFor(s)) {
        if (e.prevHash !== prev) {
          throw new DomainError('EVENT_CHAIN_BROKEN', `流 ${s} 哈希链断裂于 seq=${e.seq}`);
        }
        const digest = canonicalHash({
          eventId: e.eventId, stream: e.stream, seq: e.seq, ts: e.ts,
          type: e.type, actor: e.actor, data: e.data,
          idempotencyKey: e.idempotencyKey, prevHash: e.prevHash,
        });
        if (digest !== e.hash) {
          throw new DomainError('EVENT_HASH_MISMATCH', `事件 ${e.eventId} 内容与哈希不符`);
        }
        prev = e.hash;
      }
    }
    return true;
  }
}

export function defaultStorePath() {
  return process.env.STORE_PATH || join(process.cwd(), 'data', 'events.log');
}
