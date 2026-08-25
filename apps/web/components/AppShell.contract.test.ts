// @vitest-environment node
//
// Читаются файлы, а не отрисовывается дерево. В `jsdom`
// `import.meta.url` — адрес по http, и `fileURLToPath` на нём падает.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Широкая полоса под шапкой не должна вернуться.
 *
 * Проверка идёт по исходникам, а не по отрисованному дереву,
 * и это осознанный выбор. Отрисовать `AppShell` целиком значит
 * поднять маршрутизатор, сторожа маршрутов и провайдер прав —
 * три подделки ради одного вопроса «нет ли здесь снова полосы».
 * Подделки к тому же отвечали бы на него по нашему же сценарию.
 *
 * Исходник отвечает прямо: компонента нет, импорта нет, разметки
 * во всю ширину под шапкой нет.
 */

const web = fileURLToPath(new URL('../', import.meta.url));
const read = (path: string) => readFileSync(`${web}${path}`, 'utf8');

describe('полосы состояния доступа больше нет', () => {
  it('файла компонента не существует', () => {
    expect(existsSync(`${web}components/AccessBanner.tsx`)).toBe(false);
  });

  it('его никто не импортирует', () => {
    const sources: string[] = [];

    const walk = (dir: string) => {
      for (const entry of readdirSync(`${web}${dir}`, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;

        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(path);
        // Сами тесты пропускаются: этот файл называет удалённый
        // компонент по имени и иначе обвинил бы сам себя.
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          sources.push(path);
        }
      }
    };

    walk('app');
    walk('components');
    walk('lib');

    const offenders = sources.filter((path) => read(path).includes('AccessBanner'));

    expect(offenders).toEqual([]);
  });

  it('под шапкой сразу идёт содержимое страницы', () => {
    const shell = read('components/AppShell.tsx');

    /*
     * Между закрытием `header` и следующим за ним `main` не осталось
     * ничего, кроме комментария: любая вставка здесь снова заняла бы
     * высоту на каждой странице.
     *
     * `main` ищется именно после шапки. Первый `<main` в файле стоит
     * в ветке первого экрана — выше `</header>`, — и поиск с начала
     * файла давал пустой отрезок: проверка проходила всегда, в том
     * числе с возвращённой полосой. Негативный контроль это и показал.
     */
    const afterHeader = shell.indexOf('</header>') + '</header>'.length;
    const between = shell.slice(afterHeader, shell.indexOf('<main', afterHeader));

    expect(between.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').trim()).toBe('');
  });

  it('текстов прежней полосы не осталось нигде в интерфейсе шапки', () => {
    const shell = read('components/AppShell.tsx');
    const nav = read('components/AuthNav.tsx');

    for (const phrase of ['Радар и новые покупки закрыты', 'Подключить бесплатный период']) {
      expect(shell).not.toContain(phrase);
      expect(nav).not.toContain(phrase);
    }
  });
});

describe('индикатор стоит на своём месте', () => {
  const nav = read('components/AuthNav.tsx');

  it('рядом с бейджем режима торговли', () => {
    const paperAt = nav.indexOf('paper');
    const accessAt = nav.indexOf('<AccessStatusControl />');
    const accountAt = nav.indexOf('aria-label="Аккаунт"');

    expect(paperAt).toBeGreaterThan(-1);
    expect(accessAt).toBeGreaterThan(paperAt);
    // Перед кнопкой аккаунта: справа от неё индикатор оказался бы
    // за краем привычного места выхода.
    expect(accessAt).toBeLessThan(accountAt);
  });

  it('бейдж paper остался: это другой статус', () => {
    // Режим торговли и доступ отвечают на разные вопросы.
    expect(nav).toContain('paper');
  });

  it('логика доступа не переехала в AuthNav', () => {
    for (const leak of ['effectivePlan', 'canStartTrial', 'serviceAccess', 'trialRemaining']) {
      expect(nav).not.toContain(leak);
    }
  });
});
