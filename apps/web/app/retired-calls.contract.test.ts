// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
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
