import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { runPaperAgentTickOnce, queuePaperAgentSignal } from '../workers/paper-agent.js';
import {
  activeAllocations,
  activeSession,
  assertSchemaReady,
  concurrencyVersion,
  baselineRun,
  createToken,
  emitSignal,
  expectNoSigningOrBroadcast,
  expectUniqueViolation,
  forbidNetwork,
  ledgerOf,
  money,
  persistedEquityParts,
  principalState,
  resetData,
  setPrice,
  setupPaperAgent,
  valuationState,
} from './harness.js';

/**
 * Идемпотентность на точках прерывания.
 *
 * Основной набор сценариев проверяет повтор целого прохода. Здесь
 * проверяется то, что случается реже и стоит дороже: процесс умер
 * посередине денежной операции.
 *
 * Каждый тест обрывает работу в конкретной точке, поднимает «новый
 * процесс» — то есть просто делает следующий проход, память которого
 * пуста, — и требует, чтобы деньги применились ровно один раз.
 *
 * Что здесь считается прерыванием. Транзакции Prisma атомарны: убить
 * процесс внутри `$transaction` значит откатить её целиком. Поэтому
 * прерывание моделируется на границах транзакций — там, где состояние
 * уже записано, а следующий шаг ещё нет. Это и есть настоящие точки
 * невозврата: внутри транзакции их не существует по построению.
 */

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

/**
 * Два снимка вместо одного, и это не косметика.
 *
 * Первая версия складывала в один объект основной капитал и
 * переоценку — и тест падал на том, что при повторном проходе
 * `equity` уехало с 1000 на 995.47, а `ledgerVersion` выросло.
 * Обе величины изменились законно: пришла та же котировка, позиция
 * переоценилась, строка счёта была обновлена условным апдейтом.
 * Ни одного нового события в журнале при этом не появилось, и ни
 * один доллар основного капитала не сдвинулся.
 *
 * Контракт с тех пор такой:
 *   • `principalState` обязан быть неизменным при повторе — это
 *     деньги, и двигать их второй раз нельзя;
 *   • `valuationState` меняться вправе, но только от новой цены.
 */
const principal = principalState;
const valuation = valuationState;

describe('повторная доставка одного и того же сигнала', () => {
  it('одинаковый providerKey не создаёт второго сигнала', async () => {
    /*
     * Провайдер присылает событие дважды — по сокету и следом
     * в сверке. Ключ провайдера уникален, поэтому второй записи
     * не появляется, а значит и второго run быть не может.
     */
    await setupPaperAgent({ capitalUsd: '1000', maxOpenPositions: 4 });
    const token = await createToken({ priceUsd: ENTRY_PRICE }, NOW);
    const signal = await emitSignal({ tokenId: token.id, priceUsd: ENTRY_PRICE }, NOW);

    const providerKey = (
      await prisma.okxSignal.findUniqueOrThrow({ where: { id: signal.id } })
    ).providerKey;

    await expectUniqueViolation(
      () => prisma.okxSignal.create({
        data: {
          providerKey,
          chain: 'SOLANA',
          address: 'TEST0duplicate',
          symbol: 'TST',
          name: 'Повтор',
          signaledAt: NOW,
          receivedAt: NOW,
          walletTypes: ['smart_money'],
          source: 'paper-test',
          ingestOrigin: 'TEST_HARNESS',
        },
      }),
      'повторный providerKey обязан отвергаться базой',
    );
  });

  it('один и тот же сигнал из сокета и из сверки даёт одну позицию', async () => {
    /*
     * Происхождение у повторной доставки другое, но сигнал тот же.
     * Решает не источник, а пара «сигнал плюс стратегия».
     */
    await setupPaperAgent({ capitalUsd: '1000', maxOpenPositions: 4 });
    const token = await createToken({ priceUsd: ENTRY_PRICE }, NOW);
    const signal = await emitSignal({ tokenId: token.id, priceUsd: ENTRY_PRICE }, NOW);

    queuePaperAgentSignal(signal.id);
    await runPaperAgentTickOnce();
    const afterFirst = await principal();
    const valuedFirst = await valuation();

    // Та же запись «доставлена» ещё раз — другим путём.
    queuePaperAgentSignal(signal.id, true);
    await runPaperAgentTickOnce();

    expect(await principal(), 'основной капитал не сдвинулся').toEqual(afterFirst);

    /*
     * Цена не менялась, поэтому и переоценка обязана совпасть.
     * Сравниваются только денежные величины: `ledgerVersion` сюда
     * не входит и входить не должна — это версия оптимистичной
     * блокировки, и её рост при условном обновлении строки
     * денежным изменением не является.
     */
    expect(await valuation(), 'без новой цены переоценка та же').toEqual(valuedFirst);

    /*
     * Идемпотентность доказывается количествами, а не тем, что
     * какое-то поле не изменилось: сигнал один, run по одному на
     * стратегию, позиция одна, событие открытия одно.
     */
    const strategies = await prisma.paperAgentStrategy.count({ where: { isEnabled: true } });
    const session = await activeSession();

    expect(await prisma.okxSignal.count(), 'сигнал остался один').toBe(1);
    expect(
      await prisma.paperAgentRun.count({ where: { signalId: signal.id } }),
      'по одному run на стратегию',
    ).toBe(strategies);
    expect(session.openPositions, 'позиция одна').toBe(1);
    expect(
      (await activeAllocations(session.id, 'OPEN')).length,
      'денежное распределение одно',
    ).toBe(1);
    expect(
      (await ledgerOf(session.id)).filter((row) => row.eventType === 'OPEN').length,
      'запись открытия одна',
    ).toBe(1);

    // Версия блокировки при этом расти вправе — и это не дефект.
    expect(await concurrencyVersion(session.id)).toBeGreaterThanOrEqual(1);
  });
});

describe('прерывание между резервом и созданием позиции', () => {
  it('незавершённое решение доводится следующим проходом ровно один раз', async () => {
    /*
     * Состояние после обрыва: run создан и ждёт цену, денег ещё не
     * тронуто. Ровно это остаётся в базе, если процесс умер между
     * созданием run и решением о капитале.
     */
    await setupPaperAgent({ capitalUsd: '1000', maxOpenPositions: 4 });
    const token = await createToken({ priceUsd: null }, NOW);
    const signal = await emitSignal({ tokenId: token.id, priceUsd: null }, NOW);

    queuePaperAgentSignal(signal.id);
    await runPaperAgentTickOnce();

    const waiting = await baselineRun(signal.id);
    expect(waiting.state, 'после обрыва решение не принято').toBe('WAITING_PRICE');
    const beforeMoney = await principal();
    expect(beforeMoney.inPositions, 'деньги не тронуты').toBe(0);

    // «Новый процесс»: очередь пуста, проход подбирает ожидающий run.
    await setPrice(token.id, ENTRY_PRICE);
    await runPaperAgentTickOnce();

    const opened = await baselineRun(signal.id);
    expect(opened.id, 'тот же run, а не новый').toBe(waiting.id);
    expect(opened.state).toBe('PAPER_OPEN');

    const afterOne = await principal();
    expect(afterOne.openPositions).toBe(1);
    expect(afterOne.events.filter((e) => e.startsWith('OPEN:')), 'одно открытие').toHaveLength(1);

    // Ещё два прохода ничего не добавляют.
    await runPaperAgentTickOnce();
    await runPaperAgentTickOnce();

    expect(await principal(), 'повторные проходы денег не двигают').toEqual(afterOne);
  });
});

describe('прерывание между закрытием позиции и следующим проходом', () => {
  it('закрытие не применяется дважды', async () => {
    /*
     * Закрытие пишет разом состояние счёта, распределение и запись
     * журнала — одной транзакцией. Обрыв сразу после неё оставляет
     * позицию закрытой; следующий проход обязан это увидеть и
     * ничего не переписать.
     */
    await setupPaperAgent({ capitalUsd: '1000', maxOpenPositions: 4 });
    const token = await createToken({ priceUsd: ENTRY_PRICE }, NOW);
    const signal = await emitSignal({ tokenId: token.id, priceUsd: ENTRY_PRICE }, NOW);
    queuePaperAgentSignal(signal.id);
    await runPaperAgentTickOnce();

    await setPrice(token.id, ENTRY_PRICE * 3);
    await runPaperAgentTickOnce();

    const closed = await baselineRun(signal.id);
    expect(closed.state, 'позиция закрыта').toBe('PAPER_CLOSED');
    const afterClose = await principal();
    expect(afterClose.events.filter((e) => e.startsWith('CLOSE:')), 'одно закрытие').toHaveLength(1);

    // Три прохода «после перезапуска» при той же высокой цене.
    await runPaperAgentTickOnce();
    await runPaperAgentTickOnce();
    await runPaperAgentTickOnce();

    expect(await principal(), 'результат не удвоился').toEqual(afterClose);

    const session = await activeSession();
    expect(
      (await activeAllocations(session.id, 'CLOSED')).length,
      'закрытое распределение одно',
    ).toBe(1);
  });
});

describe('ключ события журнала защищает от повторной записи', () => {
  it('повторная запись открытия отвергается базой', async () => {
    /*
     * Последний рубеж. Даже если приложение когда-нибудь попробует
     * записать одно и то же событие дважды, база не позволит:
     * `eventKey` уникален и строится из идентификатора распределения
     * и типа события.
     */
    await setupPaperAgent({ capitalUsd: '1000', maxOpenPositions: 4 });
    const token = await createToken({ priceUsd: ENTRY_PRICE }, NOW);
    const signal = await emitSignal({ tokenId: token.id, priceUsd: ENTRY_PRICE }, NOW);
    queuePaperAgentSignal(signal.id);
    await runPaperAgentTickOnce();

    const session = await activeSession();
    const open = (await ledgerOf(session.id)).find((row) => row.eventType === 'OPEN');
    expect(open, 'запись открытия должна быть').toBeTruthy();

    await expectUniqueViolation(
      () => prisma.paperAgentCapitalLedger.create({
        data: {
          eventKey: open!.eventKey,
          sessionId: session.id,
          eventType: 'OPEN',
          amountUsd: open!.amountUsd,
          freeBeforeUsd: open!.freeBeforeUsd,
          freeAfterUsd: open!.freeAfterUsd,
          reservedBeforeUsd: open!.reservedBeforeUsd,
          reservedAfterUsd: open!.reservedAfterUsd,
          inPositionsBeforeUsd: open!.inPositionsBeforeUsd,
          inPositionsAfterUsd: open!.inPositionsAfterUsd,
          realizedPnlAfterUsd: open!.realizedPnlAfterUsd,
          equityAfterUsd: open!.equityAfterUsd,
          tradingFeesAfterUsd: open!.tradingFeesAfterUsd,
          slippageAfterUsd: open!.slippageAfterUsd,
          networkCostsAfterUsd: open!.networkCostsAfterUsd,
        },
      }),
      'вторая запись того же события обязана отвергаться',
    );
  });
});

describe('гонка проходов не создаёт лишних записей', () => {
  it('четыре одновременных прохода дают одну позицию', async () => {
    /*
     * Проверка того же контракта под нагрузкой. Раньше здесь
     * оставалась россыпь пойманных `P2002`; теперь конфликт
     * разрешает сама база оператором `ON CONFLICT DO NOTHING`,
     * и исключений не возникает вовсе.
     */
    await setupPaperAgent({ capitalUsd: '1000', maxOpenPositions: 4 });
    const token = await createToken({ priceUsd: ENTRY_PRICE }, NOW);
    const signal = await emitSignal({ tokenId: token.id, priceUsd: ENTRY_PRICE }, NOW);

    queuePaperAgentSignal(signal.id);
    await Promise.all([
      runPaperAgentTickOnce(),
      runPaperAgentTickOnce(),
      runPaperAgentTickOnce(),
      runPaperAgentTickOnce(),
    ]);

    const session = await activeSession();
    const strategies = await prisma.paperAgentStrategy.count({ where: { isEnabled: true } });

    expect(session.openPositions, 'позиция одна').toBe(1);
    expect(
      await prisma.paperAgentRun.count({ where: { signalId: signal.id } }),
      'по одному run на стратегию',
    ).toBe(strategies);
    expect(
      (await activeAllocations(session.id, 'OPEN')).length,
      'денежное распределение одно',
    ).toBe(1);
    expect(
      (await ledgerOf(session.id)).filter((row) => row.eventType === 'OPEN').length,
      'запись открытия одна',
    ).toBe(1);
  });
});

describe('бухгалтерия equity', () => {
  /**
   * Открыть позицию и вернуть счёт со всеми составляющими.
   *
   * Числа здесь настоящие: капитал 1000, резерв 30 %, четыре слота,
   * значит позиция 175 при цене 1.
   */
  async function opened() {
    await setupPaperAgent({ capitalUsd: '1000', maxOpenPositions: 4 });
    const token = await createToken({ priceUsd: ENTRY_PRICE }, NOW);
    const signal = await emitSignal({ tokenId: token.id, priceUsd: ENTRY_PRICE }, NOW);
    queuePaperAgentSignal(signal.id);
    await runPaperAgentTickOnce();
    return { token, signal, session: await activeSession() };
  }

  it('сразу после открытия equity уже учитывает понесённые расходы', async () => {
    /*
     * Главная проверка. Раньше здесь было ровно 1000: начальная
     * переоценка считалась, но до счёта не доходила, и человек видел
     * сумму больше той, что у него есть. Первая отметка цены потом
     * исправляла её без всякой новой котировки.
     */
    const { session } = await opened();

    expect(money(session.equityUsd), 'equity меньше начального капитала').toBeLessThan(1000);
    expect(money(session.unrealizedPnlUsd), 'нереализованный результат отрицателен').toBeLessThan(0);
    expect(money(session.equityUsd)).toBeCloseTo(995.46744421, 6);
  });

  it('сохранённый equity точно равен сумме сохранённых частей', async () => {
    /*
     * Точное равенство, а не приближённое. Расхождение здесь было
     * настоящим: 995.46744420 против 995.46744421 — одна последняя
     * единица масштаба `Decimal(24, 8)`. Причина была в порядке
     * действий: equity считался из необрезанного нереализованного
     * результата, а сохранялись оба поля обрезанными по отдельности.
     *
     * Сравнение идёт строками из `Decimal`: на восьмом знаке
     * двоичная плавающая точка уже врёт, и `Number` проверял бы
     * не бухгалтерию, а сам себя.
     */
    const { session } = await opened();
    const parts = await persistedEquityParts(session.id);

    expect(parts.equity, 'equity обязан сойтись с суммой частей').toBe(parts.sum);
  });

  it('запись журнала об открытии показывает тот же equity, что и счёт', async () => {
    /*
     * Журнал не может утверждать иное, чем строка, к которой он
     * относится. Раньше в него попадало значение до переоценки.
     */
    const { session } = await opened();
    const open = (await ledgerOf(session.id)).find((row) => row.eventType === 'OPEN');

    expect(open, 'запись открытия должна быть').toBeTruthy();
    expect(money(open!.equityAfterUsd)).toBeCloseTo(money(session.equityUsd), 8);
  });

  it('повторная отметка при той же цене ничего не меняет', async () => {
    /*
     * Контракт стабильности. Цена не менялась — значит и переоценке
     * меняться не от чего. `ledgerVersion` при этом расти вправе:
     * это версия оптимистичной блокировки, а не номер записи.
     */
    const { session } = await opened();
    const beforeValuation = await valuation(session.id);
    const beforePrincipal = await principal(session.id);

    await runPaperAgentTickOnce();
    await runPaperAgentTickOnce();

    const after = await valuation(session.id);
    expect(after.equity, 'equity не сдвинулся').toBe(beforeValuation.equity);
    expect(after.unrealized, 'нереализованный результат тот же').toBe(beforeValuation.unrealized);
    expect(after.drawdownPct, 'просадка та же').toBe(beforeValuation.drawdownPct);
    expect(await principal(session.id), 'основной капитал не сдвинулся').toEqual(beforePrincipal);
  });

  it('новая котировка меняет только переоценку', async () => {
    const { token, session } = await opened();
    const beforePrincipal = await principal(session.id);
    const beforeValuation = await valuation(session.id);

    await setPrice(token.id, ENTRY_PRICE * 1.5);
    await runPaperAgentTickOnce();

    expect(await principal(session.id), 'деньги не двигались').toEqual(beforePrincipal);

    const after = await valuation(session.id);
    expect(after.equity, 'рост цены поднял equity').toBeGreaterThan(beforeValuation.equity);
    expect(after.unrealized).toBeGreaterThan(beforeValuation.unrealized);
  });

  it('закрытие не учитывает расходы входа дважды', async () => {
    /*
     * После закрытия реализованный результат обязан совпасть с той
     * же величиной, что показывала переоценка: расходы входа уже
     * были в ней учтены, и повторно вычитать их нельзя.
     */
    const { token, session } = await opened();
    const openEquity = money((await activeSession()).equityUsd);

    await setPrice(token.id, ENTRY_PRICE * 3);
    await runPaperAgentTickOnce();

    const closed = await activeSession();
    expect(closed.openPositions, 'позиция закрыта').toBe(0);
    expect(money(closed.inPositionsUsd)).toBe(0);
    expect(money(closed.unrealizedPnlUsd), 'нереализованного больше нет').toBe(0);

    /*
     * Расходы обеих сторон посчитаны по одному разу: сетевой сбор
     * 0.02 на вход и 0.02 на выход.
     */
    expect(money(closed.networkCostsUsd)).toBeCloseTo(0.04, 8);

    const parts = await persistedEquityParts(closed.id);
    expect(parts.equity, 'после закрытия equity тоже точно сходится').toBe(parts.sum);
    expect(money(closed.equityUsd), 'рост цели вывел счёт выше открытия').toBeGreaterThan(
      openEquity,
    );
    expect(
      money(closed.realizedPnlUsd),
      'реализованный результат равен приросту капитала',
    ).toBeCloseTo(money(closed.equityUsd) - 1000, 6);

    void session;
  });
});
