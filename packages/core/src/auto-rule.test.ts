import { describe, it, expect } from 'vitest';
import {
  evaluateAutoRule,
  buildTargets,
  buildStopLoss,
  buildThesis,
  type AutoRuleConfig,
  type AutoRuleCandidate,
  type AutoRuleState,
} from './auto-rule.js';

const rule = (over: Partial<AutoRuleConfig> = {}): AutoRuleConfig => ({
  isEnabled: true,
  isDryRun: false,
  chains: [],
  minSmartBuyers: 2,
  minSignalStrength: 40,
  minSmartVolumeUsd: 3000,
  minLiquidityUsd: 30_000,
  minVolume24hUsd: 20_000,
  maxRiskScore: 60,
  maxPoolAgeHours: 72,
  maxCallsPerDay: 5,
  cooldownMinutes: 60,
  ...over,
});

/** Кандидат, проходящий все условия по умолчанию. */
const good = (over: Partial<AutoRuleCandidate> = {}): AutoRuleCandidate => ({
  chain: 'SOLANA',
  symbol: 'TEST',
  smartBuyers: 3,
  whaleBuyers: 1,
  smartVolumeUsd: 12_000,
  signalStrength: 65,
  liquidityUsd: 80_000,
  volume24hUsd: 150_000,
  riskScore: 35,
  poolAgeHours: 8,
  priceUsd: 0.00042,
  hasExistingCall: false,
  alreadyProcessed: false,
  ...over,
});

const fresh: AutoRuleState = { callsLast24h: 0, minutesSinceLastFire: null };

describe('evaluateAutoRule — ограничители', () => {
  it('выключенное правило не срабатывает даже на идеальной находке', () => {
    const d = evaluateAutoRule(rule({ isEnabled: false }), good(), fresh);
    expect(d.outcome).toBe('SKIPPED');
    expect(d.reason).toContain('выключено');
  });

  it('режим наблюдения даёт решение, но не публикацию', () => {
    const d = evaluateAutoRule(rule({ isDryRun: true }), good(), fresh);
    expect(d.outcome).toBe('DRY_RUN');
    expect(d.reason).toContain('наблюдение');
    // Условия при этом проверены полностью — иначе наблюдение
    // не показывало бы реальное поведение правила.
    expect(d.failed).toHaveLength(0);
    expect(d.passed.length).toBeGreaterThan(3);
  });

  it('дневной лимит останавливает публикацию', () => {
    const d = evaluateAutoRule(rule({ maxCallsPerDay: 5 }), good(), {
      callsLast24h: 5,
      minutesSinceLastFire: 500,
    });
    expect(d.outcome).toBe('SKIPPED');
    expect(d.reason).toContain('лимит');
  });

  it('пауза между публикациями соблюдается', () => {
    const state = { callsLast24h: 1, minutesSinceLastFire: 20 };
    expect(evaluateAutoRule(rule({ cooldownMinutes: 60 }), good(), state).outcome).toBe('SKIPPED');
    expect(evaluateAutoRule(rule({ cooldownMinutes: 15 }), good(), state).outcome).toBe('FIRED');
  });

  it('повторное решение по той же находке не принимается', () => {
    const d = evaluateAutoRule(rule(), good({ alreadyProcessed: true }), fresh);
    expect(d.outcome).toBe('SKIPPED');
    expect(d.reason).toContain('уже принималось');
  });

  it('существующий колл по токену блокирует дубль', () => {
    const d = evaluateAutoRule(rule(), good({ hasExistingCall: true }), fresh);
    expect(d.outcome).toBe('SKIPPED');
    expect(d.reason).toContain('уже есть колл');
  });

  it('ограничители проверяются раньше содержательных условий', () => {
    // Находка плохая по всем метрикам, но правило выключено —
    // в журнале должна быть именно эта причина.
    const d = evaluateAutoRule(
      rule({ isEnabled: false }),
      good({ smartBuyers: 0, liquidityUsd: 1 }),
      fresh,
    );
    expect(d.reason).toBe('Правило выключено');
  });

  it('пустой список сетей означает все сети', () => {
    expect(evaluateAutoRule(rule({ chains: [] }), good({ chain: 'BASE' }), fresh).outcome).toBe('FIRED');
    expect(
      evaluateAutoRule(rule({ chains: ['SOLANA'] }), good({ chain: 'BASE' }), fresh).outcome,
    ).toBe('SKIPPED');
  });
});

describe('evaluateAutoRule — условия по находке', () => {
  it('срабатывает, когда выполнены все условия', () => {
    const d = evaluateAutoRule(rule(), good(), fresh);
    expect(d.outcome).toBe('FIRED');
    expect(d.failed).toHaveLength(0);
  });

  it('перечисляет все непройденные условия, а не только первое', () => {
    const d = evaluateAutoRule(
      rule(),
      good({ smartBuyers: 0, signalStrength: 5, liquidityUsd: 100 }),
      fresh,
    );
    expect(d.outcome).toBe('SKIPPED');
    // Иначе настройка правила превращается в перебор: исправил одно —
    // узнал про следующее.
    expect(d.failed.length).toBeGreaterThanOrEqual(3);
  });

  it('отсутствующая метрика считается непройденным условием', () => {
    const noLiq = evaluateAutoRule(rule(), good({ liquidityUsd: null }), fresh);
    const noVol = evaluateAutoRule(rule(), good({ volume24hUsd: null }), fresh);
    const noRisk = evaluateAutoRule(rule(), good({ riskScore: null }), fresh);

    // Токен без данных не должен проходить фильтр легче, чем токен
    // с плохими данными.
    expect(noLiq.outcome).toBe('SKIPPED');
    expect(noVol.outcome).toBe('SKIPPED');
    expect(noRisk.outcome).toBe('SKIPPED');
    expect(noLiq.reason).toContain('неизвестна');
  });

  it('неизвестный возраст пула не блокирует', () => {
    // Возраст — единственная метрика, где отсутствие допустимо:
    // источник не всегда отдаёт время создания пула.
    const d = evaluateAutoRule(rule(), good({ poolAgeHours: null }), fresh);
    expect(d.outcome).toBe('FIRED');
  });

  it('без цены колл не создаётся', () => {
    expect(evaluateAutoRule(rule(), good({ priceUsd: null }), fresh).outcome).toBe('SKIPPED');
    expect(evaluateAutoRule(rule(), good({ priceUsd: 0 }), fresh).outcome).toBe('SKIPPED');
  });

  it('сильный сигнал по кошелькам не отменяет проверку риска', () => {
    // Смарт-деньги тоже заходят в honeypot — у них просто хватает
    // денег на потерю.
    const d = evaluateAutoRule(
      rule(),
      good({ smartBuyers: 20, signalStrength: 100, smartVolumeUsd: 1e6, riskScore: 95 }),
      fresh,
    );
    expect(d.outcome).toBe('SKIPPED');
    expect(d.failed.some((f) => f.includes('риск'))).toBe(true);
  });

  it('пороги срабатывают ровно на границе', () => {
    const r = rule({ minSmartBuyers: 3, minSignalStrength: 50, minSmartVolumeUsd: 5000 });

    expect(evaluateAutoRule(r, good({ smartBuyers: 3, signalStrength: 50, smartVolumeUsd: 5000 }), fresh).outcome)
      .toBe('FIRED');
    expect(evaluateAutoRule(r, good({ smartBuyers: 2 }), fresh).outcome).toBe('SKIPPED');
    expect(evaluateAutoRule(r, good({ signalStrength: 49 }), fresh).outcome).toBe('SKIPPED');
    expect(evaluateAutoRule(r, good({ smartVolumeUsd: 4999 }), fresh).outcome).toBe('SKIPPED');
  });
});

describe('buildTargets и buildStopLoss', () => {
  it('цели считаются от цены входа', () => {
    const t = buildTargets(100, [50, 100, 200]);
    expect(t.map((x) => x.priceUsd)).toEqual([150, 200, 300]);
  });

  it('доли в сумме дают ровно 100', () => {
    for (const pcts of [[50], [50, 100], [50, 100, 200], [25, 50, 100, 200]]) {
      const t = buildTargets(1, pcts);
      expect(t.reduce((s, x) => s + x.pct, 0)).toBe(100);
    }
  });

  it('цели упорядочены по возрастанию независимо от порядка ввода', () => {
    const t = buildTargets(100, [200, 50, 100]);
    expect(t.map((x) => x.priceUsd)).toEqual([150, 200, 300]);
  });

  it('некорректный ввод не создаёт целей', () => {
    expect(buildTargets(0, [50])).toEqual([]);
    expect(buildTargets(100, [])).toEqual([]);
    expect(buildTargets(100, [-10, 0])).toEqual([]);
  });

  it('стоп-лосс ниже цены входа', () => {
    expect(buildStopLoss(100, 35)).toBeCloseTo(65, 10);
    expect(buildStopLoss(100, 0)).toBeNull();
    // Стоп в 100% означал бы нулевую цену — это не стоп, а ошибка ввода.
    expect(buildStopLoss(100, 100)).toBeNull();
    expect(buildStopLoss(0, 35)).toBeNull();
  });

  it('очень малые цены не теряют точность в знаках', () => {
    const t = buildTargets(0.000000123, [100]);
    expect(t[0]!.priceUsd).toBeCloseTo(0.000000246, 15);
  });
});

describe('buildThesis', () => {
  it('первой строкой сообщает, что колл автоматический', () => {
    const c = good();
    const d = evaluateAutoRule(rule(), c, fresh);
    const text = buildThesis(c, d);

    // Пользователь имеет право знать, что за коллом не стоит
    // человеческое суждение.
    expect(text.split('\n')[0]).toContain('автоматически');
    expect(text).toContain('обесцениться до нуля');
    expect(text.length).toBeGreaterThan(20);
  });

  it('упоминает китов только когда они есть', () => {
    const withWhales = buildThesis(good({ whaleBuyers: 3 }), evaluateAutoRule(rule(), good(), fresh));
    const without = buildThesis(good({ whaleBuyers: 0 }), evaluateAutoRule(rule(), good(), fresh));

    expect(withWhales).toContain('крупных покупателей');
    expect(without).not.toContain('крупных покупателей');
  });
});
