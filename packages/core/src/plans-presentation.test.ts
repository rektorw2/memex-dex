import { describe, it, expect } from 'vitest';
import {
  PLAN_MARKETING,
  SELLABLE_PLANS,
  COMPARISON_ROWS,
  marketingFor,
  comparisonCell,
  planCta,
  pnlBlock,
  PNL_EMPTY_TEXT,
  PNL_DISCLAIMER,
  type SellablePlan,
} from './plans-presentation.js';
import { entitlementFor, capabilityList, NEVER_REVOKED } from './entitlements.js';
import { formatExactUsd, formatSignedUsd } from './pnl-display.js';

/**
 * Обещания страницы тарифов.
 *
 * Единственное место, где продукт говорит о себе, — и потому
 * единственное, где обещание может разойтись с делом. Разойтись оно
 * может тихо: кто-то добавит строку в карточку, кто-то через месяц
 * уберёт возможность из плана, и узнает об этом человек, уже
 * заплативший.
 */

const capsByPlan: Record<string, string[]> = Object.fromEntries(
  (['PRO', 'SEMI_AUTO', 'FULL_AUTO'] as const).map((p) => [p, capabilityList(entitlementFor(p))]),
);

const fmt = {
  usd: (v: number | null) => (v == null ? '—' : formatExactUsd(v)),
  signedUsd: formatSignedUsd,
};

describe('карточка не обещает лишнего', () => {
  it.each(SELLABLE_PLANS)('%s: каждая выгода подкреплена возможностью плана', (plan) => {
    // Главная проверка файла. Строка «копирование сделок» на плане,
    // который его не даёт, — это не опечатка, а невыполненное
    // обещание, за которое человек заплатил.
    const has = capsByPlan[plan]!;

    for (const b of marketingFor(plan).benefits) {
      expect(has, `${plan} обещает «${b.text}», но не даёт ${b.capability}`).toContain(b.capability);
    }
  });

  it('на каждый продаваемый план есть карточка', () => {
    expect(PLAN_MARKETING.map((m) => m.plan).sort()).toEqual([...SELLABLE_PLANS].sort());
  });

  it('в карточке от четырёх до пяти пунктов', () => {
    // Человек, выбирающий тариф, сравнивает решения, а не перечни.
    // Полный список прав лежит ниже, отдельным сравнением.
    for (const m of PLAN_MARKETING) {
      expect(m.benefits.length, m.plan).toBeGreaterThanOrEqual(4);
      expect(m.benefits.length, m.plan).toBeLessThanOrEqual(5);
    }
  });

  it('главное предложение ровно одно', () => {
    expect(PLAN_MARKETING.filter((m) => m.featured).map((m) => m.plan)).toEqual(['PRO']);
  });

  it('Pro готов, остальные помечены как скорые', () => {
    expect(marketingFor('PRO').comingSoon).toBe(false);
    expect(marketingFor('SEMI_AUTO').comingSoon).toBe(true);
    expect(marketingFor('FULL_AUTO').comingSoon).toBe(true);
  });

  it('ни одна строка не обещает прибыль', () => {
    // Мем-коины могут обесцениться до нуля. Слово о доходе
    // на странице с ценами — это обещание, которого мы дать
    // не можем и не имеем права.
    // Ретроспективная проверка на кириллическую букву заменяет
    // границу слова: `\b` в JavaScript опирается на латиницу,
    // и без неё «покупки» ловится по «окуп».
    const forbidden = /(?<![а-яё])(доход|прибыл|заработ|профит|гаранти|окупа|окупи)/iu;

    for (const m of PLAN_MARKETING) {
      expect(m.tagline, m.plan).not.toMatch(forbidden);
      expect(m.control, m.plan).not.toMatch(forbidden);

      for (const b of m.benefits) {
        expect(b.text, `${m.plan}: ${b.text}`).not.toMatch(forbidden);
      }
    }
  });

  it('цен в текстах нет: они приходят с сервера', () => {
    // Число, написанное в интерфейсе руками, рано или поздно
    // перестанет совпадать со списываемым.
    const dump = JSON.stringify(PLAN_MARKETING);

    expect(dump).not.toMatch(/\d+\s*(USDC|USD|\$)/);
    expect(dump).not.toContain('50');
    expect(dump).not.toContain('100');
    expect(dump).not.toContain('200');
  });
});

describe('сравнение возможностей', () => {
  it('строится из матрицы прав, а не из своего списка', () => {
    for (const row of COMPARISON_ROWS) {
      for (const plan of SELLABLE_PLANS) {
        const cell = comparisonCell(plan, row.capability, capsByPlan);
        const has = capsByPlan[plan]!.includes(row.capability);

        expect(cell === 'no', `${plan}/${row.capability}`).toBe(!has);
      }
    }
  });

  it('у скорых планов галочка заменена на «скоро»', () => {
    // «Есть» и «будет» — разные утверждения. Свести их к галочке
    // значит обещать доступ, которого сегодня нет.
    expect(comparisonCell('SEMI_AUTO', 'LEADER_COPY_BUY', capsByPlan)).toBe('coming-soon');
    expect(comparisonCell('FULL_AUTO', 'AUTO_BUY', capsByPlan)).toBe('coming-soon');
    expect(comparisonCell('PRO', 'RADAR_ACCESS', capsByPlan)).toBe('yes');
  });

  it('неотбираемые возможности помечены и есть у всех планов', () => {
    const marked = COMPARISON_ROWS.filter((r) => r.neverRevoked).map((r) => r.capability);

    expect(marked.sort()).toEqual([...NEVER_REVOKED].sort());

    for (const plan of SELLABLE_PLANS) {
      for (const c of marked) {
        expect(comparisonCell(plan, c, capsByPlan), `${plan}/${c}`).not.toBe('no');
      }
    }
  });

  it('в сравнении нет строк про несуществующие возможности', () => {
    const all = new Set(capabilityList(entitlementFor('FULL_AUTO')));

    for (const row of COMPARISON_ROWS) {
      expect(all, `строка «${row.label}» ссылается на ${row.capability}`).toContain(row.capability);
    }
  });
});

// ─────────────────────────────── Кнопки ──────────────────────────────────────

const base = {
  authenticated: true,
  currentPlan: 'EXPIRED' as const,
  canStartTrial: true,
  paymentsEnabled: true,
};

describe('кнопка карточки', () => {
  it('свежему пользователю предлагает бесплатный период на Pro', () => {
    const cta = planCta({ ...base, plan: 'PRO' });

    expect(cta.kind).toBe('start-trial');
    expect(cta.label).toBe('Начать 5 дней бесплатно');
    expect(cta.enabled).toBe(true);
    expect(cta.href).toBe('/onboarding');
  });

  it('гостя ведёт на регистрацию, а не в онбординг', () => {
    const cta = planCta({ ...base, plan: 'PRO', authenticated: false });

    expect(cta.kind).toBe('start-trial');
    expect(cta.href).toContain('mode=register');
  });

  it('на действующем плане не предлагает купить его же', () => {
    const cta = planCta({ ...base, plan: 'PRO', currentPlan: 'PRO', canStartTrial: false });

    expect(cta.kind).toBe('current');
    expect(cta.enabled).toBe(false);
    expect(cta.href).toBeNull();
  });

  it('во время пробного периода Pro считается действующим', () => {
    // Пробный период — это Pro. Предлагать его купить тому,
    // у кого он идёт, значит показывать, что мы не знаем состояния.
    const cta = planCta({ ...base, plan: 'PRO', currentPlan: 'TRIAL', canStartTrial: false });

    expect(cta.kind).toBe('checkout');
    expect(cta.enabled).toBe(true);
  });

  it('после израсходованного периода ведёт в оплату', () => {
    const cta = planCta({ ...base, plan: 'PRO', canStartTrial: false });

    expect(cta.kind).toBe('checkout');
    expect(cta.href).toBe('/checkout?plan=PRO');
  });

  it('при отключённой оплате не рисует рабочую кнопку', () => {
    // Кнопка, за которой ничего нет, хуже её отсутствия: человек
    // нажмёт и решит, что сломался он.
    const cta = planCta({ ...base, plan: 'PRO', canStartTrial: false, paymentsEnabled: false });

    expect(cta.kind).toBe('payments-off');
    expect(cta.enabled).toBe(false);
    expect(cta.href).toBeNull();
  });

  it.each(['SEMI_AUTO', 'FULL_AUTO'] as SellablePlan[])(
    '%s всегда «скоро» и никогда не ведёт в оплату',
    (plan) => {
      for (const canStartTrial of [true, false]) {
        for (const paymentsEnabled of [true, false]) {
          for (const authenticated of [true, false]) {
            const cta = planCta({ ...base, plan, canStartTrial, paymentsEnabled, authenticated });

            expect(cta.kind, plan).toBe('coming-soon');
            expect(cta.enabled).toBe(false);
            expect(cta.href).toBeNull();
          }
        }
      }
    },
  );

  it('бесплатный период предлагается только на Pro', () => {
    for (const plan of ['SEMI_AUTO', 'FULL_AUTO'] as SellablePlan[]) {
      expect(planCta({ ...base, plan }).kind).not.toBe('start-trial');
    }
  });

  it('администратору не предлагает покупку ни на одном плане', () => {
    // Возможности у него полные независимо от плана. Предложение
    // купить то, что уже есть, показывает, что мы не знаем
    // собственного состояния.
    for (const plan of SELLABLE_PLANS) {
      for (const currentPlan of ['EXPIRED', 'TRIAL', 'PRO'] as const) {
        for (const paymentsEnabled of [true, false]) {
          const cta = planCta({
            ...base,
            plan,
            currentPlan,
            paymentsEnabled,
            serviceAccess: true,
          });

          expect(cta.enabled, `${plan}/${currentPlan}`).toBe(false);
          expect(cta.href).toBeNull();
          expect(['service-access', 'coming-soon']).toContain(cta.kind);
        }
      }
    }
  });

  it('служебный доступ не превращает «скоро» в доступное', () => {
    // Роль обходит тарифы, а не готовность возможности.
    const cta = planCta({ ...base, plan: 'SEMI_AUTO', serviceAccess: true });
    expect(cta.kind).toBe('coming-soon');
  });

  it('без служебного доступа поведение прежнее', () => {
    expect(planCta({ ...base, plan: 'PRO', serviceAccess: false }).kind).toBe('start-trial');
    expect(planCta({ ...base, plan: 'PRO' }).kind).toBe('start-trial');
  });

  it('ни одна неактивная кнопка не ведёт по ссылке', () => {
    for (const plan of SELLABLE_PLANS) {
      for (const canStartTrial of [true, false]) {
        for (const paymentsEnabled of [true, false]) {
          const cta = planCta({ ...base, plan, canStartTrial, paymentsEnabled });
          if (!cta.enabled) expect(cta.href, `${plan}/${cta.kind}`).toBeNull();
        }
      }
    }
  });
});

// ──────────────────────────────── PnL ────────────────────────────────────────

const withPositions = {
  totalValueUsd: '1250.00',
  investedUsd: '1000.00',
  unrealizedPnlUsd: '250.00',
  totalFeesPaidUsd: '12.50',
  holdings: [{ tokenId: 't1' }],
};

const card = (block: ReturnType<typeof pnlBlock>, key: string) =>
  block.cards.find((c) => c.key === key)!;

describe('PnL без догадок', () => {
  it('показывает пять показателей', () => {
    expect(pnlBlock(withPositions, fmt).cards.map((c) => c.key)).toEqual([
      'value',
      'invested',
      'unrealized',
      'roi',
      'fees',
    ]);
  });

  it('реализованного PnL среди них нет', () => {
    // Сервер отдаёт результат только по открытым позициям, а история
    // ограничена последними двумястами сделками. Сумма по ней —
    // не реализованный результат за всё время, и выдавать её
    // за таковой нельзя.
    expect(pnlBlock(withPositions, fmt).cards.map((c) => c.key)).not.toContain('realized');
  });

  it('считает положительный результат и ROI', () => {
    const b = pnlBlock(withPositions, fmt);

    expect(b.hasPositions).toBe(true);
    expect(card(b, 'unrealized').text).toContain('250');
    expect(card(b, 'unrealized').sign).toBe(1);
    expect(card(b, 'roi').text).toBe('+25.00%');
    expect(card(b, 'roi').sign).toBe(1);
  });

  it('считает отрицательный результат', () => {
    const b = pnlBlock(
      { ...withPositions, totalValueUsd: '700.00', unrealizedPnlUsd: '-300.00' },
      fmt,
    );

    expect(card(b, 'unrealized').sign).toBe(-1);
    expect(card(b, 'roi').text).toBe('-30.00%');
    expect(card(b, 'roi').sign).toBe(-1);
  });

  it('на пустом портфеле не выдумывает ноль', () => {
    // Ноль — это утверждение «результат равен нулю». Оно неверно,
    // когда результата ещё нет вовсе.
    const b = pnlBlock({ ...withPositions, holdings: [] }, fmt);

    expect(b.hasPositions).toBe(false);
    expect(card(b, 'unrealized').text).toBeNull();
    expect(card(b, 'roi').text).toBeNull();
  });

  it('на отсутствующем ответе сервера показывает пустоту, а не нули', () => {
    const b = pnlBlock(null, fmt);

    expect(b.hasPositions).toBe(false);
    for (const c of b.cards) expect(c.text, c.key).toBeNull();
  });

  it('не делит на ноль при нулевой себестоимости', () => {
    // Процент от нуля — это не бесконечная доходность,
    // а отсутствие ответа.
    const b = pnlBlock({ ...withPositions, investedUsd: '0.00' }, fmt);

    expect(card(b, 'roi').text).toBeNull();
  });

  it('пропускает неизвестные значения по одному', () => {
    // Отсутствие одного показателя не должно обнулять остальные.
    const b = pnlBlock({ ...withPositions, totalFeesPaidUsd: null }, fmt);

    expect(card(b, 'fees').text).toBeNull();
    expect(card(b, 'value').text).not.toBeNull();
  });

  it('не принимает мусор за число', () => {
    const b = pnlBlock({ ...withPositions, totalValueUsd: 'много' }, fmt);
    expect(card(b, 'value').text).toBeNull();
  });

  it('цветом выделяются только денежные показатели', () => {
    // Зелёный и красный означают деньги. Стоимость портфеля
    // и комиссии знака не имеют, и красить их нельзя.
    const b = pnlBlock(withPositions, fmt);

    expect(card(b, 'unrealized').financial).toBe(true);
    expect(card(b, 'roi').financial).toBe(true);
    expect(card(b, 'value').financial).toBe(false);
    expect(card(b, 'invested').financial).toBe(false);
    expect(card(b, 'fees').financial).toBe(false);
  });

  it('тексты пустого состояния и оговорки не обещают прибыли', () => {
    expect(PNL_EMPTY_TEXT).toContain('после первой');
    expect(PNL_DISCLAIMER).toContain('не гарантирует');
    expect(PNL_DISCLAIMER).not.toMatch(/(заработ|доход)/i);
  });
});
