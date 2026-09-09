/**
 * Проверка серверной цепочки по одному настоящему сигналу.
 *
 * Preflight доказывает транспорт и локальный расчёт. Здесь доказывается
 * остальное — и только чтением базы, без сделок и без подмен:
 *
 *   получение → запись `OkxSignal` (providerKey, код приёма)
 *             → обработка воркером (`PaperAgentRun` по этому сигналу)
 *             → сохранённое решение (`decisionCode`, `decidedAt`).
 *
 * Решение может быть пропуском — это тоже обработка. Открытие позиции
 * не требуется и не проверяется. Если за окно наблюдения ни один
 * сигнал сети агента не пришёл, итог — «неполно», не отказ и не успех.
 *
 * Сигнал выбирается один: самый свежий из тех, что источник поставил
 * агенту (`QUEUED_LIVE`), либо тот, чей идентификатор передан явно.
 */
import { SMOKE_EXIT, type SmokeExit } from './exit-codes.js';

export interface StoredSignalRow {
  id: string;
  providerKey: string;
  chain: string;
  symbol: string;
  ingestOrigin: string | null;
  paperAgentIngestCode: string | null;
  signaledAt: Date;
  receivedAt: Date;
}

export interface StoredRunRow {
  id: string;
  strategyId: string;
  strategyKey: string;
  state: string;
  decisionCode: string | null;
  decidedAt: Date | null;
}

export interface EnabledStrategyRow {
  id: string;
  key: string;
}

export interface SignalChainDeps {
  /** Самый свежий сигнал, поставленный агенту, или сигнал по идентификатору. */
  findSignal: (signalId: string | null) => Promise<StoredSignalRow | null>;
  /** Все run воркера по сигналу. */
  findRuns: (signalId: string) => Promise<StoredRunRow[]>;
  /**
   * Действующие стратегии — поимённо. Решение ожидается от каждой из
   * них; решение выключенной стратегии (историческое, до смены
   * baseline) в зачёт не идёт.
   */
  listEnabledStrategies: () => Promise<EnabledStrategyRow[]>;
  /** Сколько ждать появления решения (воркер работает в фоне). */
  waitMs: number;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface SignalChainReport {
  code: SmokeExit;
  status: 'complete' | 'error' | 'incomplete';
  gaps: string[];
  lines: string[];
  signal: { id: string; providerKey: string; chain: string; ingestCode: string | null } | null;
  runs: Array<{ strategyKey: string; state: string; decisionCode: string | null; enabled: boolean }>;
}

const POLL_MS = 1_000;

export async function runSignalChainCheck(deps: SignalChainDeps, signalId: string | null = null): Promise<SignalChainReport> {
  const lines: string[] = [];
  const gaps: string[] = [];
  const log = (line: string) => { lines.push(line); deps.log?.(line); };
  const now = deps.now ?? (() => Date.now());
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const finish = (code: SmokeExit, signal: SignalChainReport['signal'], runs: SignalChainReport['runs']): SignalChainReport => ({
    code, status: code === SMOKE_EXIT.ok ? 'complete' : code === SMOKE_EXIT.incomplete ? 'incomplete' : 'error', gaps, lines, signal, runs,
  });

  // 1. Получение → запись.
  const deadline = now() + deps.waitMs;
  let signal = await deps.findSignal(signalId);
  while (!signal && now() < deadline) {
    await wait(POLL_MS);
    signal = await deps.findSignal(signalId);
  }
  if (!signal) {
    gaps.push(signalId ? `Сигнал ${signalId} в базе не найден` : `За ${Math.round(deps.waitMs / 1000)} с источник не поставил агенту ни одного сигнала сети агента`);
    log(`1. ${gaps[0]}. Серверная цепочка не проверена.`);
    return finish(SMOKE_EXIT.incomplete, null, []);
  }
  const ingestDelayMs = signal.receivedAt.getTime() - signal.signaledAt.getTime();
  log(`1. Сигнал записан: ${signal.chain} ${signal.symbol} · providerKey ${signal.providerKey} · источник ${signal.ingestOrigin ?? '—'} · код приёма ${signal.paperAgentIngestCode ?? '—'} · задержка доставки ${ingestDelayMs} мс.`);
  const summary = { id: signal.id, providerKey: signal.providerKey, chain: signal.chain, ingestCode: signal.paperAgentIngestCode };

  if (signal.paperAgentIngestCode !== 'QUEUED_LIVE') {
    log(`2. Сигнал не был поставлен агенту (код ${signal.paperAgentIngestCode ?? '—'}): воркер по нему решения не принимает — это ожидаемо, но цепочку так не проверить.`);
    gaps.push(`Сигнал имеет код приёма ${signal.paperAgentIngestCode ?? '—'}, а не QUEUED_LIVE`);
    return finish(SMOKE_EXIT.incomplete, summary, []);
  }

  // 2. Обработка воркером → решение действующих стратегий — каждой поимённо.
  const expected = await deps.listEnabledStrategies();
  if (expected.length === 0) {
    gaps.push('Нет ни одной включённой стратегии: решения принимать некому');
    log('2. Включённых стратегий нет — цепочку проверить нельзя.');
    return finish(SMOKE_EXIT.incomplete, summary, []);
  }
  const expectedIds = new Set(expected.map((row) => row.id));
  let runs = await deps.findRuns(signal.id);
  const decidedExpected = () => runs.filter((run) => expectedIds.has(run.strategyId) && run.decidedAt != null && run.decisionCode != null);
  while (decidedExpected().length < expected.length && now() < deadline) {
    await wait(POLL_MS);
    runs = await deps.findRuns(signal.id);
  }
  const rows = runs.map((run) => ({ strategyKey: run.strategyKey, state: run.state, decisionCode: run.decisionCode, enabled: expectedIds.has(run.strategyId) }));
  const historical = runs.filter((run) => !expectedIds.has(run.strategyId));
  if (historical.length > 0) {
    log(`2. Исторические run выключенных стратегий (${historical.map((run) => run.strategyKey).join(', ')}) в зачёт не идут.`);
  }
  const ours = runs.filter((run) => expectedIds.has(run.strategyId));
  if (ours.length === 0) {
    gaps.push(historical.length > 0
      ? 'По сигналу есть только решения выключенных стратегий — действующие его не обрабатывали (исторический сигнал)'
      : 'Воркер не создал ни одного run по сигналу за отведённое время');
    log(`2. Run действующих стратегий по сигналу нет${historical.length > 0 ? ' — сигнал обработан до смены стратегий' : ': сигнал в базе есть, обработка не подтверждена (воркер выключен, не запущен или не успел)'}.`);
    return finish(SMOKE_EXIT.incomplete, summary, rows);
  }
  log(`2. Воркер создал run действующих стратегий: ${ours.length} из ${expected.length}.`);

  const done = decidedExpected();
  if (done.length === 0) {
    gaps.push('Ни один run действующей стратегии не получил решения за отведённое время');
    log('3. Решения ещё нет: run созданы, decidedAt пуст — обработка не завершена.');
    return finish(SMOKE_EXIT.incomplete, summary, rows);
  }
  for (const run of done) {
    log(`3. Решение сохранено: ${run.strategyKey} → ${run.state} · ${run.decisionCode} (${run.decidedAt!.toISOString()}).`);
  }
  const missing = expected.filter((row) => !done.some((run) => run.strategyId === row.id));
  if (missing.length > 0) {
    gaps.push(`Нет решения у действующих стратегий: ${missing.map((row) => row.key).join(', ')}`);
    return finish(SMOKE_EXIT.incomplete, summary, rows);
  }
  log('Цепочка подтверждена по одному сигналу: получение → база → воркер → решение каждой действующей стратегии. Позиция не требовалась и не создавалась.');
  return finish(SMOKE_EXIT.ok, summary, rows);
}
