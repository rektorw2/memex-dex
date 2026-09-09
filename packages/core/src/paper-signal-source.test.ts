import { describe, expect, it } from 'vitest';
import { signalSourceVerdict, type SignalSourceFacts } from './paper-signal-source.js';

const T = 1_000_000_000;
const base = (over: Partial<SignalSourceFacts> = {}): SignalSourceFacts => ({
  configured: true, transportMode: 'WEBSOCKET', socketHealthy: true, channelDeniedCode: null,
  lastRestSuccessAtMs: T - 10_000, lastRestErrorCode: null, restIntervalMs: 60_000, startedAtMs: T - 600_000, nowMs: T, ...over,
});

describe('доступность источника сигналов', () => {
  it('без ключей источника нет', () => {
    expect(signalSourceVerdict(base({ configured: false }))).toMatchObject({ available: false, code: 'OKX_NOT_CONFIGURED' });
  });
  it('живой WebSocket — источник доступен', () => {
    expect(signalSourceVerdict(base())).toMatchObject({ available: true, code: 'OK', transport: 'WEBSOCKET' });
  });
  it('канал отклонён whitelist, но REST отвечает — доступен по REST с причиной', () => {
    const v = signalSourceVerdict(base({ transportMode: 'REST_ONLY', socketHealthy: false, channelDeniedCode: '60029' }));
    expect(v).toMatchObject({ available: true, code: 'OK_REST_ONLY' });
    expect(v.message).toContain('60029');
  });
  it('REST отклонил ключ — входы приостановлены', () => {
    expect(signalSourceVerdict(base({ transportMode: 'REST_ONLY', socketHealthy: false, lastRestErrorCode: 'auth' }))).toMatchObject({ available: false, code: 'REST_AUTH_REJECTED' });
  });
  it('три пропущенных интервала REST без сокета — источник потерян', () => {
    const v = signalSourceVerdict(base({ transportMode: 'WEBSOCKET', socketHealthy: false, lastRestSuccessAtMs: T - 181_000, lastRestErrorCode: 'network' }));
    expect(v).toMatchObject({ available: false, code: 'REST_STALE' });
    expect(v.message).toContain('открытые позиции ведутся');
  });
  it('сразу после старта молчание REST — не отказ', () => {
    expect(signalSourceVerdict(base({ transportMode: 'REST_ONLY', socketHealthy: false, lastRestSuccessAtMs: null, startedAtMs: T - 30_000 }))).toMatchObject({ available: true, code: 'REST_PENDING' });
  });
  it('квота 402 — входы приостановлены сразу, не через три интервала', () => {
    expect(signalSourceVerdict(base({ transportMode: 'REST_ONLY', socketHealthy: false, lastRestErrorCode: 'quota' }))).toMatchObject({ available: false, code: 'REST_QUOTA_EXHAUSTED' });
  });
  it('429 и отказ бюджета — временные: источник жив, пока свежий успех не устарел, потом REST_STALE с причиной', () => {
    expect(signalSourceVerdict(base({ transportMode: 'REST_ONLY', socketHealthy: false, lastRestErrorCode: 'rate-limit:http_429' }))).toMatchObject({ available: true, code: 'OK_REST_ONLY' });
    const stale = signalSourceVerdict(base({ transportMode: 'REST_ONLY', socketHealthy: false, lastRestSuccessAtMs: T - 181_000, lastRestErrorCode: 'budget' }));
    expect(stale).toMatchObject({ available: false, code: 'REST_STALE' });
    expect(stale.message).toContain('бюджета');
  });
  it('после восстановления REST (ошибка снята, успех свежий) источник снова доступен', () => {
    expect(signalSourceVerdict(base({ transportMode: 'REST_ONLY', socketHealthy: false, lastRestSuccessAtMs: T - 1_000, lastRestErrorCode: null }))).toMatchObject({ available: true, code: 'OK_REST_ONLY' });
  });
  it('воркер не запущен — источника нет', () => {
    expect(signalSourceVerdict(base({ transportMode: 'DISABLED', socketHealthy: false, startedAtMs: null }))).toMatchObject({ available: false, code: 'SOURCE_STOPPED' });
  });
});

it('60036 has precise subscription reason; both failures pause entries, REST recovery resumes', () => {
  const facts=base({transportMode:'REST_ONLY',socketHealthy:false,channelDeniedCode:'60036'});
  expect(signalSourceVerdict(facts).message).toContain('Market API subscription');
  expect(signalSourceVerdict({...facts,lastRestErrorCode:'auth'}).available).toBe(false);
  expect(signalSourceVerdict({...facts,lastRestErrorCode:null,lastRestSuccessAtMs:T}).available).toBe(true);
});
