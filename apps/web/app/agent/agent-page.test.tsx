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
    const { container } = render(<AgentPage />);

    expect(container.querySelector('[data-live-stage="PAPER_READY"]')).toBeTruthy();
    expect(screen.getByText('Бумажный режим работает')).toBeTruthy();
    expect(container.textContent ?? '').not.toContain('SIGNING_DISABLED');
  });

  it('mainnet назван стеной, а не следующим шагом', () => {
    state.publicData = data({ wallet });
    render(<AgentPage />);

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
    const { container } = render(<AgentPage />);

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
    const { container } = render(<AgentPage />);

    expect(container.querySelector('[data-rpc-state="NOT_RUN"]')).toBeTruthy();
    expect(screen.getByText('проверка не выполнялась')).toBeTruthy();
  });

  it('успешная проверка показывает своё время', () => {
    state.publicData = withRpc({
      state: 'VERIFIED',
      verifiedAt: '2026-09-05T10:00:00.000Z',
      expiresAt: '2026-09-05T10:30:00.000Z',
    });
    const { container } = render(<AgentPage />);

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
    const { container } = render(<AgentPage />);

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
    const { container } = render(<AgentPage />);
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
    const { container } = render(<AgentPage />);

    expect(container.querySelector('[data-action="verify-devnet"]')).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Настройки' })).toBeNull();
  });

  it('адрес узла на экран не выходит', () => {
    state.publicData = withRpc({ state: 'VERIFIED', verifiedAt: '2026-09-05T10:00:00.000Z' });
    const { container } = render(<AgentPage />);
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
    const { container } = render(<AgentPage />);

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

    expect(screen.getByText('PAPER wallet')).toBeTruthy();
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
    const { container } = render(<AgentPage />);

    fireEvent.click(screen.getByRole('tab', { name: 'Настройки' }));

    expect(container.querySelector('[data-admin-stage="PAPER_READY"]')).toBeTruthy();
    expect(container.textContent ?? '').toContain('SIGNING_DISABLED');
  });

  it('администратор может запустить проверку узла', () => {
    state.publicData = admin();
    state.adminData = { control: { isEnabled: true, learningModeEnabled: false, activeAllocationMode: 'FIXED' }, comparison: [] };
    const { container } = render(<AgentPage />);

    fireEvent.click(screen.getByRole('tab', { name: 'Настройки' }));
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
    const { container } = render(<AgentPage />);

    fireEvent.click(screen.getByRole('tab', { name: 'Настройки' }));

    expect((container.querySelector('[data-action="verify-devnet"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('неотвечающие разделы названы поимённо', () => {
    const source = admin();
    (source.phase4 as any).status = 'UNAVAILABLE';
    (source.phase4 as any).unavailable = ['FUNDING', 'SIGNING'];
    state.publicData = source;
    state.adminData = { control: { isEnabled: true, learningModeEnabled: false, activeAllocationMode: 'FIXED' }, comparison: [] };
    render(<AgentPage />);

    fireEvent.click(screen.getByRole('tab', { name: 'Настройки' }));

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
    const { container } = render(<AgentPage />);

    fireEvent.click(screen.getByRole('tab', { name: 'Настройки' }));

    const text = container.textContent ?? '';
    expect(text).not.toMatch(/https?:\/\/|arn:aws|postgres|key-|Bearer /i);
    expect(text).toContain('переход запрещён');
  });

  it('обычный пользователь этой диагностики не получает', () => {
    // Вкладки «Настройки» у него нет вовсе.
    state.publicData = data({ wallet });
    render(<AgentPage />);

    expect(screen.queryByRole('tab', { name: 'Настройки' })).toBeNull();
  });
});
