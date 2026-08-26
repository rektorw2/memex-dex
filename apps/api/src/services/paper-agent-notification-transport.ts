import { env } from '../lib/env.js';

const TELEGRAM_API = 'https://api.telegram.org';

export interface AgentNotificationTransportResult {
  ok: boolean;
  retryable: boolean;
  ambiguous: boolean;
  errorCode: string | null;
}

export interface AgentNotificationTransport {
  readonly kind: 'disabled' | 'telegram';
  send(text: string): Promise<AgentNotificationTransportResult>;
}

export class DisabledAgentNotificationTransport implements AgentNotificationTransport {
  readonly kind = 'disabled' as const;
  async send(): Promise<AgentNotificationTransportResult> {
    return { ok: false, retryable: false, ambiguous: false, errorCode: 'TELEGRAM_DISABLED' };
  }
}

export class TelegramAgentNotificationTransport implements AgentNotificationTransport {
  readonly kind = 'telegram' as const;

  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly request: typeof fetch = fetch,
  ) {}

  async send(text: string): Promise<AgentNotificationTransportResult> {
    try {
      const response = await this.request(`${TELEGRAM_API}/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (response.ok) {
        return { ok: true, retryable: false, ambiguous: false, errorCode: null };
      }

      const code = `TELEGRAM_HTTP_${response.status}`;
      return {
        ok: false,
        retryable: response.status === 429 || response.status >= 500,
        ambiguous: false,
        errorCode: code,
      };
    } catch {
      // После сетевого обрыва неизвестно, принял ли Telegram запрос.
      // Автоповтор мог бы создать дубль, поэтому решение оставляется админу.
      return {
        ok: false,
        retryable: false,
        ambiguous: true,
        errorCode: 'TELEGRAM_DELIVERY_AMBIGUOUS',
      };
    }
  }
}

export function createAgentNotificationTransport(): AgentNotificationTransport {
  if (!env.TELEGRAM_AGENT_NOTIFICATIONS_ENABLED) {
    return new DisabledAgentNotificationTransport();
  }
  return new TelegramAgentNotificationTransport(
    env.TELEGRAM_BOT_TOKEN!,
    env.TELEGRAM_AGENT_CHAT_ID!,
  );
}

export function escapeTelegramHtml(value: unknown): string {
  return String(value ?? '—')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function formatPaperAgentTelegram(eventType: string, payload: Record<string, unknown>): string {
  const p = (key: string) => escapeTelegramHtml(payload[key]);
  const headline: Record<string, string> = {
    PAPER_BUY: 'PAPER BUY',
    PAPER_SELL: 'PAPER SELL',
    TRADE_RESULT: 'PAPER RESULT',
    CRITICAL_ERROR: 'PAPER ERROR',
    OKX_WS_LOST: 'PAPER · OKX WS LOST',
    OKX_WS_RESTORED: 'PAPER · OKX WS RESTORED',
  };

  const lines = [`<b>${headline[eventType] ?? 'PAPER EVENT'}</b>`];
  if (payload.symbol != null) lines.push(`<b>${p('symbol')}</b> · ${p('network')}`);
  if (payload.strategyLabel != null) lines.push(`Strategy: ${p('strategyLabel')}`);
  if (payload.allocationMode != null) {
    lines.push(
      `Capital: ${p('allocationMode')}${payload.riskProfile != null ? ` · ${p('riskProfile')}` : ''}${payload.shadow === true ? ' · SHADOW' : ''}`,
    );
  }
  if (payload.allocatedUsd != null) {
    lines.push(`Allocation: $${p('allocatedUsd')} (${p('capitalPct')}% capital)`);
  }
  if (payload.reserveAfterUsd != null || payload.exposureAfterUsd != null) {
    lines.push(
      `After: free $${p('freeAfterUsd')} · reserve $${p('reserveAfterUsd')} · exposure $${p('exposureAfterUsd')}`,
    );
  }
  if (payload.signalScore != null) {
    lines.push(`Signal: ${p('signalScore')} · ${p('signalBand')} · ${p('allocationReason')}`);
  }
  if (payload.address != null) lines.push(`<code>${p('address')}</code>`);
  if (payload.entryExecutionPriceUsd != null) lines.push(`Entry: $${p('entryExecutionPriceUsd')}`);
  if (payload.exitExecutionPriceUsd != null) lines.push(`Exit: $${p('exitExecutionPriceUsd')}`);
  if (payload.pnlUsd != null) lines.push(`Net PnL: $${p('pnlUsd')} (${p('pnlPct')}%)`);
  if (payload.totalCostsUsd != null) lines.push(`Costs: $${p('totalCostsUsd')}`);
  if (payload.errorCode != null) lines.push(`Code: <code>${p('errorCode')}</code>`);
  return lines.join('\n');
}
