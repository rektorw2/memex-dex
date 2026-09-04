// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Экран подтверждения.
 *
 * Проверяется не вёрстка, а то, на что человека просят согласиться
 * и чего ему при этом не обещают.
 */

const source = readFileSync(
  fileURLToPath(new URL('./SemiAutoProposals.tsx', import.meta.url)),
  'utf8',
);

/** Исходник без комментариев: объяснение — не код. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const flat = code.replace(/\s+/g, ' ');

describe('что показывают перед подтверждением', () => {
  it('сумма, риск, комиссия, потолок, проскальзывание и стратегия', () => {
    for (const label of ['Риск', 'Комиссия', 'Не более', 'Проскальзывание', 'Стратегия', 'Сеть']) {
      expect(source, label).toContain(label);
    }
  });

  it('причина решения агента показывается', () => {
    expect(code).toContain('presentation.reason');
  });

  it('неизвестная комиссия названа неизвестной, а не нулём', () => {
    // Выдуманная оценка хуже отсутствующей: по ней принимают решение.
    expect(code).toContain("'неизвестна'");
    expect(code).toMatch(/estimatedFeeUsd == null/);
  });

  it('срок действия показан таймером', () => {
    expect(code).toContain('role="timer"');
    expect(code).toContain('Срок истёк');
  });

  it('таймер тикает чаще, чем обновляются данные', () => {
    /*
     * Иначе человек ещё полминуты видел бы «осталось 40 секунд»
     * у мёртвого предложения.
     */
    // `[^)]*` спотыкался о скобку внутри `Date.now()`: выражение
    // отвечало за форму записи, а не за поведение.
    expect(flat).toContain('setNow(Date.now()), 1_000)');
    expect(flat).toContain('refreshInterval: 30_000');
  });
});

describe('чего экран не обещает', () => {
  it('предупреждение об отсутствии отправки стоит до кнопок', () => {
    const warningAt = code.indexOf('warning');
    const buttonAt = code.indexOf('Подтвердить');
    expect(warningAt).toBeGreaterThan(-1);
    // Прочитанное после нажатия не помогает.
    expect(warningAt).toBeLessThan(buttonAt);
  });

  it('запасная формулировка тоже говорит про отсутствие отправки', () => {
    expect(code).toContain('не отправляет транзакцию');
  });

  it('не обещает совершённой сделки', () => {
    expect(code).not.toMatch(/Отправлено|Сделка совершена|Куплено|Транзакция отправлена/);
  });
});

describe('кнопки', () => {
  it('подтверждение отключено при заблокированном LIVE', () => {
    expect(flat).toMatch(/disabled=\{expired \|\| busyId != null \|\| liveBlocked\}/);
  });

  it('пока ответ не пришёл, контур считается заблокированным', () => {
    // Неизвестность не должна открывать кнопку.
    expect(flat).toContain('data?.liveBlocked ?? true');
  });

  it('отключённая кнопка остаётся кнопкой, а не ссылкой', () => {
    // Ссылка обещает переход, которого не будет.
    const buttons = code.match(/<button[\s\S]*?<\/button>/g) ?? [];
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    expect(code).not.toMatch(/<Link[^>]*disabled/);
  });

  it('двойной щелчок не становится вторым решением', () => {
    expect(code).toContain('idempotency-key');
    expect(code).toContain('if (busyId) return');
  });

  it('высота кнопок годится для пальца', () => {
    /*
     * Границей блока служит `</button>`, а не первый `>`: внутри
     * атрибутов есть стрелочные функции, и нежадный поиск обрывался
     * на `=>` — тест проверял бы обрезок разметки.
     */
    const buttons = code.match(/<button[\s\S]*?<\/button>/g) ?? [];
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    // 44 пикселя — нижняя граница удобной цели на телефоне.
    for (const button of buttons) expect(button).toContain('min-h-11');
  });
});

describe('клиент не передаёт деньги', () => {
  it('в тело запроса идут только решение и отпечаток', () => {
    const body = flat.slice(flat.indexOf('JSON.stringify('), flat.indexOf('JSON.stringify(') + 120);
    expect(body).toContain('decision');
    expect(body).toContain('shownFingerprint');
    expect(body).not.toMatch(/rawAmount|destination|instructions|transaction/);
  });

  it('компонент не знает ни про подпись, ни про отправку', () => {
    expect(code).not.toMatch(/signature|broadcast|sendTransaction|privateKey/i);
  });
});

describe('оформление', () => {
  it('анимация уважает настройку системы', () => {
    const transitions = code.match(/transition-colors/g) ?? [];
    const reduced = code.match(/motion-reduce:transition-none/g) ?? [];
    expect(transitions.length).toBeGreaterThan(0);
    // Каждому переходу — своё исключение.
    expect(reduced.length).toBeGreaterThanOrEqual(transitions.length);
  });

  it('раскладка перестраивается на узком экране', () => {
    // Две колонки на телефоне, четыре на планшете и шире.
    expect(code).toContain('grid-cols-2');
    expect(code).toContain('sm:grid-cols-4');
    expect(code).toContain('flex-wrap');
  });

  it('раздел объявлен для программ чтения с экрана', () => {
    expect(code).toContain('aria-label="Предложения агента"');
  });
});
