import { EVT, STREAM_AUTHZ, STREAM_RECEIPTS } from './events.mjs';
import { monthRange } from './clock.mjs';

// 月末核账：对一个自然月（可指定时区）重放全量事件，
// 输出代理更换、重复材料、退款、回执乱序四类专项结果，
// 并校验权限快照、状态机与审计哈希链。全部为只读计算。

function inRange(ts, range) {
  const t = new Date(ts).getTime();
  return t >= range.start.getTime() && t < range.end.getTime();
}

export function reconcile(store, { yearMonth, tz = 'Asia/Shanghai' } = {}) {
  if (!yearMonth) throw new Error('核账需要 yearMonth');
  const range = monthRange(yearMonth, tz);
  store.verifyChain();
  const all = store.allEvents();

  // ---- 1. 代理更换 / 授权撤回 ----
  const authzEvents = all.filter((e) => e.stream === STREAM_AUTHZ);
  const agentChanges = [];
  const grantsById = new Map();
  for (const e of authzEvents) {
    if (e.type === EVT.AgentAuthorizationGranted) grantsById.set(e.data.authorizationId, e);
  }
  for (const e of authzEvents) {
    if (!inRange(e.ts, range)) continue;
    if (e.type === EVT.AgentAuthorizationGranted) {
      agentChanges.push({ kind: 'granted', at: e.ts, authorizationId: e.data.authorizationId,
        applicantId: e.data.applicantId, agentId: e.data.agentId, by: e.actor, minorRelated: !!e.data.minorRelated });
    } else if (e.type === EVT.AgentAuthorizationRevoked) {
      agentChanges.push({ kind: 'revoked', at: e.ts, authorizationId: e.data.authorizationId,
        reason: e.data.reason, by: e.actor,
        applicantId: grantsById.get(e.data.authorizationId)?.data.applicantId ?? null });
    } else if (e.type === EVT.AgentReplaced) {
      agentChanges.push({ kind: 'replaced', at: e.ts,
        previousAuthorizationId: e.data.previousAuthorizationId,
        newAuthorizationId: e.data.newAuthorizationId, by: e.actor });
    }
  }

  // ---- 2. 重复材料（同月内的去重事件 + 跨汇款同内容） ----
  const duplicateUploads = all
    .filter((e) => e.type === EVT.DuplicateUploadDeduped && inRange(e.ts, range))
    .map((e) => ({ at: e.ts, transferId: e.stream, slot: e.data.slot, sha256: e.data.sha256,
      keptVersion: e.data.keptVersion, by: e.actor }));

  const contentUses = new Map(); // sha|slot -> uses[]
  for (const e of all) {
    if (e.type !== EVT.DocumentUploaded) continue;
    const key = `${e.data.sha256}|${e.data.slot}`;
    if (!contentUses.has(key)) contentUses.set(key, []);
    contentUses.get(key).push({ transferId: e.stream, version: e.data.version, at: e.ts });
  }
  const crossTransferDuplicates = [...contentUses.entries()]
    .map(([key, uses]) => ({ key, transfers: [...new Set(uses.map((u) => u.transferId))], uses }))
    .filter((x) => x.transfers.length > 1
      && x.uses.some((u) => inRange(u.at, range)));

  // ---- 3. 学校退款与额度回退 ----
  const refunds = all
    .filter((e) => e.type === EVT.SchoolRefundReceived || e.type === EVT.RefundSettled)
    .filter((e) => inRange(e.ts, range))
    .map((e) => ({ kind: e.type === EVT.SchoolRefundReceived ? 'received' : 'settled',
      transferId: e.stream, at: e.ts, ...e.data }));

  // ---- 4. 银行回执乱序 / 晚到 ----
  const receiptsOutOfOrder = all
    .filter((e) => e.stream === STREAM_RECEIPTS && e.type === EVT.BankReceiptMatched
      && e.data.outOfOrder && inRange(e.ts, range))
    .map((e) => ({ at: e.ts, receiptId: e.data.receiptId, transferId: e.data.transferId,
      instructionRef: e.data.instructionRef }));
  const receiptsHeld = all
    .filter((e) => e.stream === STREAM_RECEIPTS && e.type === EVT.BankReceiptHeld)
    .map((e) => e.data.receiptId);
  const receiptsMatched = new Set(all
    .filter((e) => e.stream === STREAM_RECEIPTS && e.type === EVT.BankReceiptMatched)
    .map((e) => e.data.receiptId));
  const receiptsStillHeld = receiptsHeld.filter((id) => !receiptsMatched.has(id));

  // ---- 5. 状态/权限一致性检查 ----
  const violations = [];
  for (const e of all) {
    // 已发送指令之后，收款方/用途/金额不允许再出现变更事件。
    if ([EVT.PayeeUpdated, EVT.PurposeUpdated, EVT.AmountChanged].includes(e.type)) {
      const prior = all.filter((x) => x.stream === e.stream && x.type === EVT.InstructionIssued
        && new Date(x.ts).getTime() <= new Date(e.ts).getTime());
      if (prior.length > 0) {
        violations.push({ code: 'POST_SENT_MUTATION', transferId: e.stream, eventType: e.type, at: e.ts });
      }
    }
    // 驳回必须附理由。
    if (e.type === EVT.ReviewRejected && (!e.data.reasons || e.data.reasons.length === 0)) {
      violations.push({ code: 'REJECTION_WITHOUT_REASON', transferId: e.stream, at: e.ts });
    }
  }

  return {
    yearMonth, tz,
    window: { start: range.start.toISOString(), end: range.end.toISOString() },
    chainVerified: true,
    agentChanges,
    duplicateUploads,
    crossTransferDuplicates,
    refunds,
    receiptsOutOfOrder,
    receiptsStillHeld,
    violations,
    totals: {
      agentChanges: agentChanges.length,
      duplicateUploads: duplicateUploads.length,
      crossTransferDuplicateGroups: crossTransferDuplicates.length,
      refunds: refunds.length,
      receiptsOutOfOrder: receiptsOutOfOrder.length,
      violations: violations.length,
    },
  };
}
