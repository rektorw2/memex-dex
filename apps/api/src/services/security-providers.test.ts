import { describe, it, expect } from 'vitest';
import { parseHoneypot, isHoneypotSupported } from './honeypot.js';
import { parseRugcheck, isAbsoluteFinding } from './rugcheck.js';
import { parseAdvancedInfo, readTags, readOkxRisk } from './okx-security.js';

/**
 * Проверяются разборщики ответов, а не сеть. Смысл в том, что именно
 * разбор решает, будет токен заблокирован или показан, и ошибка здесь
 * не видна ни в журнале, ни на глаз: она выглядит как исправно
 * работающая фильтрация.
 */

describe('Honeypot.is', () => {
  it('сети поддерживаются выборочно', () => {
    expect(isHoneypotSupported('ETHEREUM')).toBe(true);
    expect(isHoneypotSupported('BNB')).toBe(true);
    expect(isHoneypotSupported('BASE')).toBe(true);
    // Симуляции для Solana у сервиса нет — это факт о нём, не о нас.
    expect(isHoneypotSupported('SOLANA')).toBe(false);
  });

  it('ловушка распознаётся', () => {
    const r = parseHoneypot({
      honeypotResult: { isHoneypot: true, honeypotReason: 'продажа отклонена' },
      simulationSuccess: false,
    });
    expect(r.isHoneypot).toBe(true);
    expect(r.reason).toBe('продажа отклонена');
    expect(r.simulated).toBe(true);
  });

  it('несостоявшаяся симуляция отличается от подтверждённой ловушки', () => {
    // Разные исходы: второе может означать и отсутствие ликвидности.
    const r = parseHoneypot({ honeypotResult: { isHoneypot: false }, simulationSuccess: false });
    expect(r.isHoneypot).toBe(false);
    expect(r.sellFailed).toBe(true);
  });

  it('успешная симуляция отдаёт налоги', () => {
    const r = parseHoneypot({
      honeypotResult: { isHoneypot: false },
      simulationResult: { buyTax: 3, sellTax: 4.5, transferTax: 0 },
      simulationSuccess: true,
    });
    expect(r.isHoneypot).toBe(false);
    expect(r.sellFailed).toBe(false);
    expect(r.sellTaxPct).toBe(4.5);
    expect(r.simulated).toBe(true);
  });

  it('пустой ответ не выдаёт себя за успешную проверку', () => {
    const r = parseHoneypot({});
    expect(r.simulated).toBe(false);
    expect(r.isHoneypot).toBe(false);
    expect(r.sellTaxPct).toBeNull();
  });
});

describe('RugCheck', () => {
  it('невозможность продать блокирует', () => {
    const r = parseRugcheck({
      risks: [{ name: 'Honeypot detected', level: 'danger', description: 'Продажа отклоняется' }],
    });
    expect(r.hasCritical).toBe(true);
  });

  it('метка danger сама по себе не блокирует', () => {
    // Это исправление версии правил 6. Версия 5 принимала их danger
    // за приговор и заблокировала 137 токенов из 173: RugCheck ставит
    // эту метку и на активную эмиссию, и на концентрацию у топ-10 —
    // то есть на норму мем-коинов.
    const r = parseRugcheck({
      risks: [
        { name: 'Mint Authority still enabled', level: 'danger', description: 'Эмиссия не отозвана' },
        { name: 'Top 10 holders high ownership', level: 'danger', description: '' },
      ],
    });
    expect(r.hasCritical).toBe(false);
    // Но незамеченными они не остаются — учитываются своим весом.
    expect(r.dangerCount).toBe(2);
  });

  it('абсолютные находки распознаются по ключевым словам', () => {
    // Формулировки у RugCheck меняются, и жёсткий список названий
    // однажды молча перестал бы срабатывать.
    for (const name of ['Honeypot', 'Token cannot sell', 'Transfer disabled', 'Blacklist function']) {
      expect(isAbsoluteFinding(name), name).toBe(true);
    }
    for (const name of ['Mint Authority still enabled', 'Low amount of LP Providers']) {
      expect(isAbsoluteFinding(name), name).toBe(false);
    }
  });

  it('только предупреждения критикой не считаются', () => {
    const r = parseRugcheck({ risks: [{ name: 'x', level: 'warn' }] });
    expect(r.hasCritical).toBe(false);
    expect(r.dangerCount).toBe(0);
  });

  it('пустой список означает «проверили, чисто»', () => {
    const r = parseRugcheck({ risks: [] });
    expect(r.hasCritical).toBe(false);
    expect(r.risks).toHaveLength(0);
  });

  it('отсутствие поля risks не роняет разбор', () => {
    const r = parseRugcheck({});
    expect(r.risks).toEqual([]);
    expect(r.hasCritical).toBe(false);
  });
});

describe('advanced-info', () => {
  const raw = {
    tokenTags: ['communityRecognized', 'smartMoneyBuy'],
    riskControlLevel: '2',
    lpBurnedPercent: '1',
    top10HoldPercent: '0.44',
    devHoldingPercent: '0.03',
    bundleHoldingPercent: '0.12',
    suspiciousHoldingPercent: '0',
    sniperHoldingPercent: '0.08',
    creatorAddress: '0xcreator',
    devRugPullTokenCount: '0',
    devCreateTokenCount: '2',
    createTime: '1700000000',
  };

  it('поля переводятся в проценты', () => {
    const a = parseAdvancedInfo(raw, 'BASE', '0xtoken')!;
    expect(a.top10HoldPct).toBeCloseTo(44);
    expect(a.devHoldingPct).toBeCloseTo(3);
    expect(a.lpBurnedPct).toBeCloseTo(100);
    expect(a.riskControlLevel).toBe(2);
    expect(a.devRugPullTokenCount).toBe(0);
  });

  it('ответ массивом из одного элемента разбирается так же', () => {
    const a = parseAdvancedInfo([raw], 'BASE', '0xtoken')!;
    expect(a.riskControlLevel).toBe(2);
  });

  it('незнакомая форма даёт null', () => {
    expect(parseAdvancedInfo(null, 'BASE', '0x')).toBeNull();
    expect(parseAdvancedInfo('строка', 'BASE', '0x')).toBeNull();
  });

  it('ноль в доле остаётся нулём, а отсутствие — неизвестностью', () => {
    const a = parseAdvancedInfo(
      { suspiciousHoldingPercent: '0' },
      'BASE',
      '0x',
    )!;
    expect(a.suspiciousHoldingPct).toBe(0);
    expect(a.bundleHoldingPct).toBeNull();
  });
});

describe('толкование тегов', () => {
  it('honeypot распознаётся', () => {
    expect(readTags(['honeypot']).isHoneypot).toBe(true);
  });

  it('признаки внимания рынка собираются отдельно от опасности', () => {
    // Оплаченное продвижение говорит о бюджете на маркетинг,
    // а не о свойствах контракта.
    const r = readTags(['dexScreenerPaid', 'smartMoneyBuy', 'dexBoost']);
    expect(r.isHoneypot).toBe(false);
    expect(r.attention).toHaveLength(3);
  });

  it('выход разработчика различает полный и частичный', () => {
    expect(readTags(['devHoldingStatusSellAll']).devSoldAll).toBe(true);
    expect(readTags(['devHoldingStatusSell']).devSold).toBe(true);
    expect(readTags(['devHoldingStatusSell']).devSoldAll).toBe(false);
  });

  it('претензия на токенизированный актив видна по разным тегам', () => {
    expect(readTags(['xStocks']).claimsRwa).toBe(true);
    expect(readTags(['ondo']).claimsRwa).toBe(true);
    expect(readTags(['RWA']).claimsRwa).toBe(true);
    expect(readTags(['meme']).claimsRwa).toBe(false);
  });

  it('пустой список тегов ничего не утверждает', () => {
    const r = readTags([]);
    expect(r.isHoneypot).toBe(false);
    expect(r.communityRecognized).toBe(false);
    expect(r.attention).toEqual([]);
  });
});

describe('уровень риска OKX', () => {
  it('3 и выше — полное скрытие', () => {
    for (const l of [3, 4, 5]) {
      expect(readOkxRisk(l).hardBlock, `уровень ${l}`).toBe(true);
    }
  });

  it('2 — осторожность, но не приговор', () => {
    const r = readOkxRisk(2);
    expect(r.hardBlock).toBe(false);
    expect(r.band).toBe('caution');
  });

  it('1 — нарушений не найдено', () => {
    expect(readOkxRisk(1).band).toBe('clean');
  });

  it('0 и отсутствие читаются как «не проверяли»', () => {
    // Ключевая проверка: ноль стоит по умолчанию, в том числе у токена,
    // до которого проверка не дошла. Принять его за одобрение значит
    // пропустить непроверенное под видом безопасного.
    expect(readOkxRisk(0).band).toBe('unknown');
    expect(readOkxRisk(null).band).toBe('unknown');
    expect(readOkxRisk(null).explanation).toContain('не то же самое');
  });
});
