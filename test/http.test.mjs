import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createApp } from '../src/http/app.mjs';
import { EventStore } from '../src/domain/store.mjs';
import { TransferService } from '../src/domain/service.mjs';

async function startServer() {
  const dir = await mkdtemp(join(tmpdir(), 'http-'));
  const store = new EventStore(join(dir, 'events.log'));
  await store.load();
  const service = new TransferService(store);
  await service.replayHeldReceipts();
  const server = createServer(createApp(service));
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, body, actor) => {
    const headers = { 'content-type': 'application/json' };
    if (actor) { headers['x-actor-id'] = actor.id; headers['x-actor-role'] = actor.role; }
    const res = await fetch(base + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json };
  };
  const stop = async () => {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  };
  return { call, stop, dir: `${dir}/events.log` };
}

const student = { id: 's1', role: 'applicant' };
const parent = { id: 'p1', role: 'agent' };
const reviewer = { id: 'r1', role: 'reviewer' };
const bank = { id: 'b1', role: 'bank' };

const docs = {
  admission_letter: { fileName: 'a.pdf', sha256: 'h-a', issuedAt: '2026-08-01T00:00:00Z' },
  tuition_notice: { fileName: 't.pdf', sha256: 'h-t', noticeAmount: { value: 20000, currency: 'USD' } },
  income_proof: { fileName: 'i.pdf', sha256: 'h-i', expiresAt: '2027-06-30T00:00:00Z' },
  passport: { fileName: 'p.pdf', sha256: 'h-p' },
  fx_application: { fileName: 'f.pdf', sha256: 'h-f' },
};

test('HTTP 全流程：开立->授权->补件->审核->发送->回执->核账', async () => {
  const { call, stop } = await startServer();
  try {
    assert.equal((await call('GET', '/health')).body.status, 'ok');

    // 未带身份头被拒
    assert.equal((await call('POST', '/transfers', { applicantName: '王同学' })).status, 401);

    const opened = await call('POST', '/transfers', {
      applicantName: '王同学', minor: true,
      payee: { name: 'NYU', account: 'ACC-1' }, purpose: 'tuition',
      amount: { value: 20000, currency: 'USD' },
      deadline: { localDateTime: '2026-12-31T23:59:59', tz: 'America/New_York' },
    }, student);
    assert.equal(opened.status, 201);
    const id = opened.body.transferId;

    const grant = await call('POST', '/authorizations', {
      applicantId: 's1', agentId: 'p1', relationship: 'mother', minorRelated: true,
      expiresAt: '2027-01-01T00:00:00Z',
    }, student);
    assert.equal(grant.status, 201);

    for (const [slot, d] of Object.entries(docs)) {
      const r = await call('POST', `/transfers/${id}/documents`, { slot, ...d }, student);
      assert.equal(r.status, 201, `${slot}: ${JSON.stringify(r.body)}`);
    }
    const authLetter = await call('POST', `/transfers/${id}/documents`, {
      slot: 'authorization_letter', fileName: 'al.pdf', sha256: 'h-al',
      expiresAt: '2027-01-01T00:00:00Z',
    }, parent);
    assert.equal(authLetter.status, 201);
    const agentIdDoc = await call('POST', `/transfers/${id}/documents`, {
      slot: 'agent_id', fileName: 'id.pdf', sha256: 'h-id',
    }, parent);
    assert.equal(agentIdDoc.status, 201);

    // 缺件已补齐，家长代理可提交
    const submit = await call('POST', `/transfers/${id}/submit`, undefined, parent);
    assert.equal(submit.status, 200, JSON.stringify(submit.body));

    // 非审核员不能通过
    assert.equal((await call('POST', `/transfers/${id}/approve`, {}, parent)).status, 403);
    const approve = await call('POST', `/transfers/${id}/approve`, { note: '齐备' }, reviewer);
    assert.equal(approve.status, 200);

    const issue = await call('POST', `/transfers/${id}/issue`, undefined, reviewer);
    assert.equal(issue.status, 200);
    const ref = issue.body.instructionRef;

    const receipt = await call('POST', '/bank/receipts', { bankRef: 'BK-1', instructionRef: ref }, bank);
    assert.equal(receipt.status, 201);
    assert.equal(receipt.body.status, 'matched');

    const detail = await call('GET', `/transfers/${id}`, undefined, reviewer);
    assert.equal(detail.body.status, 'settled');

    const recon = await call('GET', '/reconciliation?month=2026-09&tz=UTC', undefined, reviewer);
    assert.equal(recon.status, 200);
    assert.equal(recon.body.chainVerified, true);
    assert.equal(recon.body.violations.length, 0);
  } finally { await stop(); }
});

test('HTTP 驳回携带依据；审核员视角可回看', async () => {
  const { call, stop } = await startServer();
  try {
    const opened = await call('POST', '/transfers', {
      payee: { name: 'U', account: 'A' }, purpose: 'tuition', amount: { value: 20000, currency: 'USD' },
    }, student);
    const id = opened.body.transferId;
    for (const [slot, d] of Object.entries(docs)) {
      await call('POST', `/transfers/${id}/documents`, { slot, ...d }, student);
    }
    await call('POST', `/transfers/${id}/submit`, undefined, student);
    const rej = await call('POST', `/transfers/${id}/reject`, {
      reasons: ['购汇申请书缺签名'], basis: '审核要点 3.1', policyVersion: 'v2',
    }, reviewer);
    assert.equal(rej.status, 200);
    const detail = await call('GET', `/transfers/${id}`, undefined, reviewer);
    assert.equal(detail.body.status, 'rejected');
    assert.deepEqual(detail.body.rejection.reasons, ['购汇申请书缺签名']);
    assert.equal(detail.body.rejection.basis, '审核要点 3.1');
  } finally { await stop(); }
});
