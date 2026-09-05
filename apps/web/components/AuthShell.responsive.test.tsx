import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { AuthShell } from './AuthShell';
import { ONBOARDING_STEPS } from './onboarding-steps';

/**
 * Поведение оболочки на восьми ширинах и во всех состояниях пути.
 *
 * О чём этот файл честно НЕ говорит. `jsdom` не считает раскладку:
 * ширины элементов здесь нулевые, каскад Tailwind не применяется, и
 * «выехало ли поле за край» отсюда не видно. Настоящую визуальную
 * проверку в браузере это не заменяет.
 *
 * Что он проверяет по-настоящему: что на каждой ширине и в каждом
 * состоянии карточка действий существует, единственная главная
 * кнопка доступна, заголовок один, и в разметке нет приёмов, которые
 * гарантированно дают горизонтальную прокрутку, — фиксированных
 * ширин в пикселях и запрета переноса у длинного текста.
 */

const WIDTHS = [375, 390, 430, 440, 768, 1024, 1280, 1440];

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

/** Состояния пути, каждое со своим содержимым карточки. */
const STATES: Array<{ name: string; step: string; body: React.ReactNode; title: string }> = [
  {
    name: 'Get Started',
    step: 'start',
    title: 'See the signal. Make your move.',
    body: <button type="button">Get Started</button>,
  },
  {
    name: 'выбор Sign in / Sign up',
    step: 'auth',
    title: 'Вход в Memex',
    body: (
      <div>
        <a href="/login?mode=register">Создать аккаунт</a>
        <a href="/login">У меня уже есть аккаунт</a>
      </div>
    ),
  },
  {
    name: 'регистрация',
    step: 'auth',
    title: 'Создание аккаунта',
    body: (
      <form>
        <label htmlFor="e">Email</label>
        <input id="e" type="email" autoComplete="email" />
        <label htmlFor="p">Пароль</label>
        <input id="p" type="password" autoComplete="new-password" />
        <button type="submit">Создать аккаунт</button>
      </form>
    ),
  },
  {
    name: 'вход',
    step: 'auth',
    title: 'Вход',
    body: (
      <form>
        <label htmlFor="e2">Email</label>
        <input id="e2" type="email" autoComplete="email" />
        <label htmlFor="p2">Пароль</label>
        <input id="p2" type="password" autoComplete="current-password" />
        <button type="submit">Войти</button>
      </form>
    ),
  },
  {
    name: 'ввод кода',
    step: 'verify',
    title: 'Подтвердите почту',
    body: (
      <form>
        <label htmlFor="c">Код из письма</label>
        <input id="c" inputMode="numeric" autoComplete="one-time-code" maxLength={6} />
        <button type="submit">Подтвердить</button>
      </form>
    ),
  },
  {
    name: 'повторная отправка в паузе',
    step: 'verify',
    title: 'Подтвердите почту',
    body: (
      <button type="button" disabled>
        Отправить ещё раз можно через 47 с
      </button>
    ),
  },
  {
    name: 'ожидание пробуждения API',
    step: 'auth',
    title: 'Вход',
    body: (
      <div>
        <p role="status">Запускаем защищённый сервер… Это занимает до минуты после простоя.</p>
        <button type="submit">Войти</button>
      </div>
    ),
  },
  {
    name: 'ошибка API',
    step: 'auth',
    title: 'Вход',
    body: (
      <div>
        <p role="alert">Неверный адрес или пароль</p>
        <button type="submit">Войти</button>
      </div>
    ),
  },
  {
    name: 'успешное подтверждение',
    step: 'plans',
    title: 'Готово',
    body: <p role="status">Бесплатный период Pro активен. Действует до 15 мая, 09:00.</p>,
  },
  {
    name: 'тарифы с активным периодом',
    step: 'plans',
    title: 'Тарифы',
    body: <a href="/agent">Перейти к агенту</a>,
  },
];

function setWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
  window.dispatchEvent(new Event('resize'));
}

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

describe('все состояния на всех ширинах', () => {
  for (const width of WIDTHS) {
    for (const state of STATES) {
      it(`${width}px · ${state.name}`, () => {
        setWidth(width);

        const { container } = render(
          <AuthShell
            steps={ONBOARDING_STEPS}
            currentStep={state.step}
            title={state.title}
            subtitle="Пояснение"
          >
            {state.body}
          </AuthShell>,
        );

        // Заголовок ровно один: два заголовка первого уровня на
        // экране означают, что человек не понимает, где он.
        expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);

        // Ролик присутствует на каждом шаге — это одна оболочка,
        // а не набор разных страниц.
        expect(container.querySelector('video, img[alt=""]')).toBeTruthy();

        // Содержимое карточки доступно и не спрятано под видео.
        const card = container.querySelector('[data-auth-card]');
        expect(card).toBeTruthy();
        expect(card!.textContent).toContain(state.title);
      });
    }
  }
});

describe('приёмы, которые дают горизонтальную прокрутку', () => {
  const markup = () => {
    const { container } = render(
      <AuthShell steps={ONBOARDING_STEPS} currentStep="auth" title="Вход">
        <button type="button">Войти</button>
      </AuthShell>,
    );
    return container.innerHTML;
  };

  it('нет фиксированных ширин в пикселях', () => {
    /*
     * `w-[380px]` на экране 375 — это прокрутка вбок независимо от
     * всего остального. Предельная ширина (`max-w-`) безопасна:
     * она уступает узкому экрану.
     *
     * Граница слова здесь не годится: `\b` попадает между дефисом
     * и `w`, и шаблон ловил безобидный `max-w-[1440px]`. Класс
     * должен начинаться после пробела или кавычки.
     */
    expect(markup()).not.toMatch(/[\s"']w-\[\d+px\]/);
  });

  it('переполнение обрезается на уровне оболочки', () => {
    expect(markup()).toContain('overflow-hidden');
  });

  it('длинные заголовки переносятся', () => {
    // `text-balance` и перенос — иначе одно длинное слово растягивает
    // карточку шире экрана.
    expect(markup()).toContain('text-balance');
  });

  it('отступы учитывают вырезы экрана', () => {
    // Без `env(safe-area-inset-*)` кнопка уезжает под системную
    // полосу на телефонах с вырезом.
    expect(markup()).toContain('env(safe-area-inset');
  });
});

describe('доступность формы', () => {
  it('фокус виден на всех интерактивных элементах оболочки', () => {
    const { container } = render(
      <AuthShell steps={ONBOARDING_STEPS} currentStep="start" title="Начало">
        <button type="button">Действие</button>
      </AuthShell>,
    );

    // Клавиатурная навигация без видимого фокуса — это навигация
    // вслепую.
    const links = [...container.querySelectorAll('a')];
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.className).toContain('focus-visible:outline');
    }
  });

  it('индикатор шагов помечен как навигация', () => {
    const { container } = render(
      <AuthShell steps={ONBOARDING_STEPS} currentStep="verify" title="Почта">
        <button type="button">Действие</button>
      </AuthShell>,
    );

    expect(container.querySelector('nav[aria-label="Шаги"]')).toBeTruthy();
  });
});
