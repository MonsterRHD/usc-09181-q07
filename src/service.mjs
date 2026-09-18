/**
 * 汇款聚合服务：负责命令 -> 事件的落库、重放、审计与查询。
 * 幂等：同一 idempotencyKey 的重复命令直接回放首次结果，不产生新事件
 * （重复上传、撤回授权、回执晚到重试都安全）。
 */
import { applyEvent, decide, deriveTodos, initialState, viewFor } from './model.mjs';
import { DomainError } from './errors.mjs';

export class TransferService {
  constructor(store, clock = () => Date.now()) {
    this.store = store;
    this.clock = clock;
    this.states = new Map(); // transferId -> state
    this.audit = []; // 进程内审计（事件本身即持久审计轨迹，这里额外记录命令结果便于查询）
    this.commandIndex = new Map(); // `${transferId}:${idempotencyKey}` -> 已产生的事件
  }

  /* ---- 恢复 ---- */
  async restore() {
    const ids = await this.store.listStreams();
    for (const id of ids) {
      const state = initialState();
      const events = await this.store.readStream(id);
      for (const e of events) applyEvent(state, e);
      this.states.set(id, state);
      // 重建命令幂等索引：用事件上记录的 cmdId
      const byCmd = new Map();
      for (const e of events) {
        if (e.cmdId) {
          const list = byCmd.get(e.cmdId) ?? [];
          list.push(e);
          byCmd.set(e.cmdId, list);
        }
      }
      for (const [cmdId, evs] of byCmd) this.commandIndex.set(`${id}:${cmdId}`, evs);
    }
    return ids.length;
  }

  getState(transferId) {
    const s = this.states.get(transferId);
    if (!s) throw new DomainError('NOT_FOUND', `汇款不存在: ${transferId}`);
    return s;
  }

  /* ---- 命令执行 ---- */
  async handle(transferId, cmd, meta = {}) {
    const now = meta.now ?? this.clock();
    const idemKey = meta.idempotencyKey ?? null;
    const idxKey = idemKey ? `${transferId}:${idemKey}` : null;

    if (idxKey && this.commandIndex.has(idxKey)) {
      const replayed = this.commandIndex.get(idxKey);
      this.writeAudit({ transferId, cmd, actor: meta.actor, result: 'replayed', now });
      return { replayed: true, events: replayed };
    }

    // openTransfer 之前流不存在，给一个空状态供决策
    const state = this.states.get(transferId) ?? initialState();
    let newEvents;
    try {
      newEvents = decide(state, { ...cmd, actor: meta.actor }, { now, quotaUsed: meta.quotaUsed, quotaLimit: meta.quotaLimit });
    } catch (err) {
      this.writeAudit({ transferId, cmd, actor: meta.actor, result: 'rejected', error: err.code, now });
      throw err;
    }
    if (!newEvents.length) {
      this.writeAudit({ transferId, cmd, actor: meta.actor, result: 'noop', now });
      return { replayed: false, events: [] };
    }

    let seq = state.seq;
    const envelope = newEvents.map((d) => {
      seq += 1;
      return { seq, id: `${transferId}-${seq}`, type: d.type, data: d.data, actor: meta.actor ?? 'system', at: new Date(now).toISOString(), cmdId: idemKey };
    });

    await this.store.append(transferId, envelope);
    for (const e of envelope) applyEvent(state, e);
    this.states.set(transferId, state);
    if (idxKey) this.commandIndex.set(idxKey, envelope);
    this.writeAudit({ transferId, cmd, actor: meta.actor, result: 'applied', eventTypes: envelope.map((e) => e.type), now });
    return { replayed: false, events: envelope };
  }

  writeAudit(entry) {
    this.audit.push({ at: new Date(entry.now ?? this.clock()).toISOString(), ...entry });
  }

  /* ---- 查询 ---- */
  eventsOf(transferId) {
    return this.store.readStream(transferId);
  }

  todos(transferId, now = this.clock()) {
    return deriveTodos(this.getState(transferId), now);
  }

  view(transferId, viewerId) {
    return viewFor(this.getState(transferId), viewerId);
  }

  // 待审核队列：重启后仍然存在
  reviewQueue() {
    return [...this.states.values()]
      .filter((s) => s.status === 'submitted')
      .map((s) => ({ transferId: s.id, amount: s.amount, currency: s.currency, deadline: s.deadline, studentMinor: s.studentMinor }));
  }

  // 已发送凭证：重启后仍然存在
  sentInstructions() {
    return [...this.states.values()]
      .filter((s) => s.instruction)
      .map((s) => ({ transferId: s.id, ...s.instruction, receiptStatus: latestReceiptStatus(s) }));
  }

  auditTrail(transferId = null) {
    return transferId ? this.audit.filter((a) => a.transferId === transferId) : [...this.audit];
  }
}

function latestReceiptStatus(state) {
  if (!state.receipts.length) return null;
  const ordered = [...state.receipts].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  return ordered[ordered.length - 1].status;
}
