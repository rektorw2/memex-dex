// @vitest-environment node
//
// Читается файл, а не отрисовывается дерево: в `jsdom`
// `import.meta.url` — адрес по http, и чтение по нему падает.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Что человек читает, пока сервер просыпается.
 *
 * Спящий сервис отвечает до минуты, и всё это время на экране стоит
 * одно сообщение. Оно должно объяснять ожидание — и ничего больше.
 *
 * Технические подробности здесь не безобидны. Адрес API — это
 * приглашение постучаться туда напрямую; слово CORS ничего не
 * говорит человеку, который просто хочет войти, но заставляет его
 * решить, что сломался он; инструкция «проверьте настройки» отправит
 * его чинить то, что не ломалось.
 */

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8');

/** Только текст, который видит человек: между тегами, без кода. */
function visibleText(block: string): string[] {
  return [...block.matchAll(/>\s*([^<>{}]{8,}?)\s*</g)].map((m) => m[1]!.trim());
}

const wakeupBlock = source.slice(source.indexOf('function WakeupNotice'));

describe('сообщения о пробуждении сервера', () => {
  it('оба состояния объяснены словами', () => {
    const texts = visibleText(wakeupBlock);

    expect(texts.some((t) => /запускаем|сервер/i.test(t))).toBe(true);
    expect(texts.some((t) => /не отвечает/i.test(t))).toBe(true);
  });

  it('человеку обещано, что введённое не потеряется', () => {
    /*
     * Форма, потерявшая адрес и пароль после минуты ожидания, —
     * это вторая попытка ввода там, где человек уже устал ждать.
     */
    expect(wakeupBlock).toMatch(/данные сохранены/i);
  });

  it('есть ручной повтор', () => {
    expect(wakeupBlock).toMatch(/Попробовать ещё раз/);
  });

  it('нет технических подробностей', () => {
    const texts = visibleText(wakeupBlock).join(' | ');

    // Ни адреса, ни протокольных слов, ни внутренних имён.
    expect(texts).not.toMatch(/https?:\/\//);
    expect(texts).not.toMatch(/CORS|localhost|127\.0\.0\.1/i);
    expect(texts).not.toMatch(/fetch|API_URL|\/api\/|endpoint/i);
    expect(texts).not.toMatch(/Error|stack|\.ts:\d+|\b\d{3}\b\s*(ошибк|статус)/i);
  });

  it('нет инструкций чинить то, что не ломалось', () => {
    const texts = visibleText(wakeupBlock).join(' | ');

    // «Проверьте интернет» и «отключите VPN» переводят стрелки
    // на человека, когда причина у нас.
    expect(texts).not.toMatch(/проверьте (интернет|соединение|настройк)/i);
    expect(texts).not.toMatch(/VPN|прокси|брандмауэр|антивирус/i);
  });

  it('состояния объявляются вслух', () => {
    // Экранный диктор должен услышать смену состояния: иначе
    // незрячий человек ждёт молча и не знает, чего именно.
    expect(wakeupBlock).toMatch(/aria-live="polite"/);
  });
});

describe('форма не теряет введённое', () => {
  it('состояние пробуждения не сбрасывает поля', () => {
    /*
     * Проверка источника: значения полей живут в состоянии формы и
     * не связаны с состоянием проверки сервера. Достаточно того,
     * что `wakeup` нигде не приводит к сбросу.
     */
    const clean = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(clean).not.toMatch(/wakeup[\s\S]{0,120}setEmail\(''\)/);
    expect(clean).not.toMatch(/wakeup[\s\S]{0,120}setPassword\(''\)/);
  });

  it('проверка сервера — только чтение', () => {
    // Автоматически повторяется лишь `GET /health`. Ни вход,
    // ни регистрация в этот цикл не попадают.
    const wakeupModule = readFileSync(
      new URL('../../lib/server-wakeup.ts', import.meta.url),
      'utf8',
    );

    expect(wakeupModule).toMatch(/method: 'GET'/);
    expect(wakeupModule).not.toMatch(/method: 'POST'/);
    expect(wakeupModule).not.toMatch(/auth\/(login|register)/);
  });
});
