'use client';

import { useEffect } from 'react';
import {
  MIN_TRADES_FOR_SCORE,
  HIGH_CONFIDENCE_TRADES,
  WIN_MULTIPLE,
  BIG_WIN_MULTIPLE,
} from '@memex/core';

/**
 * Методика расчёта Smart Score.
 *
 * Вынесена в окно, а не оставлена абзацем над списком. Причина
 * не в экономии места, хотя и в ней тоже: текст, который приходится
 * пролистывать при каждом открытии страницы, перестают читать вовсе,
 * и подробное объяснение превращается в шум ровно там, где оно
 * задумывалось как честность.
 *
 * Здесь оно доступно по ссылке из шапки — то есть тогда, когда
 * человек действительно спросил.
 */

export function ScoreMethodology({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);

    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="Как считается Smart Score"
    >
      <button className="absolute inset-0 bg-black/60" onClick={onClose} aria-label="Закрыть" />

      <div className="panel safe-bottom relative max-h-[85vh] w-full overflow-y-auto rounded-t-2xl border-t border-border sm:max-w-[560px] sm:rounded-xl sm:border">
        <header className="sticky top-0 flex items-center justify-between border-b border-border bg-panel px-4 py-3">
          <h2 className="text-sm font-medium">Как считается Smart Score</h2>
          <button onClick={onClose} className="tap px-2 text-sm text-muted">Закрыть</button>
        </header>

        <div className="space-y-5 p-4 text-xs leading-relaxed text-muted">
          <Section title="Что считается сделкой">
            <p>
              Покупка отслеживаемого токена кошельком. Исход проставляется позже:
              во сколько раз токен вырос после этой покупки. Сделка без известного
              исхода в оценке не участвует — иначе свежая покупка выглядела бы
              как неудачная.
            </p>
          </Section>

          <Section title="Почему нужно минимум пять сделок">
            <p>
              На четырёх сделках одна удача меняет долю попаданий на четверть.
              Такая оценка колеблется сильнее, чем различает кошельки, поэтому
              до {MIN_TRADES_FOR_SCORE} завершённых сделок балл не выставляется вовсе.
            </p>
            <p className="mt-2">
              Отсутствие оценки не означает плохой кошелёк. Оно означает, что
              судить не о чем — и это честнее выдуманного числа.
            </p>
          </Section>

          <Section title="Что входит в балл">
            <ul className="space-y-1.5">
              <li>
                • Доля сделок, после которых токен вырос минимум в {WIN_MULTIPLE} раза
              </li>
              <li>• Отдельно — сделки с ростом от {BIG_WIN_MULTIPLE}×</li>
              <li>• Средняя кратность, взвешенная по размеру покупки</li>
              <li>• Скорость входа: насколько рано после запуска пула</li>
              <li>• Доля обнулившихся токенов — она балл снижает</li>
            </ul>
          </Section>

          <Section title="Почему одна удачная сделка не даёт высокого балла">
            <p>
              Доля попаданий считается не напрямую, а по нижней границе
              доверительного интервала. Проще говоря: из трёх сделок с тремя
              попаданиями получается не «сто процентов», а примерно сорок четыре —
              потому что три попадания подряд бывают и по случайности.
            </p>
            <p className="mt-2">
              Тридцать попаданий из тридцати дают около восьмидесяти девяти
              процентов: столько подряд случайно не выходит.
            </p>
          </Section>

          <Section title="Уверенность — отдельно от балла">
            <p>
              Балл говорит, насколько хороши результаты. Уверенность — сколько
              за ними наблюдений. Это разные утверждения, и на странице они
              показаны раздельно.
            </p>
            <ul className="mt-2 space-y-1.5">
              <li>
                • <span className="text-up">Высокая</span> — от {HIGH_CONFIDENCE_TRADES} завершённых сделок
              </li>
              <li>
                • <span className="text-warn">Средняя</span> — от {MIN_TRADES_FOR_SCORE} до {HIGH_CONFIDENCE_TRADES - 1}
              </li>
              <li>• Собираем историю — меньше {MIN_TRADES_FOR_SCORE}</li>
            </ul>
          </Section>

          <Section title="Чего оценка не делает">
            <p>
              Она описывает прошлое и не предсказывает будущее. Кошелёк
              с высоким баллом может потерять всё на следующей покупке.
              Повторение чужих сделок не снижает риск, а переносит его на вас:
              вы входите позже и по другой цене.
            </p>
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 text-[13px] font-medium text-white">{title}</h3>
      {children}
    </section>
  );
}
