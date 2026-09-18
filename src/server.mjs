import { createServer } from 'node:http';
import { EventStore, defaultStorePath } from './domain/store.mjs';
import { TransferService } from './domain/service.mjs';
import { createApp } from './http/app.mjs';

// 进程拉起：加载追加日志 -> 重建待审核队列与已发送凭证 -> 补匹配挂起回执。
export async function buildContext({ storePath = defaultStorePath(), clock } = {}) {
  const store = new EventStore(storePath, clock);
  await store.load();
  const service = new TransferService(store, clock);
  // 银行回执可能先于指令落盘（晚到/乱序重放）：启动时尝试补匹配。
  await service.replayHeldReceipts();
  return { store, service };
}

async function main() {
  const { service } = await buildContext();
  const app = createApp(service);
  const server = createServer(app);
  const port = Number(process.env.PORT || 3000);
  server.listen(port, () => {
    console.log(`汇款材料协同服务已启动: http://localhost:${port} (事件 ${service.store.events.length} 条)`);
  });
}

// 仅在被直接执行时启动 HTTP 服务，便于测试复用 buildContext。
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
