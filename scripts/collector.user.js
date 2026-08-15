// ==UserScript==
// @name         Memex DEX — сбор адресов со страницы
// @namespace    memexdex
// @version      1.0
// @description  Отправляет адреса токенов с открытой страницы в радар Memex DEX
// @match        *://*/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/**
 * Сборщик адресов, работающий в браузере.
 *
 * Почему в браузере, а не на сервере. Чтобы серверу читать страницы,
 * требующие входа, ему нужен ваш сессионный токен. Такой токен —
 * предъявительский ключ ко всему аккаунту: кто им владеет, тот может
 * торговать и выводить средства. Держать его в переменных окружения
 * хостинга нельзя. Здесь эта задача решается тем, что скрипт работает
 * там, где сессия и так есть, а наружу уходят только адреса токенов.
 *
 * Ключ приёма, который вводится ниже, намеренно слабый: он умеет ровно
 * одно действие — добавить адрес в наблюдение. Ни войти в аккаунт, ни
 * распорядиться деньгами им нельзя, поэтому его не страшно оставить
 * в браузере.
 *
 * Скрипт не привязан к конкретному сайту: он разбирает текст страницы,
 * какой бы она ни была. Правовая сторона автоматического сбора зависит
 * от условий использования конкретного ресурса — это ваше решение
 * и ваш аккаунт.
 *
 * Установка: Tampermonkey → создать скрипт → вставить → сохранить.
 */

(function () {
  'use strict';

  const CFG_KEY = 'memex_collector_cfg';

  const cfg = (() => {
    try {
      return JSON.parse(localStorage.getItem(CFG_KEY) ?? '{}');
    } catch {
      return {};
    }
  })();

  // ─── Разбор адресов ───────────────────────────────────────────────────
  // Те же правила, что на сервере: сеть определяется по форме адреса,
  // а не по домену. Домены меняются, а base58 длиной 32-44 без символов
  // 0OIl — это адрес Solana и через год тоже.

  const EVM_RE = /\b0x[0-9a-fA-F]{40}\b/g;
  const SOLANA_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

  const SYSTEM = new Set([
    'So11111111111111111111111111111111111111112',
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    '11111111111111111111111111111111',
  ]);

  function collectFromPage() {
    const found = new Set();

    // Ссылки разбираются отдельно от текста: в href адрес встречается
    // чаще и в более чистом виде, чем в подписи, которую сайт может
    // сократить многоточием до неузнаваемости.
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') ?? '';
      // Транзакции пропускаем: хеш Solana неотличим по виду от адреса.
      if (/\/tx\/|\/transaction\//i.test(href)) continue;
      for (const m of href.match(EVM_RE) ?? []) found.add(m);
      for (const m of href.match(SOLANA_RE) ?? []) {
        if (!SYSTEM.has(m) && !/^[0-9a-fA-F]{40}$/.test(m)) found.add(m);
      }
    }

    const text = document.body?.innerText ?? '';
    for (const m of text.match(EVM_RE) ?? []) found.add(m);
    for (const m of text.match(SOLANA_RE) ?? []) {
      if (!SYSTEM.has(m) && !/^[0-9a-fA-F]{40}$/.test(m)) found.add(m);
    }

    return [...found];
  }

  // ─── Отправка ─────────────────────────────────────────────────────────

  // Уже отправленное в этой вкладке не шлём повторно: на странице
  // с автообновлением иначе уходил бы один и тот же список каждые
  // несколько секунд и выбирал часовой лимит впустую.
  const sent = new Set();

  async function send(addresses) {
    const fresh = addresses.filter((a) => !sent.has(a));
    if (fresh.length === 0) return { added: 0, existed: 0, skipped: addresses.length };

    const res = await fetch(`${cfg.api}/ingest/tokens`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.key}`,
      },
      body: JSON.stringify({
        text: fresh.join('\n'),
        source: location.hostname.slice(0, 40),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${res.status}: ${body.slice(0, 200)}`);
    }

    for (const a of fresh) sent.add(a);
    return res.json();
  }

  // ─── Интерфейс ────────────────────────────────────────────────────────

  const panel = document.createElement('div');
  panel.style.cssText = [
    'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
    'background:#121418', 'color:#e6e8eb', 'border:1px solid #1e2128',
    'border-radius:10px', 'padding:10px 12px', 'font:12px/1.4 ui-monospace,Menlo,monospace',
    'box-shadow:0 8px 24px rgba(0,0,0,.45)', 'max-width:280px',
  ].join(';');

  const status = document.createElement('div');
  status.style.cssText = 'color:#7d8592;margin-bottom:8px';
  status.textContent = 'Memex: готов';

  const btn = document.createElement('button');
  btn.textContent = 'Собрать со страницы';
  btn.style.cssText = [
    'width:100%', 'background:#7c5cff', 'color:#fff', 'border:0',
    'border-radius:6px', 'padding:7px 10px', 'cursor:pointer', 'font:inherit',
  ].join(';');

  const setup = document.createElement('button');
  setup.textContent = 'настроить';
  setup.style.cssText =
    'width:100%;margin-top:6px;background:transparent;color:#7d8592;border:0;cursor:pointer;font:inherit';

  function configure() {
    const api = prompt(
      'Адрес API (например https://memex-api.onrender.com/api/v1):',
      cfg.api ?? 'https://memex-api.onrender.com/api/v1',
    );
    if (!api) return;

    const key = prompt('Ключ приёма (создаётся в админке: Автопубликация → Ключи приёма):', cfg.key ?? '');
    if (!key) return;

    cfg.api = api.replace(/\/+$/, '');
    cfg.key = key.trim();
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
    status.textContent = 'Memex: настроен';
  }

  btn.onclick = async () => {
    if (!cfg.api || !cfg.key) {
      configure();
      if (!cfg.api || !cfg.key) return;
    }

    const addresses = collectFromPage();
    if (addresses.length === 0) {
      status.textContent = 'Адресов на странице не найдено';
      return;
    }

    btn.disabled = true;
    status.textContent = `Отправляем ${addresses.length}…`;

    try {
      const r = await send(addresses);
      status.textContent =
        `Добавлено ${r.added}` +
        (r.existed ? `, уже было ${r.existed}` : '') +
        (r.notFound?.length ? `, не найдено ${r.notFound.length}` : '');
    } catch (e) {
      // Причину показываем целиком: «не удалось» без текста ошибки
      // заставляет гадать, дело в ключе, в адресе API или в лимите.
      status.textContent = `Ошибка — ${e.message}`;
    } finally {
      btn.disabled = false;
    }
  };

  setup.onclick = configure;

  panel.append(status, btn, setup);

  // Панель добавляется только по готовности документа: на страницах
  // с медленной отрисовкой body может ещё не существовать.
  if (document.body) {
    document.body.appendChild(panel);
  } else {
    addEventListener('DOMContentLoaded', () => document.body.appendChild(panel));
  }
})();
