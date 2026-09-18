/**
 * 汇款材料协同 —— 领域核心（纯函数，无 IO）。
 *
 * 设计要点：
 * - 事件溯源：状态只能由 decide() 产出事件、applyEvent() 折叠得到，进程重启后重放日志即可恢复。
 * - 所有时间判断都从外部传入 now（毫秒），跨时区截止/晚到回执因此可以确定性重放。
 * - 待办（todo）不落库，每次由当前状态实时派生：缺件、过期、金额变化、退款、回执异常。
 * - 审核通过即锁定材料；PaymentInstructionSent 携带快照，之后新增文件不能回溯改变已发指令。
 */
import { fail } from './errors.mjs';

export const ROLES = Object.freeze({
  APPLICANT: 'applicant',
  PARENT_AGENT: 'parent_agent', // 家长代理
  REVIEWER: 'reviewer', // 审核员
  BANK_GATEWAY: 'bank_gateway', // 银行渠道（回执）
});

const ACTIVE_SCOPES = Object.freeze({
  document: 'document:write',
  submission: 'payment:submit',
  refund: 'refund:write',
});

// 默认必备材料；存在生效中的家长代理授权时，额外要求授权书。
export const DEFAULT_REQUIRED_DOCS = Object.freeze([
  'admission_letter', // 录取通知书
  'tuition_invoice', // 学费账单
  'income_proof', // 收入证明（容易过期、容易重复提交的重点文件）
  'passport_or_id', // 证件
]);
export const DOC_REQUIRED_WITH_AGENT = 'authorization_letter'; // 代理授权书

export const EXPIRING_SOON_MS = 30 * 24 * 60 * 60 * 1000;

export const initialState = () => ({
  id: null,
  status: 'draft', // draft | submitted | approved | rejected | instructed
  studentName: null,
  studentMinor: false,
  deadline: null, // ISO 字符串，按绝对时刻比较，跨时区不会错位
  currency: null,
  payee: null, // { schoolName, accountRef, bankName }
  purpose: null, // { term, academicYear }
  amount: null,
  amountAck: true, // 金额变化后需申请人/代理确认，确认前为阻断待办
  participants: new Map(),
  files: new Map(), // docId -> { docId, docType, versions: [...] }
  authorizations: new Map(), // agentParticipantId -> 授权关系
  review: null, // { decision, reason, reviewerId, at }
  instruction: null, // { instructionId, amount, currency, payee, purpose, at }
  receipts: [], // 全部追加，乱序/重复也保留，靠时间戳推导当前态
  refunds: [], // { refundId, amount, currency, schoolRefId, reason, at, acknowledgedAt }
  seq: 0,
});

/* ---------------- 事件折叠 ---------------- */

export function applyEvent(state, e) {
  const d = e.data;
  switch (e.type) {
    case 'TransferOpened':
      state.id = d.transferId;
      state.studentName = d.studentName;
      state.studentMinor = !!d.studentMinor;
      state.deadline = d.deadline ?? null;
      state.currency = d.currency ?? null;
      break;
    case 'ParticipantAdded':
      state.participants.set(d.participantId, {
        id: d.participantId,
        role: d.role,
        displayName: d.displayName ?? null,
        at: e.at,
      });
      break;
    case 'PayeeSet':
      state.payee = { schoolName: d.schoolName, accountRef: d.accountRef, bankName: d.bankName ?? null };
      break;
    case 'PurposeSet':
      state.purpose = { term: d.term, academicYear: d.academicYear };
      break;
    case 'CurrencySet':
      state.currency = d.currency;
      break;
    case 'PaymentAmountSet':
      state.amount = d.amount;
      // 已提交过材料后再改金额，必须重新确认，防止旧收入证明覆盖新金额的审核依据
      state.amountAck = d.firstSet === true;
      break;
    case 'AmountConsistencyConfirmed':
      state.amountAck = true;
      break;
    case 'DocumentUploaded':
      state.files.set(d.docId, {
        docId: d.docId,
        docType: d.docType,
        versions: [
          {
            version: 1,
            filename: d.filename,
            sha256: d.sha256,
            validFrom: d.validFrom,
            validUntil: d.validUntil ?? null,
            uploaderId: e.actor,
            at: e.at,
          },
        ],
      });
      break;
    case 'DocumentVersionAdded': {
      const f = state.files.get(d.docId);
      f.versions.push({
        version: d.version,
        filename: d.filename,
        sha256: d.sha256,
        validFrom: d.validFrom,
        validUntil: d.validUntil ?? null,
        uploaderId: e.actor,
        at: e.at,
        supersedesVersion: d.supersedesVersion,
        replaceReason: d.replaceReason ?? null,
      });
      break;
    }
    case 'AuthorizationGranted':
      state.authorizations.set(d.agentParticipantId, {
        grantId: d.grantId,
        agentParticipantId: d.agentParticipantId,
        scopes: d.scopes,
        status: 'active',
        grantedAt: e.at,
        revokedAt: null,
        revokeReason: null,
      });
      break;
    case 'AuthorizationRevoked': {
      const g = state.authorizations.get(d.agentParticipantId);
      if (g) Object.assign(g, { status: 'revoked', revokedAt: e.at, revokeReason: d.reason ?? null });
      break;
    }
    case 'SubmittedForReview':
      state.status = 'submitted';
      break;
    case 'ReviewApproved':
      state.status = 'approved';
      state.review = { decision: 'approved', reason: d.reason ?? null, reviewerId: e.actor, at: e.at };
      break;
    case 'ReviewRejected':
      state.status = 'rejected';
      state.review = { decision: 'rejected', reason: d.reason, reviewerId: e.actor, at: e.at };
      break;
    case 'PaymentInstructionSent':
      state.status = 'instructed';
      state.instruction = {
        instructionId: d.instructionId,
        amount: d.amount,
        currency: d.currency,
        payee: d.payee,
        purpose: d.purpose,
        at: e.at,
      };
      break;
    case 'BankReceiptRecorded':
      state.receipts.push({
        receiptId: d.receiptId,
        instructionId: d.instructionId ?? null,
        status: d.status, // accepted | rejected
        bankRef: d.bankRef,
        occurredAt: d.occurredAt ?? e.at,
        recordedAt: e.at,
        orphan: d.orphan === true,
      });
      break;
    case 'RefundRecorded':
      state.refunds.push({
        refundId: d.refundId,
        amount: d.amount,
        currency: d.currency,
        schoolRefId: d.schoolRefId,
        reason: d.reason ?? null,
        at: d.occurredAt ?? e.at,
        acknowledgedAt: null,
      });
      break;
    case 'RefundAcknowledged': {
      const r = state.refunds.find((x) => x.refundId === d.refundId);
      if (r) r.acknowledgedAt = e.at;
      break;
    }
    default:
      fail('UNKNOWN_EVENT', `未知事件类型: ${e.type}`);
  }
  return state;
}

/* ---------------- 工具与权限 ---------------- */

const participant = (state, actor) => state.participants.get(actor) ?? fail('UNKNOWN_ACTOR', `未登记的参与者: ${actor}`);
const requireRole = (state, actor, ...roles) => {
  const p = participant(state, actor);
  if (!roles.includes(p.role)) fail('FORBIDDEN_ROLE', `角色 ${p.role} 无权执行该操作`, { requiredRole: roles });
  return p;
};

// 申请人本人，或持有有效授权且范围匹配的家长代理
const requireOwnerScope = (state, actor, scope) => {
  const p = participant(state, actor);
  if (p.role === ROLES.APPLICANT) return p;
  if (p.role === ROLES.PARENT_AGENT) {
    const g = state.authorizations.get(p.id);
    if (!g || g.status !== 'active') fail('AUTHORIZATION_REVOKED', '授权已撤回或不存在，代理不能操作');
    if (scope && !g.scopes.includes(scope)) fail('SCOPE_DENIED', '授权范围不含该操作', { requiredScope: scope });
    return p;
  }
  fail('FORBIDDEN_ROLE', '只有申请人或获授权的家长代理可以操作');
};

const assertNotLocked = (state) => {
  if (state.status === 'approved' || state.status === 'instructed') {
    fail(
      'REVIEW_LOCKED',
      state.status === 'instructed'
        ? '汇款指令已发送，新增/替换材料不能回溯改变已发送指令'
        : '审核已通过，材料已锁定；如需变更须先拒绝/退回',
    );
  }
};

const currentVersion = (file) => file.versions[file.versions.length - 1];

const requiredDocTypes = (state) => {
  const hasActiveAgent = [...state.authorizations.values()].some((g) => g.status === 'active');
  return hasActiveAgent ? [...DEFAULT_REQUIRED_DOCS, DOC_REQUIRED_WITH_AGENT] : [...DEFAULT_REQUIRED_DOCS];
};

const isSameHash = (state, sha256) => {
  for (const f of state.files.values()) {
    const hit = f.versions.find((v) => v.sha256 === sha256);
    if (hit) return { docId: f.docId, docType: f.docType, version: hit.version };
  }
  return null;
};

/* ---------------- 待办派生（实时，不落库） ---------------- */

export function deriveTodos(state, now) {
  const todos = [];
  const push = (kind, severity, message, detail = {}) => todos.push({ kind, severity, message, ...detail });

  if (!state.payee) push('MISSING_PAYEE', 'blocking', '缺少收款方（学校账户）信息');
  if (state.amount == null) push('MISSING_AMOUNT', 'blocking', '缺少汇款金额');
  else if (!state.amountAck) push('AMOUNT_CHANGED', 'blocking', '金额发生变化，请确认现有材料与额度仍覆盖当前金额');

  for (const docType of requiredDocTypes(state)) {
    const file = [...state.files.values()].find((f) => f.docType === docType);
    if (!file) {
      push('MISSING_DOCUMENT', 'blocking', `缺少必备材料: ${docType}`, { docType });
      continue;
    }
    const v = currentVersion(file);
    if (v.validUntil != null) {
      const until = Date.parse(v.validUntil);
      if (until <= now) {
        push('EXPIRED_DOCUMENT', 'blocking', `材料已过期，请上传新版本: ${docType}`, {
          docType,
          docId: file.docId,
          version: v.version,
          validUntil: v.validUntil,
        });
      } else if (until - now <= EXPIRING_SOON_MS) {
        push('EXPIRING_SOON', 'warning', `材料将于 30 天内过期: ${docType}`, {
          docType,
          docId: file.docId,
          validUntil: v.validUntil,
        });
      }
    }
  }

  for (const r of state.refunds) {
    if (!r.acknowledgedAt) {
      push('REFUND_PENDING', 'warning', '收到学校退款，请确认后续处理（重新汇出 / 退回额度）', {
        refundId: r.refundId,
        amount: r.amount,
        currency: r.currency,
      });
    }
  }

  // 回执乱序：同一指令出现互相矛盾的状态
  const byInstruction = new Map();
  for (const rc of state.receipts) {
    if (!rc.instructionId) continue;
    const set = byInstruction.get(rc.instructionId) ?? new Set();
    set.add(rc.status);
    byInstruction.set(rc.instructionId, set);
  }
  for (const [instructionId, set] of byInstruction) {
    if (set.size > 1) {
      push('RECEIPT_STATUS_CONFLICT', 'warning', '同一笔指令收到状态矛盾的银行回执，请人工核对', { instructionId: [...set].join('/'), instructionRef: instructionId });
    }
  }
  if (state.receipts.some((r) => r.orphan)) {
    push('UNMATCHED_RECEIPT', 'warning', '存在找不到对应汇款指令的银行回执（可能早于指令重放）', {
      receiptIds: state.receipts.filter((r) => r.orphan).map((r) => r.receiptId),
    });
  }

  const blocking = todos.filter((t) => t.severity === 'blocking');
  return { todos, blocking, ready: blocking.length === 0 };
}

/* ---------------- 命令决策：返回待追加事件（不含信封） ---------------- */

export function decide(state, cmd, ctx = {}) {
  const nowIso = new Date(ctx.now ?? Date.now()).toISOString();
  const out = (type, data) => ({ type, data });

  switch (cmd.type) {
    case 'openTransfer':
      if (state.id) fail('ALREADY_OPENED', '汇款已开立');
      return [
        out('TransferOpened', {
          transferId: cmd.transferId,
          studentName: cmd.studentName ?? null,
          studentMinor: !!cmd.studentMinor,
          deadline: cmd.deadline ?? null,
          currency: cmd.currency ?? null,
        }),
        out('ParticipantAdded', { participantId: cmd.applicantId, role: ROLES.APPLICANT, displayName: cmd.applicantName ?? null }),
      ];

    case 'addParticipant': {
      requireRole(state, cmd.actor, ROLES.APPLICANT, ROLES.REVIEWER);
      if (state.participants.has(cmd.participantId)) fail('DUPLICATE_PARTICIPANT', '参与者已存在');
      if (!Object.values(ROLES).includes(cmd.role)) fail('BAD_ROLE', `未知角色: ${cmd.role}`);
      return [out('ParticipantAdded', { participantId: cmd.participantId, role: cmd.role, displayName: cmd.displayName ?? null })];
    }

    case 'setPayee':
      requireOwnerScope(state, cmd.actor);
      assertNotLocked(state);
      if (!cmd.schoolName || !cmd.accountRef) fail('BAD_PAYEE', 'schoolName 与 accountRef 必填');
      return [out('PayeeSet', { schoolName: cmd.schoolName, accountRef: cmd.accountRef, bankName: cmd.bankName ?? null })];

    case 'setPurpose':
      requireOwnerScope(state, cmd.actor);
      assertNotLocked(state);
      if (!cmd.term || !cmd.academicYear) fail('BAD_PURPOSE', 'term 与 academicYear 必填');
      return [out('PurposeSet', { term: cmd.term, academicYear: cmd.academicYear })];

    case 'setCurrency':
      requireOwnerScope(state, cmd.actor);
      assertNotLocked(state);
      return [out('CurrencySet', { currency: cmd.currency })];

    case 'setPaymentAmount': {
      requireOwnerScope(state, cmd.actor, ACTIVE_SCOPES.submission);
      assertNotLocked(state);
      const amount = Number(cmd.amount);
      if (!(amount > 0)) fail('BAD_AMOUNT', '金额必须为正数');
      return [out('PaymentAmountSet', { amount, firstSet: state.amount == null })];
    }

    case 'confirmAmountConsistency': {
      requireOwnerScope(state, cmd.actor, ACTIVE_SCOPES.submission);
      if (state.amount == null) fail('NO_AMOUNT', '尚未设置金额');
      if (state.amountAck) return [];
      return [out('AmountConsistencyConfirmed', {})];
    }

    case 'uploadDocument': {
      requireOwnerScope(state, cmd.actor, ACTIVE_SCOPES.document);
      assertNotLocked(state);
      if (!cmd.docId || !cmd.docType || !cmd.sha256) fail('BAD_DOCUMENT', 'docId / docType / sha256 必填');
      if (cmd.validUntil != null && Date.parse(cmd.validUntil) <= Date.parse(cmd.validFrom ?? nowIso)) {
        fail('BAD_VALIDITY', '有效期止必须晚于有效期起', { validFrom: cmd.validFrom, validUntil: cmd.validUntil });
      }
      // 重复材料：同一文件哈希在本笔汇款任何材料的任何版本中出现过，一律拦下
      const dup = isSameHash(state, cmd.sha256);
      if (dup && dup.docId !== cmd.docId) {
        fail('DUPLICATE_DOCUMENT', '该文件已作为其他材料提交，请勿重复上传', {
          existingDocId: dup.docId,
          docType: dup.docType,
          version: dup.version,
        });
      }
      const existing = state.files.get(cmd.docId);
      if (!existing) {
        if (dup) fail('DUPLICATE_DOCUMENT', '完全相同的文件已上传过，重复提交不会生成新版本', { ...dup });
        return [
          out('DocumentUploaded', {
            docId: cmd.docId,
            docType: cmd.docType,
            filename: cmd.filename ?? `${cmd.docType}.bin`,
            sha256: cmd.sha256,
            validFrom: cmd.validFrom ?? nowIso,
            validUntil: cmd.validUntil ?? null,
          }),
        ];
      }
      // 文件替换必须形成版本：新版本号、被替换版本号、替换原因全部入事件
      if (existing.docType !== cmd.docType) fail('DOC_TYPE_MISMATCH', '替换文件不得改变材料类型');
      const last = currentVersion(existing);
      if (last.sha256 === cmd.sha256) {
        fail('DUPLICATE_DOCUMENT', '与当前版本内容完全相同，无需替换', { docId: cmd.docId, version: last.version });
      }
      return [
        out('DocumentVersionAdded', {
          docId: cmd.docId,
          version: last.version + 1,
          supersedesVersion: last.version,
          replaceReason: cmd.replaceReason ?? null,
          filename: cmd.filename ?? `${cmd.docType}.bin`,
          sha256: cmd.sha256,
          validFrom: cmd.validFrom ?? nowIso,
          validUntil: cmd.validUntil ?? null,
        }),
      ];
    }

    case 'grantAuthorization': {
      requireRole(state, cmd.actor, ROLES.APPLICANT);
      const agent = state.participants.get(cmd.agentParticipantId);
      if (!agent || agent.role !== ROLES.PARENT_AGENT) fail('BAD_AGENT', '被授权方必须是家长代理角色');
      const existing = state.authorizations.get(cmd.agentParticipantId);
      if (existing?.status === 'active') fail('AUTHORIZATION_EXISTS', '该代理已有生效授权；更换代理请先撤回旧授权');
      const scopes = cmd.scopes?.length ? cmd.scopes : [ACTIVE_SCOPES.document, ACTIVE_SCOPES.submission];
      return [
        out('AuthorizationGranted', {
          grantId: cmd.grantId ?? `grant-${cmd.agentParticipantId}-${Date.parse(nowIso)}`,
          agentParticipantId: cmd.agentParticipantId,
          scopes,
        }),
      ];
    }

    case 'revokeAuthorization': {
      const p = participant(state, cmd.actor);
      const target = cmd.agentParticipantId ?? (p.role === ROLES.PARENT_AGENT ? p.id : null);
      if (p.role !== ROLES.APPLICANT && p.id !== target) {
        fail('FORBIDDEN_ROLE', '只有申请人可以撤回他人授权，代理只能撤回自身授权');
      }
      const g = state.authorizations.get(target);
      if (!g || g.status !== 'active') fail('NO_ACTIVE_AUTHORIZATION', '目标代理没有生效中的授权');
      return [out('AuthorizationRevoked', { agentParticipantId: target, reason: cmd.reason ?? null })];
    }

    case 'submitForReview': {
      requireOwnerScope(state, cmd.actor, ACTIVE_SCOPES.submission);
      if (state.status === 'submitted') fail('ALREADY_SUBMITTED', '已在待审核队列中');
      if (state.status === 'approved' || state.status === 'instructed') fail('REVIEW_LOCKED', '已审核通过，不能重复提交');
      if (state.status === 'rejected') fail('USE_RESUBMIT', '被拒绝的汇款须补正后走 resubmit，而非重新提交');
      if (state.deadline && Date.parse(state.deadline) < (ctx.now ?? Date.now())) {
        fail('SUBMISSION_DEADLINE_PASSED', '已超过学校/渠道截止时间，提交被拒绝', {
          deadline: state.deadline,
          now: nowIso,
        });
      }
      const { ready, todos } = deriveTodos(state, ctx.now ?? Date.now());
      if (!ready) fail('BLOCKING_TODOS', '存在阻断性待办，无法提交审核', { todos });
      return [out('SubmittedForReview', {})];
    }

    case 'review': {
      requireRole(state, cmd.actor, ROLES.REVIEWER);
      if (state.status !== 'submitted') fail('NOT_SUBMITTED', '只有待审核状态的汇款可以出审核结论', { status: state.status });
      if (cmd.decision === 'approve') {
        const { ready, todos } = deriveTodos(state, ctx.now ?? Date.now());
        if (!ready) fail('BLOCKING_TODOS', '仍有阻断性待办，不能审核通过', { todos });
        return [out('ReviewApproved', { reason: cmd.reason ?? null })];
      }
      if (cmd.decision === 'reject') {
        if (!cmd.reason || !String(cmd.reason).trim()) fail('REASON_REQUIRED', '拒绝必须填写依据，便于后续解释');
        return [out('ReviewRejected', { reason: String(cmd.reason).trim() })];
      }
      fail('BAD_DECISION', 'decision 必须为 approve 或 reject');
      break;
    }

    // 驳回后补正材料，可以重新提交
    case 'resubmit': {
      requireOwnerScope(state, cmd.actor, ACTIVE_SCOPES.submission);
      if (state.status !== 'rejected') fail('NOT_REJECTED', '只有被拒绝的汇款可以补正后重新提交');
      const { ready, todos } = deriveTodos(state, ctx.now ?? Date.now());
      if (!ready) fail('BLOCKING_TODOS', '阻断性待办尚未处理完', { todos });
      return [out('SubmittedForReview', {})];
    }

    case 'sendPaymentInstruction': {
      requireOwnerScope(state, cmd.actor, ACTIVE_SCOPES.submission);
      if (state.status !== 'approved') fail('NOT_APPROVED', '只有审核通过的汇款才能发送银行指令');
      const used = Number(ctx.quotaUsed ?? 0);
      const limit = ctx.quotaLimit == null ? Infinity : Number(ctx.quotaLimit);
      if (used + state.amount > limit) {
        fail('QUOTA_EXCEEDED', '本年度购汇额度不足', { quotaUsed: used, quotaLimit: limit, amount: state.amount });
      }
      // 快照入事件：之后任何修改都与这条指令无关
      return [
        out('PaymentInstructionSent', {
          instructionId: cmd.instructionId ?? `inst-${state.id}-${Date.parse(nowIso)}`,
          amount: state.amount,
          currency: state.currency,
          payee: state.payee,
          purpose: state.purpose,
        }),
      ];
    }

    case 'recordBankReceipt': {
      requireRole(state, cmd.actor, ROLES.BANK_GATEWAY, ROLES.APPLICANT);
      if (!['accepted', 'rejected'].includes(cmd.status)) fail('BAD_RECEIPT_STATUS', '回执状态必须为 accepted/rejected');
      const orphan = !cmd.instructionId || !state.instruction || cmd.instructionId !== state.instruction.instructionId;
      return [
        out('BankReceiptRecorded', {
          receiptId: cmd.receiptId ?? `rcpt-${state.seq + 1}`,
          instructionId: cmd.instructionId ?? state.instruction?.instructionId ?? null,
          status: cmd.status,
          bankRef: cmd.bankRef ?? null,
          occurredAt: cmd.occurredAt ?? nowIso, // 银行业务时间，可早于记录时间（晚到/乱序）
          orphan,
        }),
      ];
    }

    case 'recordRefund': {
      // 退款可由银行渠道入账，也可由申请人/代理登记
      if (participant(state, cmd.actor).role === ROLES.PARENT_AGENT) {
        requireOwnerScope(state, cmd.actor, ACTIVE_SCOPES.refund);
      } else {
        requireRole(state, cmd.actor, ROLES.APPLICANT, ROLES.BANK_GATEWAY);
      }
      if (!state.instruction) fail('NO_INSTRUCTION', '尚未汇出，不能登记退款');
      const amount = Number(cmd.amount);
      if (!(amount > 0)) fail('BAD_AMOUNT', '退款金额必须为正数');
      return [
        out('RefundRecorded', {
          refundId: cmd.refundId ?? `refund-${state.refunds.length + 1}`,
          amount,
          currency: cmd.currency ?? state.currency,
          schoolRefId: cmd.schoolRefId ?? null,
          reason: cmd.reason ?? null,
          occurredAt: cmd.occurredAt ?? nowIso,
        }),
      ];
    }

    case 'acknowledgeRefund': {
      requireOwnerScope(state, cmd.actor, ACTIVE_SCOPES.refund);
      const r = state.refunds.find((x) => x.refundId === cmd.refundId);
      if (!r) fail('NO_REFUND', '退款不存在');
      if (r.acknowledgedAt) return [];
      return [out('RefundAcknowledged', { refundId: cmd.refundId })];
    }

    default:
      fail('UNKNOWN_COMMAND', `未知命令: ${cmd.type}`);
  }
}

/* ---------------- 未成年人最小化展示 ---------------- */

const maskName = (name) => (name ? `${String(name).slice(0, 1)}*` : name);

/**
 * 按查看者角色投影：涉及未成年人时，审核员/银行只看完成审核所必需的信息，
 * 姓名脱敏、非必要的文件名隐藏。
 */
export function viewFor(state, viewerId) {
  const viewer = state.participants.get(viewerId);
  const role = viewer?.role ?? null;
  const needFull = !state.studentMinor || role === ROLES.APPLICANT || role === ROLES.PARENT_AGENT;

  const files = [...state.files.values()].map((f) => ({
    docId: f.docId,
    docType: f.docType,
    currentVersion: currentVersion(f).version,
    versions: f.versions.map((v) => ({
      version: v.version,
      filename: needFull ? v.filename : '***',
      sha256: needFull ? v.sha256 : `${String(v.sha256).slice(0, 8)}…`,
      validFrom: v.validFrom,
      validUntil: v.validUntil,
      uploaderId: v.uploaderId,
      at: v.at,
      supersedesVersion: v.supersedesVersion ?? null,
      replaceReason: v.replaceReason ?? null,
    })),
  }));

  return {
    id: state.id,
    status: state.status,
    studentName: needFull ? state.studentName : maskName(state.studentName),
    studentMinor: state.studentMinor,
    deadline: state.deadline,
    currency: state.currency,
    payee: state.payee,
    purpose: state.purpose,
    amount: state.amount,
    amountAck: state.amountAck,
    files,
    authorizations: [...state.authorizations.values()],
    review: state.review,
    instruction: state.instruction
      ? {
          instructionId: state.instruction.instructionId,
          amount: state.instruction.amount,
          currency: state.instruction.currency,
          payee: state.instruction.payee,
          purpose: state.instruction.purpose,
          at: state.instruction.at,
        }
      : null,
    receipts: state.receipts,
    refunds: state.refunds,
  };
}
