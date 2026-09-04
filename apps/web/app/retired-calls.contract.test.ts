// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { existsSync, globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('../', import.meta.url));

describe('Calls выведен из продукта', () => {
  it('страницы Calls и автопубликации отсутствуют', () => {
    expect(existsSync(`${web}app/calls/page.tsx`)).toBe(false);
    expect(existsSync(`${web}app/admin/auto/page.tsx`)).toBe(false);
  });

  it('десктопная и мобильная навигация не содержат /calls', () => {
    expect(readFileSync(`${web}components/MainNav.tsx`, 'utf8')).not.toContain("href: '/calls'");
    expect(readFileSync(`${web}components/MobileNav.tsx`, 'utf8')).not.toContain("'/calls'");
  });

  it('состав страниц зафиксирован поимённо', () => {
    /*
     * Количество страниц менялось молча.
     *
     * В коммите c6457ec ушли `/calls` и `/admin/auto`, пришёл
     * `/agent`: экспорт похудел с 19 файлов до 18, и понять по числу,
     * что именно исчезло, было нельзя. Список по именам отвечает на
     * этот вопрос сразу и ловит случайно удалённую страницу.
     */
    const pages = globSync('**/page.tsx', { cwd: `${web}app` }).sort();

    expect(pages).toEqual([
      'access/page.tsx',
      'admin/page.tsx',
      'agent/page.tsx',
      'checkout/page.tsx',
      'copy/page.tsx',
      'login/page.tsx',
      'onboarding/page.tsx',
      'page.tsx',
      'plans/page.tsx',
      'portfolio/page.tsx',
      'radar/alerts/page.tsx',
      'radar/page.tsx',
      'terminal/page.tsx',
      'token/page.tsx',
      'wallet/page.tsx',
      'wallets/page.tsx',
    ]);
  });

  it('публичная страница агента на месте', () => {
    // Она заменила собой удалённые: пропажа именно её выглядела бы
    // как то же самое уменьшение счётчика.
    expect(existsSync(`${web}app/agent/page.tsx`)).toBe(true);
  });

  it('админка не содержит Calls, Tokens и Purchase UI', () => {
    const admin = readFileSync(`${web}app/admin/page.tsx`, 'utf8');
    for (const removed of ['CallManager', 'QuickBuy', 'TokenLister']) expect(admin).not.toContain(removed);
  });
});

describe('визуальный контракт PAPER-агента', () => {
  it('использует локальные Solana и OKX assets', () => {
    expect(existsSync(`${web}public/brand/solana-mark.svg`)).toBe(true);
    expect(existsSync(`${web}public/brand/okx-mark.svg`)).toBe(true);
  });

  it('отключает появление и пульсацию при prefers-reduced-motion', () => {
    const css = readFileSync(`${web}app/globals.css`, 'utf8');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.agent-enter, \.agent-status-dot \{ animation: none; \}/);
  });
});
