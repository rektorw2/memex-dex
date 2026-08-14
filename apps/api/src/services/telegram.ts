import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';

/**
 * Отправка уведомлений в Telegram.
 *
 * Бот только шлёт сообщения и не принимает команд, кроме привязки чата.
 * Это сознательное ограничение: бот, умеющий торговать, — отдельная
 * поверхность атаки, где перехват чата означает доступ к деньгам.
 */

const API = 'https://api.telegram.org';

export function isTelegramConfigured(): boolean {
  return Boolean(env.TELEGRAM_BOT_TOKEN);
}

/** Экранирование для parse_mode=HTML: тикеры мем-коинов содержат что угодно. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function sendTelegram(chatId: string, html: string): Promise<boolean> {
  if (!isTelegramConfigured()) return false;

  try {
    const res = await fetch(`${API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: html,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.debug({ chatId, status: res.status, body: body.slice(0, 200) },
        'Telegram: сообщение не доставлено');
      return false;
    }
    return true;
  } catch (e: any) {
    logger.debug({ chatId, err: e?.message }, 'Telegram недоступен');
    return false;
  }
}

/**
 * Разбор обновлений бота для привязки чата.
 *
 * Пользователь получает код в интерфейсе и отправляет его боту.
 * Обратный порядок (бот присылает код на сайт) потребовал бы webhook
 * с публичным адресом, что на бесплатном хостинге со сном работает плохо.
 */
export async function pollTelegramUpdates(offset: number): Promise<
  Array<{ updateId: number; chatId: string; text: string }>
> {
  if (!isTelegramConfigured()) return [];

  try {
    const res = await fetch(
      `${API}/bot${env.TELEGRAM_BOT_TOKEN}/getUpdates?offset=${offset}&timeout=0&limit=50`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) return [];

    const json: any = await res.json();
    if (!json.ok || !Array.isArray(json.result)) return [];

    return json.result
      .filter((u: any) => u?.message?.chat?.id && typeof u.message.text === 'string')
      .map((u: any) => ({
        updateId: u.update_id,
        chatId: String(u.message.chat.id),
        text: String(u.message.text).trim(),
      }));
  } catch {
    return [];
  }
}
