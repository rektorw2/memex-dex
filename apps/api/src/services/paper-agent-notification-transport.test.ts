import { describe, expect, it, vi } from 'vitest';
import {
  TelegramAgentNotificationTransport,
  escapeTelegramHtml,
  formatPaperAgentTelegram,
} from './paper-agent-notification-transport.js';

describe('Telegram transport paper-агента', () => {
  it('отправляет через официальный Bot API и никогда не помещает секрет в тело', async () => {
    const request = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response('{}', { status: 200 }));
    const transport = new TelegramAgentNotificationTransport('bot-secret', 'chat-secret', request as never);
    await expect(transport.send('PAPER BUY')).resolves.toEqual({
      ok: true, retryable: false, ambiguous: false, errorCode: null,
    });
    const [url, init] = request.mock.calls[0]!;
    expect(String(url)).toBe('https://api.telegram.org/botbot-secret/sendMessage');
    expect(String(init?.body)).toContain('PAPER BUY');
    expect(String(init?.body)).not.toContain('bot-secret');
  });

  it.each([
    [429, true], [500, true], [400, false],
  ])('классифицирует HTTP %s без текста ответа', async (status, retryable) => {
    const request = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response('provider detail', { status }));
    const result = await new TelegramAgentNotificationTransport('token', 'chat', request as never).send('PAPER');
    expect(result).toMatchObject({ ok: false, retryable, ambiguous: false, errorCode: `TELEGRAM_HTTP_${status}` });
  });

  it('сетевой обрыв помечает неоднозначным и не повторяет автоматически', async () => {
    const request = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      throw new Error('network with secret');
    });
    await expect(new TelegramAgentNotificationTransport('token', 'chat', request as never).send('PAPER'))
      .resolves.toEqual({ ok: false, retryable: false, ambiguous: true, errorCode: 'TELEGRAM_DELIVERY_AMBIGUOUS' });
  });

  it('формат всегда начинается с PAPER и экранирует данные провайдера', () => {
    const text = formatPaperAgentTelegram('PAPER_BUY', {
      symbol: '<SCAM>', network: 'Solana', address: 'a&b', strategyLabel: 'baseline',
    });
    expect(text).toMatch(/^<b>PAPER/);
    expect(text).toContain('&lt;SCAM&gt;');
    expect(text).toContain('a&amp;b');
    expect(escapeTelegramHtml('"<&')).toBe('"&lt;&amp;');
  });

  it('Phase 3 показывает режим, сумму, резерв и экспозицию после решения', () => {
    const text = formatPaperAgentTelegram('PAPER_BUY', {
      symbol: 'GEM', network: 'Solana', allocationMode: 'AUTOPILOT',
      riskProfile: 'BALANCED', allocatedUsd: '15', capitalPct: 15,
      freeAfterUsd: '55', reserveAfterUsd: '30', exposureAfterUsd: '15',
      signalScore: 72, signalBand: 'STRONG', allocationReason: 'AUTOPILOT_STRONG_POSITION',
    });
    expect(text).toContain('Capital: AUTOPILOT · BALANCED');
    expect(text).toContain('Allocation: $15 (15% capital)');
    expect(text).toContain('After: free $55 · reserve $30 · exposure $15');
    expect(text).toContain('Signal: 72 · STRONG · AUTOPILOT_STRONG_POSITION');
  });
});
