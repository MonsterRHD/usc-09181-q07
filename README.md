# 留学汇款材料协同服务

申请人、家长代理与审核员围绕**一笔汇款**协同维护收款方、用途、额度、文件有效期与授权关系的服务。
全部事实以追加事件落盘，状态只能由事件回放得到——进程重启后待审核队列与已发送凭证自动恢复，
重复上传、撤回授权、跨时区截止、银行回执晚到等情形均可安全重放。

## 运行

```bash
npm start          # 启动 HTTP 服务，默认端口 3000
npm test           # 运行全部测试（node:test，零第三方依赖）
```

环境变量：`PORT`（端口）、`STORE_PATH`（事件日志路径，默认 `data/events.log`）、
`QUOTA_LIMIT_USD`（年度便利化额度，默认 50000）。

## 领域模型与关键规则

- **一笔汇款（transfer）** 是一个事件流，另设 `authz`（授权）、`receipts`（银行回执）两个系统流。
  每条事件带 `seq/prevHash/hash`，流内形成哈希链；月末核账会校验全链完整性。
- **文件版本化**：同一材料槽位（录取通知书、学费通知单、收入证明……）的替换生成新版本，
  旧版本标记 `superseded` 且不会“复活”；收入证明等时效材料必须给有效期，
  过期版本阻断审核，也**不能上传一份已经过期的文件**冒充新版。
- **同内容重复上传**不产生新版本，只记录去重事件，可重复重放。
- **金额变化**：学校新通知单金额与登记金额不一致时挂出阻断待办，在审提交自动回草稿；
  申请人确认后金额才更新，随后重新提交审核。
- **指令不可变**：审核通过后发送的汇款指令携带材料与要素快照；此后允许追加文件形成版本，
  但收款方/用途/金额一律锁定，新文件不能回溯改变已发送凭证。
- **授权关系**：监护人代理须持有效授权（可过期、可撤回、可更换代理）；撤回或更换代理使
  在审/已通过未发送的提交失效；撤回命令本身幂等。
- **学校退款**登记为明确待办，结算后回退购汇额度；全部退款结清且回执匹配后汇款结清。
- **银行回执乱序/晚到**：找不到对应指令时先挂起（held），指令发送后或进程重启重放时补匹配，
  乱序/晚到会在匹配事件与核账报告中标记；同一银行参考号重复推送幂等。
- **跨时区截止**：学校截止按其本地时区（IANA，含夏令时）换算为 UTC 时刻比较，月末窗口同样支持指定时区。
- **未成年人最小化**：本人、当前有效监护人、审核员见办理所需信息；授权失效的旧代理只见材料类别与版本、
  不见文件标识与姓名；银行/学校只见金额、指令引用与收款等办理必需项；无关人员无可见字段。
- **拒绝可解释**：驳回必须附理由与政策依据，持久保留在事件中，随时可回看。

### 状态机

```
draft ──submit──▶ in_review ──approve──▶ approved ──issue──▶ sent ──回执匹配(且退款结清)──▶ settled
  ▲                  │  │                   │
  │                  │  └─reject──▶ rejected │
  └── 要素变化 / 授权撤回或更换代理 ──────────┘   （仅 sent 之前；sent 后要素锁定）
```

## 主要 HTTP 接口

所有写接口需 `x-actor-id` / `x-actor-role` 请求头标识操作者；权限不足返回 403。

| 方法 & 路径 | 说明 |
| --- | --- |
| `POST /transfers` | 开立汇款（支持 `Idempotency-Key` 式的 `idempotencyKey`） |
| `GET /transfers` / `GET /transfers/:id` | 待审核队列 / 汇款详情（按身份做最小化裁剪） |
| `PUT /transfers/:id/payee`、`/purpose`、`/deadline`、`/minor` | 维护要素 |
| `POST /transfers/:id/amount` | 手动变更金额（发送前） |
| `POST /transfers/:id/documents` | 上传/替换文件（自动版本化、去重） |
| `POST /transfers/:id/acknowledge-amount` | 确认新通知单金额变化 |
| `POST /transfers/:id/submit`、`/approve`、`/reject`、`/issue` | 审核与发送指令 |
| `POST /transfers/:id/refunds`、`POST /transfers/:id/refunds/:rid/settle` | 学校退款与结算 |
| `POST /authorizations`、`/authorizations/:id/revoke`、`POST /agent-replacements` | 授权管理 |
| `POST /bank/receipts`、`POST /bank/replay` | 银行回执上报 / 重放挂起回执 |
| `GET /reconciliation?month=YYYY-MM&tz=...` | 月末核账（审核员/管理员） |

## 目录

```
src/domain/   时钟换算、事件、存储、投影/待办、应用服务、核账、最小化展示
src/http/     路由与 JSON 接口
src/server.mjs 进程入口：加载事件日志 → 重建状态 → 补匹配挂起回执
test/         领域场景与 HTTP 端到端测试
```
