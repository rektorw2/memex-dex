/**
 * Проверка самой проверки источника сигналов.
 *
 * Транспорт подделан целиком, поэтому здесь воспроизводимы все
 * ступени: ключей нет, подпись отклонена, сеть не в списке, канал
 * требует whitelist, сигнал пришёл и агент принял решение. Отдельно —
 * что вывод не содержит секретов.
 */
import { describe, expect, it } from 'vitest';
import { OKX_SIGNAL_CHANNEL, type OkxSignal } from '@memex/core';
import { runSignalPreflight } from './signal-preflight.js';
import { SMOKE_EXIT } from './exit-codes.js';
import type { SocketLike } from '../services/okx-ws-client.js';

class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed = false;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; }
  open() { this.onopen?.(); }
  deliver(obj: unknown) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}

function harness(script: (socket: FakeSocket, tick: number) => void) {
  const sockets: FakeSocket[] = [];
  let clock = 0;
  let tick = 0;
  return {
    sockets,
    factory: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    now: () => clock,
    wait: async (ms: number) => { clock += ms; tick += 1; const current = sockets[sockets.length - 1]; if (current) script(current, tick); },
  };
}

const CHAINS = [
  { chainIndex: '501', chainName: 'Solana' },
  { chainIndex: '56', chainName: 'BNB Chain' },
  { chainIndex: '1', chainName: 'Ethereum' },
];

const signal = (over: Partial<OkxSignal> = {}): OkxSignal => ({
  providerKey: 'okx-signal:1', chain: 'SOLANA', address: 'Mint', symbol: 'GEM', name: 'Gem', logoUrl: null,
  signaledAt: new Date(0), priceUsd: 0.5, marketCapUsd: 1e6, holders: 10, top10HolderPct: 20,
  walletTypes: ['smart_money'], triggerWalletAddresses: ['w1'], triggerWalletCount: 1, amountUsd: 5_000, soldRatioPct: null, ...over,
});

const wsSignalMessage = { arg: { channel: OKX_SIGNAL_CHANNEL, chainIndex: '501' }, data: [{ chainIndex: '501', tokenAddress: 'MintWS', symbol: 'WSG', timestamp: '1700000000000', walletType: '1', amountUsd: '7000', triggerWalletCount: '2', price: '0.4' }] };

function happy(s: FakeSocket, tick: number) {
  if (tick === 1) s.open();
  if (tick === 2) s.deliver({ event: 'login', code: '0' });
  if (tick === 3) s.deliver({ event: 'subscribe', arg: { channel: OKX_SIGNAL_CHANNEL }, connId: 'x' });
  if (tick === 5) s.deliver(wsSignalMessage);
}

function base(h: ReturnType<typeof harness>, over: Record<string, unknown> = {}) {
  return {
    configured: true, wsEnabled: true, observeMs: 1_000, connectTimeoutMs: 5_000,
    fetchSupportedChains: async () => CHAINS,
    fetchLatestSignals: async (chain: string) => (chain === 'SOLANA' ? [signal()] : []),
    factory: h.factory, now: h.now, wait: h.wait,
    ...over,
  } as never;
}

describe('ступени проверки источника сигналов', () => {
  it('без ключей — код настройки, в сеть не идёт', async () => {
    const h = harness(happy);
    const r = await runSignalPreflight(base(h, { configured: false }));
    expect(r.code).toBe(SMOKE_EXIT.config);
    expect(h.sockets).toHaveLength(0);
  });

  it('отклонённая подпись REST — код ключей, WebSocket не открывается', async () => {
    const h = harness(happy);
    const r = await runSignalPreflight(base(h, { fetchSupportedChains: async () => { throw Object.assign(new Error('x'), { code: 'auth' }); } }));
    expect(r.code).toBe(SMOKE_EXIT.auth);
    expect(r.stages.restAuth).toBe(false);
    expect(h.sockets).toHaveLength(0);
  });

  it('называет поддержку каждой сети агента по списку OKX, а не по ключу', async () => {
    const h = harness(happy);
    const r = await runSignalPreflight(base(h));
    expect(r.stages.chains.map((c) => [c.chain, c.supportedByOkx])).toEqual([['SOLANA', true], ['BNB', true], ['ROBINHOOD', false]]);
    expect(r.lines.some((line) => /ROBINHOOD: chainIndex 4663 отсутствует в списке Signal API/.test(line))).toBe(true);
  });

  it('ни одной поддержанной сети — код контракта', async () => {
    const h = harness(happy);
    const r = await runSignalPreflight(base(h, { fetchSupportedChains: async () => [{ chainIndex: '1', chainName: 'Ethereum' }] }));
    expect(r.code).toBe(SMOKE_EXIT.contract);
    expect(h.sockets).toHaveLength(0);
  });

  it('канал сигналов отклонён 60029 — код whitelist, решение считается по REST-сигналу', async () => {
    const h = harness((s, tick) => {
      if (tick === 1) s.open();
      if (tick === 2) s.deliver({ event: 'login', code: '0' });
      if (tick === 3) s.deliver({ event: 'error', code: '60029', msg: 'Only users who are in the whitelist are allowed to subscribe to this channel', arg: { channel: OKX_SIGNAL_CHANNEL } });
    });
    const r = await runSignalPreflight(base(h));
    expect(r.code).toBe(SMOKE_EXIT.channelDenied);
    expect(r.stages.wsLogin).toBe(true);
    expect(r.stages.wsDeniedCode).toBe('60029');
    expect(r.stages.firstSignalVia).toBe('rest');
    expect(r.stages.decisionCode).toBeTruthy();
    expect(r.status).toBe('error');
    expect(r.lines.some((line) => line.includes('whitelist'))).toBe(true);
    expect(r.cleanedUp).toBe(true);
  });

  it('полная цепочка: вход → подписка → сигнал по WebSocket → решение агента', async () => {
    const h = harness(happy);
    const r = await runSignalPreflight(base(h, { observeMs: 2_000 }));
    expect(r.code).toBe(SMOKE_EXIT.ok);
    expect(r.status).toBe('complete');
    expect(r.gaps).toEqual([]);
    expect(r.stages).toMatchObject({ config: true, restAuth: true, wsLogin: true, wsSubscribed: true, firstSignalVia: 'websocket' });
    expect(r.stages.decisionCode).toBeTruthy();
    expect(r.lines.some((line) => /7\. Локальный расчёт решения/.test(line))).toBe(true);
    expect(r.cleanedUp).toBe(true);
    // Подписка ушла на обе поддержанные сети, и только на них.
    const subscribe = h.sockets[0]!.sent.map((s) => JSON.parse(s)).find((m) => m.op === 'subscribe');
    expect(subscribe.args.map((a: any) => a.chainIndex).sort()).toEqual(['501', '56']);
  });

  it('нет сигналов ни по REST, ни по WebSocket — «неполно», а не успех', async () => {
    const h = harness((s, tick) => {
      if (tick === 1) s.open();
      if (tick === 2) s.deliver({ event: 'login', code: '0' });
      if (tick === 3) s.deliver({ event: 'subscribe', arg: { channel: OKX_SIGNAL_CHANNEL }, connId: 'x' });
      // Спокойный рынок: сигналов не приходит.
    });
    const r = await runSignalPreflight(base(h, { fetchLatestSignals: async () => [], observeMs: 500 }));
    expect(r.code).toBe(SMOKE_EXIT.incomplete);
    expect(r.status).toBe('incomplete');
    expect(r.stages).toMatchObject({ wsSubscribed: true, firstSignalVia: null, decisionCode: null });
    expect(r.gaps.join('\n')).toMatch(/не пришло ни одного сигнала/);
    expect(r.gaps.join('\n')).toMatch(/решение не проверено/);
  });

  it('WebSocket выключен, REST дал сигнал — решение посчитано, но проверка неполная', async () => {
    const h = harness(happy);
    const r = await runSignalPreflight(base(h, { wsEnabled: false }));
    expect(r.status).toBe('incomplete');
    expect(r.code).toBe(SMOKE_EXIT.incomplete);
    expect(r.stages.decisionCode).toBeTruthy();
    expect(r.gaps.some((gap) => gap.includes('WebSocket выключен'))).toBe(true);
  });

  it('вход принят, подтверждения подписки нет до таймаута — подписка НЕ считается подтверждённой', async () => {
    const h = harness((s, tick) => {
      if (tick === 1) s.open();
      if (tick === 2) s.deliver({ event: 'login', code: '0' });
      // подтверждения subscribe не будет
    });
    const r = await runSignalPreflight(base(h, { connectTimeoutMs: 1_000 }));
    expect(r.stages.wsLogin).toBe(true);
    expect(r.stages.wsSubscribed).toBe(false);
    expect(r.status).toBe('incomplete');
    expect(r.gaps.some((gap) => gap.includes('подтверждение подписки'))).toBe(true);
    expect(r.cleanedUp).toBe(true);
  });

  it('вывод не содержит секретов', async () => {
    const h = harness(happy);
    const r = await runSignalPreflight(base(h));
    const text = r.lines.join('\n');
    for (const secret of ['OK-ACCESS-SIGN', 'passphrase', 'apiKey', 'sign"']) expect(text).not.toContain(secret);
  });
});
