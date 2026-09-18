import { createServer } from 'node:http';
import path from 'node:path';
import { JsonlEventStore } from './eventStore.mjs';
import { TransferService } from './service.mjs';
import { DomainError } from './errors.mjs';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), '.data');
const store = new JsonlEventStore(DATA_DIR);
export const service = new TransferService(store);

const STATUS_BY_CODE = {
  NOT_FOUND: 404,
  UNKNOWN_ACTOR: 401,
  FORBIDDEN_ROLE: 403,
  AUTHORIZATION_REVOKED: 403,
  SCOPE_DENIED: 403,
  REVIEW_LOCKED: 409,
  ALREADY_SUBMITTED: 409,
  DUPLICATE_DOCUMENT: 409,
  DUPLICATE_PARTICIPANT: 409,
  AUTHORIZATION_EXISTS: 409,
  SUBMISSION_DEADLINE_PASSED: 409,
  QUOTA_EXCEEDED: 422,
  BLOCKING_TODOS: 422,
};

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 2_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new DomainError('BAD_JSON', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });

export const app = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/health') return json(res, 200, { status: 'ok' });

    if (req.method === 'POST' && p === '/transfers') {
      const b = await readBody(req);
      if (!b.transferId || !b.applicantId) throw new DomainError('BAD_REQUEST', 'transferId 与 applicantId 必填');
      const r = await service.handle(
        b.transferId,
        {
          type: 'openTransfer',
          transferId: b.transferId,
          applicantId: b.applicantId,
          applicantName: b.applicantName,
          studentName: b.studentName,
          studentMinor: b.studentMinor,
          deadline: b.deadline,
          currency: b.currency,
        },
        { actor: b.applicantId, idempotencyKey: b.idempotencyKey ?? `open:${b.transferId}`, now: b.now ? Date.parse(b.now) : undefined },
      );
      return json(res, 201, { transferId: b.transferId, replayed: r.replayed, events: r.events });
    }

    const cmdMatch = p.match(/^\/transfers\/([^/]+)\/commands$/);
    if (req.method === 'POST' && cmdMatch) {
      const id = cmdMatch[1];
      const b = await readBody(req);
      const actor = req.headers['x-actor-id'] || b.actorId;
      if (!actor) throw new DomainError('UNAUTHORIZED', '缺少 x-actor-id 头');
      const r = await service.handle(
        id,
        b.command,
        {
          actor,
          idempotencyKey: b.idempotencyKey,
          now: b.now ? Date.parse(b.now) : undefined,
          quotaUsed: b.quotaUsed,
          quotaLimit: b.quotaLimit,
        },
      );
      return json(res, 200, { replayed: r.replayed, events: r.events });
    }

    const viewMatch = p.match(/^\/transfers\/([^/]+)$/);
    if (req.method === 'GET' && viewMatch) {
      const viewer = url.searchParams.get('viewer') || req.headers['x-actor-id'] || null;
      return json(res, 200, service.view(viewMatch[1], viewer));
    }

    const todosMatch = p.match(/^\/transfers\/([^/]+)\/todos$/);
    if (req.method === 'GET' && todosMatch) {
      const now = url.searchParams.get('now') ? Date.parse(url.searchParams.get('now')) : undefined;
      return json(res, 200, service.todos(todosMatch[1], now));
    }

    const eventsMatch = p.match(/^\/transfers\/([^/]+)\/events$/);
    if (req.method === 'GET' && eventsMatch) {
      return json(res, 200, { events: await service.eventsOf(eventsMatch[1]) });
    }

    const auditMatch = p.match(/^\/transfers\/([^/]+)\/audit$/);
    if (req.method === 'GET' && auditMatch) {
      return json(res, 200, { audit: service.auditTrail(auditMatch[1]) });
    }

    if (req.method === 'GET' && p === '/queue') return json(res, 200, { queue: service.reviewQueue() });
    if (req.method === 'GET' && p === '/instructions') return json(res, 200, { instructions: service.sentInstructions() });

    return json(res, 404, { error: 'NOT_FOUND', message: `无此路由: ${p}` });
  } catch (err) {
    if (err instanceof DomainError) {
      return json(res, STATUS_BY_CODE[err.code] ?? 400, { error: err.code, message: err.message, detail: err.detail });
    }
    return json(res, 500, { error: 'INTERNAL', message: err.message });
  }
});

const port = process.env.PORT || 3000;
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await store.init();
  const restored = await service.restore();
  app.listen(port, () => {
    console.log(`汇款材料协同服务已启动: port=${port} dataDir=${DATA_DIR} restored=${restored}`);
  });
}
