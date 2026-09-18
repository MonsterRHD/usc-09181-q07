/**
 * HTTP 端到端：真实监听端口走一遍协同流程，并模拟“进程重启”（同数据目录新实例重放）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function boot(dir, tag) {
  process.env.DATA_DIR = dir;
  const mod = await import(`../src/server.mjs?boot=${tag}`);
  const restored = await mod.service.restore();
  await new Promise((resolve) => mod.app.listen(0, '127.0.0.1', resolve));
  const addr = mod.app.address();
  const base = `http://127.0.0.1:${addr.port}`;
  const api = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  };
  return { api, service: mod.service, restored, close: () => new Promise((r) => mod.app.close(r)) };
}

test('HTTP：服务拉起 → 协同全流程 → 重启后队列与凭证仍在', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'remit-http-'));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const a = await boot(dir, '1');
  t.after(a.close);
  const cmd = (p, body, actor) => a.api('POST', p, body, { 'x-actor-id': actor });

  // 健康检查
  assert.equal((await a.api('GET', '/health')).status, 200);

  // 开立（未成年人）
  const open = await a.api('POST', '/transfers', {
    transferId: 'W1', applicantId: 'a1', applicantName: '申请人',
    studentName: '王小华', studentMinor: true, deadline: '2026-12-31T00:00:00Z', currency: 'USD',
  });
  assert.equal(open.status, 201);

  await cmd('/transfers/W1/commands', { command: { type: 'addParticipant', participantId: 'p1', role: 'parent_agent' } }, 'a1');
  await cmd('/transfers/W1/commands', { command: { type: 'addParticipant', participantId: 'r1', role: 'reviewer' } }, 'a1');
  await cmd('/transfers/W1/commands', { command: { type: 'addParticipant', participantId: 'b1', role: 'bank_gateway' } }, 'a1');
  await cmd('/transfers/W1/commands', { command: { type: 'grantAuthorization', agentParticipantId: 'p1' } }, 'a1');
  await cmd('/transfers/W1/commands', { command: { type: 'setPayee', schoolName: 'East College', accountRef: 'US999' } }, 'p1');
  await cmd('/transfers/W1/commands', { command: { type: 'setPurpose', term: 'Spring', academicYear: '2027' } }, 'p1');
  await cmd('/transfers/W1/commands', { command: { type: 'setPaymentAmount', amount: 20000 } }, 'p1');
  for (const [dt, did, sha] of [
    ['admission_letter', 'd1', 's1'], ['tuition_invoice', 'd2', 's2'], ['income_proof', 'd3', 's3'],
    ['passport_or_id', 'd4', 's4'], ['authorization_letter', 'd5', 's5'],
  ]) {
    const r = await cmd('/transfers/W1/commands', { command: { type: 'uploadDocument', docId: did, docType: dt, sha256: sha, validUntil: '2027-06-01' } }, 'p1');
    assert.equal(r.status, 200, `${dt} upload: ${JSON.stringify(r.json)}`);
  }

  // 幂等：重复开立直接回放
  const reopen = await a.api('POST', '/transfers', { transferId: 'W1', applicantId: 'a1' });
  assert.equal(reopen.status, 201);
  assert.equal(reopen.json.replayed, true);

  await cmd('/transfers/W1/commands', { command: { type: 'submitForReview' } }, 'p1');
  const queue = await a.api('GET', '/queue');
  assert.deepEqual(queue.json.queue.map((q) => q.transferId), ['W1']);

  // 越权：代理不能审核
  const forbidden = await cmd('/transfers/W1/commands', { command: { type: 'review', decision: 'approve' } }, 'p1');
  assert.equal(forbidden.status, 403);

  // 拒绝必须有依据
  const noReason = await cmd('/transfers/W1/commands', { command: { type: 'review', decision: 'reject', reason: '' } }, 'r1');
  assert.equal(noReason.status, 400);
  assert.equal(noReason.json.error, 'REASON_REQUIRED');

  await cmd('/transfers/W1/commands', { command: { type: 'review', decision: 'approve' } }, 'r1');
  await cmd('/transfers/W1/commands', { command: { type: 'sendPaymentInstruction', instructionId: 'INST-W1' } }, 'a1');
  const lateReceipt = {
    idempotencyKey: 'rcpt-W1',
    command: { type: 'recordBankReceipt', receiptId: 'RR1', instructionId: 'INST-W1', status: 'accepted', occurredAt: '2026-09-02T00:00:00Z' },
  };
  await cmd('/transfers/W1/commands', lateReceipt, 'b1');
  const replay = await cmd('/transfers/W1/commands', lateReceipt, 'b1');
  assert.equal(replay.json.replayed, true, '回执晚到重试可重放且不重复入账');

  const instructions = await a.api('GET', '/instructions');
  assert.equal(instructions.json.instructions[0].instructionId, 'INST-W1');
  assert.equal(instructions.json.instructions[0].receiptStatus, 'accepted');

  // 未成年人脱敏视图
  const reviewerView = await a.api('GET', '/transfers/W1?viewer=r1');
  assert.equal(reviewerView.json.studentName, '王*');
  assert.equal(reviewerView.json.files[0].versions[0].filename, '***');

  // 审核锁定：指令后补文件 409
  const locked = await cmd('/transfers/W1/commands', { command: { type: 'uploadDocument', docId: 'd3', docType: 'income_proof', sha256: 's-new', validUntil: '2028-01-01' } }, 'p1');
  assert.equal(locked.status, 409);
  assert.equal(locked.json.error, 'REVIEW_LOCKED');

  // 审计可查
  const audit = await a.api('GET', '/transfers/W1/audit');
  assert.ok(audit.json.audit.some((x) => x.result === 'replayed'));
  assert.ok(audit.json.audit.some((x) => x.result === 'rejected' && x.error === 'FORBIDDEN_ROLE'));

  await a.close();

  // ---- 模拟服务进程重启：同数据目录新实例，启动时重放 ----
  const b = await boot(dir, '2');
  t.after(b.close);
  assert.equal(b.restored, 1, '启动时恢复 1 个汇款流');
  assert.equal((await b.api('GET', '/queue')).json.queue.length, 0);
  const sent = await b.api('GET', '/instructions');
  assert.equal(sent.json.instructions.length, 1);
  assert.equal(sent.json.instructions[0].instructionId, 'INST-W1');
  assert.equal(sent.json.instructions[0].receiptStatus, 'accepted', '晚到回执状态重放后仍在');
});
