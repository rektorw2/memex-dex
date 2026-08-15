import { D, type Numeric } from './money.js';

/**
 * Копирование отложенных ордеров лидера.
 *
 * У копитрейдинга есть развилка, которую обычно не проговаривают, а зря —
 * от неё зависит, что подписчик вообще получит.
 *
 *  1. Копировать в момент СРАБАТЫВАНИЯ. Лидер поставил лимитку, она
 *     исполнилась, подписчикам ставится рыночный ордер. Подписчик всегда
 *     входит, но по цене на секунды позже лидера и хуже неё.
 *
 *  2. Копировать в момент ПОСТАНОВКИ. Лидер поставил лимитку — такая же
 *     появляется у подписчика. Цена входа получается той же, что у лидера,
 *     но исполнение не гарантировано: на тонком пуле цена может коснуться
 *     уровня объёмом, которого хватит лидеру и не хватит остальным.
 *
 * Ни один вариант не лучше другого во всех случаях, поэтому выбор
 * оставлен подписчику. Важно другое: при втором варианте у подписчика
 * замораживаются средства на всё время жизни лимитки лидера, и это
 * надо показывать до подписки, а не выяснять постфактум.
 */

export type CopyPendingMode = 'ON_FILL' | 'MIRROR';

export interface PendingOrderInput {
  type: 'LIMIT' | 'STOP_LOSS' | 'TAKE_PROFIT' | 'TRAILING_STOP';
  side: 'BUY' | 'SELL';
  /** Цена лимитного ордера лидера в долларах. */
  limitPriceUsd: Numeric | null;
  triggerPriceUsd: Numeric | null;
  trailingBps: number | null;
  expiresAt: Date | null;
}

export interface MirrorContext {
  mode: CopyPendingMode;
  /** Сколько долларов подписчик выделяет на эту сделку. */
  allocationUsd: Numeric;
  /** Свободные средства подписчика в котировочной валюте. */
  freeQuoteUsd: Numeric;
  /** Уже заморожено под другие отложенные ордера. */
  lockedUsd: Numeric;
  /** Предел на суммарную заморозку, доля капитала 0-1. Null — без предела. */
  maxLockedShare: number | null;
  equityUsd: Numeric;
  now: Date;
}

export interface MirrorDecision {
  mirror: boolean;
  reason: string;
  /** Параметры ордера подписчика. Заполняются только при mirror = true. */
  order: {
    type: PendingOrderInput['type'];
    side: 'BUY' | 'SELL';
    limitPriceUsd: string | null;
    triggerPriceUsd: string | null;
    trailingBps: number | null;
    amountUsd: string;
    expiresAt: Date | null;
  } | null;
}

const NO: (reason: string) => MirrorDecision = (reason) => ({ mirror: false, reason, order: null });

/**
 * Решение о зеркалировании одного отложенного ордера.
 *
 * Цена берётся ровно та же, что у лидера, без поправок. Смещать её
 * «чтобы наверняка исполнилось» нельзя: подписчик подписывался на
 * повторение сделок лидера, а не на их улучшенную версию, и первая же
 * сделка, где смещение сыграло против, будет выглядеть как обман.
 */
export function decideMirrorPending(
  leader: PendingOrderInput,
  ctx: MirrorContext,
): MirrorDecision {
  if (ctx.mode !== 'MIRROR') {
    return NO('Режим подписки: копировать при исполнении, а не при постановке');
  }

  // Trailing stop зависит от достигнутого пика, который у подписчика
  // свой: он мог войти в позицию позже и по другой цене. Копировать
  // такой ордер как есть значит подставить чужой пик под чужую позицию.
  if (leader.type === 'TRAILING_STOP') {
    return NO('Скользящий стоп не зеркалится: он считается от пика вашей позиции');
  }

  if (leader.expiresAt && leader.expiresAt.getTime() <= ctx.now.getTime()) {
    return NO('Ордер лидера уже истёк');
  }

  const price = leader.type === 'LIMIT' ? leader.limitPriceUsd : leader.triggerPriceUsd;
  if (price == null) {
    return NO('У ордера лидера нет цены');
  }

  const p = D(price);
  if (!p.isFinite() || p.lte(0)) {
    return NO('Некорректная цена ордера лидера');
  }

  const alloc = D(ctx.allocationUsd);
  if (!alloc.isFinite() || alloc.lte(0)) {
    return NO('Нулевой размер позиции по настройкам подписки');
  }

  // Продажа не требует свободных средств: продаётся уже имеющийся токен,
  // и проверка свободного остатка в котировочной валюте здесь ни при чём.
  if (leader.side === 'BUY') {
    const free = D(ctx.freeQuoteUsd);
    if (free.lt(alloc)) {
      return NO(
        `Недостаточно свободных средств: нужно $${alloc.toFixed(2)}, доступно $${free.toFixed(2)}`,
      );
    }

    // Предел суммарной заморозки. Без него десяток лимиток лидера
    // связывает весь капитал подписчика, и на рыночные сделки —
    // включая выход из уже открытых позиций — денег не остаётся.
    if (ctx.maxLockedShare != null) {
      const equity = D(ctx.equityUsd);
      if (equity.gt(0)) {
        const afterLock = D(ctx.lockedUsd).plus(alloc);
        const limit = equity.times(ctx.maxLockedShare);
        if (afterLock.gt(limit)) {
          return NO(
            `Превышен предел заморозки: было бы $${afterLock.toFixed(2)} при пределе $${limit.toFixed(2)}`,
          );
        }
      }
    }
  }

  return {
    mirror: true,
    reason: `Зеркалируем ${leader.type} по цене $${p.toFixed(8)}`,
    order: {
      type: leader.type,
      side: leader.side,
      limitPriceUsd: leader.type === 'LIMIT' ? p.toString() : null,
      triggerPriceUsd: leader.type === 'LIMIT' ? null : p.toString(),
      trailingBps: null,
      amountUsd: alloc.toString(),
      // Срок жизни наследуется от лидера: ордер, переживший источник,
      // сработает по обстоятельствам, которых лидер уже не разделяет.
      expiresAt: leader.expiresAt,
    },
  };
}

/**
 * Нужно ли снять копию, когда лидер отменил свой ордер.
 *
 * Ответ всегда «да», и это не формальность: неотменённая копия — это
 * ордер, за которым больше никто не следит. Лидер отменил его, потому
 * что передумал, а у подписчика он останется висеть и однажды сработает
 * по цене, которую лидер уже счёл неподходящей.
 */
export function shouldCancelMirror(
  leaderStatus: 'CANCELLED' | 'EXPIRED' | 'REJECTED' | 'FILLED' | 'OPEN',
): { cancel: boolean; reason: string } {
  switch (leaderStatus) {
    case 'CANCELLED':
      return { cancel: true, reason: 'Лидер отменил ордер' };
    case 'EXPIRED':
      return { cancel: true, reason: 'Ордер лидера истёк' };
    case 'REJECTED':
      return { cancel: true, reason: 'Ордер лидера отклонён' };
    default:
      return { cancel: false, reason: '' };
  }
}
