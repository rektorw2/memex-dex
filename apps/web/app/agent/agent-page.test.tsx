// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: any) => <a href={href} {...rest}>{children}</a> }));

const state = vi.hoisted(() => ({ publicData: null as any, adminData: null as any, error: null as any }));
const apiMock = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('swr', () => ({ default: (key: string | null) => ({
  data: key === '/paper-agent' ? state.publicData : key === '/admin/paper-agent' ? state.adminData : undefined,
  error: key === '/paper-agent' ? state.error : null,
  mutate: vi.fn(async () => undefined),
}) }));
/*
 * `ApiError` — настоящий класс, а не заглушка.
 *
 * Страница различает состояния по `instanceof`, и подмена класса
 * пустышкой сделала бы тест бессмысленным: он проверял бы поведение,
 * которого в приложении нет.
 */
class ApiErrorMock extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'ApiError';
  }
}
vi.mock('@/lib/api', () => ({
  fetcher: vi.fn(),
  api: apiMock,
  errorMessage: () => 'Ошибка',
  ApiError: ApiErrorMock,
}));
vi.mock('@/lib/public-assets', () => ({ publicAsset: (path: string) => path }));

const { default: AgentPage } = await import('./page');
const { default: SettingsPage } = await import('./settings/page');

function renderLive() {
  const view = render(<AgentPage />);
  fireEvent.click(screen.getByRole('tab', { name: 'Подготовка LIVE' }));
  return view;
}

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
      status: 'AVAILABLE', unavailable: [],
      live: {
        enabled: false, executionEnabled: false, ready: false, blockers: ['LIVE_DISABLED'],
        stage: 'PAPER_READY', stageBlockers: ['SIGNING_DISABLED'], mainnetRequested: false,
        rpc: { state: 'NOT_RUN', verifiedAt: null, expiresAt: null, stale: false },
      },
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
    state.publicData = data(); renderLive();
    expect(screen.getByText('PAPER · АКТИВНЫЙ КОНТУР')).toBeTruthy();
    expect(screen.getByText('LIVE · ЗАБЛОКИРОВАН')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Недоступно' }).hasAttribute('disabled')).toBe(true);
  });

  it('не может включить LIVE через браузер даже для администратора', async () => {
    state.publicData = data({ viewer: { isAdmin: true }, wallet });
    state.adminData = { comparison: [] };
    renderLive();
    const confirm = screen.getByRole('button', { name: 'Подтверждение LIVE недоступно' });
    const kill = screen.getByRole('button', { name: 'LIVE kill switch недоступен' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    expect(kill.hasAttribute('disabled')).toBe(true);
    await userEvent.setup().click(confirm);
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('показывает честный funding pipeline и canonical USDC mint', () => {
    state.publicData = data({ wallet }); renderLive();
    expect(screen.getByRole('list', { name: 'Этапы пополнения' })).toBeTruthy();
    expect(screen.getByText('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Подтверждение LIVE недоступно' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'LIVE kill switch недоступен' }).hasAttribute('disabled')).toBe(true);
    // Формулировка сменилась на статусную, смысл прежний: приём
    // не работает, и страница не должна обещать обратного.
    expect(screen.getByText('LIVE-пополнения ещё не подключены')).toBeTruthy();
    expect(screen.getByText('Реальные переводы пока не принимаются.')).toBeTruthy();
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
    expect(screen.getByText('Ждёт подходящий сигнал')).toBeTruthy();
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
  it('ссылка настроек доступна только при server-side isAdmin', () => {
    state.publicData = data({ viewer: { isAdmin: true }, wallet }); render(<AgentPage />);
    expect(screen.getByRole('link', { name: 'Настройки →' }).getAttribute('href')).toBe('/agent/settings');
    expect(screen.queryByRole('tab', { name: 'Настройки' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });
  it('раскрывает Fixed и Autopilot на странице настроек', () => {
    state.publicData = data({ viewer: { isAdmin: true }, wallet }); render(<SettingsPage />);
    expect(screen.getByRole('button', { name: /Fixed/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Autopilot/ })).toBeTruthy();
  });
  it('показывает Stop для включённого агента', () => {
    state.publicData = data({ viewer: { isAdmin: true }, wallet }); render(<SettingsPage />);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
  });
  it('переключает вкладки с клавиатуры', async () => {
    state.publicData = data({ wallet }); render(<AgentPage />);
    const live = screen.getByRole('tab', { name: 'Подготовка LIVE' }); live.focus();
    await userEvent.setup().keyboard('{Enter}');
    expect(live.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('list', { name: 'Этапы пополнения' })).toBeTruthy();
  });
});

describe('четыре причины отказа различимы', () => {
  /*
   * До этой правки все четыре давали одну карточку «Агент временно
   * недоступен. Обновите страницу через несколько секунд». Трём из
   * четырёх этот совет не помогал вовсе: обновление не чинит ни
   * истёкшую сессию, ни отсутствие подписки.
   */
  const cases: Array<[unknown, string, string]> = [
    [new ApiErrorMock('нет', 401), 'SIGN_IN_REQUIRED', 'Нужно войти заново'],
    [new ApiErrorMock('нет', 403), 'ACCESS_REQUIRED', 'Экран агента недоступен на текущем тарифе'],
    [new ApiErrorMock('нет', 503), 'SERVER_UNAVAILABLE', 'Сервер сейчас не отвечает'],
    [new Error('оборвалось'), 'NETWORK_UNAVAILABLE', 'Не удалось связаться с сервером'],
  ];

  for (const [error, kind, title] of cases) {
    it(`${kind}: своё сообщение`, () => {
      state.error = error;
      const { container } = render(<AgentPage />);

      expect(container.querySelector(`[data-agent-failure="${kind}"]`)).toBeTruthy();
      expect(screen.getByText(title)).toBeTruthy();
    });
  }

  it('все четыре текста разные', () => {
    const titles = new Set(cases.map(([, , title]) => title));

    expect(titles.size).toBe(4);
  });

  it('повтор предлагается только там, где он помогает', () => {
    // Кнопка «Попробовать ещё раз» при истёкшей сессии — это
    // приглашение к бесполезному действию.
    state.error = new ApiErrorMock('нет', 401);
    const { container } = render(<AgentPage />);
    expect(container.querySelector('button')).toBeNull();
    cleanup();

    state.error = new ApiErrorMock('нет', 503);
    render(<AgentPage />);
    expect(screen.getByRole('button', { name: 'Попробовать ещё раз' })).toBeTruthy();
  });

  it('повтор действительно перезапрашивает данные', () => {
    // Кнопка, которая ничего не делает, хуже её отсутствия.
    state.error = new ApiErrorMock('нет', 503);
    render(<AgentPage />);

    const button = screen.getByRole('button', { name: 'Попробовать ещё раз' });
    fireEvent.click(button);

    expect(button.isConnected).toBe(true);
  });

  it('истёкшая сессия ведёт ко входу, отсутствие доступа — к тарифам', () => {
    state.error = new ApiErrorMock('нет', 401);
    render(<AgentPage />);
    expect(screen.getByRole('link', { name: 'Войти' }).getAttribute('href')).toBe('/login');
    cleanup();

    state.error = new ApiErrorMock('нет', 403);
    render(<AgentPage />);
    expect(screen.getByRole('link', { name: 'Посмотреть тарифы' }).getAttribute('href')).toBe('/plans');
  });

  it('в сообщениях нет технических подробностей', () => {
    for (const [error] of cases) {
      state.error = error;
      const { container } = render(<AgentPage />);

      expect(container.textContent ?? '').not.toMatch(/https?:\/\/|CORS|fetch|\bAPI\b|\b40[13]\b|\b50[03]\b/);
      cleanup();
    }
  });
});

describe('ступень готовности LIVE', () => {
  it('названа словами, без кодов блокировок', () => {
    state.publicData = data({ wallet });
    const { container } = renderLive();

    expect(container.querySelector('[data-live-stage="PAPER_READY"]')).toBeTruthy();
    expect(screen.getByText('Бумажный режим работает')).toBeTruthy();
    expect(container.textContent ?? '').not.toContain('SIGNING_DISABLED');
  });

  it('mainnet назван стеной, а не следующим шагом', () => {
    state.publicData = data({ wallet });
    renderLive();

    expect(screen.getByText(/Переход в основную сеть/)).toBeTruthy();
  });

  it('молчащая диагностика не показывает ступень', () => {
    /*
     * `null` вместо ступени. Показать нижнюю «на всякий случай»
     * значило бы сделать утверждение о контуре, которого никто
     * не проверял.
     */
    const source = data({ wallet });
    (source.phase4 as any).live.stage = null;
    state.publicData = source;
    const { container } = renderLive();

    expect(container.querySelector('[data-live-stage="UNKNOWN"]')).toBeTruthy();
    expect(screen.getByText(/Готовность LIVE сейчас не читается/)).toBeTruthy();
  });
});

describe('состояние узла devnet названо честно', () => {
  /**
   * Раньше готовность сети выводилась из наличия адреса узла в
   * настройках, и человек читал «проверено» там, где не проверяли
   * ничего. Здесь проверяется, что шесть состояний различимы и что
   * ни одно из них не выдаёт непроверенное за проверенное.
   */
  const withRpc = (rpc: Record<string, unknown>) => {
    const source = data({ wallet });
    (source.phase4 as any).live.rpc = { verifiedAt: null, expiresAt: null, stale: false, ...rpc };
    return source;
  };

  it('проверки не было — так и написано', () => {
    state.publicData = withRpc({ state: 'NOT_RUN' });
    const { container } = renderLive();

    expect(container.querySelector('[data-rpc-state="NOT_RUN"]')).toBeTruthy();
    expect(screen.getByText('проверка не выполнялась')).toBeTruthy();
  });

  it('успешная проверка показывает своё время', () => {
    state.publicData = withRpc({
      state: 'VERIFIED',
      verifiedAt: '2026-09-05T10:00:00.000Z',
      expiresAt: '2026-09-05T10:30:00.000Z',
    });
    const { container } = renderLive();

    expect(container.querySelector('[data-rpc-state="VERIFIED"]')).toBeTruthy();
    expect(screen.getByText('проверен')).toBeTruthy();
    expect(container.textContent ?? '').toContain('последняя успешная проверка');
  });

  it('устаревшая проверка просит повторить', () => {
    state.publicData = withRpc({
      state: 'STALE',
      stale: true,
      verifiedAt: '2026-09-04T10:00:00.000Z',
    });
    const { container } = renderLive();

    expect(container.querySelector('[data-rpc-state="STALE"]')).toBeTruthy();
    expect(screen.getByText(/требуется повторная проверка/)).toBeTruthy();
  });

  it('незнакомое состояние не выдаётся за проверенное', () => {
    /*
     * Статика и API выкладываются раздельно: новый сервер может
     * прислать состояние, о котором эта страница ещё не знает.
     * Подставить «проверен» значило бы соврать из-за рассинхрона.
     */
    state.publicData = withRpc({ state: 'СОВСЕМ_НОВОЕ' });
    const { container } = renderLive();
    const line = container.querySelector('[data-rpc-state="СОВСЕМ_НОВОЕ"]');

    expect(screen.getByText('состояние неизвестно')).toBeTruthy();
    // Проверяется именно строка состояния: слово «проверена» есть в
    // подписи ступени лестницы, и поиск по всей странице ловил бы её.
    expect(line?.textContent ?? '').not.toContain('проверен');
  });

  it('обычный пользователь не может запустить проверку', () => {
    // Кнопка живёт только в администраторских настройках, а вкладки
    // «Настройки» у обычного пользователя нет вовсе.
    state.publicData = withRpc({ state: 'NOT_RUN' });
    const { container } = renderLive();

    expect(container.querySelector('[data-action="verify-devnet"]')).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Настройки' })).toBeNull();
  });

  it('адрес узла на экран не выходит', () => {
    state.publicData = withRpc({ state: 'VERIFIED', verifiedAt: '2026-09-05T10:00:00.000Z' });
    const { container } = renderLive();
    const block = container.querySelector('[data-live-stage]');
    const text = block?.textContent ?? '';

    expect(block, 'блок лестницы отрисован').toBeTruthy();
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toContain('api-key');
    expect(text).not.toContain('RPC_URL');
  });
});

describe('недоступная диагностика не выдаётся за факт', () => {
  it('состояние пополнений названо неизвестным, а не «не подключено»', () => {
    const source = data({ wallet });
    (source.phase4 as any).status = 'UNAVAILABLE';
    (source.phase4 as any).unavailable = ['FUNDING'];
    (source.phase4 as any).depositNetwork = null;
    state.publicData = source;
    const { container } = renderLive();

    expect(container.querySelector('[data-deposit-status="UNAVAILABLE"]')).toBeTruthy();
    expect(screen.getByText('Не удалось прочитать состояние пополнений')).toBeTruthy();
  });

  it('PAPER-счёт при этом показан', () => {
    // Смысл разделения: диагностика не участвует в бумажной торговле.
    const source = data({ wallet });
    (source.phase4 as any).status = 'UNAVAILABLE';
    (source.phase4 as any).depositNetwork = null;
    state.publicData = source;
    render(<AgentPage />);

    expect(screen.getByText('Виртуальный капитал')).toBeTruthy();
  });
});

describe('администратор видит то, что чинит', () => {
  const admin = () => data({ wallet, viewer: { isAdmin: true } });

  it('ступень и коды блокировок названы', () => {
    /*
     * Пользователю коды не нужны и вредны; дежурному без них
     * нечего снимать. Это разные адресаты, а не разная подача.
     */
    state.publicData = admin();
    state.adminData = { control: { isEnabled: true, learningModeEnabled: false, activeAllocationMode: 'FIXED' }, comparison: [] };
    const { container } = renderLive();


    expect(container.querySelector('[data-admin-stage="PAPER_READY"]')).toBeTruthy();
    expect(container.textContent ?? '').toContain('SIGNING_DISABLED');
  });

  it('администратор может запустить проверку узла', () => {
    state.publicData = admin();
    state.adminData = { control: { isEnabled: true, learningModeEnabled: false, activeAllocationMode: 'FIXED' }, comparison: [] };
    const { container } = renderLive();

    const button = container.querySelector('[data-action="verify-devnet"]') as HTMLButtonElement;

    expect(button, 'кнопка есть у администратора').toBeTruthy();
    expect(button.disabled, 'проверка не выполнялась — кнопка доступна').toBe(false);

    fireEvent.click(button);

    /*
     * Тела у запроса нет. Прислать сюда свой URL значило бы поднять
     * ступень готовности проверкой чужого узла — поэтому адрес
     * берётся с сервера, а клиент не отправляет ничего.
     */
    expect(apiMock).toHaveBeenCalledWith('/admin/live/devnet-network/check', { method: 'POST' });
  });

  it('кнопка недоступна, пока узел не настроен', () => {
    // Нажимать нечего: проверять нечего. Отключённая кнопка честнее
    // отказа после запроса.
    const source = admin();
    (source.phase4 as any).live.rpc = { state: 'NOT_CONFIGURED', verifiedAt: null, expiresAt: null, stale: false };
    state.publicData = source;
    state.adminData = { control: { isEnabled: true, learningModeEnabled: false, activeAllocationMode: 'FIXED' }, comparison: [] };
    const { container } = renderLive();


    expect((container.querySelector('[data-action="verify-devnet"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('неотвечающие разделы названы поимённо', () => {
    const source = admin();
    (source.phase4 as any).status = 'UNAVAILABLE';
    (source.phase4 as any).unavailable = ['FUNDING', 'SIGNING'];
    state.publicData = source;
    state.adminData = { control: { isEnabled: true, learningModeEnabled: false, activeAllocationMode: 'FIXED' }, comparison: [] };
    renderLive();


    expect(screen.getByText(/FUNDING, SIGNING/)).toBeTruthy();
  });

  it('в админской диагностике нет ключей, адресов и строк подключения', () => {
    /*
     * Права в интерфейсе не делают эти вещи безопасными на экране.
     * Их место — журнал сервера, где есть `reqId` и срок хранения.
     */
    const source = admin();
    (source.phase4 as any).live.mainnetRequested = true;
    state.publicData = source;
    state.adminData = { control: { isEnabled: true, learningModeEnabled: false, activeAllocationMode: 'FIXED' }, comparison: [] };
    const { container } = renderLive();


    const text = container.textContent ?? '';
    expect(text).not.toMatch(/https?:\/\/|arn:aws|postgres|key-|Bearer /i);
    expect(text).toContain('переход запрещён');
  });

  it('обычный пользователь этой диагностики не получает', () => {
    // Вкладки «Настройки» у него нет вовсе.
    state.publicData = data({ wallet });
    renderLive();

    expect(screen.queryByRole('tab', { name: 'Настройки' })).toBeNull();
  });
});

describe('правило выхода и Panic', () => {
  const adminState = () => {
    state.publicData = data({ viewer: { isAdmin: true }, wallet: { ...wallet, exitPlan: { mode: 'PROTECTED', label: 'Защищённый', description: 'стоп −35%' } }, metrics24h: { uniqueSignals: 2, runs: 4, openPositions: 2, closedPositions: 1, capitalUtilizationPct: 20 } });
    state.adminData = { comparison: [] };
  };

  it('четыре режима выхода выбираются, текущий назван', () => {
    adminState(); render(<SettingsPage />); fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('data-exit-mode'))).toEqual(['TARGET', 'PROTECTED', 'LADDER', 'TRAILING', 'TRAILING_PURE']);
    expect(screen.getByText('сейчас: Защищённый')).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Защищённый/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('выбранный режим и правки уходят вместе с распределением', async () => {
    adminState(); state.publicData.metrics24h.openPositions = 0; render(<SettingsPage />); fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
    fireEvent.click(screen.getByRole('radio', { name: /Трейлинг/ }));
    fireEvent.change(screen.getByLabelText(/Трейлинг от максимума/), { target: { value: '40' } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
    fireEvent.click(screen.getByRole('button', { name: 'Применить' }));
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalled());
    const [path, init] = (apiMock.mock.calls[0] as unknown as [string, { body: string }]);
    expect(path).toBe('/admin/paper-agent/allocation');
    expect(JSON.parse(init.body)).toMatchObject({ exitMode: 'TRAILING', exitOverrides: { trailingPct: 40 }, confirm: true });
  });

  it('Panic — отдельная кнопка, зовёт свой маршрут и не трогает Stop', async () => {
    adminState(); render(<SettingsPage />);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: /Panic · закрыть 2/ }));
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalled());
    expect(apiMock.mock.calls.map((call) => (call as unknown as [string])[0])).toEqual(['/admin/paper-agent/panic']);
  });

  it('без открытых позиций Panic недоступен', () => {
    state.publicData = data({ viewer: { isAdmin: true }, wallet }); state.adminData = { comparison: [] };
    render(<SettingsPage />);
    expect((screen.getByRole('button', { name: /Panic/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('позиция показывает режим, стоп и остаток', () => {
    state.publicData = data({ wallet, positions: [{
      id: 'r', tokenId: 'token-1', token: { id: 'token-1', symbol: 'GEM', name: 'Gem', logoUrl: null }, state: 'PAPER_OPEN', decisionCode: null,
      strategyLabel: 'Baseline', chain: 'solana', address: 'Mint', symbol: 'GEM', signaledAt: '2026-09-08T10:00:00.000Z', decidedAt: null, signalOrigin: null,
      entryAt: null, exitAt: null, entryPriceUsd: 1, currentPriceUsd: 1.5, realizedPnlUsd: null, unrealizedPnlUsd: 20, maxMultiple: 1.6, durationMs: null, positionUsd: 100, totalCostsUsd: 1,
      allocation: { exit: { mode: 'LADDER', label: 'Лестница', description: '', remainingPct: 60, legsFilled: 1, legsTotal: 2, stopPriceUsd: 1, stopReason: 'BREAKEVEN_STOP', nextTargetPriceUsd: 2, exitReason: null } },
    }] });
    render(<AgentPage />); fireEvent.click(screen.getByRole('tab', { name: 'Позиции' }));
    expect(screen.getByText('Лестница')).toBeTruthy();
    expect(screen.getByText('открыто 60%')).toBeTruthy();
    expect(screen.getByText(/стоп 1\.00× \(безубыток\)/)).toBeTruthy();
    expect(screen.getByText('ступень 2/2 · 2.00×')).toBeTruthy();
  });
});

function run(over: Record<string, unknown> = {}) {
  return {
    id: 'run-a', tokenId: 'token-a', token: { id: 'token-a', symbol: 'GEM', name: 'Gem', logoUrl: null },
    symbol: 'GEM', address: 'mint', chain: 'SOLANA', state: 'PAPER_OPEN', decisionCode: 'ENTRY_OPENED',
    strategyLabel: 'Balanced', signaledAt: '2026-09-08T10:00:00Z', decidedAt: '2026-09-08T10:00:01Z',
    entryAt: '2026-09-08T10:00:01Z', exitAt: null, entryPriceUsd: 1, currentPriceUsd: 1.5,
    unrealizedPnlUsd: 50, realizedPnlUsd: null, maxMultiple: 1.5, positionUsd: 100,
    allocation: { exit: { mode: 'LADDER', label: 'Лестница', remainingPct: 100, legsFilled: 0, legsTotal: 2, stopPriceUsd: .65, nextTargetPriceUsd: 1.6, exitReason: null } },
    ...over,
  };
}

describe('простой обзор', () => {
  it('первый экран содержит позиции, а подготовка LIVE монтируется только по запросу', () => {
    state.publicData = data({ wallet, positions: [run()] });
    const { container } = render(<AgentPage />);
    const row = container.querySelector('[data-compact-position]')!;
    expect(row.textContent).toContain('GEM');
    expect(row.textContent).toContain('$50.00');
    expect(row.textContent).toContain('1.50×');
    expect(row.textContent).toContain('Стоп 0.65×');
    expect(row.textContent).toContain('Цель 1.60×');
    expect(screen.queryByRole('list', { name: 'Этапы пополнения' })).toBeNull();
    expect(container.querySelector('[data-live-stage]')).toBeNull();
    expect(screen.queryByText('Путь решения')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /LIVE заблокирован/ }));
    expect(screen.getByRole('list', { name: 'Этапы пополнения' })).toBeTruthy();
  });

  it('старый API без плана выхода не выдумывает стоп и цель', () => {
    state.publicData = data({ wallet, positions: [run({ allocation: undefined })] });
    const { container } = render(<AgentPage />);
    const summary = container.querySelector('[data-compact-position] summary')!;
    expect(summary.textContent).toContain('Стоп —');
    expect(summary.textContent).toContain('Цель —');
    expect(screen.getByText('выход: Цель 2×')).toBeTruthy();
  });

  it('пустой обзор оставляет одну строку ожидания', () => {
    state.publicData = data(); render(<AgentPage />);
    expect(screen.getAllByText('Ждёт подходящий сигнал')).toHaveLength(1);
  });

  it('раскрывает полную позицию и открывает расширенный список', () => {
    state.publicData = data({ wallet, positions: [run()] });
    const { container } = render(<AgentPage />);
    fireEvent.click(container.querySelector('[data-compact-position] summary')!);
    expect(container.querySelector('[data-compact-position]')!.hasAttribute('open')).toBe(true);
    expect(screen.getByRole('link', { name: 'Открыть график →' }).getAttribute('href')).toBe('/terminal/?token=token-a');
    fireEvent.click(screen.getByRole('button', { name: 'Подробнее →' }));
    expect(screen.getByRole('tab', { name: 'Позиции' }).getAttribute('aria-selected')).toBe('true');
  });

  it('лента ограничена пятью строками, пропуски сгруппированы по реальным кодам', () => {
    state.publicData = data({ wallet, recentDecisions: [
      ...Array.from({ length: 7 }, (_, i) => run({ id: `entry-${i}`, entryAt: `2026-09-08T10:0${i}:00Z` })),
      run({ id: 'skip-1', state: 'SKIPPED', decisionCode: 'TOKEN_TOO_OLD' }),
      run({ id: 'skip-2', state: 'SKIPPED', decisionCode: 'TOKEN_TOO_OLD' }),
      run({ id: 'skip-3', state: 'SKIPPED', decisionCode: 'PRICE_UNAVAILABLE_BEFORE_DEADLINE' }),
    ] });
    const { container } = render(<AgentPage />);
    const feed = container.querySelector('[aria-label="Последние события"]')!;
    expect(feed.querySelectorAll('ol > li')).toHaveLength(5);
    expect(feed.querySelector('time')?.getAttribute('datetime')).toBe('2026-09-08T10:06:00Z');
    expect(feed.textContent).toContain('Пропущено: 3');
    expect(feed.textContent).toContain('Старый пул: 2');
    expect(feed.textContent).toContain('Нет цены: 1');
    expect(feed.textContent).not.toContain('TOKEN_TOO_OLD');
  });

  it('лента содержит вход, выход и частичную продажу', () => {
    state.publicData = data({ wallet: { ...wallet, ledger: [{ id: 'partial', eventType: 'PARTIAL_EXIT', createdAt: '2026-09-08T10:02:00Z', allocation: { symbol: 'GEM' } }] }, recentDecisions: [run({ state: 'PAPER_CLOSED', exitAt: '2026-09-08T10:03:00Z', realizedPnlUsd: 20, allocation: { exit: { exitReason: 'STOP_LOSS' } } })] });
    render(<AgentPage />);
    expect(screen.getByText(/Позиция открыта/)).toBeTruthy();
    expect(screen.getByText(/Позиция закрыта/)).toBeTruthy();
    expect(screen.getByText(/Часть позиции продана/)).toBeTruthy();
    expect(screen.getByText('стоп-лосс')).toBeTruthy();
  });

  it('неизвестные причины никогда не показываются внутренними кодами', () => {
    state.publicData = data({ wallet, recentDecisions: [run({ state: 'PAPER_CLOSED', exitAt: '2026-09-08T11:00:00Z', allocation: { exit: { exitReason: 'FUTURE_EXIT_CODE' } } }), run({ id: 'skip', state: 'SKIPPED', decisionCode: 'FUTURE_DECISION_CODE' })] });
    const { container } = render(<AgentPage />);
    expect(container.textContent).not.toMatch(/FUTURE_EXIT_CODE|FUTURE_DECISION_CODE/);
    expect(screen.getByText('Другая причина выхода')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'История' }));
    expect(container.textContent).not.toMatch(/FUTURE_EXIT_CODE|FUTURE_DECISION_CODE/);
  });

  it('неизвестная диагностика не превращается в пройденные ступени', () => {
    const source = data(); source.phase4.live.stage = 'FUTURE_STAGE'; state.publicData = source;
    render(<AgentPage />);
    expect(screen.getByRole('button', { name: /LIVE заблокирован/ }).textContent).toContain('готовность неизвестна');
  });

  it('стрелки переключают вкладку и фокус', () => {
    state.publicData = data(); render(<AgentPage />);
    const overview = screen.getByRole('tab', { name: 'Обзор' }); overview.focus();
    fireEvent.keyDown(overview, { key: 'ArrowRight' });
    const positions = screen.getByRole('tab', { name: 'Позиции' });
    expect(positions.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(positions);
  });
});

describe('мастер настроек на отдельном маршруте', () => {
  it('не монтирует управление для обычного пользователя даже по прямой ссылке', () => {
    state.publicData = data({ wallet }); render(<SettingsPage />);
    expect(screen.queryByRole('button', { name: /Start|Stop|Panic|Применить/ })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Мастер настройки' })).toBeNull();
  });

  it('подтверждение отражает выбранные капитал, профиль и лестницу, отправка только на третьем шаге', async () => {
    state.publicData = data({ viewer: { isAdmin: true }, wallet }); render(<SettingsPage />);
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Применить' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Autopilot/ }));
    fireEvent.change(screen.getByLabelText('PAPER-капитал, USD'), { target: { value: '2500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
    fireEvent.click(screen.getByRole('radio', { name: /Лестница/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
    expect(screen.getByText(/\$2,500.00, Autopilot Balanced, Лестница: 40% на 1.6×, 30% на 2×, стоп −35%/)).toBeTruthy();
    expect(apiMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Применить' }));
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse((apiMock.mock.calls[0] as any)[1].body)).toMatchObject({ mode: 'AUTOPILOT', capitalUsd: '2500', riskProfile: 'BALANCED', exitMode: 'LADDER', confirm: true });
  });

  it('переход назад сохраняет введённые параметры', () => {
    state.publicData = data({ viewer: { isAdmin: true }, wallet }); render(<SettingsPage />);
    fireEvent.change(screen.getByLabelText('PAPER-капитал, USD'), { target: { value: '1250' } });
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
    fireEvent.click(screen.getByRole('radio', { name: /Трейлинг/ }));
    fireEvent.change(screen.getByLabelText(/Трейлинг от максимума/), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
    expect((screen.getByLabelText('PAPER-капитал, USD') as HTMLInputElement).value).toBe('1250');
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
    expect((screen.getByLabelText(/Трейлинг от максимума/) as HTMLInputElement).value).toBe('40');
  });

  it('не пропускает некорректный капитал и выход', () => {
    state.publicData = data({ viewer: { isAdmin: true }, wallet }); render(<SettingsPage />);
    fireEvent.change(screen.getByLabelText('PAPER-капитал, USD'), { target: { value: '-10' } });
    expect((screen.getByRole('button', { name: 'Далее' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('PAPER-капитал, USD'), { target: { value: '1000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
    fireEvent.click(screen.getByRole('radio', { name: /Лестница/ }));
    fireEvent.change(screen.getByLabelText(/Стоп от входа/), { target: { value: '100' } });
    expect((screen.getByRole('button', { name: 'Далее' }) as HTMLButtonElement).disabled).toBe(true);
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('скрытые правки другого режима не попадают в итог или запрос', async () => {
    state.publicData = data({ viewer: { isAdmin: true }, wallet }); render(<SettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
    fireEvent.click(screen.getByRole('radio', { name: /Трейлинг/ }));
    fireEvent.change(screen.getByLabelText(/Трейлинг от максимума/), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('radio', { name: /Цель 2×/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
    expect(screen.queryByText(/Трейлинг −40/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Применить' }));
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse((apiMock.mock.calls[0] as any)[1].body)).not.toHaveProperty('exitOverrides');
  });
});

describe('карточки правил выхода', () => {
  const adminState = () => {
    state.publicData = data({ viewer: { isAdmin: true }, wallet });
    state.adminData = { comparison: [] };
  };
  const toExitStep = () => { render(<SettingsPage />); fireEvent.click(screen.getByRole('button', { name: 'Далее' })); };

  it('у каждой карточки есть сцена, посчитанная ядром, и её итог назван словами', () => {
    adminState(); toExitStep();
    const scenes = screen.getAllByRole('img', { name: /На общей траектории/ });
    expect(scenes).toHaveLength(5);
    expect(screen.getByRole('img', { name: /Лестница: .*40% на 1\.62×, 30% на 2\.02×, остаток закрыт на 1\.77× — трейлинг/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: /Цель 2×: .*остаток закрыт на 2\.02× — выход по цели/ })).toBeTruthy();
  });

  it('демонстрация идёт только у выбранной карточки; повтор — отдельной кнопкой', () => {
    adminState(); toExitStep();
    fireEvent.click(screen.getByRole('radio', { name: /Лестница/ }));
    const playing = document.querySelectorAll('.agent-scene[data-play="demo"]');
    expect(playing).toHaveLength(1);
    expect(playing[0]!.closest('[data-exit-card]')?.getAttribute('data-exit-card')).toBe('LADDER');
    expect(document.querySelectorAll('.agent-scene[data-play="static"]')).toHaveLength(4);
    const replay = screen.getByRole('button', { name: /Повторить показ/ });
    expect(replay.closest('[data-exit-card]')?.getAttribute('data-exit-card')).toBe('LADDER');
    fireEvent.click(replay);
    expect(screen.getByRole('radio', { name: /Лестница/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('при prefers-reduced-motion показывается статичный итог без кнопки повтора', () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: /reduce/.test(query), media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
    try {
      adminState(); toExitStep();
      fireEvent.click(screen.getByRole('radio', { name: /Трейлинг/ }));
      expect(document.querySelectorAll('.agent-scene[data-play="demo"]')).toHaveLength(0);
      expect(screen.queryByRole('button', { name: /Повторить показ/ })).toBeNull();
    } finally { window.matchMedia = original; }
  });

  it('стрелки переключают режим и переносят фокус', () => {
    adminState(); toExitStep();
    const first = screen.getByRole('radio', { name: /Цель 2×/ });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(screen.getByRole('radio', { name: /Защищённый/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(screen.getByRole('radio', { name: /Защищённый/ }), { key: 'ArrowUp' });
    expect(first.getAttribute('aria-checked')).toBe('true');
  });

  it('правки администратора меняют сцену выбранной карточки', () => {
    adminState(); toExitStep();
    fireEvent.click(screen.getByRole('radio', { name: /Защищённый/ }));
    fireEvent.change(screen.getByLabelText(/Стоп от входа/), { target: { value: '10' } });
    expect(screen.getByRole('img', { name: /Защищённый: .*закрыт на 0\.8\d× — стоп-лосс/ })).toBeTruthy();
  });
});


describe('финальная проверка карточек', () => {
  const openModes = () => {
    state.publicData = data({ viewer: { isAdmin: true }, wallet });
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
  };

  it('выбранная карточка начинает демонстрацию только при появлении на экране', () => {
    const observers: Array<{ callback: IntersectionObserverCallback; node?: Element }> = [];
    vi.stubGlobal('IntersectionObserver', class {
      record: typeof observers[number];
      constructor(callback: IntersectionObserverCallback) { this.record = { callback }; observers.push(this.record); }
      observe(node: Element) { this.record.node = node; }
      disconnect() {}
    });
    try {
      openModes();
      expect(document.querySelectorAll('[data-play="demo"]')).toHaveLength(0);
      const selected = observers.find((observer) => observer.node?.getAttribute('data-selected') === 'true')!;
      act(() => selected.callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
      expect(selected.node?.querySelector('[data-play="demo"]')).toBeTruthy();
      expect(document.querySelectorAll('[data-play="demo"]')).toHaveLength(1);
    } finally { vi.unstubAllGlobals(); }
  });

  it('изменение системной настройки отключает движение и повтор без перезагрузки', () => {
    const original = window.matchMedia;
    const listeners: Array<() => void> = [];
    const media = { matches: false, addEventListener: (_: string, callback: () => void) => { listeners.push(callback); }, removeEventListener() {} };
    window.matchMedia = (() => media) as unknown as typeof window.matchMedia;
    try {
      openModes();
      act(() => { media.matches = true; listeners.forEach((listener) => listener()); });
      fireEvent.click(screen.getByRole('radio', { name: /Чистый трейлинг/ }));
      expect(document.querySelectorAll('[data-play="demo"]')).toHaveLength(0);
      expect(screen.queryByRole('button', { name: /Повторить показ/ })).toBeNull();
    } finally { window.matchMedia = original; }
  });

  it('чистый трейлинг подтверждается как защита с входа и отправляется в API', async () => {
    openModes();
    fireEvent.click(screen.getByRole('radio', { name: /Чистый трейлинг/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
    const summary = document.querySelector('[data-settings-summary]')!.textContent;
    expect(summary).toContain('Чистый трейлинг: 50% на 2×');
    expect(summary).toContain('трейлинг −50% с момента входа');
    expect(summary).not.toContain('без стопа');
    expect(document.body.textContent).not.toContain('после ступени 0');
    fireEvent.click(screen.getByRole('button', { name: 'Применить' }));
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse((apiMock.mock.calls[0] as any)[1].body)).toMatchObject({ exitMode: 'TRAILING_PURE', confirm: true });
  });
});
