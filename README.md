# 留学汇款材料协同

围绕一笔留学汇款，让申请人、家长代理、审核员、银行渠道协同维护收款方、用途、额度、文件有效期与授权关系。
核心承诺：材料一次维护多角色可见、文件替换必留版本、各类异常给明确待办、审核通过后材料锁定、进程重启状态不丢。

## 运行

```bash
npm start            # 默认端口 3000，数据目录 .data/（可用 DATA_DIR / PORT 覆盖）
npm test             # node:test，无需任何外部依赖
```

## 架构

| 文件 | 职责 |
|---|---|
| `src/model.mjs` | 领域核心（纯函数）：事件折叠 `applyEvent`、命令决策 `decide`、待办派生 `deriveTodos`、角色视图 `viewFor` |
| `src/eventStore.mjs` | JSONL 追加式事件日志，每笔汇款一个流；重启逐行重放恢复 |
| `src/service.mjs` | 聚合服务：命令执行、幂等索引（重放不重复入账）、审计记录、队列/凭证查询 |
| `src/server.mjs` | 零依赖 HTTP API；启动时自动 `restore()` |

所有时间判断均由外部时钟注入（命令可带 `now`，API 支持传 `now`），因此跨时区截止、晚到回执、月末核账都可以确定性重放。

## 状态机

```
draft ──submitForReview──▶ submitted ──approve──▶ approved ──sendPaymentInstruction──▶ instructed
  ▲                           │
  └──────── resubmit ── rejected ◀──reject（必须填写拒绝依据 reason）
```

## 关键规则

- **文件版本化**：同一 `docId` 再传即生成新版本（号递增、记录被替换版本与替换原因），旧版本永不覆盖；过期版本只作为历史，当前待办只看最新版本的有效期。
- **重复材料拦截**：文件 SHA-256 在本笔汇款内出现过即拒绝（相同内容不能换个材料类型重传）。
- **授权关系**：申请人可授予/撤回家长代理；撤回后代理任何操作立即返回 `AUTHORIZATION_REVOKED`；更换代理必须先撤回旧授权；有生效代理时必备材料增加授权书。
- **金额变化**：提交后修改金额产生阻断待办 `AMOUNT_CHANGED`，确认材料/额度仍覆盖前不能审核通过。
- **截止时间**：`deadline` 以 UTC 绝对时刻存储与比较，时区不会错位；过期提交返回 `SUBMISSION_DEADLINE_PASSED`。
- **审核锁定**：approved/instructed 后文件与金额不可改（`REVIEW_LOCKED`）；`PaymentInstructionSent` 携带金额/收款方/用途快照，新增文件不能回溯改变已发指令。
- **额度**：发指令时校验年度购汇额度，超限返回 `QUOTA_EXCEEDED`。
- **退款**：学校退款入账后生成 `REFUND_PENDING` 待办，代理/申请人确认后消除。
- **回执**：银行回执允许业务时间早于记录时间（晚到）；同指令状态矛盾给 `RECEIPT_STATUS_CONFLICT`；找不到指令的回执标记 `UNMATCHED_RECEIPT`。
- **未成年人**：minor 汇款对审核员/银行视图脱敏（姓名 `王*`、文件名 `***`、哈希截断），申请人与代理见全文。
- **幂等**：带 `idempotencyKey` 的命令重放直接返回首次结果，覆盖重复上传、重复撤回、回执重试。
- **持久化**：启动重放 `.data/<transferId>.jsonl`，待审核队列（`GET /queue`）与已发送凭证（`GET /instructions`）重启后仍在；拒绝依据保存在 `review.reason`，随时可解释。

## HTTP API（均通过 `x-actor-id` 头标识操作者）

| 方法/路径 | 说明 |
|---|---|
| `POST /transfers` | 开立汇款（body: transferId, applicantId, studentName, studentMinor, deadline, currency, now?） |
| `POST /transfers/:id/commands` | 执行命令（body: `{command, idempotencyKey?, now?, quotaUsed?, quotaLimit?}`） |
| `GET  /transfers/:id` | 按查看者角色投影的汇款视图（`?viewer=`） |
| `GET  /transfers/:id/todos` | 实时派生待办（`?now=` 可指定时刻） |
| `GET  /transfers/:id/events` | 原始事件流（审计/重放依据） |
| `GET  /transfers/:id/audit` | 命令级审计记录（applied/replayed/rejected/noop） |
| `GET  /queue` | 待审核队列 |
| `GET  /instructions` | 已发送凭证（含最新回执状态） |
| `GET  /health` | 健康检查 |

命令类型见 `decide()` 的 switch：`addParticipant / setPayee / setPurpose / setCurrency /
setPaymentAmount / confirmAmountConsistency / uploadDocument / grantAuthorization /
revokeAuthorization / submitForReview / review / resubmit / sendPaymentInstruction /
recordBankReceipt / recordRefund / acknowledgeRefund`。
