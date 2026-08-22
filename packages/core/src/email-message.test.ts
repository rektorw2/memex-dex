import { describe, it, expect } from 'vitest';
import { verificationEmail, maskEmail } from './email-message.js';
import { CODE_TTL_MS } from './email-verification.js';

const base = { code: '482913', productName: 'Memex DEX' };

describe('письмо с кодом', () => {
  const mail = verificationEmail(base);

  it('код виден в теме', () => {
    // Почтовые клиенты показывают тему в списке — код часто вводят,
    // не открывая письмо.
    expect(mail.subject).toContain('482913');
    expect(mail.subject).toContain('Memex DEX');
  });

  it('код есть и в тексте, и в разметке', () => {
    expect(mail.text).toContain('482913');
    expect(mail.html).toContain('482913');
  });

  it('назван срок действия', () => {
    expect(mail.text).toContain('15 минут');
    expect(mail.html).toContain('15 минут');
  });

  it('есть предупреждение для того, кто письма не запрашивал', () => {
    for (const body of [mail.text, mail.html]) {
      expect(body).toMatch(/не запрашивали/);
    }
  });

  it('нет ссылок, по которым что-то происходит', () => {
    // Письмо с кодом читает и тот, кто получил чужой ящик. Ссылка,
    // делающая что-то по нажатию, превратила бы его в дверь.
    expect(mail.html).not.toMatch(/<a\s/i);
    expect(mail.text).not.toMatch(/https?:\/\//);
  });

  it('нет обещаний и предложений', () => {
    for (const body of [mail.text, mail.html]) {
      expect(body).not.toMatch(/скидк|бесплатн|акци|подпис|тариф|прибыл/i);
    }
  });

  it('нет ничего секретного, кроме самого кода', () => {
    for (const body of [mail.text, mail.html]) {
      expect(body).not.toMatch(/токен|пароль|ключ|api/i);
    }
  });

  it('имя продукта экранируется', () => {
    // Настройки правят люди, а угловая скобка в названии приезжает
    // в письмо как разметка.
    const evil = verificationEmail({ ...base, productName: '<script>x</script>' });

    expect(evil.html).not.toContain('<script>');
    expect(evil.html).toContain('&lt;script&gt;');
  });

  it('срок берётся из правил проверки, а не назначается заново', () => {
    const custom = verificationEmail({ ...base, ttlMs: CODE_TTL_MS });
    expect(custom.text).toBe(mail.text);
  });

  it('окончания склоняются', () => {
    expect(verificationEmail({ ...base, ttlMs: 60_000 }).text).toContain('1 минуту');
    expect(verificationEmail({ ...base, ttlMs: 180_000 }).text).toContain('3 минуты');
    expect(verificationEmail({ ...base, ttlMs: 660_000 }).text).toContain('11 минут');
  });
});

describe('адрес в журнале', () => {
  it('от адреса остаётся первая буква и форма домена', () => {
    expect(maskEmail('myron@example.com')).toBe('m***@e***.com');
  });

  it('полный адрес не восстанавливается', () => {
    const masked = maskEmail('very.long.address@company.co');

    expect(masked).not.toContain('very.long.address');
    expect(masked).not.toContain('company');
  });

  it('мусор не роняет и ничего не раскрывает', () => {
    expect(maskEmail('не-адрес')).toBe('***');
    expect(maskEmail('')).toBe('***');
    expect(maskEmail('@x.com')).toBe('***');
  });

  it('домен без точки тоже скрывается', () => {
    expect(maskEmail('a@localhost')).toBe('a***@l***');
  });
});
