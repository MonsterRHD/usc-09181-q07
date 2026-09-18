import { DOC_SLOTS } from './catalog.mjs';
import { currentVersion, deriveTodos } from './projection.mjs';
import { authorizationActiveAt } from './projection.mjs';

// 最小化展示：涉及未成年人时，按“需要知道”裁剪。
// - 申请人本人 / 其当前有效监护人代理 / 审核员 / 管理员：可见办理所需信息；
// - 其他代理（授权已撤回或过期）：仅见状态与待办，不见未成年人身份与文件明细；
// - 学校 / 银行：只见办理该环节必需的收款、金额、指令引用，不见任何学生 PII。

function maskName(name) {
  if (!name) return null;
  if (name.length <= 1) return '*';
  return `${name[0]}${'*'.repeat(Math.max(1, name.length - 1))}`;
}

function viewerAuthz(model, state, viewer) {
  if (viewer?.role !== 'agent') return null;
  for (const rec of model.authz.values()) {
    if (rec.applicantId !== state.applicantId || rec.agentId !== viewer.id) continue;
    if (rec.transferIds && !rec.transferIds.includes(state.transferId)) continue;
    return rec;
  }
  return null;
}

export function visibilityLevel(model, state, viewer) {
  if (!viewer) return 'none';
  if (viewer.role === 'reviewer' || viewer.role === 'admin') return 'full';
  if (viewer.role === 'applicant' && viewer.id === state.applicantId) return 'full';
  if (viewer.role === 'agent') {
    const rec = viewerAuthz(model, state, viewer);
    if (rec && authorizationActiveAt(rec, model.now)) return 'full';
    if (rec) return 'limited'; // 曾被授权但已撤回/过期
    return 'none';
  }
  if (viewer.role === 'bank' || viewer.role === 'school') return 'counterparty';
  return 'none';
}

function presentDocuments(state, level, now) {
  const out = [];
  for (const [slot, bucket] of state.documents) {
    for (const v of bucket.versions) {
      const cur = bucket.versions[bucket.versions.length - 1];
      const item = {
        slot, label: DOC_SLOTS[slot]?.label ?? slot,
        version: v.version, documentId: v.documentId,
        status: v === cur ? currentVersion(state, slot, now)?.status : 'superseded',
        uploadedAt: v.uploadedAt,
        expiresAt: v.expiresAt ?? null,
        afterSent: v.afterSent,
      };
      if (level === 'full') {
        item.fileName = v.fileName;
        item.sha256 = v.sha256;
        item.issuedAt = v.issuedAt;
        item.reusedOnTransfers = v.reusedOnTransfers;
        if (v.noticeAmount) item.noticeAmount = v.noticeAmount;
      } else if (level === 'limited') {
        item.fileName = null; // 已失去授权：可见有哪类材料与版本，不可见文件标识
        item.sha256 = null;
      } else {
        // counterparty / none：不返回文件
        continue;
      }
      out.push(item);
    }
  }
  return out;
}

export function presentTransfer(model, state, viewer) {
  const level = visibilityLevel(model, state, viewer);
  const now = model.now;
  const base = {
    transferId: state.transferId,
    status: state.status,
    purpose: state.purpose,
    todos: deriveTodos(state, model.authz, now),
    visibility: level,
  };
  if (level === 'none') return { ...base, visibility: 'none' };

  if (level === 'counterparty') {
    // 银行/学校办理所需的最小集合。
    return {
      ...base,
      amount: state.amount,
      instructionRef: state.instruction?.instructionRef ?? null,
      payee: viewer.role === 'bank' ? state.payee : { name: state.payee?.name ?? null, account: null },
      refunds: state.refunds.map((r) => ({ refundId: r.refundId, amount: r.amount, settledAt: r.settledAt })),
    };
  }

  const minor = state.minor;
  const view = {
    ...base,
    applicantId: state.applicantId,
    applicantName: minor && level !== 'full' ? maskName(state.applicantName) : state.applicantName,
    minor, // 办理方需要知道这是未成年人业务；姓名等 PII 已按级别脱敏
    payee: state.payee,
    amount: state.amount,
    quotaYear: state.quotaYear,
    deadline: state.deadline,
    documents: presentDocuments(state, level, now),
    submissions: state.submissions.map((x) => ({ at: x.at, by: x.by })),
    rejection: state.rejection, // 审核员必须能解释拒绝依据
    approval: state.approval ? { at: state.approval.at, by: state.approval.by, basis: state.approval.basis } : null,
    instruction: state.instruction
      ? { instructionRef: state.instruction.instructionRef, at: state.instruction.at,
          by: state.instruction.by, snapshot: state.instruction.snapshot }
      : null,
    refunds: state.refunds,
    receipt: state.receiptMatched ?? null,
    notes: level === 'full' ? state.notes : [],
    createdAt: state.createdAt,
  };

  // 已发送指令的快照是凭证：任何视角都标注其不可变性。
  if (view.instruction) view.instruction.immutable = true;
  return view;
}

export function presentQueue(model, viewer) {
  const rows = [];
  for (const state of model.transfers.values()) {
    const level = visibilityLevel(model, state, viewer);
    if (level === 'none') continue;
    rows.push({
      transferId: state.transferId,
      status: state.status,
      applicantName: state.minor && level !== 'full' ? maskName(state.applicantName) : state.applicantName,
      minor: state.minor,
      amount: state.amount,
      purpose: state.purpose,
      blockers: deriveTodos(state, model.authz, model.now).filter((t) => t.severity === 'blocker').length,
      instructionRef: state.instruction?.instructionRef ?? null,
      updatedAt: state.updatedAt ?? state.createdAt,
    });
  }
  return rows;
}
