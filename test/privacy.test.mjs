import test from 'node:test';
import assert from 'node:assert/strict';
import { makeService, ACTORS, openReadyTransfer } from './helpers.mjs';
import { presentTransfer } from '../src/domain/presenters.mjs';

test('未成年人汇款：当前监护人/审核员可见办理信息，旧代理脱敏，银行只见要素', async () => {
  const { service, cleanup } = await makeService();
  try {
    const { transferId, authId } = await openReadyTransfer(service, { minor: true });
    const model = service.model;
    const state = model.transfers.get(transferId);

    const reviewerView = presentTransfer(model, state, ACTORS.reviewer);
    assert.equal(reviewerView.applicantName, '张同学');
    assert.equal(reviewerView.visibility, 'full');
    assert.ok(reviewerView.documents.some((d) => d.sha256));

    const parentView = presentTransfer(model, state, ACTORS.parent);
    assert.equal(parentView.visibility, 'full');
    assert.equal(parentView.applicantName, '张同学');

    // 撤回授权后，旧代理只保留有限可见：有材料类别与版本，无文件标识与姓名
    await service.revokeAuthorization(ACTORS.student, authId, '更换监护人');
    const model2 = service.model;
    const state2 = model2.transfers.get(transferId);
    const exView = presentTransfer(model2, state2, ACTORS.parent);
    assert.equal(exView.visibility, 'limited');
    assert.notEqual(exView.applicantName, '张同学');
    assert.ok(exView.applicantName.includes('*'));
    assert.ok(exView.documents.length > 0);
    assert.ok(exView.documents.every((d) => d.sha256 === null && d.fileName === null));

    // 银行：只见金额/指令/收款账户，不见学生 PII 与文件
    await service.grantAuthorization(ACTORS.admin, {
      applicantId: ACTORS.student.id, agentId: ACTORS.parent2.id, minorRelated: true,
      expiresAt: '2027-06-01T00:00:00.000Z',
    });
    await service.uploadDocument(ACTORS.parent2, transferId, {
      slot: 'authorization_letter', fileName: 'p2.pdf', sha256: 'p2-auth',
      expiresAt: '2027-06-01T00:00:00.000Z',
    });
    await service.submitForReview(ACTORS.parent2, transferId);
    await service.approve(ACTORS.reviewer, transferId, {});
    const { instructionRef } = await service.issueInstruction(ACTORS.reviewer, transferId);
    const model3 = service.model;
    const bankView = presentTransfer(model3, model3.transfers.get(transferId), ACTORS.bank);
    assert.equal(bankView.visibility, 'counterparty');
    assert.equal(bankView.instructionRef, instructionRef);
    assert.equal(bankView.applicantName, undefined);
    assert.equal(bankView.documents, undefined);
    assert.equal(bankView.payee.account.length > 0, true);

    // 学校：连收款账户都不可见
    const schoolView = presentTransfer(model3, model3.transfers.get(transferId), ACTORS.school);
    assert.equal(schoolView.payee.account, null);
  } finally { await cleanup(); }
});

test('无关人员无任何可见信息', async () => {
  const { service, cleanup } = await makeService();
  try {
    const { transferId } = await openReadyTransfer(service, { minor: true });
    const view = presentTransfer(service.model, service.model.transfers.get(transferId), {
      id: 'stranger-agent', role: 'agent',
    });
    assert.equal(view.visibility, 'none');
    assert.equal(view.payee, undefined);
  } finally { await cleanup(); }
});
