// 时间与跨时区工具：领域内一律使用 UTC 时刻比较，展示时再带回时区标签。
// 学校截止时间可能以当地墙钟时间给出（如 America/New_York），
// 这里借助 Intl 提供的偏移量把“当地墙钟时间”换算成 UTC 时刻，避免按时区硬编码。

function offsetMsAt(instant, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(instant).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
  );
  // hour12:false 下个别运行时午夜会给出 "24"
  const hour = Number(parts.hour) % 24;
  const asUTC = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    hour, Number(parts.minute), Number(parts.second),
  );
  return asUTC - instant.getTime();
}

// 墙钟时间（不带时区的 'YYYY-MM-DDTHH:mm:ss'）+ IANA 时区 -> UTC 时刻。
// 两次定点迭代即可消除 DST 切换附近的歧义。
export function zonedWallToInstant(wall, tz) {
  let guess = Date.parse(`${wall}Z`);
  if (Number.isNaN(guess)) throw new DomainTimeError(`无法解析的本地时间: ${wall}`);
  for (let i = 0; i < 3; i += 1) {
    const offset = offsetMsAt(new Date(guess), tz);
    const instant = guess - offset;
    if (offsetMsAt(new Date(instant), tz) === offset) return new Date(instant);
    guess = instant;
  }
  throw new DomainTimeError(`时区换算失败: ${wall} @ ${tz}`);
}

export class DomainTimeError extends Error {}

// 接受带偏移的 ISO 字符串（...Z / +08:00 / -04:00），返回 Date。
export function parseInstant(input) {
  if (input instanceof Date) return input;
  const ms = Date.parse(input);
  if (Number.isNaN(ms)) throw new DomainTimeError(`无法解析的时刻: ${input}`);
  return new Date(ms);
}

// 截止时间入参：{ instant } 或 { localDateTime, tz }。
export function parseDeadline(input) {
  if (!input) return null;
  if (input.instant) return { instant: parseInstant(input.instant), tz: input.tz || 'UTC' };
  if (input.localDateTime && input.tz) {
    return { instant: zonedWallToInstant(input.localDateTime, input.tz), tz: input.tz };
  }
  throw new DomainTimeError('截止时间需要 instant 或 localDateTime+tz');
}

// 某时区下一个自然月的 UTC 半开区间 [start, end)，用于月末核账。
export function monthRange(yearMonth, tz) {
  const match = /^(\d{4})-(\d{2})$/.exec(yearMonth);
  if (!match) throw new DomainTimeError(`月份格式应为 YYYY-MM: ${yearMonth}`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  const start = zonedWallToInstant(`${y}-${String(m).padStart(2, '0')}-01T00:00:00`, tz);
  const endYear = m === 12 ? y + 1 : y;
  const endMonth = m === 12 ? 1 : m + 1;
  const end = zonedWallToInstant(
    `${endYear}-${String(endMonth).padStart(2, '0')}-01T00:00:00`, tz,
  );
  return { start, end };
}

export function iso(d) {
  return new Date(d).toISOString();
}

export function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86_400_000);
}
