/**
 * Допуск автоматической покупки.
 *
 * Набор проверяет одно утверждение под разными углами: отсутствие
 * данных запрещает покупку. Нарушить это правило легко и приятно —
 * каждое послабление по отдельности выглядит безобидным, — поэтому
 * тестов на «не хватает данных» здесь больше, чем на «порог
 * нарушен».
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateGate,
  missingLimits,
  GATE_REASON,
  type GateInput,
  type GateLimits,
} from './risk-gate-decision.js';
import { mandatoryChecks, type RiskSignal } from './risk-completeness.js';

const NOW = 1_800_000_000_000;

/** Пороги, заданные полностью. Числа условные — модуль их не знает. */
const limits: GateLimits = {
  maxSignalAgeMs: 60_000,
  minLiquidityUsd: 20_000,
  maxPriceImpactPct: 3,
  maxSellTaxPct: 10,
  maxTopHolderPct: 40,
  maxSoldRatioPct: 30,
  maxOpenPositions: 5,
  maxPositionsPerToken: 1,
  dailyLossLimitUsd: 100,
};

function passedSignals(chain: 'ETHEREUM' | 'SOLANA'): RiskSignal[] {
  return mandatoryChecks(chain).map((code) => ({
    code,
    status: 'passed' as const,
    value: code === 'sell_tax' ? 0 : true,
    source: 'okx',
    checkedAt: NOW,
  }));
}

/** Вход, при котором всё в порядке. Каждый тест портит одно поле. */
function goodInput(over: Partial<GateInput> = {}): GateInput {
  return {
    chain: 'ETHEREUM',
    signals: passedSignals('ETHEREUM'),
    limits,
    tokenSupported: true,
    sellRouteAvailable: true,
    sellSimulationOk: true,
    liquidityUsd: 50_000,
    priceImpactPct: 1,
    topHolderPct: 10,
    soldRatioPct: 5,
    signalAgeMs: 5_000,
    sourceCategories: ['smart_money'],
    quoteFresh: true,
    openPositions: 0,
    positionsForToken: 0,
    dailyLossUsd: 0,
    ...over,
  };
}

describe('разрешение', () => {
  it('при полном наборе данных и соблюдённых порогах — ALLOW', () => {
    const r = evaluateGate(goodInput());

    expect(r.decision).toBe('ALLOW');
    expect(r.reasons).toEqual([]);
  });

  it('Solana с её набором проверок тоже проходит', () => {
    const r = evaluateGate(
      goodInput({ chain: 'SOLANA', signals: passedSignals('SOLANA') }),
    );

    expect(r.decision).toBe('ALLOW');
  });
});

describe('незнание запрещает покупку', () => {
  it('пустой набор проверок — SKIP', () => {
    const r = evaluateGate(goodInput({ signals: [] }));

    expect(r.decision).toBe('SKIP');
    expect(r.reasons).toContain(GATE_REASON.riskDataMissing);
  });

  it('неподтверждённая поддержка токена — SKIP', () => {
    // null означает «не выясняли», и это не то же самое, что «да».
    const r = evaluateGate(goodInput({ tokenSupported: null }));

    expect(r.decision).toBe('SKIP');
    expect(r.reasons).toContain(GATE_REASON.tokenNotSupported);
    expect(r.explanations.join(' ')).toContain('не подтверждена');
  });

  it('непроверенный обратный маршрут — SKIP', () => {
    // Купить можно почти всё; вопрос всегда в том, можно ли продать.
    const r = evaluateGate(goodInput({ sellRouteAvailable: null }));

    expect(r.reasons).toContain(GATE_REASON.sellRouteUnavailable);
  });

  it('невыполненная симуляция продажи — SKIP', () => {
    const r = evaluateGate(goodInput({ sellSimulationOk: null }));

    expect(r.reasons).toContain(GATE_REASON.sellSimulationFailed);
    expect(r.explanations.join(' ')).toContain('не выполнялась');
  });

  it('неполученная котировка — SKIP', () => {
    const r = evaluateGate(goodInput({ quoteFresh: null }));

    expect(r.reasons).toContain(GATE_REASON.quoteExpired);
  });

  it('неизвестная ликвидность не проходит порог «не меньше»', () => {
    // В JavaScript `null < 20000` истинно, и токен без данных
    // прошёл бы проверку на достаточную ликвидность.
    const r = evaluateGate(goodInput({ liquidityUsd: null }));

    expect(r.decision).toBe('SKIP');
    expect(r.reasons).toContain(GATE_REASON.riskDataMissing);
  });

  it('неизвестное влияние на цену не проходит порог «не больше»', () => {
    const r = evaluateGate(goodInput({ priceImpactPct: null }));

    expect(r.decision).toBe('SKIP');
    expect(r.explanations.join(' ')).toContain('неизвестно');
  });

  it('неизвестная концентрация держателей — SKIP', () => {
    const r = evaluateGate(goodInput({ topHolderPct: null }));
    expect(r.decision).toBe('SKIP');
  });

  it('неизвестный возраст сигнала — SKIP', () => {
    const r = evaluateGate(goodInput({ signalAgeMs: null }));
    expect(r.decision).toBe('SKIP');
  });

  it('недоступность источника закрывает вход, а не открывает', () => {
    // Работать по старым проверкам нельзя: устаревшая проверка
    // безопасности хуже отсутствующей, она выглядит как проверка.
    const r = evaluateGate(goodInput({ providerUnavailable: true }));

    expect(r.decision).toBe('SKIP');
    expect(r.reasons).toContain(GATE_REASON.providerUnavailable);
  });
});

describe('подтверждённые запреты', () => {
  it('ханипот — SKIP', () => {
    const signals = passedSignals('ETHEREUM').map((s) =>
      s.code === 'honeypot' ? { ...s, status: 'failed' as const } : s,
    );

    const r = evaluateGate(goodInput({ signals }));

    expect(r.decision).toBe('SKIP');
    expect(r.reasons).toContain(GATE_REASON.honeypotSuspected);
  });

  it('активная эмиссия — SKIP', () => {
    const signals = passedSignals('ETHEREUM').map((s) =>
      s.code === 'mint_authority' ? { ...s, status: 'failed' as const } : s,
    );

    expect(evaluateGate(goodInput({ signals })).reasons).toContain(
      GATE_REASON.mintAuthorityActive,
    );
  });

  it('активная заморозка в Solana — SKIP', () => {
    const signals = passedSignals('SOLANA').map((s) =>
      s.code === 'freeze_authority' ? { ...s, status: 'failed' as const } : s,
    );

    const r = evaluateGate(goodInput({ chain: 'SOLANA', signals }));

    expect(r.reasons).toContain(GATE_REASON.freezeAuthorityActive);
  });

  it('увод ликвидности — SKIP даже при остальных пройденных', () => {
    const signals = [
      ...passedSignals('ETHEREUM'),
      {
        code: 'liquidity_removed',
        status: 'failed' as const,
        source: 'okx',
        checkedAt: NOW,
      },
    ];

    expect(evaluateGate(goodInput({ signals })).decision).toBe('SKIP');
  });
});

describe('пороги', () => {
  it('старый сигнал — SKIP', () => {
    const r = evaluateGate(goodInput({ signalAgeMs: limits.maxSignalAgeMs + 1 }));

    expect(r.reasons).toContain(GATE_REASON.signalTooOld);
  });

  it('низкая ликвидность — SKIP', () => {
    const r = evaluateGate(goodInput({ liquidityUsd: limits.minLiquidityUsd - 1 }));

    expect(r.reasons).toContain(GATE_REASON.liquidityTooLow);
  });

  it('высокое влияние на цену — SKIP', () => {
    const r = evaluateGate(goodInput({ priceImpactPct: limits.maxPriceImpactPct + 0.1 }));

    expect(r.reasons).toContain(GATE_REASON.priceImpactTooHigh);
  });

  it('высокая концентрация — SKIP', () => {
    const r = evaluateGate(goodInput({ topHolderPct: limits.maxTopHolderPct + 1 }));

    expect(r.reasons).toContain(GATE_REASON.topHolderConcentration);
  });

  it('источники уже распродают — SKIP', () => {
    // Повторять вход за теми, кто выходит, — это покупать у них же.
    const r = evaluateGate(goodInput({ soldRatioPct: limits.maxSoldRatioPct + 1 }));

    expect(r.reasons).toContain(GATE_REASON.sourceAlreadySelling);
  });

  it('высокий налог на продажу в EVM — SKIP', () => {
    const signals = passedSignals('ETHEREUM').map((s) =>
      s.code === 'sell_tax' ? { ...s, value: limits.maxSellTaxPct + 5 } : s,
    );

    expect(evaluateGate(goodInput({ signals })).reasons).toContain(
      GATE_REASON.sellTaxTooHigh,
    );
  });

  it('ровно на пороге — не нарушение', () => {
    const r = evaluateGate(
      goodInput({
        signalAgeMs: limits.maxSignalAgeMs,
        liquidityUsd: limits.minLiquidityUsd,
        priceImpactPct: limits.maxPriceImpactPct,
      }),
    );

    expect(r.decision).toBe('ALLOW');
  });
});

describe('пределы позиций', () => {
  it('достигнут предел открытых позиций — SKIP', () => {
    const r = evaluateGate(goodInput({ openPositions: limits.maxOpenPositions }));

    expect(r.reasons).toContain(GATE_REASON.positionLimitReached);
  });

  it('повторный вход в тот же токен — SKIP', () => {
    const r = evaluateGate(goodInput({ positionsForToken: 1 }));

    expect(r.reasons).toContain(GATE_REASON.positionLimitReached);
  });

  it('дневной убыток достигнут — SKIP', () => {
    const r = evaluateGate(goodInput({ dailyLossUsd: limits.dailyLossLimitUsd }));

    expect(r.reasons).toContain(GATE_REASON.dailyLossLimitReached);
  });
});

describe('источник сигнала', () => {
  it('снайпер среди источников — SKIP', () => {
    const r = evaluateGate(goodInput({ sourceCategories: ['smart_money', 'sniper'] }));

    expect(r.decision).toBe('SKIP');
    expect(r.reasons).toContain(GATE_REASON.adverseSourceWallet);
  });

  it('подозрение на фишинг — SKIP', () => {
    const r = evaluateGate(goodInput({ sourceCategories: ['phishing_suspect'] }));

    expect(r.reasons).toContain(GATE_REASON.adverseSourceWallet);
  });

  it('умные деньги и киты не мешают', () => {
    const r = evaluateGate(goodInput({ sourceCategories: ['smart_money', 'whale', 'kol'] }));

    expect(r.decision).toBe('ALLOW');
  });
});

describe('стоп-кран и настройки', () => {
  it('стоп-кран запрещает вход', () => {
    const r = evaluateGate(goodInput({ killSwitchActive: true }));

    expect(r.decision).toBe('SKIP');
    expect(r.reasons).toContain(GATE_REASON.killSwitchActive);
  });

  it('незаданные пороги запрещают автоматику', () => {
    // Пока обязательные пределы не настроены, живая автоматика
    // включаться не должна вовсе.
    const r = evaluateGate(goodInput({ limits: null }));

    expect(r.decision).toBe('SKIP');
    expect(r.reasons).toContain(GATE_REASON.limitsNotConfigured);
  });

  it('частично заданные пороги перечисляются поимённо', () => {
    const partial = { maxSignalAgeMs: 60_000, minLiquidityUsd: 1_000 };
    const missing = missingLimits(partial);

    expect(missing).toContain('maxPriceImpactPct');
    expect(missing).toContain('dailyLossLimitUsd');
    expect(missing).not.toContain('maxSignalAgeMs');
  });

  it('ноль — допустимый порог, а не отсутствие настройки', () => {
    const withZero = { ...limits, dailyLossLimitUsd: 0 };

    expect(missingLimits(withZero)).toEqual([]);
  });

  it('все пороги заданы — список пуст', () => {
    expect(missingLimits(limits)).toEqual([]);
  });
});

describe('накопление причин', () => {
  it('несколько нарушений перечисляются все', () => {
    // Человеку нужно видеть всё, что не так, а не первую причину:
    // иначе он чинит их по одной и удивляется каждой следующей.
    const r = evaluateGate(
      goodInput({
        liquidityUsd: 1,
        priceImpactPct: 99,
        signalAgeMs: 999_999,
      }),
    );

    expect(r.reasons.length).toBeGreaterThanOrEqual(3);
    expect(r.explanations).toHaveLength(r.reasons.length);
  });

  it('у каждой причины есть человеческое пояснение', () => {
    const r = evaluateGate(goodInput({ signals: [], tokenSupported: false }));

    for (const e of r.explanations) expect(e.length).toBeGreaterThan(0);
  });
});
