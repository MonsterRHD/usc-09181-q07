import {
  EVT, STREAM_AUTHZ, STREAM_RECEIPTS, DomainError,
} from './events.mjs';
import {
  newTransferId, newAuthorizationId, newInstructionRef, newId,
} from './ids.mjs';
import { DOC_SLOTS, PURPOSES } from './catalog.mjs';
import {
  buildReadModel, currentVersion, deriveTodos, blockingTodos, versionStatus, usdOf,
} from './projection.mjs';
import { parseInstant, parseDeadline } from './clock.mjs';

// 应用服务：无状态命令处理器。每次命令从事件存储重建读模型，
// 因此重启、重放、迟到事件得到的结果完全确定。
export class TransferService {
  constructor(store, clock = () => new Date().toISOString()) {
    this.store = store;
    this.clock = clock;
  }

  get model() {
    return buildReadModel(this.store, this.clock());
  }

  _transfer(model, id) {
    const st = model.transfers.get(id);
    if (!st) throw new DomainError('NOT_FOUND', `汇款不存在: ${id}`);
    return st;
  }

  _requireActor(actor) {
    if (!actor?.id || !actor?.role) {
      throw new DomainError('UNAUTHENTICATED', '缺少操作者身份');
    }
    return actor;
  }

  // 申请人本人，或对该汇款当前持有有效授权的代理。
  _requireParticipant(model, state, actor) {
    this._requireActor(actor);
    if (actor.role === 'admin' || actor.role === 'reviewer') return actor;
    if (actor.role === 'applicant' && actor.id === state.applicantId) return actor;
    if (actor.role === 'agent') {
      const authz = model.activeAuthzFor({
        applicantId: state.applicantId,
        transferId: state.transferId,
        agentId: actor.id,
        at: this.clock(),
      });
      if (authz) return actor;
    }
    throw new DomainError('FORBIDDEN', '无权操作该汇款');
  }

  _requireRole(actor, ...roles) {
    this._requireActor(actor);
    if (!roles.includes(actor.role)) {
      throw new DomainError('FORBIDDEN', `该操作需要角色: ${roles.join('/')}`);
    }
    return actor;
  }

  _validateAmount(amount) {
    if (!amount || typeof amount.value !== 'number' || amount.value <= 0 || !amount.currency) {
      throw new DomainError('INVALID_AMOUNT', '金额必须为正数且包含币种');
    }
    if (amount.currency !== 'USD' && typeof amount.usdEquivalent !== 'number') {
      throw new DomainError('INVALID_AMOUNT', '非美元金额需要提供 usdEquivalent 用于额度核算');
    }
    return { value: amount.value, currency: amount.currency, usdEquivalent: amount.usdEquivalent };
  }

  // ---------- 汇款生命周期 ----------

  async openTransfer(actor, input = {}) {
    this._requireActor(actor);
    if (input.idempotencyKey) {
      const existing = this.store.findIdempotency(input.idempotencyKey);
      if (existing) return { transferId: existing.stream, event: existing, duplicate: true };
    }
    const amount = input.amount ? this._validateAmount(input.amount) : null;
    if (input.purpose && !Object.values(PURPOSES).includes(input.purpose)) {
      throw new DomainError('INVALID_PURPOSE', `未知用途: ${input.purpose}`);
    }
    const transferId = newTransferId();
    const now = this.clock();
    const { event } = await this.store.append({
      stream: transferId,
      type: EVT.TransferOpened,
      actor,
      ts: now,
      data: {
        applicantId: input.applicantId || actor.id,
        applicantName: input.applicantName ?? null,
        minor: !!input.minor,
        payee: input.payee ?? null,
        purpose: input.purpose ?? null,
        amount,
        quotaYear: input.quotaYear ?? new Date(now).getUTCFullYear(),
        deadline: input.deadline ? parseDeadline(input.deadline) : null,
      },
      idempotencyKey: input.idempotencyKey,
    });
    return { transferId, event };
  }

  async updatePayee(actor, transferId, payee) {
    const model = this.model;
    const state = this._transfer(model, transferId);
    this._requireParticipant(model, state, actor);
    if (['sent', 'settled'].includes(state.status)) {
      throw new DomainError('INSTRUCTION_LOCKED', '指令已发送，收款方不能变更；如学校退款请走退款流程');
    }
    if (!payee?.account || !payee?.name) {
      throw new DomainError('INVALID_PAYEE', '收款方必须包含账户与户名');
    }
    return this.store.append({
      stream: transferId, type: EVT.PayeeUpdated, actor, ts: this.clock(),
      data: { payee }, idempotencyKey: payee.idempotencyKey,
    });
  }

  async updatePurpose(actor, transferId, purpose) {
    const model = this.model;
    const state = this._transfer(model, transferId);
    this._requireParticipant(model, state, actor);
    if (['sent', 'settled'].includes(state.status)) {
      throw new DomainError('INSTRUCTION_LOCKED', '指令已发送，用途不能变更');
    }
    if (!Object.values(PURPOSES).includes(purpose)) {
      throw new DomainError('INVALID_PURPOSE', `未知用途: ${purpose}`);
    }
    return this.store.append({
      stream: transferId, type: EVT.PurposeUpdated, actor, ts: this.clock(), data: { purpose },
    });
  }

  async changeAmount(actor, transferId, amountInput) {
    const model = this.model;
    const state = this._transfer(model, transferId);
    this._requireParticipant(model, state, actor);
    if (['sent', 'settled'].includes(state.status)) {
      throw new DomainError('INSTRUCTION_LOCKED', '指令已发送，金额不能回溯变更；差额需另开汇款，退款走退款流程');
    }
    const amount = this._validateAmount(amountInput);
    if (state.amount && state.amount.value === amount.value && state.amount.currency === amount.currency) {
      throw new DomainError('NO_CHANGE', '金额与当前一致');
    }
    return this.store.append({
      stream: transferId, type: EVT.AmountChanged, actor, ts: this.clock(),
      data: { amount, reason: amountInput.reason ?? null },
    });
  }

  async updateDeadline(actor, transferId, deadline) {
    const model = this.model;
    const state = this._transfer(model, transferId);
    this._requireParticipant(model, state, actor);
    return this.store.append({
      stream: transferId, type: EVT.DeadlineUpdated, actor, ts: this.clock(),
      data: { deadline: parseDeadline(deadline) },
    });
  }

  async setMinor(actor, transferId, minor) {
    const model = this.model;
    const state = this._transfer(model, transferId);
    if (actor.role !== 'admin' && !(actor.role === 'applicant' && actor.id === state.applicantId)) {
      throw new DomainError('FORBIDDEN', '仅申请人本人或管理员可维护未成年标记');
    }
    return this.store.append({
      stream: transferId, type: EVT.MinorFlagUpdated, actor, ts: this.clock(), data: { minor: !!minor },
    });
  }

  // ---------- 授权关系 ----------

  async grantAuthorization(actor, input = {}) {
    this._requireActor(actor);
    if (actor.role !== 'admin' && !(actor.role === 'applicant' && actor.id === input.applicantId)) {
      throw new DomainError('FORBIDDEN', '仅申请人本人或管理员可授予代办授权');
    }
    if (!input.agentId || !input.applicantId) {
      throw new DomainError('INVALID_AUTHZ', '授权必须包含代理人与申请人');
    }
    const authz = {
      authorizationId: newAuthorizationId(),
      agentId: input.agentId,
      agentName: input.agentName ?? null,
      applicantId: input.applicantId,
      relationship: input.relationship ?? null,
      transferIds: input.transferIds ?? null,
      expiresAt: input.expiresAt ? parseInstant(input.expiresAt).toISOString() : null,
      minorRelated: !!input.minorRelated,
    };
    const { event } = await this.store.append({
      stream: STREAM_AUTHZ, type: EVT.AgentAuthorizationGranted,
      actor, ts: this.clock(), data: authz, idempotencyKey: input.idempotencyKey,
    });
    return { authorizationId: authz.authorizationId, event };
  }

  async revokeAuthorization(actor, authorizationId, reason = null) {
    const model = this.model;
    const rec = model.authz.get(authorizationId);
    if (!rec) throw new DomainError('NOT_FOUND', `授权不存在: ${authorizationId}`);
    if (actor.role !== 'admin' && !(actor.role === 'applicant' && actor.id === rec.applicantId)) {
      throw new DomainError('FORBIDDEN', '仅申请人本人或管理员可撤回授权');
    }
    if (rec.revokedAt) return []; // 已撤回：重放安全的空操作
    const now = this.clock();
    const results = [];
    results.push(await this.store.append({
      stream: STREAM_AUTHZ, type: EVT.AgentAuthorizationRevoked,
      actor, ts: now, data: { authorizationId, reason },
    }));
    // 授权撤回使覆盖范围内“在审/已通过未发送”的提交失效，需申请人重新确认提交。
    for (const st of model.transfers.values()) {
      if (st.applicantId !== rec.applicantId) continue;
      if (rec.transferIds && !rec.transferIds.includes(st.transferId)) continue;
      if (['in_review', 'approved'].includes(st.status)) {
        results.push(await this.store.append({
          stream: st.transferId, type: EVT.ReviewWithdrawn, actor, ts: now,
          data: { reason: 'authorization_revoked', authorizationId },
        }));
      }
    }
    return results;
  }

  async replaceAgent(actor, previousAuthorizationId, newAuthzInput) {
    const model = this.model;
    const old = model.authz.get(previousAuthorizationId);
    if (!old) throw new DomainError('NOT_FOUND', `原授权不存在: ${previousAuthorizationId}`);
    if (actor.role !== 'admin' && !(actor.role === 'applicant' && actor.id === old.applicantId)) {
      throw new DomainError('FORBIDDEN', '仅申请人本人或管理员可更换代理');
    }
    const now = this.clock();
    const { authorizationId } = await this.grantAuthorization(actor, {
      ...newAuthzInput,
      applicantId: newAuthzInput.applicantId || old.applicantId,
      minorRelated: newAuthzInput.minorRelated ?? old.minorRelated,
    });
    const results = [];
    results.push(await this.store.append({
      stream: STREAM_AUTHZ, type: EVT.AgentReplaced, actor, ts: now,
      data: { previousAuthorizationId, newAuthorizationId: authorizationId },
    }));
    results.push(await this.store.append({
      stream: STREAM_AUTHZ, type: EVT.AgentAuthorizationRevoked, actor, ts: now,
      data: { authorizationId: previousAuthorizationId, reason: 'agent_replaced' },
    }));
    // 代理更换后在审汇款回到草稿，由申请人或新代理重新提交。
    const fresh = this.model;
    for (const st of fresh.transfers.values()) {
      if (st.applicantId !== old.applicantId) continue;
      if (old.transferIds && !old.transferIds.includes(st.transferId)) continue;
      if (['in_review', 'approved'].includes(st.status)) {
        results.push(await this.store.append({
          stream: st.transferId, type: EVT.ReviewWithdrawn, actor, ts: now,
          data: { reason: 'agent_replaced', previousAuthorizationId, newAuthorizationId: authorizationId },
        }));
      }
    }
    return { newAuthorizationId: authorizationId, results };
  }

  // ---------- 文件与版本 ----------

  async uploadDocument(actor, transferId, input = {}) {
    const model = this.model;
    const state = this._transfer(model, transferId);
    this._requireParticipant(model, state, actor);
    const { slot } = input;
    if (!DOC_SLOTS[slot]) throw new DomainError('INVALID_SLOT', `未知材料槽位: ${slot}`);
    if (!input.sha256 || !input.fileName) {
      throw new DomainError('INVALID_DOCUMENT', '文件需要 fileName 与 sha256');
    }
    const def = DOC_SLOTS[slot];
    const expiresAt = input.expiresAt ? parseInstant(input.expiresAt).toISOString() : null;
    if (def.expirable && !expiresAt) {
      throw new DomainError('EXPIRY_REQUIRED', `${def.label}必须提供有效期`);
    }
    if (expiresAt && new Date(expiresAt).getTime() <= new Date(this.clock()).getTime()) {
      throw new DomainError('DOCUMENT_ALREADY_EXPIRED', '不能上传一份已经过期的文件，请提供最新版本');
    }
    if (input.noticeAmount) this._validateAmount(input.noticeAmount);

    const bucket = state.documents.get(slot);
    const last = bucket?.versions[bucket.versions.length - 1];

    // 同笔汇款同槽位同内容：重复上传不产生新版本，仅登记去重事件，可重放、可审计。
    if (last && last.sha256 === input.sha256) {
      const { event } = await this.store.append({
        stream: transferId, type: EVT.DuplicateUploadDeduped, actor, ts: this.clock(),
        data: { slot, sha256: input.sha256, fileName: input.fileName, keptVersion: last.version,
          keptStatus: versionStatus(last, this.clock()) },
        idempotencyKey: input.idempotencyKey,
      });
      return { deduped: true, version: last.version, documentId: last.documentId, event };
    }

    const version = (last?.version ?? 0) + 1;
    const documentId = newId('doc');
    const afterSent = ['sent', 'settled'].includes(state.status);

    // 跨汇款重复使用：不阻断，但留下引用，供月末核账统计“重复材料”。
    const reusedOnTransfers = (model.contentIndex.get(`${input.sha256}|${slot}`) ?? [])
      .map((x) => x.transferId);

    const events = [];
    events.push((await this.store.append({
      stream: transferId, type: EVT.DocumentUploaded, actor, ts: this.clock(),
      data: {
        slot, version, documentId, fileName: input.fileName, sha256: input.sha256,
        issuedAt: input.issuedAt ?? null, expiresAt,
        noticeAmount: input.noticeAmount ?? null, afterSent, reusedOnTransfers,
      },
      idempotencyKey: input.idempotencyKey,
    })).event);
    if (last) {
      events.push((await this.store.append({
        stream: transferId, type: EVT.DocumentSuperseded, actor, ts: this.clock(),
        data: { slot, oldVersion: last.version, newVersion: version },
      })).event);
    }
    return { deduped: false, version, documentId, afterSent, reusedOnTransfers, events };
  }

  async acknowledgeAmountChange(actor, transferId) {
    const model = this.model;
    const state = this._transfer(model, transferId);
    this._requireParticipant(model, state, actor);
    if (state.latestNoticeVersion <= state.amountAckNoticeVersion) {
      throw new DomainError('NO_CHANGE', '没有待确认的金额变化');
    }
    // 确认时以最新学费通知单金额登记金额变化（若携带金额）。
    const notice = currentVersion(state, 'tuition_notice', this.clock());
    const events = [];
    if (notice?.noticeAmount && (!state.amount
      || notice.noticeAmount.value !== state.amount.value
      || notice.noticeAmount.currency !== state.amount.currency)) {
      if (!['sent', 'settled'].includes(state.status)) {
        events.push((await this.store.append({
          stream: transferId, type: EVT.AmountChanged, actor, ts: this.clock(),
          data: { amount: this._validateAmount(notice.noticeAmount), reason: 'new_tuition_notice',
            tuitionNoticeVersion: notice.version },
        })).event);
      }
    }
    events.push((await this.store.append({
      stream: transferId, type: EVT.AmountChangeAcknowledged, actor, ts: this.clock(),
      data: { noticeVersion: state.latestNoticeVersion },
    })).event);
    return events;
  }

  // ---------- 审核与指令 ----------

  async submitForReview(actor, transferId) {
    const model = this.model;
    const state = this._transfer(model, transferId);
    this._requireParticipant(model, state, actor);
    if (['sent', 'settled'].includes(state.status)) {
      throw new DomainError('INSTRUCTION_LOCKED', '指令已发送，不能再次提交审核');
    }
    const todos = deriveTodos(state, model.authz, this.clock());
    const blockers = blockingTodos(todos);
    if (blockers.length > 0) {
      throw new DomainError('BLOCKERS_PRESENT', '仍有阻断性待办未处理', { blockers });
    }
    const documentVersions = [...state.documents.entries()].map(([slot, b]) => ({
      slot, version: b.versions[b.versions.length - 1].version,
    }));
    return this.store.append({
      stream: transferId, type: EVT.SubmittedForReview, actor, ts: this.clock(),
      data: { documentVersions },
    });
  }

  async approve(actor, transferId, basis = {}) {
    const model = this.model;
    const state = this._transfer(model, transferId);
    this._requireRole(actor, 'reviewer');
    if (state.status !== 'in_review') {
      throw new DomainError('INVALID_STATUS', `当前状态 ${state.status} 不能审核通过`);
    }
    const blockers = blockingTodos(deriveTodos(state, model.authz, this.clock()));
    if (blockers.length > 0) {
      throw new DomainError('BLOCKERS_PRESENT', '仍有阻断性待办，不能通过', { blockers });
    }
    return this.store.append({
      stream: transferId, type: EVT.ReviewApproved, actor, ts: this.clock(),
      data: { basis: basis.note ?? null, checklist: basis.checklist ?? null },
    });
  }

  async reject(actor, transferId, { reasons = [], basis = null, policyVersion = null } = {}) {
    const model = this.model;
    const state = this._transfer(model, transferId);
    this._requireRole(actor, 'reviewer');
    if (state.status !== 'in_review') {
      throw new DomainError('INVALID_STATUS', `当前状态 ${state.status} 不能驳回`);
    }
    if (reasons.length === 0) {
      throw new DomainError('REASON_REQUIRED', '驳回必须给出可解释的依据');
    }
    return this.store.append({
      stream: transferId, type: EVT.ReviewRejected, actor, ts: this.clock(),
      data: { reasons, basis, policyVersion: policyVersion ?? 'v1' },
    });
  }

  // 审核通过后形成不可变汇款指令；此后新增文件只进版本链，不回溯修改快照。
  async issueInstruction(actor, transferId) {
    const model = this.model;
    const state = this._transfer(model, transferId);
    this._requireRole(actor, 'reviewer', 'admin');
    if (state.status !== 'approved') {
      throw new DomainError('INVALID_STATUS', '仅审核通过的汇款可以发送指令');
    }
    const usd = usdOf(state.amount);
    const used = model.quotaUsed.get(`${state.applicantId}|${state.quotaYear}`) ?? 0;
    if (used + usd > model.quotaLimitUsd) {
      throw new DomainError('QUOTA_EXCEEDED',
        `额度不足：已用 ${used}，本笔 ${usd}，上限 ${model.quotaLimitUsd}（${state.quotaYear} 年度）`);
    }
    const authz = model.activeAuthzFor({
      applicantId: state.applicantId, transferId, at: this.clock(),
    });
    const snapshot = {
      payee: state.payee,
      purpose: state.purpose,
      amount: state.amount,
      quotaYear: state.quotaYear,
      deadline: state.deadline,
      applicantId: state.applicantId,
      minor: state.minor,
      authorizationId: authz?.authorizationId ?? null,
      documents: [...state.documents.entries()].map(([slot, b]) => {
        const v = b.versions[b.versions.length - 1];
        return { slot, version: v.version, documentId: v.documentId, sha256: v.sha256, expiresAt: v.expiresAt };
      }),
    };
    const instructionRef = newInstructionRef();
    const issued = await this.store.append({
      stream: transferId, type: EVT.InstructionIssued, actor, ts: this.clock(),
      data: { instructionRef, snapshot },
    });
    await this._matchHeldReceipts();
    return { ...issued, instructionRef };
  }

  // ---------- 备注 ----------

  async addNote(actor, transferId, text) {
    const model = this.model;
    const state = this._transfer(model, transferId);
    this._requireParticipant(model, state, actor);
    if (!text || !String(text).trim()) {
      throw new DomainError('INVALID_NOTE', '备注内容不能为空');
    }
    return this.store.append({
      stream: transferId, type: EVT.NoteAdded, actor, ts: this.clock(), data: { text: String(text) },
    });
  }

  // ---------- 退款 ----------

  async recordSchoolRefund(actor, transferId, input = {}) {
    const model = this.model;
    const state = this._transfer(model, transferId);
    this._requireRole(actor, 'school', 'admin');
    if (!state.instruction) {
      throw new DomainError('INVALID_STATUS', '汇款指令尚未发送，不能登记学校退款');
    }
    const amount = this._validateAmount(input.amount);
    const refundId = newId('rfd');
    return this.store.append({
      stream: transferId, type: EVT.SchoolRefundReceived, actor, ts: this.clock(),
      data: {
        refundId, amount, reason: input.reason ?? null, schoolRef: input.schoolRef ?? null,
      },
      idempotencyKey: input.idempotencyKey,
    });
  }

  async settleRefund(actor, transferId, refundId, quotaReleasedUsd = null) {
    const model = this.model;
    const state = this._transfer(model, transferId);
    this._requireRole(actor, 'admin', 'bank');
    const refund = state.refunds.find((r) => r.refundId === refundId);
    if (!refund) throw new DomainError('NOT_FOUND', `退款不存在: ${refundId}`);
    if (refund.settledAt) throw new DomainError('ALREADY_SETTLED', '该退款已结算');
    const release = quotaReleasedUsd ?? usdOf(refund.amount);
    if (release < 0) throw new DomainError('INVALID_AMOUNT', '退回额度不能为负');
    return this.store.append({
      stream: transferId, type: EVT.RefundSettled, actor, ts: this.clock(),
      data: { refundId, quotaReleasedUsd: release },
    });
  }

  // ---------- 银行回执（允许晚到/乱序，可重放） ----------

  async receiveBankReceipt(actor, input = {}) {
    this._requireRole(actor, 'bank', 'admin');
    const amount = input.amount ? this._validateAmount(input.amount) : null;
    const receiptId = newId('rcp');
    const now = this.clock();

    // 同一银行参考号重复推送：幂等返回既有结果。
    const existing = [...this.model.receipts.values()].find((r) => r.bankRef === input.bankRef);
    if (existing) {
      return { deduped: true, receiptId: existing.receiptId, status: existing.status, match: existing.match };
    }

    await this.store.append({
      stream: STREAM_RECEIPTS, type: EVT.BankReceiptReceived, actor, ts: now,
      data: {
        receiptId, bankRef: input.bankRef, instructionRef: input.instructionRef ?? null,
        amount, payee: input.payee ?? null,
      },
      idempotencyKey: input.idempotencyKey,
    });

    return this._tryMatchReceipt(receiptId, now);
  }

  async _tryMatchReceipt(receiptId, now = this.clock()) {
    const model = this.model;
    const receipt = model.receipts.get(receiptId);
    if (!receipt) throw new DomainError('NOT_FOUND', `回执不存在: ${receiptId}`);
    if (receipt.status === 'matched') return { deduped: false, receiptId, status: 'matched', match: receipt.match };

    let target = null;
    if (receipt.instructionRef) {
      target = [...model.transfers.values()].find(
        (st) => st.instruction?.instructionRef === receipt.instructionRef,
      ) ?? null;
    }
    if (!target && receipt.amount) {
      // 参考号缺失：按“已发送 + 金额 + 收款账户”唯一匹配；不唯一则继续挂起。
      const candidates = [...model.transfers.values()].filter(
        (st) => st.instruction
          && st.amount?.value === receipt.amount.value
          && st.amount?.currency === receipt.amount.currency
          && (!receipt.payee?.account || st.payee?.account === receipt.payee.account),
      );
      if (candidates.length === 1) [target] = candidates;
    }
    if (!target) {
      // 指令尚未出现（乱序/晚到）：挂起，待指令发送后或重放时补匹配。
      if (receipt.status !== 'held') {
        await this.store.append({
          stream: STREAM_RECEIPTS, type: EVT.BankReceiptHeld, actor: { id: 'system', role: 'admin' }, ts: now,
          data: { receiptId, reason: 'instruction_not_found' },
        });
      }
      return { deduped: false, receiptId, status: 'held' };
    }

    const outOfOrder = !!receipt.holdReason || this._isLate(target, now);
    await this.store.append({
      stream: STREAM_RECEIPTS, type: EVT.BankReceiptMatched,
      actor: { id: 'system', role: 'admin' }, ts: now,
      data: {
        receiptId, instructionRef: target.instruction.instructionRef,
        transferId: target.transferId, outOfOrder,
      },
    });
    return { deduped: false, receiptId, status: 'matched', transferId: target.transferId, outOfOrder };
  }

  _isLate(state, now) {
    if (!state.instruction) return false;
    const lateMs = Number(process.env.RECEIPT_LATE_MS || 3 * 86_400_000);
    return new Date(now).getTime() - new Date(state.instruction.at).getTime() > lateMs;
  }

  // 重放挂起回执：进程启动、指令发送后调用；重复调用完全幂等。
  async replayHeldReceipts() {
    const results = [];
    for (const r of this.model.receipts.values()) {
      if (r.status === 'held') {
        results.push(await this._tryMatchReceipt(r.receiptId));
      }
    }
    return results;
  }

  async _matchHeldReceipts() {
    return this.replayHeldReceipts();
  }
}
