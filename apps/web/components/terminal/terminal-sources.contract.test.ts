// @vitest-environment node
//
// Читаются файлы, а не отрисовывается дерево. В `jsdom`
// `import.meta.url` — адрес по http, и путь из него не построить.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Обе вкладки терминала пользуются одними контролами.
 *
 * Вопрос про устройство кода, а не про поведение: отрисовать GEMS
 * целиком значило бы поднять SWR, избранное и сеть ради ответа,
 * который прямо написан в файле. Подделки к тому же отвечали бы
 * на него по нашему же сценарию.
 */

const here = fileURLToPath(new URL('./', import.meta.url));
const read = (path: string) => readFileSync(`${here}${path}`, 'utf8');

const gems = read('GemsList.tsx');
const page = read('../../app/terminal/page.tsx');

// ──────────────── Один набор контролов на обе вкладки ───────────────────────

describe('Рынок и GEMS используют одни контролы', () => {
  it('обе вкладки берут списки из общего модуля', () => {
    expect(page).toContain("from '@/components/terminal/controls'");
    expect(gems).toContain("from './controls'");

    expect(page).toContain('<TerminalSelect');
    expect(gems).toContain('<TerminalSelect');
  });

  it('своих select с классом .input не осталось', () => {
    // Именно они и делали переключение вкладки похожим на переход
    // в другое приложение: другой шрифт, другая высота, системная
    // рамка вокруг одного из полей.
    for (const [name, source] of [
      ['page.tsx', page],
      ['GemsList.tsx', gems],
    ] as const) {
      expect(source, name).not.toMatch(/<select/);
      expect(source, name).not.toMatch(/className="input/);
    }
  });

  it('быстрые фильтры тоже общие', () => {
    expect(page).toContain('<TerminalFilterChip');
    expect(gems).toContain('<TerminalFilterChip');

    // Своя копия классов чипа удалена вместе с `filterClass`.
    expect(gems).not.toContain('function filterClass');
  });

  it('глобальный .input не тронут: им пользуются другие страницы', () => {
    const globals = read('../../app/globals.css');

    // Правка общего класса ради терминала чинила бы одно, ломая
    // формы ввода сумм на остальных экранах.
    expect(globals).toContain('.input {');
    expect(globals).toContain('min-height: 36px');
  });

  it('вкладки не удалены', () => {
    for (const tab of ['Рынок', 'GEMS', 'DexScreener']) {
      expect(page).toContain(tab);
    }
  });
});

