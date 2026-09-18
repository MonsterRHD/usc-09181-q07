import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError } from '../src/domain/events.mjs';
import { makeService, ACTORS, openReadyTransfer } from './helpers.mjs';

test('无有效授权的代理不能操作汇款；授权后可以', async () => {
  const { service, cleanup } = await makeService();
  try {
    const { transferId } = await openReadyTransfer(service, { minor: false });
    await assert.rejects(
      () => service.updatePayee(ACTORS.parent, transferId, { name: 'NYU', account: 'ACC-9' }),
      (e) => e.code === 'FORBIDDEN',
    );
    await service.grantAuthorization(ACTORS.student, {
      applicantId: ACTORS.student.id, agentId: ACTORS.parent.id, relationship: 'parent',
    });
    const r = await service.updatePayee(ACTORS.parent, transferId, { name: 'NYU', account: 'ACC-9' });
    assert.equal(r.duplicate, false);
  } finally { await cleanup(); }
});

test('授权撤回后在审汇款回到草稿，代理失去操作权', async () => {
  const { service, cleanup } = await makeService();
  try {
    const { transferId, authId } = await openReadyTransfer(service, { minor: true });
    await service.submitForReview(ACTORS.parent, transferId);
    assert.equal(service._transfer(service.model, transferId).status, 'in_review');

    await service.revokeAuthorization(ACTORS.student, authId, '家庭原因');
    assert.equal(service._transfer(service.model, transferId).status, 'draft');
    await assert.rejects(
      () => service.submitForReview(ACTORS.parent, transferId),
      (e) => e.code === 'FORBIDDEN',
    );
  } finally { await cleanup(); }
});

test('过期授权等同失效，延期需重新授予', async () => {
  const { service, clock, cleanup } = await makeService();
  try {
    const { transferId } = await openReadyTransfer(service, { minor: true });
    clock.set('2027-02-01T00:00:00.000Z'); // 超过授权与授权书有效期 2027-01-01
    assert.equal(service.model.activeAuthzFor({
      applicantId: ACTORS.student.id, transferId, agentId: ACTORS.parent.id,
    }), null);
    await assert.rejects(
      () => service.updatePurpose(ACTORS.parent, transferId, 'deposit'),
      (e) => e.code === 'FORBIDDEN',
    );
    const todos = service.model.todosOf(transferId).map((t) => t.code);
    assert.ok(todos.includes('DOCUMENT_EXPIRED')); // 授权书过期
  } finally { await cleanup(); }
});

test('代理更换：旧授权失效、在审汇款回草稿、新代理可接手', async () => {
  const { service, cleanup } = await makeService();
  try {
    const { transferId, authId } = await openReadyTransfer(service, { minor: true });
    await service.submitForReview(ACTORS.parent, transferId);

    const { newAuthorizationId } = await service.replaceAgent(ACTORS.admin, authId, {
      agentId: ACTORS.parent2.id, agentName: '张父', relationship: 'father',
      expiresAt: '2027-06-01T00:00:00.000Z',
    });
    assert.equal(service._transfer(service.model, transferId).status, 'draft');
    const old = service.model.authz.get(authId);
    assert.ok(old.revokedAt);
    assert.equal(old.replacedBy, newAuthorizationId);

    // 旧代理被拒；新代理补一份代办授权书后可重新提交
    await assert.rejects(
      () => service.submitForReview(ACTORS.parent, transferId),
      (e) => e.code === 'FORBIDDEN',
    );
    await service.uploadDocument(ACTORS.parent2, transferId, {
      slot: 'authorization_letter', fileName: 'father-auth.pdf', sha256: 'father-auth-1',
      expiresAt: '2027-06-01T00:00:00.000Z',
    });
    await service.submitForReview(ACTORS.parent2, transferId);
    assert.equal(service._transfer(service.model, transferId).status, 'in_review');
  } finally { await cleanup(); }
});

test('撤回可重放：对同一授权重复撤回不产生第二条撤回事件', async () => {
  const { service, store, cleanup } = await makeService();
  try {
    await openReadyTransfer(service, { minor: true });
    const { authorizationId } = await service.grantAuthorization(ACTORS.student, {
      applicantId: ACTORS.student.id, agentId: 'agent_tmp',
    });
    const before = store.eventsFor('authz').length;
    await service.revokeAuthorization(ACTORS.student, authorizationId, 'x');
    const afterFirst = store.eventsFor('authz').length;
    assert.ok(afterFirst > before);
    // 再次撤回：授权已失效，命令仍成功但不追加事件
    await service.revokeAuthorization(ACTORS.student, authorizationId, 'x');
    assert.equal(store.eventsFor('authz').length, afterFirst);
  } finally { await cleanup(); }
});

test('他人申请人不能操作不属于自己的汇款', async () => {
  const { service, cleanup } = await makeService();
  try {
    const { transferId } = await openReadyTransfer(service);
    await assert.rejects(
      () => service.updatePayee(ACTORS.student2, transferId, { name: 'X', account: 'Y' }),
      (e) => e instanceof DomainError && e.code === 'FORBIDDEN',
    );
  } finally { await cleanup(); }
});
