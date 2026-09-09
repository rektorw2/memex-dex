/**
 * Строка памяти в журнал раз в минуту.
 *
 * Render показывает график памяти, но не говорит, что процесс делал в
 * момент пика. Эта строка кладёт рядом с временем цифры процесса —
 * RSS, куча, внешние буферы — и то, что дешево узнать без запросов
 * к базе: сколько кошельков сейчас пересчитывается и когда агент
 * завершил проход. По журналу за сутки пик памяти сопоставляется с
 * задачей, которая шла в ту минуту. Секретов и адресов нет.
 *
 * Это измерение, а не лечение: воркер ничего не чистит и не
 * ограничивает.
 */
import { logger } from '../lib/logger.js';

export const MEMORY_MONITOR_INTERVAL_MS = 60_000;

let timer: NodeJS.Timeout | null = null;

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);

export interface MemorySample {
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  uptimeSec: number;
}

export function memorySample(): MemorySample {
  const m = process.memoryUsage();
  return {
    rssMb: mb(m.rss),
    heapUsedMb: mb(m.heapUsed),
    heapTotalMb: mb(m.heapTotal),
    externalMb: mb(m.external),
    arrayBuffersMb: mb(m.arrayBuffers),
    uptimeSec: Math.round(process.uptime()),
  };
}

/** Что процесс делает сейчас — дешёвые счётчики из памяти, без базы. */
type ActivityProbe = () => Record<string, unknown>;
const probes = new Map<string, ActivityProbe>();

export function registerMemoryActivityProbe(name: string, probe: ActivityProbe): void {
  probes.set(name, probe);
}

export function memoryMonitorLine(): Record<string, unknown> {
  const activity: Record<string, unknown> = {};
  for (const [name, probe] of probes) {
    try { activity[name] = probe(); } catch { activity[name] = 'probe_failed'; }
  }
  return { ...memorySample(), activity };
}

export function startMemoryMonitor(): void {
  if (timer) return;
  const tick = () => logger.info(memoryMonitorLine(), 'память процесса');
  tick();
  timer = setInterval(tick, MEMORY_MONITOR_INTERVAL_MS);
  timer.unref?.();
}

export function stopMemoryMonitor(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
