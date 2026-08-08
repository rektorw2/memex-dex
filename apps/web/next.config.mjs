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

// Для project pages адрес выглядит как https://user.github.io/memex-dex/,
// и без basePath все ссылки и ассеты будут ломаться на 404.
// Для user pages (репозиторий user.github.io) префикс не нужен.
const repo = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? '';
const isUserPage = repo.endsWith('.github.io');
const basePath = isPages && repo && !isUserPage ? `/${repo}` : '';

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
        // внутри директории, иначе прямой переход на /calls даёт 404.
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
