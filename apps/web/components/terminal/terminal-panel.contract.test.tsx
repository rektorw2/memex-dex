import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MarketStats } from './MarketStats';

/**
 * Сводка рынка.
 *
 * Прежде это была горизонтальная лента с прокруткой: на телефоне
 * половина показателей уезжала за край, и узнать об их существовании
 * было нельзя — полоса прокрутки скрыта, а сдвиг внутри узкой ленты
 * пальцем почти не нащупывается.
 */

afterEach(cleanup);

// ────────────────────────── Сводка рынка ────────────────────────────────────

describe('сводка рынка', () => {
  const summary = {
    passedCheck: 128,
    volume24hUsd: '33211250000',
    liquidityUsd: '257180000',
    byChain: { SOLANA: 84, BNB: 30, BASE: 14 },
    dataSource: 'okx',
    updatedAt: '2026-08-25T12:53:00.000Z',
  };

  it('это сетка, а не лента с горизонтальной прокруткой', () => {
    const { container } = render(<MarketStats summary={summary} />);

    const panel = container.firstElementChild!;

    // Лента прятала половину показателей за краем телефона, и узнать
    // об их существовании было нельзя: полоса прокрутки скрыта.
    expect(panel.className).toContain('grid');
    expect(panel.className).not.toContain('scroll-x');
  });

  it('на телефоне две колонки, на планшете три', () => {
    const { container } = render(<MarketStats summary={summary} />);

    const panel = container.firstElementChild!;

    expect(panel.className).toContain('grid-cols-2');
    expect(panel.className).toContain('sm:grid-cols-3');
  });

  it('подписи приглушены, значения контрастны и числовым стилем', () => {
    render(<MarketStats summary={summary} />);

    const label = screen.getByText('Объём 24ч');
    const value = label.nextElementSibling!;

    expect(label.className).toContain('text-muted');
    expect(value.className).toContain('text-white');
    // Тот же числовой стиль, что в таблице ниже: иначе глаз
    // не сравнивает число из сводки с числом из списка.
    expect(value.className).toContain('num');
  });

  it('все показатели остаются на экране, ничего не обрезано ветвлением', () => {
    render(<MarketStats summary={summary} />);

    for (const label of ['Прошли проверку', 'Объём 24ч', 'Ликвидность', 'Solana', 'BNB Chain']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it('источник и время отделены от показателей', () => {
    render(<MarketStats summary={summary} />);

    const source = screen.getByText(/Рыночные данные/).parentElement!;

    // Это сведения о показателях, а не показатель.
    expect(source.className).toContain('border-t');
    expect(source.className).toContain('col-span-2');
  });

  it('без данных показывается заглушка той же формы', () => {
    const { container } = render(<MarketStats summary={undefined} />);

    // Прежняя заглушка была лентой, а готовая панель — сеткой:
    // при появлении данных раскладка менялась на глазах.
    expect(container.firstElementChild!.className).toContain('grid');
  });

  it('пустая сводка не выдумывает нули там, где их не присылали', () => {
    render(<MarketStats summary={{ passedCheck: 0, byChain: {} }} />);

    // Ноль показывается только там, где он действительно пришёл.
    expect(screen.getByText('Прошли проверку')).toBeTruthy();
    expect(screen.queryByText(/Рыночные данные/)).toBeNull();
  });
});
