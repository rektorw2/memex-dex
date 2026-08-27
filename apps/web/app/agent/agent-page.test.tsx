// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: any) => <a href={href} {...rest}>{children}</a> }));

const state = vi.hoisted(() => ({ publicData: null as any, adminData: null as any, error: null as any }));
const apiMock = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('swr', () => ({ default: (key: string | null) => ({
  data: key === '/paper-agent' ? state.publicData : key === '/admin/paper-agent' ? state.adminData : undefined,
  error: key === '/paper-agent' ? state.error : null,
  mutate: vi.fn(async () => undefined),
}) }));
vi.mock('@/lib/api', () => ({ fetcher: vi.fn(), api: apiMock, errorMessage: () => 'Ошибка' }));
vi.mock('@/lib/public-assets', () => ({ publicAsset: (path: string) => path }));

const { default: AgentPage } = await import('./page');

function data(over: Record<string, unknown> = {}) {
  return {
    paper: true, network: 'Solana', viewer: { isAdmin: false }, health: 'STANDBY',
    control: { isEnabled: true, activeAllocationMode: 'FIXED', learningModeEnabled: false },
    runtime: { running: true, lastActivityAt: '2026-08-27T10:00:00.000Z', queued: 0 },
    source: { transportMode: 'WEBSOCKET', socketState: 'connected', lastSignalAt: null, lastRestSuccessAt: null, nextRestReconciliationAt: null, fallbackActive: false },
    lastDecisionAt: null, notifications: { unread: 0, telegramEnabled: false },
    metrics24h: { uniqueSignals: 2, runs: 4, openPositions: 0, closedPositions: 1, capitalUtilizationPct: 0 },
    wallet: null, positions: [], recentDecisions: [], analytics: { strategyCount: 5, decisionLatencyP50Ms: 100, decisionLatencyP95Ms: 200, validLatencySampleSize: 4 },
    phase4: {
      mode: 'SEMI_AUTO', network: 'SOLANA',
      live: { enabled: false, executionEnabled: false, ready: false, blockers: ['LIVE_DISABLED'] },
      funding: { enabled: false, source: 'DISABLED', assets: [
        { symbol: 'SOL', mint: null, minAmount: '0.01', decimals: 9, minConfirmations: 32 },
        { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', minAmount: '1', decimals: 6, minConfirmations: 32 },
      ] },
      withdrawals: { enabled: false }, compliance: { state: 'NOT_CONFIGURED' }, proposal: null,
    },
    ...over,
  };
}

const wallet = {
  id: 'a', kind: 'ACTIVE', mode: 'FIXED', riskProfile: null, status: 'ACTIVE', openPositions: 0,
  capital: { initialUsd: 1000, freeUsd: 700, reservedUsd: 300, inPositionsUsd: 0, equityUsd: 1000, realizedPnlUsd: 0, unrealizedPnlUsd: 0, tradingFeesUsd: 0, slippageUsd: 0, networkCostsUsd: 0, drawdownPct: 0 },
  limits: { reservePct: 30, maxOpenPositions: 4, maxPositionPct: 17.5, drawdownStopPct: 20 }, ledger: [],
};

afterEach(() => { cleanup(); state.publicData = null; state.adminData = null; state.error = null; apiMock.mockClear(); });

describe('/agent для обычного пользователя', () => {
  it('показывает честную PAPER-маркировку и Solana', () => {
    state.publicData = data(); render(<AgentPage />);
    expect(screen.getByText('PAPER')).toBeTruthy(); expect(screen.getByText('Solana')).toBeTruthy();
  });

  it('визуально отделяет PAPER от заблокированного LIVE', () => {
    state.publicData = data(); render(<AgentPage />);
    expect(screen.getByText('PAPER · АКТИВНЫЙ КОНТУР')).toBeTruthy();
    expect(screen.getByText('LIVE · ЗАБЛОКИРОВАН')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Недоступно' }).hasAttribute('disabled')).toBe(true);
  });

  it('не может включить LIVE через браузер даже для администратора', async () => {
    state.publicData = data({ viewer: { isAdmin: true }, wallet });
    state.adminData = { comparison: [] };
    render(<AgentPage />);
    const confirm = screen.getByRole('button', { name: 'Подтверждение LIVE недоступно' });
    const kill = screen.getByRole('button', { name: 'LIVE kill switch недоступен' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    expect(kill.hasAttribute('disabled')).toBe(true);
    await userEvent.setup().click(confirm);
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('показывает честный funding pipeline и canonical USDC mint', () => {
    state.publicData = data({ wallet }); render(<AgentPage />);
    expect(screen.getByRole('list', { name: 'Этапы пополнения' })).toBeTruthy();
    expect(screen.getByText('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Подтверждение LIVE недоступно' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'LIVE kill switch недоступен' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('On-chain источник не подключён — реальные переводы не принимаются.')).toBeTruthy();
  });

  it('не показывает административную вкладку и кнопки Start/Stop', () => {
    state.publicData = data(); render(<AgentPage />);
    expect(screen.queryByRole('tab', { name: 'Настройки' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Start|Stop/ })).toBeNull();
  });

  it('объясняет пустой PAPER-счёт', () => {
    state.publicData = data(); render(<AgentPage />);
    expect(screen.getByText('PAPER-счёт ещё не создан')).toBeTruthy();
  });

  it('REST_ONLY называется резервным каналом, а не внутренним кодом', () => {
    state.publicData = data({ source: { transportMode: 'REST_ONLY', socketState: null, fallbackActive: true } }); render(<AgentPage />);
    expect(screen.getByText('Резервный REST-канал')).toBeTruthy();
  });

  it('деградация объясняет переход на резервный режим', () => {
    state.publicData = data({
      health: 'DEGRADED',
      source: { transportMode: 'REST_ONLY', socketState: 'disconnected', fallbackActive: true },
    });
    render(<AgentPage />);
    expect(screen.getByText('Резервный режим')).toBeTruthy();
    expect(screen.getByText('Основной канал временно недоступен')).toBeTruthy();
  });

  it('показывает капитал, резерв и расходы без обещаний дохода', () => {
    state.publicData = data({ wallet }); render(<AgentPage />);
    expect(screen.getByText('Свободно')).toBeTruthy(); expect(screen.getByText('Резерв')).toBeTruthy(); expect(screen.getByText('Расходы')).toBeTruthy();
  });

  it('пустые позиции имеют объяснение', () => {
    state.publicData = data({ wallet }); render(<AgentPage />); fireEvent.click(screen.getByRole('tab', { name: 'Позиции' }));
    expect(screen.getByText('Открытых позиций нет')).toBeTruthy();
  });

  it('позиция открывает существующий терминальный график токена', () => {
    state.publicData = data({ wallet, positions: [{
      id: 'run-1', tokenId: 'token-1', token: { id: 'token-1', symbol: 'MEME', name: 'Meme', logoUrl: null },
      symbol: 'MEME', address: 'mint-1', chain: 'SOLANA', state: 'PAPER_OPEN', decisionCode: 'ENTRY_OPENED',
      strategyLabel: 'Baseline', signaledAt: '2026-08-27T10:00:00.000Z', decidedAt: '2026-08-27T10:00:01.000Z',
      entryAt: '2026-08-27T10:00:01.000Z', exitAt: null, entryPriceUsd: 1, currentPriceUsd: 1.1,
      realizedPnlUsd: null, unrealizedPnlUsd: 10, maxMultiple: 1.1, durationMs: 1000, positionUsd: 100,
      totalCostsUsd: 0.2, signalOrigin: 'OKX_SIGNAL_WEBSOCKET',
    }] });
    render(<AgentPage />); fireEvent.click(screen.getByRole('tab', { name: 'Позиции' }));
    expect(screen.getByRole('link', { name: 'Открыть график →' }).getAttribute('href')).toBe('/terminal/?token=token-1');
  });

  it('пустая история имеет отдельное состояние', () => {
    state.publicData = data({ wallet }); render(<AgentPage />); fireEvent.click(screen.getByRole('tab', { name: 'История' }));
    expect(screen.getByText('История пока пуста')).toBeTruthy();
  });

  it('история не остаётся пустой при одном событии PAPER-счёта', () => {
    state.publicData = data({ wallet: { ...wallet, ledger: [{
      id: 'ledger-1', eventType: 'INITIALIZE', amountUsd: 1000, freeAfterUsd: 700,
      reservedAfterUsd: 300, inPositionsAfterUsd: 0, realizedPnlAfterUsd: 0,
      equityAfterUsd: 1000, createdAt: '2026-08-27T10:00:00.000Z', allocation: null,
    }] } });
    render(<AgentPage />); fireEvent.click(screen.getByRole('tab', { name: 'История' }));
    expect(screen.getByText('Создан PAPER-счёт')).toBeTruthy();
    expect(screen.getByText('баланс $1,000.00')).toBeTruthy();
  });
});

describe('/agent для администратора', () => {
  it('показывает настройки только при server-side isAdmin', () => {
    state.publicData = data({ viewer: { isAdmin: true }, wallet }); state.adminData = { comparison: [] }; render(<AgentPage />);
    expect(screen.getByRole('tab', { name: 'Настройки' })).toBeTruthy();
  });

  it('раскрывает Fixed и Autopilot как два разных режима', () => {
    state.publicData = data({ viewer: { isAdmin: true }, wallet }); state.adminData = { comparison: [] }; render(<AgentPage />); fireEvent.click(screen.getByRole('tab', { name: 'Настройки' }));
    expect(screen.getByRole('button', { name: /Fixed/ })).toBeTruthy(); expect(screen.getByRole('button', { name: /Autopilot/ })).toBeTruthy();
  });

  it('показывает Stop для включённого агента', () => {
    state.publicData = data({ viewer: { isAdmin: true }, wallet }); state.adminData = { comparison: [] }; render(<AgentPage />); fireEvent.click(screen.getByRole('tab', { name: 'Настройки' }));
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
  });

  it('переключает вкладки с клавиатуры', async () => {
    state.publicData = data({ viewer: { isAdmin: true }, wallet }); state.adminData = { comparison: [] };
    render(<AgentPage />);
    const settings = screen.getByRole('tab', { name: 'Настройки' });
    settings.focus();
    await userEvent.setup().keyboard('{Enter}');
    expect(settings.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Управление агентом')).toBeTruthy();
  });
});
