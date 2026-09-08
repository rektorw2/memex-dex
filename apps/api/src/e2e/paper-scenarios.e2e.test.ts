import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { runPaperAgentTickOnce, queuePaperAgentSignal } from '../workers/paper-agent.js';
import { PAPER_LEDGER_EVENTS } from '@memex/core';
import {
  activeAllocations,
  activeSession,
  allocationDiagnostics,
  assertSchemaReady,
  baselineRun,
  createToken,
  emitSignal,
  enableAgent,
  expectNoSigningOrBroadcast,
  forbidNetwork,
  ledgerOf,
  money,
  paperAgentSnapshot,
  resetData,
  setPrice,
  setupAutopilotAgent,
  setupPaperAgent,
} from './harness.js';

/**
 * Одиннадцать сценариев PAPER-режима на настоящей базе.
 *
 * Каждый идёт полным путём: управляемый сигнал → очередь → воркер →
 * решение → распределение капитала → счёт и журнал → позиция → снимок
 * `/paper-agent`. Ни воркер, ни служба капитала, ни маршрут не
 * подменены.
 *
 * После каждого сценария проверяется одно и то же: контур подписи не
 * ожил, выводов нет, в сеть никто не ходил. Бумажный режим не имеет
 * права ничего из этого делать ни при каком стечении обстоятельств.
 */

/** Цена входа. Круглая, чтобы арифметику можно было проверить в уме. */
const ENTRY_PRICE = 1;
const NOW = new Date('2026-09-05T12:00:00.000Z');

let restoreNetwork: () => void;

beforeAll(async () => {
  await assertSchemaReady();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(NOW);
  restoreNetwork = forbidNetwork();
  await resetData();
});

afterEach(async () => {
  await expectNoSigningOrBroadcast();
  restoreNetwork();
  vi.useRealTimers();
});

/** Довести сигнал до решения через очередь и проход воркера. */
async function pushThroughQueue(signalId: string): Promise<void> {
  queuePaperAgentSignal(signalId);
  await runPaperAgentTickOnce();
}

/** Открыть позицию и вернуть её идентификаторы. */
async function openPosition(price = ENTRY_PRICE) {
  const token = await createToken({ priceUsd: price }, NOW);
  const signal = await emitSignal({ tokenId: token.id, priceUsd: price }, NOW);
  await pushThroughQueue(signal.id);
  return { token, signal };
}

describe('1. Прибыльная позиция', () => {
  it('открывается, растёт, закрывается и переносит результат в realized', async () => {
    await setupPaperAgent({ capitalUsd: '1000', maxOpenPositions: 4 });
    const { token, signal } = await openPosition();

    const opened = await baselineRun(signal.id);
    expect(opened.state, 'позиция должна открыться').toBe('PAPER_OPEN');
    expect(opened.decisionCode).toBe('ELIGIBLE');

    const afterOpen = await activeSession();
    const reservedAfterOpen = money(afterOpen.reservedBalanceUsd);
    const inPositions = money(afterOpen.inPositionsUsd);
    expect(inPositions, 'капитал ушёл в позицию').toBeGreaterThan(0);
    expect(afterOpen.openPositions).toBe(1);

    /*
     * Цена растёт, но до цели не доходит: позиция обязана остаться
     * открытой, а нереализованный результат — стать положительным.
     */
    await setPrice(token.id, ENTRY_PRICE * 1.5);
    await runPaperAgentTickOnce();

    const marked = await baselineRun(signal.id);
    expect(marked.state, 'до цели позиция не закрывается').toBe('PAPER_OPEN');
    expect(money(marked.unrealizedPnlUsd), 'рост даёт положительный PnL').toBeGreaterThan(0);

    // Цель — двукратный рост; переступаем её с запасом.
    await setPrice(token.id, ENTRY_PRICE * 3);
    await runPaperAgentTickOnce();

    const closed = await baselineRun(signal.id);
    expect(closed.state, 'цель достигнута — позиция закрыта').toBe('PAPER_CLOSED');
    expect(money(closed.realizedPnlUsd), 'результат положительный').toBeGreaterThan(0);

    const session = await activeSession();
    expect(session.openPositions, 'позиция освободила слот').toBe(0);
    expect(money(session.inPositionsUsd), 'капитал вернулся из позиции').toBe(0);
    expect(money(session.reservedBalanceUsd), 'резерв не тронут').toBe(reservedAfterOpen);
    expect(money(session.realizedPnlUsd), 'результат перенесён в realized').toBeGreaterThan(0);
    expect(money(session.equityUsd), 'капитал вырос').toBeGreaterThan(1000);

    /*
     * Расходы учтены ровно один раз.
     *
     * Двойной учёт комиссии — ошибка, которую не видно в PnL одной
     * сделки: она выглядит просто как чуть худший результат.
     */
    expect(money(session.tradingFeesUsd), 'комиссия входа и выхода').toBeGreaterThan(0);
    expect(money(session.networkCostsUsd), 'сетевые расходы двух сторон').toBeCloseTo(0.04, 6);

    /*
     * Первое событие называется `INITIALIZE`, а не `DEPOSIT`.
     *
     * Тест сначала ожидал `DEPOSIT` — и ошибался именно тест.
     * Виртуальный капитал назначает администратор: человек ничего
     * не вносил и ничего не может вывести. Слово «внесено» рядом
     * с готовящимся приёмом настоящих депозитов вводило бы
     * в заблуждение там, где ошибка дороже всего.
     */
    const ledger = await ledgerOf(session.id);
    expect(ledger.map((row) => row.eventType)).toEqual(['INITIALIZE', 'OPEN', 'CLOSE']);
    for (const row of ledger) {
      expect(PAPER_LEDGER_EVENTS, row.eventType).toContain(row.eventType);
    }

    const snapshot = await paperAgentSnapshot();
    expect(snapshot.wallet.capital.realizedPnlUsd).toBeGreaterThan(0);
    expect(snapshot.positions, 'открытых позиций не осталось').toHaveLength(0);
  });
});

describe('2. Убыточная позиция', () => {
  it('падение цены даёт отрицательный нереализованный результат', async () => {
    await setupPaperAgent({ capitalUsd: '1000', maxOpenPositions: 4 });
    const { token, signal } = await openPosition();

    await setPrice(token.id, ENTRY_PRICE * 0.4);
    await runPaperAgentTickOnce();

    const marked = await baselineRun(signal.id);
    expect(marked.state, 'убыток сам по себе позицию не закрывает').toBe('PAPER_OPEN');
    expect(money(marked.unrealizedPnlUsd), 'результат отрицательный').toBeLessThan(0);

    const session = await activeSession();
    expect(money(session.unrealizedPnlUsd)).toBeLessThan(0);
    expect(money(session.equityUsd), 'капитал уменьшился').toBeLessThan(1000);
    expect(money(session.drawdownPct), 'просадка выросла').toBeGreaterThan(0);

    /*
     * Слот и капитал остаются занятыми: пока позиция открыта,
     * деньги в ней, и свободными их считать нельзя.
     */
    expect(session.openPositions).toBe(1);
    expect(money(session.inPositionsUsd)).toBeGreaterThan(0);

    const snapshot = await paperAgentSnapshot();
    expect(snapshot.positions, 'позиция видна человеку').toHaveLength(1);
    expect(snapshot.positions[0].unrealizedPnlUsd).toBeLessThan(0);
  });
});

describe('3. Цена отсутствует', () => {
  it('позиция не открывается и капитал не резервируется', async () => {
    await setupPaperAgent({ capitalUsd: '1000', maxOpenPositions: 4 });
    const before = await activeSession();

    const token = await createToken({ priceUsd: null }, NOW);
    const signal = await emitSignal({ tokenId: token.id, priceUsd: null }, NOW);
    await pushThroughQueue(signal.id);

    const waiting = await baselineRun(signal.id);
    expect(waiting.state, 'ожидание цены — не отказ').toBe('WAITING_PRICE');
    expect(waiting.decisionCode).toBe('WAITING_FOR_PRICE');

    const after = await activeSession();
    expect(money(after.freeBalanceUsd), 'свободный остаток не тронут').toBe(
      money(before.freeBalanceUsd),
    );
    expect(money(after.inPositionsUsd), 'ничего не ушло в позицию').toBe(0);
    expect(after.openPositions).toBe(0);
    expect(await prisma.paperAgentAllocation.count(), 'распределения не было').toBe(0);
    expect(
      (await ledgerOf(after.id)).map((r) => r.eventType),
      'в журнале только создание счёта — никакого внесения средств не было',
    ).toEqual(['INITIALIZE']);
  });

  it('появившаяся цена продолжает тот же run, а не создаёт новый', async () => {
    await setupPaperAgent({ capitalUsd: '1000', maxOpenPositions: 4 });
    const token = await createToken({ priceUsd: null }, NOW);
    const signal = await emitSignal({ tokenId: token.id, priceUsd: null }, NOW);
    await pushThroughQueue(signal.id);

    const waiting = await baselineRun(signal.id);

    await setPrice(token.id, ENTRY_PRICE);
    await runPaperAgentTickOnce();

    const resumed = await baselineRun(signal.id);
    expect(resumed.id, 'тот же самый run').toBe(waiting.id);
    expect(resumed.state).toBe('PAPER_OPEN');
    expect(
      await prisma.paperAgentRun.count({ where: { signalId: signal.id } }),
      'новых run не появилось',
    ).toBe(await prisma.paperAgentStrategy.count({ where: { isEnabled: true } }));
  });
});

describe('4. Резкий скачок цены', () => {
  it('не порождает NaN, Infinity и отрицательных балансов', async () => {
    await setupPaperAgent({ capitalUsd: '1000', maxOpenPositions: 4 });
    const { token, signal } = await openPosition();

    // Скачок на семь порядков вверх: цель пройдена далеко за один шаг.
    await setPrice(token.id, ENTRY_PRICE * 10_000_000);
    await runPaperAgentTickOnce();

    const run = await baselineRun(signal.id);
    const session = await activeSession();

    for (const [name, value] of Object.entries({
      realized: money(run.realizedPnlUsd),
      free: money(session.freeBalanceUsd),
      reserved: money(session.reservedBalanceUsd),
      inPositions: money(session.inPositionsUsd),
      equity: money(session.equityUsd),
    })) {
      expect(Number.isFinite(value), `${name} должно быть конечным числом`).toBe(true);
    }

    expect(money(session.freeBalanceUsd), 'свободный остаток не уходит в минус').toBeGreaterThanOrEqual(0);
    expect(money(session.reservedBalanceUsd)).toBeGreaterThanOrEqual(0);
    expect(money(session.inPositionsUsd)).toBeGreaterThanOrEqual(0);

    /*
     * Решение и его причина остаются в журнале капитала: скачок —
     * это событие, о котором потом спросят.
     */
    const ledger = await ledgerOf(session.id);
    expect(ledger.some((row) => row.eventType === 'CLOSE'), 'закрытие записано').toBe(true);
  });

  it('исчезнувшая цена не закрывает позицию наугад', async () => {
    /*
     * Неоднозначный результат не должен приводить к действию.
     * Пропавшая цена — это «не знаем, сколько стоит», а не «ноль».
     */
    await setupPaperAgent({ capitalUsd: '1000', maxOpenPositions: 4 });
    const { token, signal } = await openPosition();

    await setPrice(token.id, null);
    await runPaperAgentTickOnce();

    const run = await baselineRun(signal.id);
    expect(run.state, 'позиция остаётся открытой').toBe('PAPER_OPEN');
    expect(run.exitAt, 'выхода не было').toBeNull();
  });
});

describe('5. Дубликат сигнала', () => {
  it('повторная обработка не создаёт второй позиции и не двигает деньги дважды', async () => {
    await setupPaperAgent({ capitalUsd: '1000', maxOpenPositions: 4 });
    const { signal } = await openPosition();

    const afterFirst = await activeSession();
    const ledgerAfterFirst = await ledgerOf(afterFirst.id);

    // Тот же сигнал приходит в очередь ещё дважды.
    await pushThroughQueue(signal.id);
    await pushThroughQueue(signal.id);

    const afterRepeat = await activeSession();
    expect(afterRepeat.openPositions, 'позиция по-прежнему одна').toBe(1);
    expect(money(afterRepeat.inPositionsUsd)).toBe(money(afterFirst.inPositionsUsd));
    expect(money(afterRepeat.freeBalanceUsd)).toBe(money(afterFirst.freeBalanceUsd));
    expect(
      (await ledgerOf(afterRepeat.id)).length,
      'в журнале не появилось новых записей',
    ).toBe(ledgerAfterFirst.length);

    /*
     * Считаются только распределения активного счёта.
     *
     * Первая версия теста считала все `OPEN` подряд, видела два и
     * называла это дублем. На деле второе принадлежит shadow-счёту:
     * у него собственный капитал, собственный журнал и собственная
     * политика, и его существование — работающее разделение, а не
     * ошибка. Экономическое действие активного контура — ровно одно.
     */
    expect(
      (await activeAllocations(afterRepeat.id, 'OPEN')).length,
      'у активного счёта одно денежное распределение',
    ).toBe(1);
  });

  it('shadow-счёт не двигает деньги активного', async () => {
    /*
     * Обратная сторона того же контракта. Shadow ведёт параллельный
     * эксперимент, и если бы он трогал активный счёт, разделение
     * было бы декоративным.
     */
    await setupPaperAgent({ capitalUsd: '1000', maxOpenPositions: 4 });
    await openPosition();

    const active = await activeSession();
    const shadow = await prisma.paperAgentAccountSession.findFirstOrThrow({
      where: { kind: 'SHADOW' },
    });

    expect(shadow.id).not.toBe(active.id);
    expect(
      await prisma.paperAgentCapitalLedger.count({ where: { sessionId: active.id } }),
      'журнал активного счёта содержит только его события',
    ).toBe((await ledgerOf(active.id)).length);
    expect(
      (await activeAllocations(active.id, 'OPEN')).every((row) => row.isShadow === false),
      'ни одно распределение активного счёта не помечено shadow',
    ).toBe(true);
    expect(
      await prisma.paperAgentAllocation.count({ where: { sessionId: shadow.id, isShadow: false } }),
      'на shadow-счёте нет активных распределений',
    ).toBe(0);
  });

  it('повторный проход не создаёт второй run на пару сигнал+стратегия', async () => {
    // Контракт идемпотентности: один run на `(signalId, strategyId)`.
    await setupPaperAgent({ capitalUsd: '1000', maxOpenPositions: 4 });
    const { signal } = await openPosition();

    const strategies = await prisma.paperAgentStrategy.count({ where: { isEnabled: true } });
    await pushThroughQueue(signal.id);
    await runPaperAgentTickOnce();

    expect(
      await prisma.paperAgentRun.count({ where: { signalId: signal.id } }),
      'на каждую включённую стратегию ровно один run',
    ).toBe(strategies);
  });

  it('параллельные проходы не удваивают деньги', async () => {
    /*
     * Два прохода стартуют одновременно. Захват строки счёта идёт
     * по `ledgerVersion`, поэтому второй обязан либо увидеть уже
     * созданное распределение, либо получить конфликт и повторить —
     * но не открыть вторую позицию.
     */
    await setupPaperAgent({ capitalUsd: '1000', maxOpenPositions: 4 });
    const token = await createToken({ priceUsd: ENTRY_PRICE }, NOW);
    const signal = await emitSignal({ tokenId: token.id, priceUsd: ENTRY_PRICE }, NOW);

    queuePaperAgentSignal(signal.id);
    await Promise.all([runPaperAgentTickOnce(), runPaperAgentTickOnce()]);

    const session = await activeSession();
    expect(session.openPositions, 'позиция одна').toBe(1);
    expect(
      (await activeAllocations(session.id, 'OPEN')).length,
      'денежное распределение одно',
    ).toBe(1);
    expect(
      (await ledgerOf(session.id)).filter((row) => row.eventType === 'OPEN').length,
      'запись открытия в журнале одна',
    ).toBe(1);
  });
});

describe('6. Перезапуск процесса', () => {
  it('очередь теряется, но воркер сам находит необработанный сигнал', async () => {
    await setupPaperAgent({ capitalUsd: '1000', maxOpenPositions: 4 });
    const token = await createToken({ priceUsd: ENTRY_PRICE }, NOW);
    const signal = await emitSignal({ tokenId: token.id, priceUsd: ENTRY_PRICE }, NOW);

    /*
     * Перезапуск моделируется честно: сигнал в очередь не попадает
     * вовсе — ровно как после падения процесса, где очередь жила
     * только в памяти. Проход обязан подобрать его сам.
     */
    await runPaperAgentTickOnce();

    const run = await baselineRun(signal.id);
    expect(run.state, 'сигнал подобран без очереди').toBe('PAPER_OPEN');

    const session = await activeSession();
    expect(session.openPositions).toBe(1);

    // Второй проход после «перезапуска» ничего не удваивает.
    await runPaperAgentTickOnce();
    const again = await activeSession();
    expect(again.openPositions).toBe(1);
    expect(money(again.freeBalanceUsd)).toBe(money(session.freeBalanceUsd));
  });
});

describe('7. Предел экспозиции', () => {
  it('вход разрешён, пока есть экспозиция, и отклонён, когда она исчерпана', async () => {
    /*
     * Предел проверяется в AUTOPILOT, и на то есть причина в формуле.
     *
     * В FIXED размер позиции выводится как
     * `maxExposurePct / maxOpenPositions` от капитала, поэтому
     * экспозиция и слоты кончаются одновременно, а первым в порядке
     * проверок стоит предел числа позиций. Отдельно наблюдать
     * исчерпание экспозиции там нельзя вовсе.
     *
     * У профиля BALANCED пять слотов по 20 % при экспозиции 70 %:
     * 5 × 20 > 70, поэтому экспозиция кончается раньше слотов —
     * то самое состояние, которое нужно проверить.
     */
    await setupAutopilotAgent({ capitalUsd: '1000', riskProfile: 'BALANCED' });

    const opened: string[] = [];
    let refusedRunId: string | null = null;

    // Открываем, пока разрешают, но не больше числа слотов.
    for (let attempt = 0; attempt < 8; attempt++) {
      const token = await createToken({ priceUsd: ENTRY_PRICE }, NOW);
      const signal = await emitSignal({ tokenId: token.id, priceUsd: ENTRY_PRICE }, NOW);
      await pushThroughQueue(signal.id);

      const run = await baselineRun(signal.id);
      if (run.state === 'PAPER_OPEN') {
        opened.push(run.id);
        continue;
      }
      refusedRunId = run.id;
      break;
    }

    expect(opened.length, 'хотя бы один вход до порога обязан пройти').toBeGreaterThan(0);
    expect(refusedRunId, 'после исчерпания экспозиции вход обязан быть отклонён').not.toBeNull();

    const before = await activeSession();
    const refused = await prisma.paperAgentRun.findUniqueOrThrow({ where: { id: refusedRunId! } });

    /*
     * Причина названа и относится к капиталу, а не к слотам:
     * иначе сценарий проверял бы не тот предел.
     */
    expect(refused.state, await allocationDiagnostics(refused.id)).toBe('SKIPPED');
    expect(refused.decisionCode, await allocationDiagnostics(refused.id)).toBe(
      'CAPITAL_EXPOSURE_LIMIT_REACHED',
    );
    expect(
      before.openPositions,
      'слоты ещё оставались — значит сработала именно экспозиция',
    ).toBeLessThan(before.maxOpenPositions);

    // Отказ ничего не занял.
    const after = await activeSession();
    expect(money(after.inPositionsUsd)).toBe(money(before.inPositionsUsd));
    expect(after.openPositions).toBe(before.openPositions);
    expect(
      (await activeAllocations(after.id, 'OPEN')).length,
      'отказ не создал денежного распределения',
    ).toBe(opened.length);

    const snapshot = await paperAgentSnapshot();
    const decision = snapshot.recentDecisions.find((row: any) => row.id === refused.id);
    expect(decision, 'решение видно человеку').toBeTruthy();
    expect(decision.decisionCode).toMatch(/^CAPITAL_/);
  });
});

describe('8. Предел числа открытых позиций', () => {
  it('после исчерпания слотов вход отклонён', async () => {
    await setupPaperAgent({ capitalUsd: '1000', maxOpenPositions: 1, reservePct: 30 });

    const first = await openPosition();
    const firstRun = await baselineRun(first.signal.id);
    expect(firstRun.state, await allocationDiagnostics(firstRun.id)).toBe('PAPER_OPEN');

    const before = await activeSession();
    expect(before.openPositions, 'слот занят').toBe(1);

    const token = await createToken({ priceUsd: ENTRY_PRICE }, NOW);
    const second = await emitSignal({ tokenId: token.id, priceUsd: ENTRY_PRICE }, NOW);
    await pushThroughQueue(second.id);

    const run = await baselineRun(second.id);
    expect(run.state, await allocationDiagnostics(run.id)).toBe('SKIPPED');
    expect(run.decisionCode).toBe('CAPITAL_MAX_POSITIONS_REACHED');

    const after = await activeSession();
    expect(after.openPositions, 'второй слот не появился').toBe(1);
    expect(money(after.inPositionsUsd)).toBe(money(before.inPositionsUsd));
  });

  it('предел переживает перезапуск', async () => {
    // Лимит хранится в счёте, а не в памяти процесса.
    await setupPaperAgent({ capitalUsd: '1000', maxOpenPositions: 1, reservePct: 30 });
    await openPosition();

    const token = await createToken({ priceUsd: ENTRY_PRICE }, NOW);
    const second = await emitSignal({ tokenId: token.id, priceUsd: ENTRY_PRICE }, NOW);

    await runPaperAgentTickOnce();
    await runPaperAgentTickOnce();

    const run = await baselineRun(second.id);
    expect(run.decisionCode, await allocationDiagnostics(run.id)).toBe(
      'CAPITAL_MAX_POSITIONS_REACHED',
    );
  });
});

describe('9. Суточный предел входов', () => {
  it('до предела вход проходит, после — отклонён', async () => {
    /*
     * Предел задаётся политикой, а не колонкой счёта.
     *
     * Первая версия теста правила колонку `dailyEntryLimit` прямо
     * в строке счёта — и лимит не сработал. Решение читает лимиты из
     * `policySnapshot`, то есть из снимка политики; колонки рядом
     * существуют для отображения. Правильный путь — тот же, которым
     * пользуется администратор: переопределение при настройке.
     */
    await setupAutopilotAgent({
      capitalUsd: '1000',
      riskProfile: 'BALANCED',
      overrides: { dailyEntryLimit: 1 },
    });

    const allowed = await openPosition();
    const allowedRun = await baselineRun(allowed.signal.id);
    expect(allowedRun.state, await allocationDiagnostics(allowedRun.id)).toBe('PAPER_OPEN');

    const before = await activeSession();
    expect(before.dailyEntries, 'первый вход посчитан').toBe(1);

    const token = await createToken({ priceUsd: ENTRY_PRICE }, NOW);
    const second = await emitSignal({ tokenId: token.id, priceUsd: ENTRY_PRICE }, NOW);
    await pushThroughQueue(second.id);

    const run = await baselineRun(second.id);
    expect(run.state, await allocationDiagnostics(run.id)).toBe('SKIPPED');
    expect(run.decisionCode).toBe('CAPITAL_DAILY_ENTRY_LIMIT_REACHED');

    const after = await activeSession();
    expect(after.dailyEntries, 'счётчик не вырос от отказа').toBe(1);
    expect(money(after.inPositionsUsd)).toBe(money(before.inPositionsUsd));
  });

  it('счётчик переживает перезапуск', async () => {
    // Счётчик и его дата лежат в счёте, а не в памяти процесса.
    await setupAutopilotAgent({
      capitalUsd: '1000',
      riskProfile: 'BALANCED',
      overrides: { dailyEntryLimit: 1 },
    });
    await openPosition();

    const token = await createToken({ priceUsd: ENTRY_PRICE }, NOW);
    const second = await emitSignal({ tokenId: token.id, priceUsd: ENTRY_PRICE }, NOW);

    await runPaperAgentTickOnce();
    await runPaperAgentTickOnce();

    const run = await baselineRun(second.id);
    expect(run.decisionCode, await allocationDiagnostics(run.id)).toBe(
      'CAPITAL_DAILY_ENTRY_LIMIT_REACHED',
    );
  });
});

describe('10. Остановка по просадке', () => {
  it('до порога вход возможен, после — нет', async () => {
    /*
     * Порог тоже приходит из политики. В FIXED он равен 100 %,
     * то есть недостижим; у AUTOPILOT он осмысленный, а
     * переопределение — штатная возможность администратора.
     */
    await setupAutopilotAgent({
      capitalUsd: '1000',
      riskProfile: 'BALANCED',
      overrides: { drawdownStopPct: 5 },
    });

    // До порога вход проходит — это негативный контроль к отказу ниже.
    const opened = await openPosition();
    const openedRun = await baselineRun(opened.signal.id);
    expect(openedRun.state, await allocationDiagnostics(openedRun.id)).toBe('PAPER_OPEN');

    /*
     * Позиция уходит в глубокий минус: нереализованный убыток
     * опускает equity, и просадка счёта переступает порог.
     */
    await setPrice(opened.token.id, ENTRY_PRICE * 0.01);
    await runPaperAgentTickOnce();

    const drawn = await activeSession();
    expect(money(drawn.drawdownPct), 'просадка переступила порог').toBeGreaterThanOrEqual(5);

    const historyBefore = await prisma.paperAgentRun.count();
    const nextToken = await createToken({ priceUsd: ENTRY_PRICE }, NOW);
    const next = await emitSignal({ tokenId: nextToken.id, priceUsd: ENTRY_PRICE }, NOW);
    await pushThroughQueue(next.id);

    const run = await baselineRun(next.id);
    expect(run.state, await allocationDiagnostics(run.id)).toBe('SKIPPED');
    expect(run.decisionCode).toBe('CAPITAL_DRAWDOWN_STOP');

    const after = await activeSession();
    expect(money(after.inPositionsUsd), 'отказ ничего не занял').toBe(money(drawn.inPositionsUsd));
    expect(
      await prisma.paperAgentRun.count(),
      'история сохранена: отказ добавляет решение, а не стирает прошлые',
    ).toBeGreaterThan(historyBefore);
    expect(
      (await baselineRun(opened.signal.id)).state,
      'открытая позиция не испорчена остановкой',
    ).toBe('PAPER_OPEN');
  });

  it('остановка переживает перезапуск', async () => {
    await setupAutopilotAgent({
      capitalUsd: '1000',
      riskProfile: 'BALANCED',
      overrides: { drawdownStopPct: 5 },
    });
    const opened = await openPosition();
    await setPrice(opened.token.id, ENTRY_PRICE * 0.01);
    await runPaperAgentTickOnce();

    const token = await createToken({ priceUsd: ENTRY_PRICE }, NOW);
    const next = await emitSignal({ tokenId: token.id, priceUsd: ENTRY_PRICE }, NOW);

    // Проход без очереди — то, что происходит после перезапуска.
    await runPaperAgentTickOnce();
    await runPaperAgentTickOnce();

    const run = await baselineRun(next.id);
    expect(run.decisionCode, await allocationDiagnostics(run.id)).toBe('CAPITAL_DRAWDOWN_STOP');
  });
});

describe('11. Kill switch', () => {
  it('останавливает новые входы, сохраняя историю и открытые позиции', async () => {
    await setupPaperAgent({ capitalUsd: '1000', maxOpenPositions: 4 });
    const opened = await openPosition();

    const beforeStop = await activeSession();
    const historyBefore = await prisma.paperAgentRun.count();

    await enableAgent(false);

    const token = await createToken({ priceUsd: ENTRY_PRICE }, NOW);
    const blocked = await emitSignal({ tokenId: token.id, priceUsd: ENTRY_PRICE }, NOW);
    await pushThroughQueue(blocked.id);

    expect(
      await prisma.paperAgentRun.count({ where: { signalId: blocked.id } }),
      'при выключенном агенте новый вход не создаётся',
    ).toBe(0);
    expect(await prisma.paperAgentRun.count(), 'история не удалена').toBe(historyBefore);

    const openRun = await baselineRun(opened.signal.id);
    expect(openRun.state, 'открытая позиция не испорчена').toBe('PAPER_OPEN');

    const after = await activeSession();
    expect(money(after.inPositionsUsd)).toBe(money(beforeStop.inPositionsUsd));
    expect(after.openPositions).toBe(beforeStop.openPositions);

    /*
     * Открытая позиция продолжает сопровождаться: кнопка запрещает
     * входы, а не бросает уже открытое.
     */
    await setPrice(opened.token.id, ENTRY_PRICE * 3);
    await runPaperAgentTickOnce();
    expect((await baselineRun(opened.signal.id)).state, 'позиция довелась до конца').toBe(
      'PAPER_CLOSED',
    );

    // Обратно включает только администратор — через тот же переход.
    await enableAgent(true);
    expect(
      (await prisma.paperAgentControl.findUniqueOrThrow({ where: { id: 'primary' } })).isEnabled,
    ).toBe(true);
  });
});
