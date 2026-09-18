import { DomainError } from '../domain/events.mjs';
import { presentTransfer, presentQueue } from '../domain/presenters.mjs';
import { reconcile } from '../domain/reconcile.mjs';

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

const readBody = (req) => new Promise((resolve, reject) => {
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 2_000_000) reject(new DomainError('PAYLOAD_TOO_LARGE', '请求体过大')); });
  req.on('end', () => {
    if (!raw) return resolve({});
    try { resolve(JSON.parse(raw)); } catch { reject(new DomainError('BAD_JSON', '请求体不是合法 JSON')); }
  });
  req.on('error', reject);
});

function actorFromHeaders(req) {
  const id = req.headers['x-actor-id'];
  const role = req.headers['x-actor-role'];
  if (!id || !role) return null;
  return { id: String(id), role: String(role) };
}

const ERROR_STATUS = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INSTRUCTION_LOCKED: 409,
  ALREADY_SETTLED: 409,
  NO_CHANGE: 409,
  INVALID_STATUS: 409,
  BLOCKERS_PRESENT: 422,
};

// 路由表：[method, pattern, handler]，pattern 中 :name 为路径参数。
export function createApp(service) {
  const routes = [];
  const on = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; })}$`);
    routes.push({ method, re, keys, handler });
  };

  const mustActor = (req) => {
    const actor = actorFromHeaders(req);
    if (!actor) throw new DomainError('UNAUTHENTICATED', '需要 x-actor-id 与 x-actor-role 请求头');
    return actor;
  };

  // ---- 汇款 ----
  on('POST', '/transfers', async (req, b) => {
    const { transferId } = await service.openTransfer(mustActor(req), b);
    return { status: 201, body: { transferId } };
  });
  on('GET', '/transfers', async (req) => {
    const viewer = mustActor(req);
    return { body: { queue: presentQueue(service.model, viewer) } };
  });
  on('GET', '/transfers/:id', async (req, _b, params) => {
    const viewer = actorFromHeaders(req);
    const state = service._transfer(service.model, params.id);
    return { body: presentTransfer(service.model, state, viewer) };
  });
  on('PUT', '/transfers/:id/payee', async (req, b, p) => ({ body: await service.updatePayee(mustActor(req), p.id, b.payee) }));
  on('PUT', '/transfers/:id/purpose', async (req, b, p) => ({ body: await service.updatePurpose(mustActor(req), p.id, b.purpose) }));
  on('PUT', '/transfers/:id/deadline', async (req, b, p) => ({ body: await service.updateDeadline(mustActor(req), p.id, b.deadline) }));
  on('PUT', '/transfers/:id/minor', async (req, b, p) => ({ body: await service.setMinor(mustActor(req), p.id, b.minor) }));
  on('POST', '/transfers/:id/amount', async (req, b, p) => ({ body: await service.changeAmount(mustActor(req), p.id, b) }));
  on('POST', '/transfers/:id/documents', async (req, b, p) => ({ status: 201, body: await service.uploadDocument(mustActor(req), p.id, b) }));
  on('POST', '/transfers/:id/acknowledge-amount', async (req, _b, p) => ({ body: await service.acknowledgeAmountChange(mustActor(req), p.id) }));
  on('POST', '/transfers/:id/submit', async (req, _b, p) => ({ body: await service.submitForReview(mustActor(req), p.id) }));
  on('POST', '/transfers/:id/approve', async (req, b, p) => ({ body: await service.approve(mustActor(req), p.id, b) }));
  on('POST', '/transfers/:id/reject', async (req, b, p) => ({ body: await service.reject(mustActor(req), p.id, b) }));
  on('POST', '/transfers/:id/issue', async (req, _b, p) => {
    const r = await service.issueInstruction(mustActor(req), p.id);
    return { body: { instructionRef: r.instructionRef, eventId: r.event.eventId } };
  });
  on('POST', '/transfers/:id/notes', async (req, b, p) => ({ body: await service.addNote(mustActor(req), p.id, b.text) }));
  on('POST', '/transfers/:id/refunds', async (req, b, p) => {
    const r = await service.recordSchoolRefund(mustActor(req), p.id, b);
    return { status: 201, body: { refundId: r.event.data.refundId } };
  });
  on('POST', '/transfers/:id/refunds/:refundId/settle', async (req, b, p) =>
    ({ body: await service.settleRefund(mustActor(req), p.id, p.refundId, b.quotaReleasedUsd ?? null) }));

  // ---- 授权 ----
  on('POST', '/authorizations', async (req, b) => {
    const r = await service.grantAuthorization(mustActor(req), b);
    return { status: 201, body: { authorizationId: r.authorizationId } };
  });
  on('POST', '/authorizations/:id/revoke', async (req, b, p) =>
    ({ body: await service.revokeAuthorization(mustActor(req), p.id, b.reason ?? null) }));
  on('POST', '/agent-replacements', async (req, b) => {
    const r = await service.replaceAgent(mustActor(req), b.previousAuthorizationId, b.newAuthorization);
    return { status: 201, body: { newAuthorizationId: r.newAuthorizationId } };
  });

  // ---- 银行回执 ----
  on('POST', '/bank/receipts', async (req, b) => {
    const r = await service.receiveBankReceipt(mustActor(req), b);
    return { status: 201, body: r };
  });
  on('POST', '/bank/replay', async () => ({ body: { results: await service.replayHeldReceipts() } }));

  // ---- 月末核账 ----
  on('GET', '/reconciliation', async (req) => {
    const actor = mustActor(req);
    if (!['reviewer', 'admin'].includes(actor.role)) throw new DomainError('FORBIDDEN', '核账仅对审核员/管理员开放');
    const url = new URL(req.url, 'http://local');
    const yearMonth = url.searchParams.get('month');
    const tz = url.searchParams.get('tz') || 'Asia/Shanghai';
    if (!yearMonth) throw new DomainError('BAD_REQUEST', '需要 month=YYYY-MM');
    return { body: reconcile(service.store, { yearMonth, tz }) };
  });

  return async (req, res) => {
    const url = new URL(req.url, 'http://local');
    if (url.pathname === '/health') return json(res, 200, { status: 'ok' });
    for (const route of routes) {
      if (route.method !== req.method) continue;
      const m = route.re.exec(url.pathname);
      if (!m) continue;
      const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      try {
        const result = await route.handler(req, await readBody(req), params);
        return json(res, result.status ?? 200, result.body ?? {});
      } catch (err) {
        if (err instanceof DomainError) {
          const status = ERROR_STATUS[err.code] || 400;
          return json(res, status, { error: err.code, message: err.message, details: err.details });
        }
        req.log?.error?.(err);
        return json(res, 500, { error: 'INTERNAL', message: err.message });
      }
    }
    return json(res, 404, { error: 'NOT_FOUND', message: '路由不存在' });
  };
}
