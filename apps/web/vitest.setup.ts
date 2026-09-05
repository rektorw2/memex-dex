/**
 * Недостающие возможности браузера в jsdom.
 *
 * Здесь только то, чего в jsdom нет вовсе, — не подмена поведения.
 * Подделывать то, что jsdom умеет сам, значит проверять собственные
 * представления вместо настоящей разметки.
 *
 * `matchMedia` нужен компонентам, которые уважают
 * `prefers-reduced-motion`. По умолчанию отвечаем «анимация
 * разрешена»: это состояние большинства, а отключённую анимацию
 * тесты задают явно, подменяя ответ.
 */
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
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
}

/**
 * `randomUUID` есть не во всех версиях jsdom.
 *
 * Значение случайное и в тестах не проверяется: оно нужно как ключ
 * идемпотентности, а не как данные.
 */
if (typeof globalThis.crypto?.randomUUID !== 'function') {
  Object.defineProperty(globalThis.crypto ?? (globalThis.crypto = {} as Crypto), 'randomUUID', {
    value: () => `test-${Math.random().toString(16).slice(2)}-${Date.now()}`,
    configurable: true,
  });
}

/**
 * Видео в jsdom не воспроизводится.
 *
 * `play()` отсутствует, и компонент, который его вызывает, падал бы
 * на пустом месте. Возвращается отклонённый промис — ровно то, что
 * делает браузер, запретивший автозапуск: этот случай компонент
 * обязан переживать и без тестов.
 */
if (typeof HTMLMediaElement !== 'undefined') {
  /*
   * Переопределяется безусловно.
   *
   * jsdom объявляет `play`, но тот бросает «Not implemented» и
   * возвращает `undefined` — то есть проверка «метода нет» его
   * не ловит. Тот же `undefined` возвращали старые Safari, поэтому
   * компонент обязан переживать и это.
   */
  HTMLMediaElement.prototype.play = () => Promise.reject(new Error('автозапуск недоступен'));
  HTMLMediaElement.prototype.pause = () => {};
}
