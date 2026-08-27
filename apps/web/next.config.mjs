/**
 * Два режима сборки из одного конфига.
 *
 *   DEPLOY_TARGET=pages  → статический экспорт для GitHub Pages
 *   (по умолчанию)       → standalone для Docker
 *
 * Разделение нужно потому, что GitHub Pages отдаёт только файлы: сервера,
 * который выполнял бы код Next, там нет. Приложению это подходит — все
 * страницы помечены 'use client' и берут данные из API через SWR, серверный
 * рендеринг им не требуется.
 */

const isPages = process.env.DEPLOY_TARGET === 'pages';

// Префикс пути нужен только когда сайт лежит в подпапке.
//
//   https://user.github.io/memex-dex/  → нужен /memex-dex
//   https://user.github.io/            → не нужен (user page)
//   https://memexdex.com/              → не нужен (свой домен)
//
// Последний случай важен: при подключении своего домена GitHub Pages
// отдаёт сайт с корня. Если оставить префикс, все ссылки и стили
// разъедутся на 404, и выглядеть это будет как сломанная вёрстка.
const repo = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? '';
const isUserPage = repo.endsWith('.github.io');
const hasCustomDomain = Boolean(process.env.PAGES_CUSTOM_DOMAIN);
const needsPrefix = isPages && repo && !isUserPage && !hasCustomDomain;
const basePath = needsPrefix ? `/${repo}` : '';

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,

  ...(isPages
    ? {
        output: 'export',
        basePath,
        assetPrefix: basePath || undefined,
        // На Pages нет сервера оптимизации изображений.
        images: { unoptimized: true },
        // Пути с завершающим слэшем: статический хостинг ищет index.html
        // внутри директории, иначе прямой переход на вложенную страницу даёт 404.
        trailingSlash: true,
      }
    : {
        output: 'standalone',
        outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
      }),

  env: {
    NEXT_PUBLIC_API_URL:
      process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1',
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
};
