/**
 * Учёт позиций и расчёт результата.
 *
 * Здесь исправляется главная ошибка прежней оценки: рост токена
 * после покупки считался успехом кошелька. Это разные утверждения,
 * и разница между ними — деньги.
 *
 * Токен вырос вдвое после того, как кошелёк его купил. Заработал ли
 * кошелёк? Неизвестно. Он мог продать на минус тридцать процентов
 * за час до роста. Мог держать и не продать до сих пор. Мог продать
 * половину в плюс, а вторую половину обнулить. Все три случая
 * прежде считались одинаковой победой.
 *
 * Поэтому здесь два разных числа, которые нельзя складывать:
 *
 *   зафиксированное  — что кошелёк уже получил, продав;
 *   незафиксированное — что он получит, если продаст сейчас.
 *
 * Второе не является результатом. Это оценка, которая обнулится,
 * если пул осушат. В расчёт доли удачных сделок входит только первое.
 *
 * Способ учёта себестоимости — средневзвешенный. Выбран не потому,
 * что лучший, а потому что единственный, который можно применить,
 * не зная порядка списания у самого держателя: FIFO и LIFO требуют
 * знать, какие именно монеты проданы, а в блокчейне их не различить.
 * Смешивать способы между источниками нельзя — результаты станут
 * несопоставимы.
 */

import type { EconomicTrade } from './economic-trade.js';

/**
 * Остаток, ниже которого позиция считается закрытой.
 *
 * Доля от купленного, а не абсолютное число: у токена с ценой
 * в стотысячную цента остаток в тысячу штук — это пыль, а у токена
 * по десять долларов — заметная сумма.
 */
export const DUST_RATIO = 0.01;

export interface Position {
  chain: string;
  wallet: string;
  tokenAddress: string;

  /** Всего вложено в токен за всё время, USD. */
  totalInvestedUsd: number;
  /** Всего получено от продаж, USD. */
  totalSoldUsd: number;

  /** Куплено токена всего. */
  boughtAmount: number;
  /** Продано токена всего. */
  soldAmount: number;
  /** Остаток на руках. */
  remainingAmount: number;

  /** Средняя цена входа по средневзвешенной себестоимости. */
  avgEntryPrice: number | null;
  /** Средняя цена выхода. */
  avgExitPrice: number | null;

  /**
   * Зафиксированный результат: выручка минус себестоимость проданного.
   * Только это участвует в доле удачных сделок.
   */
  realizedPnlUsd: number;
  /** Себестоимость остатка. Незафиксированный результат считается от неё. */
  remainingCostUsd: number;

  firstBuyAt: number | null;
  lastTradeAt: number | null;
  /** Время удержания до полного закрытия, часы. */
  holdingHours: number | null;

  isClosed: boolean;
  buys: number;
  sells: number;
}

/**
 * Построить позиции из потока сделок.
 *
 * Сделки должны идти по возрастанию времени: расчёт себестоимости
 * зависит от порядка, и переставленная сделка тихо испортит среднюю
 * цену входа.
 */
export function buildPositions(trades: EconomicTrade[]): Position[] {
  const byToken = new Map<string, EconomicTrade[]>();

  for (const t of trades) {
    const key = `${t.chain}|${t.tokenAddress.toLowerCase()}`;
    const list = byToken.get(key) ?? [];
    list.push(t);
    byToken.set(key, list);
  }

  const out: Position[] = [];

  for (const list of byToken.values()) {
    const sorted = [...list].sort((a, b) => a.timestamp - b.timestamp);
    const first = sorted[0]!;

    const p: Position = {
      chain: first.chain,
      wallet: first.wallet,
      tokenAddress: first.tokenAddress,
      totalInvestedUsd: 0,
      totalSoldUsd: 0,
      boughtAmount: 0,
      soldAmount: 0,
      remainingAmount: 0,
      avgEntryPrice: null,
      avgExitPrice: null,
      realizedPnlUsd: 0,
      remainingCostUsd: 0,
      firstBuyAt: null,
      lastTradeAt: null,
      holdingHours: null,
      isClosed: false,
      buys: 0,
      sells: 0,
    };

    for (const t of sorted) {
      p.lastTradeAt = t.timestamp;

      if (t.side === 'BUY') {
        p.buys++;
        p.firstBuyAt ??= t.timestamp;

        p.totalInvestedUsd += t.amountUsd;
        p.boughtAmount += t.tokenAmount;
        p.remainingAmount += t.tokenAmount;
        p.remainingCostUsd += t.amountUsd;
        continue;
      }

      p.sells++;

      // Продажа без предшествующей покупки. Такое бывает после
      // аирдропа, перевода со своего же адреса или ошибки разбора.
      // Считать это прибылью нельзя: себестоимости нет, и любой
      // результат оказался бы бесконечным.
      if (p.remainingAmount <= 0) {
        p.totalSoldUsd += t.amountUsd;
        p.soldAmount += t.tokenAmount;
        continue;
      }

      // Продать больше, чем на руках, физически можно (докупили
      // в другом месте), но себестоимость есть только у того,
      // что мы видели.
      const sellAmount = Math.min(t.tokenAmount, p.remainingAmount);
      const unitCost = p.remainingCostUsd / p.remainingAmount;
      const costOfSold = unitCost * sellAmount;

      // Выручка пропорциональна проданной части, если продали
      // больше, чем числилось.
      const proceeds =
        t.tokenAmount > 0 ? t.amountUsd * (sellAmount / t.tokenAmount) : t.amountUsd;

      p.realizedPnlUsd += proceeds - costOfSold;
      p.totalSoldUsd += t.amountUsd;
      p.soldAmount += t.tokenAmount;

      p.remainingAmount -= sellAmount;
      p.remainingCostUsd -= costOfSold;
    }

    p.avgEntryPrice = p.boughtAmount > 0 ? p.totalInvestedUsd / p.boughtAmount : null;
    p.avgExitPrice = p.soldAmount > 0 ? p.totalSoldUsd / p.soldAmount : null;

    // Позиция закрыта, когда остаток стал пылью. Требовать точного
    // нуля нельзя: округления и комиссии почти всегда оставляют
    // копеечный хвост, и позиция висела бы открытой вечно.
    p.isClosed = p.boughtAmount > 0 && p.remainingAmount <= p.boughtAmount * DUST_RATIO;

    if (p.isClosed && p.firstBuyAt != null && p.lastTradeAt != null) {
      p.holdingHours = (p.lastTradeAt - p.firstBuyAt) / 3_600_000;
    }

    out.push(p);
  }

  return out;
}

// ──────────────────────────── Свод по кошельку ──────────────────────────────

export interface WalletPnl {
  /** Закрытых позиций. Только они участвуют в оценке. */
  closedCount: number;
  openCount: number;

  /** Зафиксированный результат по закрытым позициям. */
  realizedPnlUsd: number;
  /** Себестоимость открытых позиций. Результат по ним неизвестен. */
  openCostUsd: number;

  /** Закрытых позиций с положительным результатом. */
  wins: number;
  losses: number;

  /** Доля удачных среди закрытых. Без поправки на выборку. */
  rawWinRate: number;

  /** Медианная доходность закрытой позиции, доля. */
  medianRoi: number | null;
  /** Отношение суммы прибылей к сумме убытков. */
  profitFactor: number | null;

  /** Какую долю всей прибыли дала одна лучшая позиция. */
  topTradeShare: number | null;
  /** То же для трёх лучших. */
  top3Share: number | null;

  /** Сколько разных токенов торговал. */
  uniqueTokens: number;
  medianHoldingHours: number | null;
}

export function summarizePnl(positions: Position[]): WalletPnl {
  const closed = positions.filter((p) => p.isClosed);
  const open = positions.filter((p) => !p.isClosed);

  const realized = closed.reduce((s, p) => s + p.realizedPnlUsd, 0);

  const wins = closed.filter((p) => p.realizedPnlUsd > 0);
  const losses = closed.filter((p) => p.realizedPnlUsd < 0);

  const rois = closed
    .filter((p) => p.totalInvestedUsd > 0)
    .map((p) => p.realizedPnlUsd / p.totalInvestedUsd);

  const grossProfit = wins.reduce((s, p) => s + p.realizedPnlUsd, 0);
  const grossLoss = Math.abs(losses.reduce((s, p) => s + p.realizedPnlUsd, 0));

  // Концентрация прибыли. Кошелёк, у которого девять десятых заработка
  // пришли с одной сделки, — это не мастер, а человек, которому
  // однажды повезло, и оценивать его как первого нельзя.
  const profits = wins.map((p) => p.realizedPnlUsd).sort((a, b) => b - a);
  const totalProfit = profits.reduce((s, v) => s + v, 0);

  const holdings = closed
    .map((p) => p.holdingHours)
    .filter((h): h is number => h != null)
    .sort((a, b) => a - b);

  return {
    closedCount: closed.length,
    openCount: open.length,
    realizedPnlUsd: realized,
    openCostUsd: open.reduce((s, p) => s + p.remainingCostUsd, 0),
    wins: wins.length,
    losses: losses.length,
    rawWinRate: closed.length > 0 ? wins.length / closed.length : 0,
    medianRoi: median(rois),
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : null,
    topTradeShare: totalProfit > 0 && profits[0] != null ? profits[0] / totalProfit : null,
    top3Share:
      totalProfit > 0 ? profits.slice(0, 3).reduce((s, v) => s + v, 0) / totalProfit : null,
    uniqueTokens: positions.length,
    medianHoldingHours: median(holdings),
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
