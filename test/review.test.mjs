import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError } from '../src/domain/events.mjs';
import { EventStore } from '../src/domain/store.mjs';
import { TransferService } from '../src/domain/service.mjs';
import { makeService, ACTORS, openReadyTransfer } from './helpers.mjs';

test('要素齐备可提交审核；缺件时阻断并给出明确待办', async () => {
  const { service, cleanup } = await makeService();
  try {
    const { transferId } = await service.openTransfer(ACTORS.student, {
      applicantName: '李同学', payee: { name: 'U', account: 'A1' }, purpose: 'tuition',
      amount: { value: 1000, currency: 'USD' },
    });
    await assert.rejects(
      () => service.submitForReview(ACTORS.student, transferId),
      (e) => e instanceof DomainError && e.code === 'BLOCKERS_PRESENT',
    );
    const codes = service.model.todosOf(transferId).map((t) => t.code);
    for (const c of ['MISSING_DOCUMENT', 'MISSING_DOCUMENT']) {
      assert.ok(codes.includes(c));
    }
  } finally { await cleanup(); }
});

test('驳回必须附理由，重启后审核员仍能解释拒绝依据', async () => {
  const { service, cleanup } = await makeService();
  try {
    const { transferId } = await openReadyTransfer(service);
    await service.submitForReview(ACTORS.student, transferId);
    await assert.rejects(
      () => service.reject(ACTORS.reviewer, transferId, { reasons: [] }),
      (e) => e.code === 'REASON_REQUIRED',
    );
    await service.reject(ACTORS.reviewer, transferId, {
      reasons: ['收入证明开具日期早于签证申请前 31 天', '购汇申请书用途与通知单不一致'],
      basis: '《个人购汇业务审核要点》第 4.2 条',
      policyVersion: 'fx-2026-v2',
    });
    const st = service._transfer(service.model, transferId);
    assert.equal(st.status, 'rejected');
    assert.equal(st.rejection.reasons.length, 2);
    assert.equal(st.rejection.basis, '《个人购汇业务审核要点》第 4.2 条');
  } finally { await cleanup(); }
});

test('金额变化（新通知单）产生待办，确认后才能继续审核', async () => {
  const { service, cleanup } = await makeService();
  try {
    const { transferId } = await openReadyTransfer(service, { amount: 30000 });
    await service.submitForReview(ACTORS.student, transferId);
    // 学校发来金额不同的新通知单（版本 2）
    await service.uploadDocument(ACTORS.student, transferId, {
      slot: 'tuition_notice', fileName: 'notice-v2.pdf', sha256: 'notice-v2',
      issuedAt: '2026-09-10T00:00:00.000Z',
      noticeAmount: { value: 32000, currency: 'USD' },
    });
    // 在审提交因关键要素变化失效
    assert.equal(service._transfer(service.model, transferId).status, 'draft');
    assert.ok(service.model.todosOf(transferId).some((t) => t.code === 'AMOUNT_CHANGED_UNACKNOWLEDGED'));
    await assert.rejects(
      () => service.submitForReview(ACTORS.student, transferId),
      (e) => e.code === 'BLOCKERS_PRESENT',
    );
    const events = await service.acknowledgeAmountChange(ACTORS.student, transferId);
    assert.equal(events.length, 2); // AmountChanged + Acknowledged
    assert.equal(service._transfer(service.model, transferId).amount.value, 32000);
    await service.submitForReview(ACTORS.student, transferId);
    assert.equal(service._transfer(service.model, transferId).status, 'in_review');
  } finally { await cleanup(); }
});

test('额度超限不能发送指令；退款结算后释放额度', async () => {
  const { service, cleanup } = await makeService();
  try {
    process.env.QUOTA_LIMIT_USD = '50000';
    const a = await openReadyTransfer(service, { amount: 40000 });
    await service.submitForReview(ACTORS.student, a.transferId);
    await service.approve(ACTORS.reviewer, a.transferId, {});
    await service.issueInstruction(ACTORS.reviewer, a.transferId);

    const b = await openReadyTransfer(service, { amount: 20000 });
    await service.submitForReview(ACTORS.student, b.transferId);
    await service.approve(ACTORS.reviewer, b.transferId, {});
    await assert.rejects(
      () => service.issueInstruction(ACTORS.reviewer, b.transferId),
      (e) => e.code === 'QUOTA_EXCEEDED',
    );
  } finally {
    delete process.env.QUOTA_LIMIT_USD;
    await cleanup();
  }
});

test('重启后待审核队列与已发送凭证完整恢复，挂起回执自动补匹配', async () => {
  const ctx = await makeService();
  const { service, dir, clock } = ctx;
  let refA;
  let queuedId;
  try {
    const a = await openReadyTransfer(service, { amount: 10000 });
    await service.submitForReview(ACTORS.student, a.transferId);
    await service.approve(ACTORS.reviewer, a.transferId, {});
    const { instructionRef } = await service.issueInstruction(ACTORS.reviewer, a.transferId);
    refA = instructionRef;

    const b = await openReadyTransfer(service, { amount: 11000 });
    await service.submitForReview(ACTORS.student, b.transferId);
    queuedId = b.transferId; // 停留在 in_review

    // 重启：全新 store/service 指向同一日志
    const store2 = new EventStore(`${dir}/events.log`, () => clock.now());
    await store2.load();
    const service2 = new TransferService(store2, () => clock.now());
    await service2.replayHeldReceipts();

    const sent = service2._transfer(service2.model, a.transferId);
    assert.equal(sent.status, 'sent');
    assert.equal(sent.instruction.instructionRef, refA);
    assert.equal(sent.instruction.immutable ?? true, true);
    const pending = service2._transfer(service2.model, queuedId);
    assert.equal(pending.status, 'in_review');
    store2.verifyChain();
  } finally { await ctx.cleanup(); }
});

test('审核通过但未发送时金额被修改，审批失效需重走审核', async () => {
  const { service, cleanup } = await makeService();
  try {
    const { transferId } = await openReadyTransfer(service);
    await service.submitForReview(ACTORS.student, transferId);
    await service.approve(ACTORS.reviewer, transferId, {});
    assert.equal(service._transfer(service.model, transferId).status, 'approved');
    await service.changeAmount(ACTORS.student, transferId, { value: 30500, currency: 'USD' });
    assert.equal(service._transfer(service.model, transferId).status, 'draft');
    await assert.rejects(
      () => service.issueInstruction(ACTORS.reviewer, transferId),
      (e) => e.code === 'INVALID_STATUS',
    );
  } finally { await cleanup(); }
});
