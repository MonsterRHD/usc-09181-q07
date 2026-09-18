import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError } from '../src/domain/events.mjs';
import { currentVersion } from '../src/domain/projection.mjs';
import { makeService, ACTORS, openReadyTransfer } from './helpers.mjs';

test('文件替换形成版本链，旧版本标记为 superseded', async () => {
  const { service, cleanup } = await makeService();
  try {
    const { transferId } = await openReadyTransfer(service);
    const r1 = await service.uploadDocument(ACTORS.student, transferId, {
      slot: 'income_proof', fileName: 'income.pdf', sha256: 'inc-new-1',
      expiresAt: '2027-06-30T00:00:00.000Z',
    });
    assert.equal(r1.version, 2); // 与夹具中的第 1 版同槽位
    const r2 = await service.uploadDocument(ACTORS.student, transferId, {
      slot: 'income_proof', fileName: 'income-v3.pdf', sha256: 'inc-new-2',
      expiresAt: '2027-12-31T00:00:00.000Z',
    });
    assert.equal(r2.version, 3);

    const state = service._transfer(service.model, transferId);
    const bucket = state.documents.get('income_proof');
    assert.equal(bucket.versions.length, 3);
    assert.ok(bucket.versions[0].supersededAt);
    assert.ok(bucket.versions[1].supersededAt);
    assert.equal(bucket.versions[2].supersededAt, null);
    const cur = currentVersion(state, 'income_proof', service.clock());
    assert.equal(cur.version, 3);
    assert.equal(cur.status, 'active');
  } finally { await cleanup(); }
});

test('同内容重复上传被去重，不产生新版本且可重放', async () => {
  const { service, cleanup } = await makeService();
  try {
    const { transferId } = await openReadyTransfer(service);
    const input = {
      slot: 'fx_application', fileName: 'fx-extra.pdf', sha256: 'fx-dup-test',
    };
    const a = await service.uploadDocument(ACTORS.student, transferId, input);
    const b = await service.uploadDocument(ACTORS.student, transferId, input);
    assert.equal(a.deduped, false);
    assert.equal(b.deduped, true);
    assert.equal(b.version, a.version);
    const state = service._transfer(service.model, transferId);
    assert.equal(a.version, state.documents.get('fx_application').versions.length); // 新内容占一版
    // 第三次（重放）仍然不新增版本
    const c = await service.uploadDocument(ACTORS.student, transferId, { ...input, idempotencyKey: 'retry' });
    assert.equal(c.deduped, true);
    assert.equal(service._transfer(service.model, transferId).documents.get('fx_application').versions.length, a.version);
  } finally { await cleanup(); }
});

test('过期的收入证明阻断审核，且不能上传一份已经过期的文件', async () => {
  const { service, clock, cleanup } = await makeService();
  try {
    const { transferId } = await openReadyTransfer(service);
    // 推进时间使收入证明过期
    clock.set('2027-07-01T00:00:00.000Z');
    const todos = service.model.todosOf(transferId);
    assert.ok(todos.some((t) => t.code === 'DOCUMENT_EXPIRED' && t.slot === 'income_proof'));
    await assert.rejects(
      () => service.submitForReview(ACTORS.student, transferId),
      (e) => e instanceof DomainError && e.code === 'BLOCKERS_PRESENT'
        && e.details.blockers.some((b) => b.code === 'DOCUMENT_EXPIRED'),
    );
    await assert.rejects(
      () => service.uploadDocument(ACTORS.student, transferId, {
        slot: 'income_proof', fileName: 'stale.pdf', sha256: 'inc-stale',
        expiresAt: '2027-06-01T00:00:00.000Z',
      }),
      (e) => e instanceof DomainError && e.code === 'DOCUMENT_ALREADY_EXPIRED',
    );
    // 上传新版本解除阻断
    await service.uploadDocument(ACTORS.student, transferId, {
      slot: 'income_proof', fileName: 'fresh.pdf', sha256: 'inc-fresh',
      expiresAt: '2028-06-30T00:00:00.000Z',
    });
    assert.ok(!service.model.todosOf(transferId).some((t) => t.code === 'DOCUMENT_EXPIRED'));
  } finally { await cleanup(); }
});

test('审核通过后新增文件不改变已发送指令快照', async () => {
  const { service, cleanup } = await makeService();
  try {
    const { transferId } = await openReadyTransfer(service);
    const ref = await (async () => {
      await service.submitForReview(ACTORS.student, transferId);
      await service.approve(ACTORS.reviewer, transferId, { note: 'ok' });
      const { instructionRef } = await service.issueInstruction(ACTORS.reviewer, transferId);
      return instructionRef;
    })();
    const before = service._transfer(service.model, transferId).instruction.snapshot;
    const sentDocVersion = before.documents.find((d) => d.slot === 'income_proof').version;

    // 指令后允许追加文件（形成版本），但快照不变，关键字段被锁定
    const added = await service.uploadDocument(ACTORS.student, transferId, {
      slot: 'income_proof', fileName: 'after.pdf', sha256: 'after-sent',
      expiresAt: '2028-12-31T00:00:00.000Z',
    });
    assert.equal(added.afterSent, true);
    assert.equal(added.version, sentDocVersion + 1);
    const after = service._transfer(service.model, transferId).instruction.snapshot;
    assert.deepEqual(after, before);
    assert.equal(after.documents.find((d) => d.slot === 'income_proof').version, sentDocVersion);

    await assert.rejects(
      () => service.changeAmount(ACTORS.student, transferId, { value: 99999, currency: 'USD' }),
      (e) => e instanceof DomainError && e.code === 'INSTRUCTION_LOCKED',
    );
    await assert.rejects(
      () => service.updatePayee(ACTORS.student, transferId, { name: 'X', account: 'Y' }),
      (e) => e instanceof DomainError && e.code === 'INSTRUCTION_LOCKED',
    );
    assert.equal(ref, service._transfer(service.model, transferId).instruction.instructionRef);
  } finally { await cleanup(); }
});
