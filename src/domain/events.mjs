import { createHash } from 'node:crypto';
import { newEventId } from './ids.mjs';

// 所有事实都以追加事件记录；状态只能由事件回放得到，不做原地更新。
// 每条事件携带 seq 与 prevHash，形成按流串联的哈希链，供月末核账验证完整性。

export const EVT = Object.freeze({
  TransferOpened: 'TransferOpened',
  PayeeUpdated: 'PayeeUpdated',
  PurposeUpdated: 'PurposeUpdated',
  AmountChanged: 'AmountChanged',
  DeadlineUpdated: 'DeadlineUpdated',
  MinorFlagUpdated: 'MinorFlagUpdated',

  AgentAuthorizationGranted: 'AgentAuthorizationGranted',
  AgentAuthorizationRevoked: 'AgentAuthorizationRevoked',
  AgentReplaced: 'AgentReplaced',

  DocumentUploaded: 'DocumentUploaded',
  DocumentSuperseded: 'DocumentSuperseded',
  DuplicateUploadDeduped: 'DuplicateUploadDeduped',

  SubmittedForReview: 'SubmittedForReview',
  ReviewWithdrawn: 'ReviewWithdrawn', // 授权撤回等导致在审/已通过未发送的提交失效，回到草稿
  ReviewApproved: 'ReviewApproved',
  InstructionIssued: 'InstructionIssued',
  ReviewRejected: 'ReviewRejected',

  AmountChangeAcknowledged: 'AmountChangeAcknowledged',

  SchoolRefundReceived: 'SchoolRefundReceived',
  RefundSettled: 'RefundSettled',
  BankReceiptReceived: 'BankReceiptReceived',
  BankReceiptMatched: 'BankReceiptMatched',
  BankReceiptHeld: 'BankReceiptHeld', // 找不到对应指令，先挂起，保证乱序可重放

  NoteAdded: 'NoteAdded',
});

// 系统流：授权关系与幂等登记独立成流，挂起的银行回执记录在 receipt 流。
export const STREAM_AUTHZ = 'authz';
export const STREAM_RECEIPTS = 'receipts';
export const STREAM_IDEMPOTENCY = 'idempotency';
export const SYSTEM_STREAMS = new Set([
  STREAM_AUTHZ, STREAM_RECEIPTS, STREAM_IDEMPOTENCY,
]);

export function canonicalHash(obj) {
  return createHash('sha256').update(stableStringify(obj)).digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function envelope({ stream, seq, type, data, actor, ts, prevHash, idempotencyKey }) {
  const eventId = newEventId();
  // 统一做 JSON 往返：Date 等类型一律按落盘形态参与哈希，保证回放一致。
  const eventData = JSON.parse(JSON.stringify(data ?? {}));
  const event = {
    eventId,
    stream,
    seq,
    ts,
    type,
    actor: actor ? { id: actor.id, role: actor.role } : null,
    data: eventData,
    idempotencyKey: idempotencyKey ?? null,
    prevHash,
  };
  event.hash = canonicalHash({
    eventId: event.eventId,
    stream: event.stream,
    seq: event.seq,
    ts: event.ts,
    type: event.type,
    actor: event.actor,
    data: event.data,
    idempotencyKey: event.idempotencyKey,
    prevHash: event.prevHash,
  });
  return event;
}

export class DomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}
