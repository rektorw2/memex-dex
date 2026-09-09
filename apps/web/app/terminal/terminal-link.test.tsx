/**
 * Ссылка «Открыть график» из истории агента.
 *
 * Пока ссылка не разрешена — грузится или не найдена — терминал не
 * подставляет первый токен рынка ни в график, ни в торговую панель,
 * и говорит об этом сразу, на компьютере и на телефоне. Здесь
 * подделаны только сеть (`fetcher`) и параметры адреса; страница
 * настоящая.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, act } from '@testing-library/react';
import React from 'react';

const state = vi.hoisted(() => ({
  params: new URLSearchParams(),
  resolve: null as null | ((query: string) => Promise<any>),
  listener: null as null | (() => void),
}));

class ApiErrorMock extends Error {
  constructor(message: string, public status: number) { super(message); this.name = 'ApiError'; }
}

const MARKET = [
  { id: 'first', chain: 'SOLANA', address: 'First111111111111111111111111111111111111111', symbol: 'FIRST', name: 'First', isQuote: false, priceUsd: '1', decimals: 9 },
  { id: 'usdc', chain: 'SOLANA', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', name: 'USD Coin', isQuote: true, priceUsd: '1', decimals: 6 },
];
const GEM = { id: 'gem-1', chain: 'SOLANA', address: 'GemMint1111111111111111111111111111111111111', symbol: 'GEM', name: 'Gem', isQuote: false, priceUsd: '0.5', decimals: 9, hidden: true, hasChart: true };

vi.mock('next/navigation', () => ({
  useSearchParams: () => {
    const [, force] = React.useReducer((n: number) => n + 1, 0);
    React.useEffect(() => { state.listener = force; return () => { state.listener = null; }; }, [force]);
    return state.params;
  },
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('swr', () => ({ default: (key: string | null) => ({ data: key?.startsWith('/tokens?') ? MARKET : undefined, error: null, isLoading: false, mutate: vi.fn() }) }));
vi.mock('@/lib/api', () => ({
  fetcher: (query: string) => state.resolve!(query),
  api: vi.fn(),
  errorMessage: () => 'Ошибка',
  ApiError: ApiErrorMock,
  fmtUsd: (v: unknown) => String(v), fmtPrice: (v: unknown) => String(v), fmtPct: (v: unknown) => String(v),
}));
vi.mock('@/lib/access', () => ({ useAccess: () => ({ anonymous: true, loading: false, access: null }) }));
vi.mock('@/components/terminal/useTerminalChart', () => ({
  useTerminalChart: (token: any) => ({ chart: null, token, loadOlder: vi.fn(), reload: vi.fn() }),
}));
vi.mock('@/components/terminal/ChartPanel', () => ({
  ChartPanel: ({ token }: { token: any }) => <div data-testid="chart" data-token={token?.id ?? 'none'}>{token ? `chart:${token.symbol}` : 'chart:empty'}</div>,
}));
vi.mock('@/components/terminal/SidePanel', () => ({
  SidePanel: ({ token }: { token: any }) => <div data-testid="side" data-token={token?.id ?? 'none'} />,
}));
vi.mock('@/components/terminal/GemsList', () => ({ GemsList: () => null }));
vi.mock('@/components/terminal/DexScreenerList', () => ({ DexScreenerList: () => null }));
vi.mock('@/components/terminal/TokenList', () => ({ TokenList: () => <div data-testid="list" /> }));
vi.mock('@/components/terminal/MarketStats', () => ({ MarketStats: () => null }));

const { default: TerminalPage } = await import('./page');

function setLink(query: string) {
  state.params = new URLSearchParams(query);
  act(() => state.listener?.());
}

afterEach(() => { cleanup(); state.params = new URLSearchParams(); state.resolve = null; });

describe('терминал по ссылке из истории', () => {
  it('пока ссылка грузится — состояние «открываем», график и торговля пустые, без первого токена рынка', async () => {
    let finish!: (value: any) => void;
    state.resolve = () => new Promise((resolve) => { finish = resolve; });
    state.params = new URLSearchParams('token=gem-1&chain=SOLANA&address=' + GEM.address);
    const { container } = render(<TerminalPage />);
    const loading = container.querySelectorAll('[data-chart-link="loading"]');
    expect(loading.length).toBeGreaterThanOrEqual(1);
    for (const chart of screen.getAllByTestId('chart')) expect(chart.getAttribute('data-token')).toBe('none');
    for (const side of screen.getAllByTestId('side')) expect(side.getAttribute('data-token')).toBe('none');
    await act(async () => { finish(GEM); });
    await waitFor(() => expect(container.querySelector('[data-chart-link]')).toBeNull());
    expect(screen.getAllByTestId('chart')[0]!.getAttribute('data-token')).toBe('gem-1');
  });

  it('404 — «График по ссылке недоступен» виден сразу на обоих экранах, чужой график не подставляется', async () => {
    state.resolve = async () => { throw new ApiErrorMock('нет', 404); };
    state.params = new URLSearchParams('chain=SOLANA&address=Missing111111111111111111111111111111111111');
    const { container } = render(<TerminalPage />);
    await waitFor(() => expect(container.querySelectorAll('[data-chart-link="missing"]').length).toBeGreaterThanOrEqual(2));
    for (const notice of container.querySelectorAll('[data-chart-link="missing"]')) {
      expect(notice.getAttribute('data-chart-link-reason')).toBe('not-found');
      expect(notice.textContent).toContain('График по ссылке недоступен');
      expect(notice.textContent).toContain('Другой токен вместо него не подставлен');
    }
    for (const chart of screen.getAllByTestId('chart')) expect(chart.getAttribute('data-token')).toBe('none');
    for (const side of screen.getAllByTestId('side')) expect(side.getAttribute('data-token')).toBe('none');
    // Два уведомления — настольная колонка графика и мобильная вкладка графика:
    // телефон уже на вкладке «График», переключать вручную не нужно.
  });

  it('сетевая ошибка названа отдельно от «не найден»', async () => {
    state.resolve = async () => { throw new TypeError('fetch failed'); };
    state.params = new URLSearchParams('token=gem-1');
    const { container } = render(<TerminalPage />);
    await waitFor(() => expect(container.querySelector('[data-chart-link="missing"]')).not.toBeNull());
    expect(container.querySelector('[data-chart-link="missing"]')!.getAttribute('data-chart-link-reason')).toBe('network');
    expect(container.textContent).toContain('Не удалось связаться с сервером');
  });

  it('ответ с другим адресом (старый сервер) не принимается за нужный токен', async () => {
    state.resolve = async () => ({ ...GEM, address: 'Other111111111111111111111111111111111111111' });
    state.params = new URLSearchParams('token=gem-1&chain=SOLANA&address=' + GEM.address);
    const { container } = render(<TerminalPage />);
    await waitFor(() => expect(container.querySelector('[data-chart-link="missing"]')).not.toBeNull());
    expect(container.querySelector('[data-chart-link="missing"]')!.getAttribute('data-chart-link-reason')).toBe('mismatch');
    expect(screen.getAllByTestId('chart')[0]!.getAttribute('data-token')).toBe('none');
  });

  it('регистр адреса Solana значим: ответ с тем же адресом в другом регистре — несовпадение', async () => {
    state.resolve = async () => ({ ...GEM, address: GEM.address.toLowerCase() });
    state.params = new URLSearchParams('chain=SOLANA&address=' + GEM.address);
    const { container } = render(<TerminalPage />);
    await waitFor(() => expect(container.querySelector('[data-chart-link="missing"]')).not.toBeNull());
    expect(container.querySelector('[data-chart-link="missing"]')!.getAttribute('data-chart-link-reason')).toBe('mismatch');
  });

  it('переход между двумя ссылками без перезагрузки: вторая ссылка заменяет первую, ошибка второй не оставляет чужой график', async () => {
    const queries: string[] = [];
    state.resolve = async (query) => {
      queries.push(query);
      if (query.includes('gem-1')) return GEM;
      throw new ApiErrorMock('нет', 404);
    };
    state.params = new URLSearchParams('token=gem-1&chain=SOLANA&address=' + GEM.address);
    const { container } = render(<TerminalPage />);
    await waitFor(() => expect(screen.getAllByTestId('chart')[0]!.getAttribute('data-token')).toBe('gem-1'));

    setLink('token=gem-2&chain=BNB&address=0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    await waitFor(() => expect(container.querySelector('[data-chart-link="missing"]')).not.toBeNull());
    expect(screen.getAllByTestId('chart')[0]!.getAttribute('data-token')).toBe('none');
    expect(container.textContent).toContain('BNB Chain');

    setLink('token=gem-1&chain=SOLANA&address=' + GEM.address);
    await waitFor(() => expect(container.querySelector('[data-chart-link]')).toBeNull());
    expect(screen.getAllByTestId('chart')[0]!.getAttribute('data-token')).toBe('gem-1');
    expect(queries.some((q) => q.includes('id=gem-2') && q.includes('chain=BNB'))).toBe(true);
  });
});
