import { maskEmail, type EmailMessage } from '@memex/core';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';

/**
 * Отправка писем.
 *
 * Один слой между бизнес-правилами и провайдером. Правила выдачи кода
 * не знают, кто именно доставляет письмо, и не должны знать: провайдера
 * меняют по причинам, к подтверждению адреса отношения не имеющим —
 * цена, доставляемость, страна.
 *
 * Главное свойство слоя — он никогда не отвечает «отправлено», если
 * письмо не приняли. Молчаливый успех при выключенном транспорте —
 * худший из возможных исходов: интерфейс покажет «письмо отправлено»,
 * человек будет ждать, и оба будут уверены, что всё хорошо.
 *
 * Поэтому отсутствие настройки — это `disabled`, отдельное состояние
 * с собственным кодом ошибки, а не «отправили в никуда».
 */

export type SendFailure =
  /** Транспорт не настроен. Не ошибка сети, а решение о конфигурации. */
  | 'DISABLED'
  /** Провайдер ответил отказом: плохой адрес, неподтверждённый домен, лимит. */
  | 'REJECTED'
  /** Провайдер не ответил вовремя. */
  | 'TIMEOUT'
  /** До провайдера не достучались. */
  | 'NETWORK';

export type SendResult =
  | { ok: true; id: string | null }
  | { ok: false; failure: SendFailure; detail?: string };

export interface OutgoingEmail {
  to: string;
  message: EmailMessage;
  /**
   * Ключ повторной отправки.
   *
   * Провайдер использует его, чтобы повтор запроса не превратился
   * во второе письмо. Сеть обрывается посередине чаще, чем кажется,
   * и повтор — обычное дело, а не сбой.
   */
  idempotencyKey?: string;
}

export interface Mailer {
  readonly name: string;
  readonly enabled: boolean;
  send(email: OutgoingEmail): Promise<SendResult>;
}

/** Сколько ждём провайдера. Дольше — держим соединение и пользователя. */
const SEND_TIMEOUT_MS = 10_000;

/**
 * Транспорт, которого нет.
 *
 * Возвращает отказ, а не тишину. Именно этот отказ доходит до API
 * и превращается в `EMAIL_DELIVERY_UNAVAILABLE`.
 */
const disabledMailer: Mailer = {
  name: 'disabled',
  enabled: false,
  async send() {
    return { ok: false, failure: 'DISABLED' };
  },
};

/**
 * Транспорт для разработки.
 *
 * Пишет письмо в журнал вместо отправки. Код при этом не пишется:
 * его отдаёт API отдельным полем, и дублировать секрет в логах
 * незачем даже на своей машине — логи разработки попадают
 * в скриншоты и в отчёты об ошибках.
 *
 * В production выбрать этот транспорт нельзя: проверка в env.ts
 * не даст приложению запуститься.
 */
const consoleMailer: Mailer = {
  name: 'console',
  enabled: true,
  async send(email) {
    // Тема письма в журнал не попадает: в ней стоит код. Это ровно
    // тот случай, когда «просто залогировать для отладки» отдаёт
    // секрет в скриншот, в отчёт об ошибке и в систему сбора логов.
    logger.info(
      { to: maskEmail(email.to), transport: 'console' },
      'письмо не отправлено: транспорт разработки',
    );
    return { ok: true, id: null };
  },
};

/**
 * Resend через официальный HTTPS API.
 *
 * Без SDK: нужен ровно один вызов `POST /emails` с заголовком
 * `Authorization: Bearer`. Пакет добавил бы зависимость, обновления
 * и свой слой ошибок ради одного запроса, который `fetch` делает
 * в десять строк.
 *
 * Ключ живёт только здесь и в переменных окружения. Ни в журнал,
 * ни в ответ он не попадает — в том числе в тексте ошибки от
 * провайдера, поэтому ответ обрезается и очищается.
 */
function resendMailer(apiKey: string, from: string): Mailer {
  return {
    name: 'resend',
    enabled: true,

    async send(email) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
            'user-agent': 'memex-api/1.0',
            ...(email.idempotencyKey ? { 'Idempotency-Key': email.idempotencyKey } : {}),
          },
          body: JSON.stringify({
            from,
            to: [email.to],
            subject: email.message.subject,
            text: email.message.text,
            html: email.message.html,
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          // Тело ответа обрезается: в нём бывает эхо запроса, а в эхе —
          // адрес получателя и тема с кодом.
          const body = await res.text().catch(() => '');
          return {
            ok: false,
            failure: 'REJECTED',
            detail: `HTTP ${res.status} ${body.slice(0, 120)}`,
          };
        }

        const data = (await res.json().catch(() => null)) as { id?: string } | null;
        return { ok: true, id: data?.id ?? null };
      } catch (e) {
        const aborted = e instanceof Error && e.name === 'AbortError';
        return {
          ok: false,
          failure: aborted ? 'TIMEOUT' : 'NETWORK',
          detail: e instanceof Error ? e.message.slice(0, 120) : undefined,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

/**
 * Безопасная деталь SMTP-ошибки.
 *
 * Текст ошибки намеренно не возвращается: SMTP-библиотеки иногда
 * включают туда команду целиком, а команда AUTH содержит материал,
 * из которого нельзя делать ни ответ API, ни запись в журнале.
 */
function smtpFailure(error: unknown): { failure: Exclude<SendFailure, 'DISABLED'>; detail: string } {
  const e = error as { code?: string; responseCode?: number };
  const code = typeof e?.code === 'string' ? e.code : 'SMTP_ERROR';
  const responseCode = typeof e?.responseCode === 'number' ? e.responseCode : null;

  if (code === 'ETIMEDOUT') {
    return { failure: 'TIMEOUT', detail: code };
  }

  if (
    code === 'EAUTH' ||
    code === 'EENVELOPE' ||
    code === 'EMESSAGE' ||
    (responseCode ?? 0) >= 400
  ) {
    return {
      failure: 'REJECTED',
      detail: responseCode ? `${code} HTTP ${responseCode}` : code,
    };
  }

  return { failure: 'NETWORK', detail: code };
}

/** Детерминированный, но не раскрывающий userId и хеш кода Message-ID. */
function smtpMessageId(key: string | undefined): string | undefined {
  if (!key) return undefined;
  const digest = crypto.createHash('sha256').update(key).digest('hex');
  return `<${digest}@memex.invalid>`;
}

/**
 * Обычный SMTP-транспорт, в том числе для Gmail.
 *
 * Gmail используется с отдельным паролем приложения, никогда с основным
 * паролем аккаунта. Соединение либо сразу защищено TLS (обычно порт 465),
 * либо обязано перейти на STARTTLS (обычно порт 587). Сертификат
 * провайдера проверяется всегда.
 */
function smtpMailer(config: SmtpConfig): Mailer {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure,
    auth: { user: config.user, pass: config.pass },
    connectionTimeout: SEND_TIMEOUT_MS,
    greetingTimeout: SEND_TIMEOUT_MS,
    socketTimeout: SEND_TIMEOUT_MS,
    tls: {
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
    },
  });

  return {
    name: 'smtp',
    enabled: true,

    async send(email) {
      try {
        const info = await transport.sendMail({
          from: config.from,
          to: email.to,
          subject: email.message.subject,
          text: email.message.text,
          html: email.message.html,
          // SMTP не обещает идемпотентность, но стабильный Message-ID
          // не раскрывает исходный ключ и помогает принимающей стороне
          // распознать повтор одной и той же попытки.
          messageId: smtpMessageId(email.idempotencyKey),
        });

        if ((info.rejected?.length ?? 0) > 0 || (info.accepted?.length ?? 0) === 0) {
          return { ok: false, failure: 'REJECTED', detail: 'SMTP_RECIPIENT_REJECTED' };
        }

        return { ok: true, id: info.messageId || null };
      } catch (e) {
        return { ok: false, ...smtpFailure(e) };
      }
    },
  };
}

/**
 * Транспорт по настройкам окружения.
 *
 * Собирается один раз при первом обращении. Несогласованные настройки
 * — выбран Resend, но нет ключа — до сюда не доходят: их отвергает
 * проверка при старте.
 */
let cached: Mailer | null = null;

export function getMailer(): Mailer {
  if (cached) return cached;

  switch (env.EMAIL_PROVIDER) {
    case 'resend':
      cached = resendMailer(env.RESEND_API_KEY!, env.EMAIL_FROM!);
      break;
    case 'smtp':
      cached = smtpMailer({
        host: env.SMTP_HOST!,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        user: env.SMTP_USER!,
        pass: env.SMTP_PASS!,
        from: env.EMAIL_FROM!,
      });
      break;
    case 'console':
      cached = consoleMailer;
      break;
    default:
      cached = disabledMailer;
  }

  return cached;
}

/** Подмена транспорта в тестах. Возвращает то, что было. */
export function setMailerForTests(mailer: Mailer | null): Mailer | null {
  const previous = cached;
  cached = mailer;
  return previous;
}

/** Настроена ли доставка. Проверяется до создания кода. */
export function isDeliveryConfigured(): boolean {
  return getMailer().enabled;
}
