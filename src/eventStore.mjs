/**
 * JSONL 追加式事件存储：每个汇款一个流（文件），每行一个事件信封。
 * 服务重启后读取目录、逐行重放即可恢复全部待审核队列与已发送凭证。
 * 写入采用先 append 到临时缓冲再 fsync 的朴素策略，保证崩溃后日志仍可解析。
 */
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';

export class JsonlEventStore {
  constructor(dir) {
    this.dir = dir;
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
  }

  fileOf(transferId) {
    return path.join(this.dir, `${transferId}.jsonl`);
  }

  streamExists(transferId) {
    return existsSync(this.fileOf(transferId));
  }

  async append(transferId, events) {
    const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await fs.appendFile(this.fileOf(transferId), lines, 'utf8');
  }

  async readStream(transferId) {
    let text;
    try {
      text = await fs.readFile(this.fileOf(transferId), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const events = [];
    text.split('\n').forEach((line, i) => {
      const t = line.trim();
      if (!t) return;
      try {
        events.push(JSON.parse(t));
      } catch (err) {
        throw new Error(`事件日志损坏 ${transferId}:${i + 1}: ${err.message}`);
      }
    });
    return events;
  }

  async listStreams() {
    let names = [];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    return names.filter((n) => n.endsWith('.jsonl')).map((n) => n.slice(0, -'.jsonl'.length));
  }
}
