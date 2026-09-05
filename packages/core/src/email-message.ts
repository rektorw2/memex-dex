import { CODE_TTL_MS } from './email-verification.js';

/**
 * Тексты писем.
 *
 * Здесь нет ни провайдера, ни ключей, ни сети — только то, что человек
 * увидит в почте. Отделено от отправки намеренно: текст письма меняют
 * часто и по другим причинам, чем транспорт, и смешивать их значит
 * править письмо в файле, где рядом лежит ключ доступа.
 *
 * Правила у письма с кодом простые и все — про доверие.
 *
 * Ничего лишнего. Ни предложений, ни ссылок на разделы, ни «а ещё
 * у нас есть». Письмо с кодом читают три секунды, и всё, что не код,
 * мешает его найти.
 *
 * Ссылок для входа нет вовсе. Письмо с кодом — ровно то место, куда
 * заглядывает чужой человек, получивший чужой ящик; ссылка, которая
 * что-то делает по нажатию, превратила бы его в дверь.
 *
 * И обязательная строка о том, что делать, если письмо не запрашивали.
 * Человек, получивший код без запроса, должен понимать: кто-то ввёл
 * его адрес, и достаточно письмо проигнорировать.
 */

export interface EmailMessage {
  subject: string;
  text: string;
  html: string;
}

export interface VerificationEmailInput {
  code: string;
  /** Публичное имя продукта. Попадает в тему письма. */
  productName: string;
  /** Срок действия кода. По умолчанию — тот же, что у правил проверки. */
  ttlMs?: number;
}

/** Срок жизни словами: «15 минут». */
function ttlLabel(ms: number): string {
  const minutes = Math.round(ms / 60_000);

  // Русские окончания: 1 минута, 2 минуты, 15 минут.
  const mod10 = minutes % 10;
  const mod100 = minutes % 100;

  if (mod10 === 1 && mod100 !== 11) return `${minutes} минуту`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${minutes} минуты`;

  return `${minutes} минут`;
}

/**
 * Экранирование для вставки в HTML.
 *
 * Код состоит из цифр и экранировать его незачем, но имя продукта
 * приходит из настроек, а настройки правят люди. Одна угловая скобка
 * в названии — и письмо приезжает сломанным; в худшем случае
 * с чужой разметкой внутри.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Письмо с кодом подтверждения. */
export function verificationEmail(input: VerificationEmailInput): EmailMessage {
  const ttl = ttlLabel(input.ttlMs ?? CODE_TTL_MS);
  const product = input.productName;

  /*
   * Кода в теме нет.
   *
   * Тема письма показывается на заблокированном экране, в списке
   * входящих и в предпросмотре на чужом мониторе — везде, где
   * человек кода не показывал. Удобство «увидеть код, не открывая
   * письмо» здесь оплачивается тем, что его увидит и любой, кто
   * стоит рядом.
   *
   * Раньше код в теме был. Нашлось это сквозным тестом почты.
   */
  const subject = `${product}: подтверждение адреса`;

  const text = [
    `Код подтверждения: ${input.code}`,
    '',
    `Введите его на странице подтверждения адреса. Код действует ${ttl}.`,
    '',
    'Если вы не запрашивали это письмо, просто удалите его.',
    'Никаких действий не требуется, и адрес останется неподтверждённым.',
    '',
    'Мы никогда не спрашиваем код в переписке и по телефону.',
  ].join('\n');

  const html = [
    '<!doctype html>',
    '<html lang="ru"><body style="margin:0;padding:24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;">',
    `<p style="margin:0 0 16px;font-size:15px;">Код подтверждения для ${escapeHtml(product)}:</p>`,
    `<p style="margin:0 0 16px;font-size:32px;font-weight:700;letter-spacing:6px;">${escapeHtml(input.code)}</p>`,
    `<p style="margin:0 0 16px;font-size:14px;color:#555;">Код действует ${escapeHtml(ttl)}.</p>`,
    '<p style="margin:0 0 8px;font-size:14px;color:#555;">Если вы не запрашивали это письмо, просто удалите его — ничего делать не нужно.</p>',
    '<p style="margin:0;font-size:14px;color:#555;">Мы никогда не спрашиваем код в переписке и по телефону.</p>',
    '</body></html>',
  ].join('');

  return { subject, text, html };
}

/**
 * Адрес в виде, пригодном для журнала.
 *
 * Полный адрес в логах — это персональные данные, которые оседают
 * в файлах, в системе сбора логов и в резервных копиях, причём
 * навсегда. Для разбора инцидента достаточно понять, тот ли это
 * человек; для этого хватает первой буквы и домена.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';

  const name = email.slice(0, at);
  const domain = email.slice(at + 1);

  const dot = domain.lastIndexOf('.');
  const tld = dot > 0 ? domain.slice(dot) : '';
  const head = dot > 0 ? domain.slice(0, dot) : domain;

  return `${name[0]}***@${head[0] ?? '*'}***${tld}`;
}
