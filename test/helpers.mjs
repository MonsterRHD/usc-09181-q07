import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/domain/store.mjs';
import { TransferService } from '../src/domain/service.mjs';

export class FakeClock {
  constructor(start = '2026-09-01T00:00:00.000Z') { this.t = new Date(start); }
  now() { return this.t.toISOString(); }
  advance(ms) { this.t = new Date(this.t.getTime() + ms); return this.now(); }
  set(iso) { this.t = new Date(iso); return this.now(); }
}

export async function makeService() {
  const dir = await mkdtemp(join(tmpdir(), 'fx-'));
  const clock = new FakeClock();
  const store = new EventStore(join(dir, 'events.log'), () => clock.now());
  await store.load();
  const service = new TransferService(store, () => clock.now());
  const cleanup = async () => rm(dir, { recursive: true, force: true });
  return { dir, clock, store, service, cleanup };
}

export const ACTORS = {
  student: { id: 'stu_1', role: 'applicant' },
  student2: { id: 'stu_2', role: 'applicant' },
  parent: { id: 'agent_ma', role: 'agent' },
  parent2: { id: 'agent_pa', role: 'agent' },
  reviewer: { id: 'rev_1', role: 'reviewer' },
  admin: { id: 'adm_1', role: 'admin' },
  bank: { id: 'bank_1', role: 'bank' },
  school: { id: 'school_1', role: 'school' },
};

const PAYEE = { name: 'New York University', account: 'GB29NWBK60161331926819', bank: 'NWBKGB2L' };
export { PAYEE };

const docFor = (slot, version = 1, overrides = {}) => ({
  slot,
  fileName: `${slot}-v${version}.pdf`,
  sha256: `hash-${slot}-${version}`,
  issuedAt: '2026-08-01T00:00:00.000Z',
  ...(overrides),
});

let openSeq = 0;

// 开立一笔要素齐全的学费汇款；minor=true 时同时授予监护人授权并补齐代理材料。
export async function openReadyTransfer(service, { minor = false, amount = 30000 } = {}) {
  openSeq += 1;
  const openKey = `open-${process.pid}-${openSeq}`;
  const authId = minor
    ? (await service.grantAuthorization(ACTORS.admin, {
      applicantId: ACTORS.student.id, agentId: ACTORS.parent.id,
      agentName: '张母', relationship: 'mother', minorRelated: true,
      expiresAt: '2027-01-01T00:00:00.000Z',
      idempotencyKey: `grant-${openKey}`,
    })).authorizationId
    : null;

  const { transferId } = await service.openTransfer(ACTORS.student, {
    applicantName: '张同学',
    minor,
    payee: PAYEE,
    purpose: 'tuition',
    amount: { value: amount, currency: 'USD' },
    deadline: { localDateTime: '2026-12-31T23:59:59', tz: 'America/New_York' },
    idempotencyKey: openKey,
  });

  const upload = async (slot, actor = ACTORS.student, extra = {}) =>
    service.uploadDocument(actor, transferId, docFor(slot, 1, extra));

  await upload('admission_letter');
  await upload('tuition_notice', ACTORS.student, { noticeAmount: { value: amount, currency: 'USD' } });
  await upload('income_proof', ACTORS.student, {
    expiresAt: '2027-06-30T00:00:00.000Z', sha256: 'hash-income-1',
  });
  await upload('passport');
  await upload('fx_application');
  if (minor) {
    await upload('authorization_letter', ACTORS.parent, {
      expiresAt: '2027-01-01T00:00:00.000Z', sha256: 'hash-authletter-1',
    });
    await upload('agent_id', ACTORS.parent, { sha256: 'hash-agentid-1' });
  }
  return { transferId, authId };
}

export async function submitApproveIssue(service, transferId) {
  await service.submitForReview(ACTORS.student, transferId);
  await service.approve(ACTORS.reviewer, transferId, { note: '材料齐备，额度内' });
  const { instructionRef } = await service.issueInstruction(ACTORS.reviewer, transferId);
  return instructionRef;
}
