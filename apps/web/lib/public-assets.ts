/**
 * Путь к статическому файлу с учётом GitHub Pages basePath.
 *
 * Переменная публичная, но читать окружение внутри client-компонента
 * нельзя: это размывает границу между серверной конфигурацией и
 * браузерным кодом. Здесь она собирается в одну неизменяемую строку.
 */
const PUBLIC_BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export function publicAsset(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${PUBLIC_BASE_PATH}${normalized}`;
}
