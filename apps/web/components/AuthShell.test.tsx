import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { AuthShell } from './AuthShell';
import { ONBOARDING_STEPS } from './onboarding-steps';

/**
 * Общая оболочка первого сценария.
 *
 * Проверяется не вёрстка, а обещания, которые она даёт: форма всегда
 * доступна, ролик всегда заменяем, и ни одно из его состояний не
 * оставляет человека перед пустым экраном.
 */

vi.mock('next/link', () => ({
  // Настоящая ссылка: проверяются атрибуты, а не поведение роутера.
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const shell = (step = 'start') =>
  render(
    <AuthShell steps={ONBOARDING_STEPS} currentStep={step} title="Заголовок" subtitle="Пояснение">
      <button type="button">Действие</button>
    </AuthShell>,
  );

beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});

afterEach(cleanup);

describe('карточка действий доступна всегда', () => {
  it('заголовок и содержимое на месте', () => {
    shell();

    expect(screen.getByRole('heading').textContent).toBe('Заголовок');
    expect(screen.getByRole('button', { name: 'Действие' })).toBeTruthy();
  });

  it('видео помечено служебным и не читается вслух', () => {
    const { container } = shell();

    /*
     * Ролик — украшение. Экранный диктор, который его объявляет,
     * заставляет человека разбираться в том, что не несёт смысла.
     */
    const decorative = container.querySelector('[aria-hidden="true"]');
    expect(decorative).toBeTruthy();
  });

  it('постер лежит слоем ниже видео', () => {
    const { container } = shell();

    /*
     * Не запасной вариант «на случай», а постоянный слой. Если видео
     * не загрузится или его уберут по любой из причин, под ним уже
     * есть картинка — форма не окажется в пустоте.
     */
    const poster = container.querySelector('img[alt=""]');
    expect(poster).toBeTruthy();
    expect(poster?.getAttribute('src')).toContain('memex-welcome-poster');
  });
});

describe('видео ведёт себя как украшение', () => {
  it('автозапуск без звука и без выхода на весь экран', () => {
    const { container } = shell();
    const video = container.querySelector('video');

    expect(video?.hasAttribute('autoplay')).toBe(true);
    expect(video?.hasAttribute('muted') || video?.muted).toBeTruthy();
    expect(video?.hasAttribute('loop')).toBe(true);
    // Без `playsInline` iOS открывает ролик поверх всего.
    expect(video?.hasAttribute('playsinline')).toBe(true);
  });

  it('при отключённой анимации видео не показывается', async () => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;

    let container!: HTMLElement;
    await act(async () => {
      container = shell().container;
    });

    expect(container.querySelector('video')).toBeNull();
    // Постер остаётся: фон не исчезает вместе с анимацией.
    expect(container.querySelector('img[alt=""]')).toBeTruthy();
  });

  it('при экономии трафика видео не загружается', async () => {
    Object.defineProperty(navigator, 'connection', {
      value: { saveData: true },
      configurable: true,
    });

    let container!: HTMLElement;
    await act(async () => {
      container = shell().container;
    });

    expect(container.querySelector('video')).toBeNull();

    Reflect.deleteProperty(navigator, 'connection');
  });

  it('ошибка загрузки не ломает форму', async () => {
    let result!: ReturnType<typeof shell>;
    await act(async () => {
      result = shell();
    });

    const video = result.container.querySelector('video')!;
    await act(async () => {
      video.dispatchEvent(new Event('error'));
    });

    // Видео убрано, а действие по-прежнему доступно.
    expect(result.container.querySelector('video')).toBeNull();
    expect(screen.getByRole('button', { name: 'Действие' })).toBeTruthy();
  });
});

describe('индикатор шагов', () => {
  it('показывает текущий шаг', () => {
    shell('verify');

    // Подпись, а не только точки: точки сами по себе ничего не говорят.
    expect(screen.getAllByText('Почта').length).toBeGreaterThan(0);
  });

  it('пройденные шаги отличаются от предстоящих', () => {
    const { container } = shell('verify');

    const done = container.querySelectorAll('[data-state="done"]');
    const next = container.querySelectorAll('[data-state="next"]');
    const current = container.querySelectorAll('[data-state="current"]');

    expect(done.length).toBeGreaterThan(0);
    expect(next.length).toBeGreaterThan(0);
    expect(current.length).toBeGreaterThan(0);
  });

  it('неизвестный шаг не ломает индикатор', () => {
    // Опечатка в имени шага не должна давать пустой экран.
    const { container } = shell('нет-такого');
    expect(container.querySelectorAll('[data-state="current"]').length).toBeGreaterThan(0);
  });
});

describe('вёрстка не прячет форму под видео', () => {
  it('на узких экранах ролик ограничен по высоте', () => {
    const { container } = shell();
    const stage = container.querySelector('[aria-hidden="true"]');

    /*
     * Ролик во весь экран на телефоне означает, что форма уезжает
     * за нижний край и человек прокручивает видео, чтобы найти поле
     * ввода. Ограничение по высоте — это не украшение вёрстки.
     */
    expect(stage?.className).toContain('h-[38svh]');
    expect(stage?.className).toContain('lg:h-full');
  });

  it('карточка имеет предельную ширину', () => {
    const { container } = shell();

    // Одинаковая ширина между шагами читается как один процесс,
    // разъезжающаяся — как разные страницы.
    expect(container.innerHTML).toContain('max-w-[420px]');
  });
});
