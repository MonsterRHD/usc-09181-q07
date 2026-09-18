/**
 * 月末核账场景测试：权限、状态流转、待办、审计与重启恢复。
 * 所有时间显式传入，保证跨时区/晚到回执场景可确定性重放。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonlEventStore } from '../src/eventStore.mjs';
import { TransferService } from '../src/service.mjs';
import { DomainError } from '../src/errors.mjs';

const T0 = Date.parse('2026-09-01T08:00:00Z');

async function newHarness(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'remit-'));
  t.after(async () => fs.rm(dir, { recursive: true, force: true }));
  const store = new JsonlEventStore(dir);
  await store.init();
  let clock = T0;
  const svc = new TransferService(store, () => clock);
  const send = (id, actor, command, opts = {}) =>
    svc.handle(id, command, {
      actor,
      now: opts.now ?? clock,
      idempotencyKey: opts.key,
      quotaUsed: opts.quotaUsed,
      quotaLimit: opts.quotaLimit,
    });
  const upload = (id, actor, docType, docId, sha, extra = {}) =>
    send(id, actor, { type: 'uploadDocument', docId, docType, sha256: sha, filename: `${docId}.pdf`, ...extra });
  const expectError = async (p, code) => {
    let thrown = null;
    try {
      await p;
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof DomainError, `期望抛出 DomainError(${code})，实际: ${thrown?.constructor?.name} ${thrown?.message}`);
    assert.equal(thrown.code, code, `期望 ${code}，实际 ${thrown.code}: ${thrown.message}`);
    return thrown;
  };
  // 开立一笔材料齐备的汇款（含家长代理），返回各角色 id
  async function openComplete(id = 'T1', opts = {}) {
    await send(id, 'a1', {
      type: 'openTransfer', transferId: id, applicantId: 'a1', applicantName: '申请人',
      studentName: opts.studentName ?? '张小明', studentMinor: opts.studentMinor ?? true,
      deadline: opts.deadline ?? '2026-09-20T16:00:00Z', currency: 'USD',
    });
    await send(id, 'a1', { type: 'addParticipant', participantId: 'p1', role: 'parent_agent', displayName: '家长甲' });
    await send(id, 'a1', { type: 'addParticipant', participantId: 'r1', role: 'reviewer', displayName: '审核员' });
    await send(id, 'a1', { type: 'addParticipant', participantId: 'b1', role: 'bank_gateway' });
    await send(id, 'a1', { type: 'grantAuthorization', agentParticipantId: 'p1', scopes: ['document:write', 'payment:submit', 'refund:write'] });
    await send(id, 'p1', { type: 'setPayee', schoolName: 'West University', accountRef: 'US123456', bankName: 'Citi' });
    await send(id, 'p1', { type: 'setPurpose', term: 'Fall', academicYear: '2026' });
    await send(id, 'p1', { type: 'setPaymentAmount', amount: 30000 });
    await upload(id, 'p1', 'admission_letter', 'd-letter', 'h-letter', { validUntil: '2027-09-01' });
    await upload(id, 'p1', 'tuition_invoice', 'd-invoice', 'h-invoice', { validUntil: '2026-12-01' });
    await upload(id, 'p1', 'income_proof', 'd-income', 'h-income-v1', { validFrom: '2026-01-01', validUntil: opts.incomeValidUntil ?? '2026-12-15' });
    await upload(id, 'p1', 'passport_or_id', 'd-id', 'h-id', { validUntil: '2030-01-01' });
    await upload(id, 'p1', 'authorization_letter', 'd-auth', 'h-auth', { validUntil: '2027-01-01' });
    return { id, clock: () => clock, setClock: (t2) => { clock = t2; } };
  }
  return { dir, store, svc, clock: () => clock, setClock: (t2) => { clock = t2; }, send, upload, expectError, openComplete };
}

test('完整流程：代理提交 → 审核 → 发指令 → 银行受理回执', async (t) => {
  const h = await newHarness(t);
  const { id } = await h.openComplete();

  const todos = h.svc.todos(id, T0);
  assert.equal(todos.ready, true, '齐备材料不应有阻断待办');
  assert.deepEqual(todos.todos, []);

  await h.send(id, 'p1', { type: 'submitForReview' });
  assert.deepEqual(h.svc.reviewQueue().map((q) => q.transferId), [id], '进入待审核队列');

  await h.send(id, 'r1', { type: 'review', decision: 'approve' });
  await h.send(id, 'a1', { type: 'sendPaymentInstruction', instructionId: 'INST-1' });
  await h.send(id, 'b1', {
    type: 'recordBankReceipt', receiptId: 'R-1', instructionId: 'INST-1', status: 'accepted', bankRef: 'CITI-9',
    occurredAt: '2026-09-02T10:00:00Z',
  });

  const sent = h.svc.sentInstructions();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].instructionId, 'INST-1');
  assert.equal(sent[0].receiptStatus, 'accepted');
  assert.equal(h.svc.reviewQueue().length, 0);
});

test('文件替换必须形成版本；过期收入证明不会被当成最新版本', async (t) => {
  const h = await newHarness(t);
  // 截止日放到年末，确保 10/05 时阻断原因是“材料过期”而非“截止已过”
  const { id } = await h.openComplete('T1', { deadline: '2026-12-31T00:00:00Z', incomeValidUntil: '2026-10-01' });

  // 时间推进到收入证明过期之后
  h.setClock(Date.parse('2026-10-05T00:00:00Z'));
  let todos = h.svc.todos(id, h.clock());
  assert.ok(todos.todos.some((x) => x.kind === 'EXPIRED_DOCUMENT' && x.docType === 'income_proof'));
  assert.equal(todos.ready, false);
  await h.expectError(h.send(id, 'p1', { type: 'submitForReview' }), 'BLOCKING_TODOS');

  // 替换为新版收入证明（带替换原因），旧版保留为历史版本
  await h.upload(id, 'p1', 'income_proof', 'd-income', 'h-income-v2', {
    validFrom: '2026-10-01', validUntil: '2027-10-01', replaceReason: '收入证明已过期，更新最新版本',
  });
  todos = h.svc.todos(id, h.clock());
  assert.equal(todos.ready, true);
  const file = h.svc.getState(id).files.get('d-income');
  assert.equal(file.versions.length, 2);
  assert.equal(file.versions[1].version, 2);
  assert.equal(file.versions[1].supersedesVersion, 1);
  assert.equal(file.versions[1].replaceReason, '收入证明已过期，更新最新版本');
});

test('重复上传同一文件被拦截，同哈希不能冒充另一类材料', async (t) => {
  const h = await newHarness(t);
  const { id } = await h.openComplete();
  // 与当前版本完全相同
  await h.expectError(
    h.upload(id, 'p1', 'income_proof', 'd-income', 'h-income-v1', { validUntil: '2027-10-01' }),
    'DUPLICATE_DOCUMENT',
  );
  // 相同内容换一个 docId / docType 也不允许
  await h.expectError(
    h.upload(id, 'p1', 'passport_or_id', 'd-id-2', 'h-income-v1'),
    'DUPLICATE_DOCUMENT',
  );
});

test('代理更换：撤回授权后旧代理立即失权，新代理可继续操作', async (t) => {
  const h = await newHarness(t);
  const { id } = await h.openComplete();
  await h.send(id, 'a1', { type: 'addParticipant', participantId: 'p2', role: 'parent_agent', displayName: '家长乙' });

  // 旧代理撤回前可操作
  await h.send(id, 'p1', { type: 'setPurpose', term: 'Fall', academicYear: '2026-2027' });
  // 申请人撤回 p1
  await h.send(id, 'a1', { type: 'revokeAuthorization', agentParticipantId: 'p1', reason: '更换代理人' });
  await h.expectError(h.upload(id, 'p1', 'income_proof', 'd-income', 'h-after-revoke'), 'AUTHORIZATION_REVOKED');
  await h.expectError(h.send(id, 'p1', { type: 'submitForReview' }), 'AUTHORIZATION_REVOKED');

  // 不允许重复授权；授权新代理 p2
  await h.send(id, 'a1', { type: 'grantAuthorization', agentParticipantId: 'p2' });
  await h.send(id, 'p2', { type: 'submitForReview' });
  assert.deepEqual(h.svc.reviewQueue().map((q) => q.transferId), [id]);

  // 审计记录可查
  const trail = h.svc.auditTrail(id).map((a) => [a.cmd?.type, a.result]);
  assert.ok(trail.some(([c, r]) => c === 'revokeAuthorization' && r === 'applied'));
  assert.ok(trail.some(([c, r]) => c === 'uploadDocument' && r === 'rejected'));
});

test('金额变化产生阻断待办，确认前审核不能通过', async (t) => {
  const h = await newHarness(t);
  const { id } = await h.openComplete();
  await h.send(id, 'p1', { type: 'submitForReview' });
  // 学校账单更新，金额由 30000 改为 42000
  await h.send(id, 'p1', { type: 'setPaymentAmount', amount: 42000 });
  assert.ok(h.svc.todos(id).todos.some((x) => x.kind === 'AMOUNT_CHANGED'));
  await h.expectError(h.send(id, 'r1', { type: 'review', decision: 'approve' }), 'BLOCKING_TODOS');
  // 代理确认材料/额度仍覆盖新金额
  await h.send(id, 'p1', { type: 'confirmAmountConsistency' });
  await h.send(id, 'r1', { type: 'review', decision: 'approve' });
  assert.equal(h.svc.getState(id).status, 'approved');
});

test('审核通过/指令发出后锁定：新文件不能回溯改变已发送指令', async (t) => {
  const h = await newHarness(t);
  const { id } = await h.openComplete();
  await h.send(id, 'p1', { type: 'submitForReview' });
  await h.send(id, 'r1', { type: 'review', decision: 'approve' });
  await h.send(id, 'a1', { type: 'sendPaymentInstruction', instructionId: 'INST-LOCK' });

  await h.expectError(
    h.upload(id, 'p1', 'income_proof', 'd-income', 'h-income-v3', { validUntil: '2028-01-01' }),
    'REVIEW_LOCKED',
  );
  await h.expectError(h.send(id, 'p1', { type: 'setPaymentAmount', amount: 1 }), 'REVIEW_LOCKED');

  // 凭证快照保持发出时的内容
  const inst = h.svc.getState(id).instruction;
  assert.equal(inst.amount, 30000);
  assert.equal(inst.payee.accountRef, 'US123456');
});

test('学校退款生成明确待办，确认后消除', async (t) => {
  const h = await newHarness(t);
  const { id } = await h.openComplete();
  await h.send(id, 'p1', { type: 'submitForReview' });
  await h.send(id, 'r1', { type: 'review', decision: 'approve' });
  await h.send(id, 'a1', { type: 'sendPaymentInstruction', instructionId: 'INST-R' });
  await h.send(id, 'b1', { type: 'recordBankReceipt', instructionId: 'INST-R', status: 'accepted', occurredAt: '2026-09-02T00:00:00Z' });
  // 学校退回 5000
  await h.send(id, 'b1', {
    type: 'recordRefund', refundId: 'RF-1', amount: 5000, currency: 'USD',
    schoolRefId: 'SCH-9', reason: '宿舍费取消', occurredAt: '2026-09-20T00:00:00Z',
  });
  assert.ok(h.svc.todos(id).todos.some((x) => x.kind === 'REFUND_PENDING' && x.refundId === 'RF-1'));
  await h.send(id, 'p1', { type: 'acknowledgeRefund', refundId: 'RF-1' });
  assert.ok(!h.svc.todos(id).todos.some((x) => x.kind === 'REFUND_PENDING'));
});

test('银行回执晚到与乱序：幂等重放 + 状态矛盾待办 + 无主回执', async (t) => {
  const h = await newHarness(t);
  const { id } = await h.openComplete();
  await h.send(id, 'p1', { type: 'submitForReview' });
  await h.send(id, 'r1', { type: 'review', decision: 'approve' });
  await h.send(id, 'a1', { type: 'sendPaymentInstruction', instructionId: 'INST-X' });

  // 晚到的受理回执（业务时间早于登记时间），同一请求重放两次只入账一次
  const rcpt = { type: 'recordBankReceipt', receiptId: 'R-LATE', instructionId: 'INST-X', status: 'accepted', bankRef: 'B-1', occurredAt: '2026-09-02T01:00:00Z' };
  const first = await h.send(id, 'b1', rcpt, { key: 'rcpt-R-LATE', now: Date.parse('2026-09-10T00:00:00Z') });
  assert.equal(first.replayed, false);
  const again = await h.send(id, 'b1', rcpt, { key: 'rcpt-R-LATE', now: Date.parse('2026-09-11T00:00:00Z') });
  assert.equal(again.replayed, true);
  assert.equal(h.svc.getState(id).receipts.length, 1);
  assert.ok(h.svc.auditTrail(id).some((a) => a.result === 'replayed'));

  // 又来一条退票回执（银行业务时间更早）——状态矛盾，要求人工核对
  await h.send(id, 'b1', { type: 'recordBankReceipt', receiptId: 'R-REJ', instructionId: 'INST-X', status: 'rejected', occurredAt: '2026-09-01T23:00:00Z' });
  assert.ok(h.svc.todos(id).todos.some((x) => x.kind === 'RECEIPT_STATUS_CONFLICT'));

  // 找不到指令的回执标记 orphan
  await h.send(id, 'b1', { type: 'recordBankReceipt', receiptId: 'R-ORPHAN', instructionId: 'INST-OTHER', status: 'accepted' });
  assert.ok(h.svc.todos(id).todos.some((x) => x.kind === 'UNMATCHED_RECEIPT'));
});

test('跨时区截止按绝对时刻判断；拒绝必须留依据并可补正重提', async (t) => {
  const h = await newHarness(t);
  // deadline 用绝对时刻表达：UTC 9/15 16:00 = 北京时间 9/16 00:00
  const { id } = await h.openComplete('T1', { deadline: '2026-09-15T16:00:00Z' });
  // 北京时间 9/16 08:00（UTC 9/16 00:00）提交 —— 虽然本地“日期刚到16号”，绝对时刻已过截止
  h.setClock(Date.parse('2026-09-16T00:00:00Z'));
  await h.expectError(h.send(id, 'p1', { type: 'submitForReview' }), 'SUBMISSION_DEADLINE_PASSED');

  // 另一笔：审核员拒绝并写明依据
  const id2 = 'T2';
  await h.openComplete(id2);
  h.setClock(T0);
  await h.send(id2, 'p1', { type: 'submitForReview' });
  // 拒绝无依据不允许，状态保持 submitted，可补依据后再次结论
  await h.expectError(h.send(id2, 'r1', { type: 'review', decision: 'reject', reason: '   ' }), 'REASON_REQUIRED');
  assert.equal(h.svc.getState(id2).status, 'submitted');
  const reason = '收入证明开具日期早于账单周期，要求补充近三个月流水';
  await h.send(id2, 'r1', { type: 'review', decision: 'reject', reason });
  assert.equal(h.svc.getState(id2).review.decision, 'rejected');
  assert.equal(h.svc.getState(id2).review.reason, reason, '审核员事后可解释拒绝依据');

  // 补正后重新提交并通过
  await h.upload(id2, 'p1', 'income_proof', 'd-income', 'h-income-fixed', { validFrom: '2026-06-01', validUntil: '2027-06-01', replaceReason: '按拒绝意见补充近期材料' });
  await h.send(id2, 'p1', { type: 'resubmit' });
  await h.send(id2, 'r1', { type: 'review', decision: 'approve' });
  assert.equal(h.svc.getState(id2).status, 'approved');
});

test('额度校验：超出年度购汇额度不能发出指令', async (t) => {
  const h = await newHarness(t);
  const { id } = await h.openComplete();
  await h.send(id, 'p1', { type: 'submitForReview' });
  await h.send(id, 'r1', { type: 'review', decision: 'approve' });
  await h.expectError(
    h.send(id, 'a1', { type: 'sendPaymentInstruction' }, { quotaUsed: 30000, quotaLimit: 50000 }),
    'QUOTA_EXCEEDED',
  );
  await h.send(id, 'a1', { type: 'sendPaymentInstruction', instructionId: 'INST-Q' }, { quotaUsed: 10000, quotaLimit: 50000 });
  assert.equal(h.svc.getState(id).status, 'instructed');
});

test('未成年人信息最小化：审核员只见脱敏姓名与必要材料信息', async (t) => {
  const h = await newHarness(t);
  const { id } = await h.openComplete(); // studentMinor = true
  const reviewerView = h.svc.view(id, 'r1');
  assert.equal(reviewerView.studentName, '张*');
  assert.ok(reviewerView.files.every((f) => f.versions.every((v) => v.filename === '***')));
  assert.match(reviewerView.files[0].versions[0].sha256, /…$/);

  const applicantView = h.svc.view(id, 'a1');
  assert.equal(applicantView.studentName, '张小明');
  assert.equal(applicantView.files.find((f) => f.docType === 'income_proof').versions[0].filename, 'd-income.pdf');
});

test('服务重启后待审核队列与已发送凭证仍在（事件重放恢复）', async (t) => {
  const h = await newHarness(t);
  const { id } = await h.openComplete(); // T1 最终 instructed
  await h.send(id, 'p1', { type: 'submitForReview' });
  await h.send(id, 'r1', { type: 'review', decision: 'approve' });
  await h.send(id, 'a1', { type: 'sendPaymentInstruction', instructionId: 'INST-PERSIST' });

  // T2 停在待审核队列
  await h.openComplete('T2', { incomeValidUntil: '2026-10-01' });
  await h.send('T2', 'p1', { type: 'submitForReview' });

  // 用同目录启动新进程实例
  const store2 = new JsonlEventStore(h.dir);
  const svc2 = new TransferService(store2);
  const restored = await svc2.restore();
  assert.equal(restored, 2);
  assert.deepEqual(svc2.reviewQueue().map((q) => q.transferId), ['T2']);
  const sent = svc2.sentInstructions();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].instructionId, 'INST-PERSIST');
  // 重放后规则仍可继续工作：T2 可审核、过期待办可派生
  assert.equal(svc2.todos('T2', Date.parse('2026-10-05T00:00:00Z')).ready, false);
  await svc2.handle('T2', { type: 'review', decision: 'reject', reason: '重启后补审：账单模糊' }, { actor: 'r1', now: T0 });
  assert.equal(svc2.getState('T2').status, 'rejected');
  assert.equal(svc2.getState('T2').review.reason, '重启后补审：账单模糊');
});

test('缺件场景：有生效代理但缺授权书时阻断提交', async (t) => {
  const h = await newHarness(t);
  const id = 'T3';
  await h.send(id, 'a1', { type: 'openTransfer', transferId: id, applicantId: 'a1', studentName: '李四', currency: 'USD' });
  await h.send(id, 'a1', { type: 'addParticipant', participantId: 'p9', role: 'parent_agent' });
  await h.send(id, 'a1', { type: 'grantAuthorization', agentParticipantId: 'p9' });
  await h.send(id, 'p9', { type: 'setPayee', schoolName: 'S', accountRef: 'AC1' });
  await h.send(id, 'p9', { type: 'setPurpose', term: 'Fall', academicYear: '2026' });
  await h.send(id, 'p9', { type: 'setPaymentAmount', amount: 100 });
  for (const [dt, hid] of [['admission_letter', 'x1'], ['tuition_invoice', 'x2'], ['income_proof', 'x3'], ['passport_or_id', 'x4']]) {
    await h.upload(id, 'p9', dt, `d-${dt}`, hid, { validUntil: '2027-01-01' });
  }
  const kinds = h.svc.todos(id).todos.map((x) => x.kind);
  assert.ok(kinds.includes('MISSING_DOCUMENT'));
  await h.expectError(h.send(id, 'p9', { type: 'submitForReview' }), 'BLOCKING_TODOS');
});
