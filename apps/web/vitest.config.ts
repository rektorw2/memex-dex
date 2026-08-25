import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * Тесты интерфейса.
 *
 * До сих пор в вебе тестов не было вовсе, и это заметно по тому,
 * какие дефекты доживали до боевой страницы: неверное состояние
 * доступа, исчезающие отметки, предложение войти уже вошедшему
 * человеку. Все они видны в разметке и все проверяются за секунды —
 * но только если есть чем.
 *
 * `jsdom`, а не подделка DOM: проверять надо настоящие атрибуты
 * доступности, настоящие обработчики клавиш и настоящий порядок
 * фокуса. Подделка воспроизводит ровно то, что мы про неё
 * подумали, — то есть не находит ничего.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: ['node_modules/**', '.next/**', 'out/**'],
  },
});
