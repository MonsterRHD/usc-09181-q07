import test from 'node:test';
import assert from 'node:assert/strict';
import { makeService, ACTORS, openReadyTransfer, submitApproveIssue, PAYEE } from './helpers.mjs';
import { reconcile } from '../src/domain/reconcile.mjs';

test('银行回执先于指令到达：挂起，指令发送后自动补匹配并标记乱序', async () => {
  const { service, cleanup } = await makeService();
  try {
    const { transferId } = await openReadyTransfer(service, { amount: 12000 });
    // 回执乱序先到（银行参考号已生成，但系统里还没有指令）
    const early = await service.receiveBankReceipt(ACTORS.bank, {
      bankRef: 'BNK-EARLY-1',
      amount: { value: 12000, currency: 'USD' },
      payee: { account: PAYEE.account },
    });
    assert.equal(early.status, 'held');

    await submitApproveIssue(service, transferId);
    // issueInstruction 已触发补匹配；查询该回执状态
    const matched = [...service.model.receipts.values()].find((r) => r.bankRef === 'BNK-EARLY-1');
    assert.equal(matched.status, 'matched');
    assert.equal(matched.match.transferId, transferId);
    assert.equal(matched.match.outOfOrder, true);
    assert.equal(service._transfer(service.model, transferId).status, 'settled');
  } finally { await cleanup(); }
});

test('银行回执晚到：重放接口幂等补匹配', async () => {
  const { service, clock, cleanup } = await makeService();
  try {
    const { transferId } = await openReadyTransfer(service, { amount: 13000 });
    await submitApproveIssue(service, transferId);
    clock.advance(5 * 86_400_000); // 超过 3 天的晚到阈值
    await service.receiveBankReceipt(ACTORS.bank, {
      bankRef: 'BNK-LATE-1',
      amount: { value: 13000, currency: 'USD' },
      payee: { account: PAYEE.account },
    });
    const receipt = [...service.model.receipts.values()].find((r) => r.bankRef === 'BNK-LATE-1');
    assert.equal(receipt.status, 'matched');
    assert.equal(receipt.match.outOfOrder, true);
    // 重放不产生第二条匹配事件
    const before = service.store.eventsFor('receipts').length;
    const replay = await service.replayHeldReceipts();
    assert.deepEqual(replay, []);
    assert.equal(service.store.eventsFor('receipts').length, before);
  } finally { await cleanup(); }
});

test('回执按 instructionRef 精确匹配，重复推送幂等', async () => {
  const { service, cleanup } = await makeService();
  try {
    const { transferId } = await openReadyTransfer(service, { amount: 14000 });
    const ref = await submitApproveIssue(service, transferId);
    const r1 = await service.receiveBankReceipt(ACTORS.bank, { bankRef: 'B1', instructionRef: ref });
    assert.equal(r1.status, 'matched');
    const r2 = await service.receiveBankReceipt(ACTORS.bank, { bankRef: 'B1', instructionRef: ref });
    assert.equal(r2.deduped, true);
    assert.equal(service.store.eventsFor('receipts').filter((e) => e.type === 'BankReceiptMatched').length, 1);
  } finally { await cleanup(); }
});

test('学校退款登记为待办，结算后释放额度并结清汇款', async () => {
  const { service, cleanup } = await makeService();
  try {
    const { transferId } = await openReadyTransfer(service, { amount: 40000 });
    const ref = await submitApproveIssue(service, transferId);
    // 回执到达
    await service.receiveBankReceipt(ACTORS.bank, { bankRef: 'B-RFD', instructionRef: ref });
    // 学校退回部分学费
    const created = await service.recordSchoolRefund(ACTORS.school, transferId, {
      amount: { value: 5000, currency: 'USD' }, reason: '课程取消', schoolRef: 'SCH-77',
    });
    const refundId = created.event.data.refundId;
    const todos = service.model.todosOf(transferId);
    assert.ok(todos.some((t) => t.code === 'REFUND_PENDING_SETTLEMENT'));
    assert.equal(service._transfer(service.model, transferId).status, 'sent'); // 有退款未结清

    await service.settleRefund(ACTORS.admin, transferId, refundId, 5000);
    const st = service._transfer(service.model, transferId);
    assert.equal(st.status, 'settled');
    assert.equal(st.refunds[0].quotaReleased, 5000);
    const key = `${st.applicantId}|${st.quotaYear}`;
    assert.equal(service.model.quotaUsed.get(key), 35000);
  } finally { await cleanup(); }
});

test('月末核账覆盖代理更换、重复材料、退款、回执乱序，且审计链校验通过', async () => {
  const { service, store, cleanup } = await makeService();
  try {
    const { transferId, authId } = await openReadyTransfer(service, { minor: true, amount: 15000 });
    // 同月内：代理更换 + 重复上传 + 发送 + 乱序回执 + 退款
    await service.submitForReview(ACTORS.parent, transferId);
    await service.replaceAgent(ACTORS.admin, authId, {
      agentId: ACTORS.parent2.id, agentName: '张父', expiresAt: '2027-06-01T00:00:00.000Z',
    });
    await service.uploadDocument(ACTORS.parent2, transferId, {
      slot: 'authorization_letter', fileName: 'f.pdf', sha256: 'father-auth-1',
      expiresAt: '2027-06-01T00:00:00.000Z',
    });
    await service.uploadDocument(ACTORS.parent2, transferId, {
      slot: 'authorization_letter', fileName: 'f.pdf', sha256: 'father-auth-1',
      expiresAt: '2027-06-01T00:00:00.000Z',
    }); // 重复
    await service.submitForReview(ACTORS.parent2, transferId);
    await service.approve(ACTORS.reviewer, transferId, {});

    // 先挂起一条乱序回执
    const held = await service.receiveBankReceipt(ACTORS.bank, {
      bankRef: 'M-1', amount: { value: 15000, currency: 'USD' }, payee: { account: PAYEE.account },
    });
    assert.equal(held.status, 'held');
    const { instructionRef } = await service.issueInstruction(ACTORS.reviewer, transferId);
    const r = await service.recordSchoolRefund(ACTORS.school, transferId, {
      amount: { value: 1500, currency: 'USD' }, reason: '多收退费',
    });
    await service.settleRefund(ACTORS.admin, transferId, r.event.data.refundId, 1500);

    const report = reconcile(store, { yearMonth: '2026-09', tz: 'UTC' });
    assert.equal(report.chainVerified, true);
    assert.ok(report.agentChanges.some((c) => c.kind === 'replaced'));
    assert.ok(report.duplicateUploads.length >= 1);
    assert.ok(report.refunds.some((x) => x.kind === 'received'));
    assert.ok(report.refunds.some((x) => x.kind === 'settled'));
    assert.ok(report.receiptsOutOfOrder.some((x) => x.transferId === transferId));
    assert.deepEqual(report.receiptsStillHeld, []);
    assert.equal(report.violations.length, 0);
  } finally { await cleanup(); }
});
