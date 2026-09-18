import test from 'node:test';
import assert from 'node:assert/strict';
import { zonedWallToInstant, monthRange } from '../src/domain/clock.mjs';

test('跨时区截止：美国东部墙钟时间正确换算为 UTC（含夏令时）', () => {
  // 2026-01-15 美国东部处于标准时 UTC-5
  const winter = zonedWallToInstant('2026-01-15T12:00:00', 'America/New_York');
  assert.equal(winter.toISOString(), '2026-01-15T17:00:00.000Z');
  // 2026-07-15 为夏令时 UTC-4
  const summer = zonedWallToInstant('2026-07-15T12:00:00', 'America/New_York');
  assert.equal(summer.toISOString(), '2026-07-15T16:00:00.000Z');
  // 北京截止 UTC+8
  const bj = zonedWallToInstant('2026-09-30T23:59:59', 'Asia/Shanghai');
  assert.equal(bj.toISOString(), '2026-09-30T15:59:59.000Z');
});

test('月末窗口按指定时区计算，不按 UTC 硬切', () => {
  const r = monthRange('2026-09', 'America/New_York');
  assert.equal(r.start.toISOString(), '2026-09-01T04:00:00.000Z'); // 夏令时 -4
  assert.equal(r.end.toISOString(), '2026-10-01T04:00:00.000Z');
});

test('截止时间按学校本地时区判定，错过截止产生阻断待办', async () => {
  const { service, clock, cleanup } = await (await import('./helpers.mjs')).makeService();
  const { ACTORS } = await import('./helpers.mjs');
  try {
    const { transferId } = await (await import('./helpers.mjs')).openReadyTransfer(service);
    // 截止为纽约时间 2026-12-31 23:59:59（UTC 2027-01-01 04:59:59）
    clock.set('2027-01-01T03:00:00.000Z'); // 纽约本地仍是 2026-12-31 22:00，未过截止
    assert.ok(!service.model.todosOf(transferId).some((t) => t.code === 'DEADLINE_PASSED'));
    clock.set('2027-01-01T05:00:00.000Z'); // 纽约本地 2027-01-01 00:00，已过
    assert.ok(service.model.todosOf(transferId).some((t) => t.code === 'DEADLINE_PASSED'));
  } finally { await cleanup(); }
});
