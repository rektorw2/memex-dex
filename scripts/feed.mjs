#!/usr/bin/env node
/**
 * Подача находок в радар из внешнего источника.
 *
 * Скрипт делает одну вещь: берёт текст с адресами токенов и отправляет
 * его в /ingest/tokens. Что считать источником — решаете вы, функция
 * collect() ниже для этого и оставлена пустой.
 *
 * Запуск:
 *   MEMEX_API=https://memex-api.onrender.com/api/v1 \
 *   MEMEX_KEY=mdx_xxxxx \
 *   node scripts/feed.mjs
 *
 * Постоянная работа — обычным cron, отдельный демон не нужен:
 *   ​*​/10 * * * * cd /path/to/memex-dex && node scripts/feed.mjs >> feed.log 2>&1
 *
 * Про источники. Радар и так читает GeckoTerminal — новые пулы, растущие
 * и крупнейшие. Этот скрипт нужен для того, чего система не видит сама:
 * закрытых каналов, ваших собственных подборок, экспорта из сторонних
 * приложений. Отправлять сюда то, что уже приходит из GeckoTerminal,
 * смысла нет — дубликаты отсеются, но лимит запросов израсходуется.
 */

const API = process.env.MEMEX_API ?? 'http://localhost:4000/api/v1';
const KEY = process.env.MEMEX_KEY;

if (!KEY) {
  console.error('Не задан MEMEX_KEY. Ключ создаётся в админке: Автопубликация → Ключи приёма.');
  process.exit(1);
}

/**
 * Сбор адресов. Возвращает произвольный текст — разбором занимается сервер.
 *
 * Подойдёт что угодно: адреса по одному на строку, ссылки, вперемешку.
 * Сеть определяется автоматически.
 *
 * Ниже три заготовки. Раскомментируйте нужную или напишите свою.
 */
async function collect() {
  // ── Вариант 1: файл со списком ──────────────────────────────────────
  // Самый простой рабочий способ: вы складываете найденное в файл,
  // скрипт по расписанию его забирает и очищает.
  //
  // const fs = await import('node:fs/promises');
  // const path = 'watchlist.txt';
  // try {
  //   const text = await fs.readFile(path, 'utf8');
  //   await fs.writeFile(path, '');
  //   return text;
  // } catch {
  //   return '';
  // }

  // ── Вариант 2: канал Telegram, куда добавлен ваш бот ────────────────
  // Работает без ключей сторонних сервисов. Бот должен состоять
  // в канале; сообщения приходят через getUpdates.
  //
  // const token = process.env.TELEGRAM_BOT_TOKEN;
  // const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
  // const data = await r.json();
  // return (data.result ?? [])
  //   .map((u) => u.channel_post?.text ?? u.message?.text ?? '')
  //   .join('\n');

  // ── Вариант 3: свой источник ────────────────────────────────────────
  // Сюда подставляется всё остальное. Сервер ждёт просто текст.

  return '';
}

async function main() {
  const text = (await collect()).trim();

  if (!text) {
    console.log('Источник пуст — отправлять нечего.');
    return;
  }

  const res = await fetch(`${API}/ingest/tokens`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify({ text, source: 'feed.mjs' }),
    // Бесплатный хостинг засыпает после простоя, и первый запрос
    // может идти до минуты. Без запаса скрипт молча падал бы
    // по таймауту раз в несколько часов.
    signal: AbortSignal.timeout(90_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`Ошибка ${res.status}: ${body.slice(0, 300)}`);
    process.exitCode = 1;
    return;
  }

  const r = await res.json();
  console.log(
    `${new Date().toISOString()} — добавлено ${r.added}, уже было ${r.existed}` +
      (r.notFound?.length ? `, не найдено ${r.notFound.length}` : ''),
  );

  for (const n of r.notFound ?? []) {
    console.log(`  пропущен ${n.address}: ${n.reason}`);
  }
}

main().catch((e) => {
  console.error('Сбой:', e?.message ?? e);
  process.exitCode = 1;
});
