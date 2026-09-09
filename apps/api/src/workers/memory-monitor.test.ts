import { afterEach, describe, expect, it, vi } from 'vitest';

const logs: any[] = [];
vi.mock('../lib/logger.js', () => ({ logger: { info: (obj: any, msg: string) => logs.push({ obj, msg }), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const monitor = await import('./memory-monitor.js');

afterEach(() => { monitor.stopMemoryMonitor(); logs.length = 0; vi.useRealTimers(); });

describe('строка памяти', () => {
  it('содержит цифры процесса в мегабайтах и зарегистрированные пробы', () => {
    monitor.registerMemoryActivityProbe('test', () => ({ jobs: 2 }));
    monitor.registerMemoryActivityProbe('broken', () => { throw new Error('x'); });
    const line = monitor.memoryMonitorLine();
    expect(line.rssMb).toBeGreaterThan(0);
    expect(line.heapUsedMb).toBeGreaterThan(0);
    expect(line.uptimeSec).toBeGreaterThanOrEqual(0);
    expect((line.activity as any).test).toEqual({ jobs: 2 });
    expect((line.activity as any).broken).toBe('probe_failed');
  });

  it('пишет строку сразу при старте и затем раз в минуту; стоп снимает таймер', () => {
    vi.useFakeTimers();
    monitor.startMemoryMonitor();
    expect(logs).toHaveLength(1);
    expect(logs[0].msg).toBe('память процесса');
    vi.advanceTimersByTime(monitor.MEMORY_MONITOR_INTERVAL_MS * 2);
    expect(logs).toHaveLength(3);
    monitor.stopMemoryMonitor();
    vi.advanceTimersByTime(monitor.MEMORY_MONITOR_INTERVAL_MS * 2);
    expect(logs).toHaveLength(3);
  });
});
