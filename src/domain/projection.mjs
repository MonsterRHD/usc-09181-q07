import { EVT, STREAM_AUTHZ, STREAM_RECEIPTS } from './events.mjs';
import { DOC_SLOTS, requiredSlots, DEFAULT_QUOTA_LIMIT_USD, QUOTA_CURRENCY } from './catalog.mjs';
import { parseInstant } from './clock.mjs';

// 纯函数式回放：输入全部事件，输出只读模型。重启后重新回放即可得到完全一致的状态。

const EDITABLE_STATUSES = new Set(['draft', 'rejected', 'in_review', 'approved']);

function usdOf(amount) {
  if (!amount) return 0;
  if (amount.currency === QUOTA_CURRENCY) return amount.value;
  if (typeof amount.usdEquivalent === 'number') return amount.usdEquivalent;
  return NaN;
}

function reduceAuthz(events) {
  const records = new Map();
  for (const e of events) {
    if (e.stream !== STREAM_AUTHZ) continue;
    switch (e.type) {
      case EVT.AgentAuthorizationGranted: {
        records.set(e.data.authorizationId, {
          authorizationId: e.data.authorizationId,
          agentId: e.data.agentId,
          agentName: e.data.agentName,
          applicantId: e.data.applicantId,
          relationship: e.data.relationship,
          transferIds: e.data.transferIds ?? null,
          grantedAt: e.ts,
          expiresAt: e.data.expiresAt,
          revokedAt: null,
          revokeReason: null,
          replacedBy: null,
          minorRelated: !!e.data.minorRelated,
        });
        break;
      }
      case EVT.AgentAuthorizationRevoked: {
        const rec = records.get(e.data.authorizationId);
        if (rec) {
          rec.revokedAt = e.ts;
          rec.revokeReason = e.data.reason;
        }
        break;
      }
      case EVT.AgentReplaced: {
        const old = records.get(e.data.previousAuthorizationId);
        if (old) old.replacedBy = e.data.newAuthorizationId;
        break;
      }
      default:
    }
  }
  return records;
}

// 授权在某时刻是否有效：已授予、未过期、未撤回。撤回前的历史行为仍留在审计中。
export function authorizationActiveAt(rec, at) {
  if (!rec) return false;
  const t = new Date(at).getTime();
  if (new Date(rec.grantedAt).getTime() > t) return false;
  if (rec.expiresAt && new Date(rec.expiresAt).getTime() <= t) return false;
  if (rec.revokedAt && new Date(rec.revokedAt).getTime() <= t) return false;
  return true;
}

function activeAuthzFor(authzRecords, { applicantId, transferId, agentId, at }) {
  for (const rec of authzRecords.values()) {
    if (rec.applicantId !== applicantId) continue;
    if (agentId && rec.agentId !== agentId) continue;
    if (rec.transferIds && !rec.transferIds.includes(transferId)) continue;
    if (authorizationActiveAt(rec, at)) return rec;
  }
  return null;
}

function reduceTransfer(transferId, events, authzRecords) {
  const s = {
    transferId,
    status: 'draft',
    applicantId: null,
    applicantName: null,
    minor: false,
    payee: null,
    purpose: null,
    amount: null,
    quotaYear: null,
    deadline: null,
    documents: new Map(), // slot -> { versions: [] }
    amountAckNoticeVersion: 0,
    latestNoticeVersion: 0,
    submissions: [],
    rejection: null,
    approval: null,
    instruction: null,
    refunds: [],
    notes: [],
    createdAt: null,
    createdBy: null,
    revision: 0,
  };

  const current = (slot) => {
    const bucket = s.documents.get(slot);
    if (!bucket || bucket.versions.length === 0) return null;
    return bucket.versions[bucket.versions.length - 1];
  };

  for (const e of events) {
    if (e.stream !== transferId
      && !(e.type === EVT.BankReceiptMatched && e.data.transferId === transferId)) continue;
    const d = e.data;
    switch (e.type) {
      case EVT.TransferOpened:
        s.applicantId = d.applicantId;
        s.applicantName = d.applicantName;
        s.minor = !!d.minor;
        s.payee = d.payee;
        s.purpose = d.purpose;
        s.amount = d.amount;
        s.quotaYear = d.quotaYear;
        s.deadline = d.deadline ?? null;
        s.createdAt = e.ts;
        s.createdBy = e.actor;
        break;
      case EVT.PayeeUpdated:
        s.payee = d.payee;
        break;
      case EVT.PurposeUpdated:
        s.purpose = d.purpose;
        break;
      case EVT.AmountChanged:
        s.amount = d.amount;
        // 仅“以新通知单为准”的金额变化推进待确认版本号；手动改额只令在审提交失效。
        if (d.tuitionNoticeVersion) {
          s.latestNoticeVersion = Math.max(s.latestNoticeVersion, d.tuitionNoticeVersion);
        }
        // 审核中/已通过但未发送指令时，关键要素变化使既有提交失效。
        if (s.status === 'in_review' || s.status === 'approved') s.status = 'draft';
        break;
      case EVT.DeadlineUpdated:
        s.deadline = d.deadline;
        break;
      case EVT.MinorFlagUpdated:
        s.minor = !!d.minor;
        break;
      case EVT.DocumentUploaded: {
        if (!s.documents.has(d.slot)) s.documents.set(d.slot, { versions: [] });
        const bucket = s.documents.get(d.slot);
        const version = {
          version: d.version,
          documentId: d.documentId,
          fileName: d.fileName,
          sha256: d.sha256,
          issuedAt: d.issuedAt ?? null,
          expiresAt: d.expiresAt ?? null,
          noticeAmount: d.noticeAmount ?? null,
          uploadedBy: e.actor,
          uploadedAt: e.ts,
          supersededAt: null,
          afterSent: !!d.afterSent,
          reusedOnTransfers: d.reusedOnTransfers ?? [],
        };
        bucket.versions.push(version);
        if (d.slot === 'tuition_notice' && d.noticeAmount
          && (!s.amount || d.noticeAmount.value !== s.amount.value
            || d.noticeAmount.currency !== s.amount.currency)) {
          // 新通知单金额与当前登记金额不一致：挂出金额变化待办；
          // 在审/已通过未发送的提交依据的是旧材料，必须回到草稿重新提交。
          s.latestNoticeVersion = Math.max(s.latestNoticeVersion, d.version);
          if (s.status === 'in_review' || s.status === 'approved') s.status = 'draft';
        }
        break;
      }
      case EVT.DocumentSuperseded: {
        const bucket = s.documents.get(d.slot);
        const old = bucket?.versions.find((v) => v.version === d.oldVersion);
        if (old) old.supersededAt = e.ts;
        break;
      }
      case EVT.DuplicateUploadDeduped:
        // 重复上传不产生新版本，仅留下可审计的去重记录。
        break;
      case EVT.SubmittedForReview:
        s.status = 'in_review';
        s.submissions.push({ at: e.ts, by: e.actor, documentVersions: d.documentVersions });
        s.rejection = null;
        break;
      case EVT.ReviewWithdrawn:
        if (s.status === 'in_review' || s.status === 'approved') s.status = 'draft';
        break;
      case EVT.ReviewApproved:
        s.status = 'approved';
        s.approval = { at: e.ts, by: e.actor, basis: d.basis };
        s.rejection = null;
        break;
      case EVT.InstructionIssued:
        s.status = 'sent';
        s.instruction = {
          instructionRef: d.instructionRef,
          at: e.ts,
          by: e.actor,
          snapshot: d.snapshot,
        };
        break;
      case EVT.ReviewRejected:
        s.status = 'rejected';
        s.rejection = { at: e.ts, by: e.actor, reasons: d.reasons, basis: d.basis, policyVersion: d.policyVersion };
        break;
      case EVT.AmountChangeAcknowledged:
        s.amountAckNoticeVersion = d.noticeVersion;
        break;
      case EVT.SchoolRefundReceived:
        s.refunds.push({
          refundId: d.refundId,
          amount: d.amount,
          reason: d.reason,
          schoolRef: d.schoolRef,
          receivedAt: e.ts,
          settledAt: null,
          quotaReleased: 0,
        });
        break;
      case EVT.RefundSettled: {
        const r = s.refunds.find((x) => x.refundId === d.refundId);
        if (r) {
          r.settledAt = e.ts;
          r.quotaReleased = d.quotaReleasedUsd;
        }
        break;
      }
      case EVT.BankReceiptMatched:
        if (d.transferId === transferId) {
          s.receiptMatched = {
            receiptId: d.receiptId,
            instructionRef: d.instructionRef,
            matchedAt: e.ts,
            outOfOrder: !!d.outOfOrder,
          };
        }
        break;
      case EVT.NoteAdded:
        s.notes.push({ at: e.ts, by: e.actor, text: d.text });
        break;
      default:
    }
    s.revision += 1;
    s.updatedAt = e.ts;
  }

  // 回执已匹配：无退款即视为结清；有退款则全部结算后才结清。
  if (s.status === 'sent' && s.receiptMatched
    && (s.refunds.length === 0 || s.refunds.every((r) => r.settledAt))) {
    s.status = 'settled';
  }
  return s;
}

// 版本的时效状态：被替换即 superseded；否则按 expiresAt 判定 expired。
// 关键规则：被替换的旧版即使仍在有效期内也不会“复活”为当前版本。
export function versionStatus(version, now) {
  if (version.supersededAt) return 'superseded';
  if (version.expiresAt && new Date(version.expiresAt).getTime() <= new Date(now).getTime()) return 'expired';
  return 'active';
}

export function currentVersion(state, slot, now) {
  const bucket = state.documents.get(slot);
  if (!bucket || bucket.versions.length === 0) return null;
  const v = bucket.versions[bucket.versions.length - 1];
  return { ...v, status: versionStatus(v, now) };
}

// 派生待办：缺件、过期、金额变化、授权、截止时间、退款、回执。
export function deriveTodos(state, authzRecords, now) {
  const todos = [];
  if (!state.applicantId) return todos;
  // 指令发送后，发送前的阻断项不再适用（只保留回执/退款等待办）。
  const settled = ['sent', 'settled'].includes(state.status);

  if (!settled) {
    if (!state.payee) todos.push({ code: 'MISSING_PAYEE', severity: 'blocker', message: '缺少收款方信息' });
    if (!state.amount) todos.push({ code: 'MISSING_AMOUNT', severity: 'blocker', message: '缺少汇款金额' });
    if (!state.purpose) todos.push({ code: 'MISSING_PURPOSE', severity: 'blocker', message: '缺少汇款用途' });
  }

  const hasAgent = !!activeAuthzFor(authzRecords, {
    applicantId: state.applicantId,
    transferId: state.transferId,
    at: now,
  });
  const usesAgent = state.minor || hasAgent;

  if (!settled) {
    for (const slot of requiredSlots(usesAgent)) {
      const cur = currentVersion(state, slot, now);
      if (!cur) {
        todos.push({ code: 'MISSING_DOCUMENT', severity: 'blocker', slot, label: DOC_SLOTS[slot].label,
          message: `缺少必备材料：${DOC_SLOTS[slot].label}` });
      } else if (cur.status === 'expired') {
        todos.push({ code: 'DOCUMENT_EXPIRED', severity: 'blocker', slot, label: DOC_SLOTS[slot].label,
          version: cur.version, expiresAt: cur.expiresAt,
          message: `${DOC_SLOTS[slot].label}（第 ${cur.version} 版）已于 ${cur.expiresAt} 过期，请上传新版本` });
      }
    }

    if (usesAgent && !hasAgent) {
      todos.push({ code: 'AGENT_AUTHORIZATION_MISSING', severity: 'blocker',
        message: state.minor ? '未成年申请人需要有效的监护人代办授权' : '当前无有效代办授权，代理行为将被拒绝' });
    }
  }

  if (state.latestNoticeVersion > state.amountAckNoticeVersion && state.status !== 'sent' && state.status !== 'settled') {
    todos.push({ code: 'AMOUNT_CHANGED_UNACKNOWLEDGED', severity: 'blocker',
      noticeVersion: state.latestNoticeVersion,
      message: '学费通知单出现新版本或金额发生变化，需确认后才能继续审核' });
  }

  if (state.deadline && !['sent', 'settled'].includes(state.status)) {
    const due = new Date(state.deadline.instant).getTime();
    if (due <= new Date(now).getTime()) {
      todos.push({ code: 'DEADLINE_PASSED', severity: 'blocker', deadlineAt: state.deadline.instant, tz: state.deadline.tz,
        message: `学校缴费截止时间（${state.deadline.tz}）已过，需学校确认后另行处理` });
    }
  }

  for (const r of state.refunds) {
    if (!r.settledAt) {
      todos.push({ code: 'REFUND_PENDING_SETTLEMENT', severity: 'task', refundId: r.refundId,
        amount: r.amount, message: `学校退款 ${r.amount.value} ${r.amount.currency} 待核对并回退购汇额度` });
    }
  }

  if (['sent'].includes(state.status) && !state.receiptMatched) {
    todos.push({ code: 'BANK_RECEIPT_PENDING', severity: 'task',
      message: '指令已发送，尚未匹配到银行回执' });
  }

  return todos;
}

export function blockingTodos(todos) {
  return todos.filter((t) => t.severity === 'blocker');
}

function reduceReceipts(events) {
  const receipts = new Map();
  for (const e of events) {
    if (e.stream !== STREAM_RECEIPTS) continue;
    const d = e.data;
    if (e.type === EVT.BankReceiptReceived) {
      receipts.set(d.receiptId, {
        receiptId: d.receiptId,
        bankRef: d.bankRef,
        instructionRef: d.instructionRef ?? null,
        amount: d.amount,
        payee: d.payee ?? null,
        receivedAt: e.ts,
        status: 'received',
        match: null,
      });
    } else if (e.type === EVT.BankReceiptHeld) {
      const r = receipts.get(d.receiptId);
      if (r) {
        r.status = 'held';
        r.holdReason = d.reason;
      }
    } else if (e.type === EVT.BankReceiptMatched) {
      const r = receipts.get(d.receiptId);
      if (r) {
        r.status = 'matched';
        r.match = { at: e.ts, instructionRef: d.instructionRef, transferId: d.transferId, outOfOrder: !!d.outOfOrder };
      }
    }
  }
  return receipts;
}

export function buildReadModel(store, now = new Date().toISOString()) {
  const all = store.allEvents();
  const authz = reduceAuthz(all);
  const receipts = reduceReceipts(all);

  const transferIds = new Set();
  for (const e of all) {
    if (![STREAM_AUTHZ, STREAM_RECEIPTS].includes(e.stream)) transferIds.add(e.stream);
  }

  const transfers = new Map();
  for (const id of transferIds) {
    transfers.set(id, reduceTransfer(id, all, authz));
  }

  // 全局 sha256 -> 使用位置，用于识别跨汇款重复材料。
  const contentIndex = new Map();
  for (const [id, st] of transfers) {
    for (const [slot, bucket] of st.documents) {
      for (const v of bucket.versions) {
        const key = `${v.sha256}|${slot}`;
        if (!contentIndex.has(key)) contentIndex.set(key, []);
        contentIndex.get(key).push({ transferId: id, slot, version: v.version, documentId: v.documentId });
      }
    }
  }

  // 额度：已发送指令占用，已结算退款释放；按申请人 + 额度年度。
  const quotaUsed = new Map();
  for (const st of transfers.values()) {
    if (st.instruction) {
      const key = `${st.applicantId}|${st.quotaYear}`;
      quotaUsed.set(key, (quotaUsed.get(key) ?? 0) + usdOf(st.instruction.snapshot.amount));
      for (const r of st.refunds) {
        if (r.settledAt) quotaUsed.set(key, (quotaUsed.get(key) ?? 0) - (r.quotaReleased || 0));
      }
    }
  }

  return {
    now,
    authz,
    receipts,
    transfers,
    contentIndex,
    quotaUsed,
    quotaLimitUsd: Number(process.env.QUOTA_LIMIT_USD || DEFAULT_QUOTA_LIMIT_USD),
    activeAuthzFor: (q) => activeAuthzFor(authz, { ...q, at: q.at ?? now }),
    todosOf: (id) => deriveTodos(transfers.get(id), authz, now),
  };
}

export { usdOf, EDITABLE_STATUSES, parseInstant };
