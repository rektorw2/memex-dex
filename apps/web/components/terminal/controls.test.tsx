import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import {
  TerminalSearchField,
  TerminalSelect,
  TerminalFilterChip,
  TerminalChipRow,
  TerminalFilterBar,
  TerminalTabs,
  TERMINAL_CONTROL_SHAPE,
} from './controls';

/**
 * Контролы терминала как одна система.
 *
 * Дефект, ради которого это написано, был не в поведении: поиск
 * и два выпадающих списка работали. Они выглядели тремя разными
 * элементами — разной высоты, с разным шрифтом, с системной рамкой
 * у одного и без неё у других. Такие вещи не ловятся типами
 * и не видны в отзыве «кнопка не работает»; их ловит только сравнение
 * контрактов между собой.
 *
 * Поэтому ниже сравниваются классы контролов друг с другом, а не
 * с переписанным от руки ожиданием: список классов, повторённый
 * в тесте, разошёлся бы с кодом при первой же правке и подтверждал бы
 * вчерашнюю разметку.
 */

afterEach(cleanup);

const CHAINS = [
  ['', 'Все сети'],
  ['SOLANA', 'Solana'],
  ['BNB', 'BNB Chain'],
] as const;

// ───────────────────────── Доступные имена ──────────────────────────────────

describe('доступные имена', () => {
  it('у поиска есть подпись, а не только placeholder', () => {
    render(<TerminalSearchField value="" onChange={() => {}} />);

    // `placeholder` исчезает при первом символе — назначение поля
    // теряется ровно тогда, когда им начинают пользоваться.
    expect(screen.getByLabelText('Поиск токена')).toBeTruthy();
    expect(screen.getByPlaceholderText('Поиск по тикеру или адресу')).toBeTruthy();
  });

  it('подпись поиска связана с полем, а не просто выведена рядом', () => {
    const { container } = render(<TerminalSearchField value="" onChange={() => {}} />);

    const label = container.querySelector('label')!;
    const input = screen.getByLabelText('Поиск токена');

    expect(label.getAttribute('for')).toBe(input.getAttribute('id'));
    // Визуально скрыта: в панели фильтров подпись избыточна.
    expect(label.className).toContain('sr-only');
  });

  it('у каждого списка есть своё имя', () => {
    render(
      <>
        <TerminalSelect value="" onChange={() => {}} label="Сеть" options={CHAINS} />
        <TerminalSelect value="volume" onChange={() => {}} label="Сортировка" options={[['volume', 'По объёму']]} />
      </>,
    );

    expect(screen.getByLabelText('Сеть')).toBeTruthy();
    expect(screen.getByLabelText('Сортировка')).toBeTruthy();
  });

  it('ряд чипов и вкладки названы группами', () => {
    render(
      <>
        <TerminalChipRow label="Быстрые фильтры">
          <TerminalFilterChip active={false} onClick={() => {}}>
            Растущие
          </TerminalFilterChip>
        </TerminalChipRow>
        <TerminalTabs value="own" onChange={() => {}} items={[['own', 'Рынок']]} label="Источник списка" />
      </>,
    );

    expect(screen.getByRole('group', { name: 'Быстрые фильтры' })).toBeTruthy();
    expect(screen.getByRole('tablist', { name: 'Источник списка' })).toBeTruthy();
  });
});

// ───────────────────────────── Очистка поиска ───────────────────────────────

describe('очистка поиска', () => {
  it('кнопки нет, пока запрос пуст', () => {
    render(<TerminalSearchField value="" onChange={() => {}} />);

    // Постоянный крестик в пустом поле обещает действие, которого нет.
    expect(screen.queryByLabelText('Очистить поиск')).toBeNull();
  });

  it('кнопка появляется при непустом запросе', () => {
    render(<TerminalSearchField value="wif" onChange={() => {}} />);

    expect(screen.getByLabelText('Очистить поиск')).toBeTruthy();
  });

  it('очистка отдаёт пустую строку тому же обработчику, что и ввод', () => {
    const onChange = vi.fn();
    render(<TerminalSearchField value="wif" onChange={onChange} />);

    fireEvent.click(screen.getByLabelText('Очистить поиск'));

    // Тот же путь, что у обычного ввода: фильтрация на странице
    // не знает о существовании кнопки и не может из-за неё сломаться.
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('ввод по-прежнему доходит до обработчика', () => {
    const onChange = vi.fn();
    render(<TerminalSearchField value="" onChange={onChange} />);

    fireEvent.change(screen.getByLabelText('Поиск токена'), { target: { value: 'bonk' } });

    expect(onChange).toHaveBeenCalledWith('bonk');
  });
});

// ──────────────────────── Обработчики выбора ────────────────────────────────

describe('выбор сети и сортировки', () => {
  it('сеть отдаёт выбранное значение', () => {
    const onChange = vi.fn();
    render(<TerminalSelect value="" onChange={onChange} label="Сеть" options={CHAINS} />);

    fireEvent.change(screen.getByLabelText('Сеть'), { target: { value: 'SOLANA' } });

    expect(onChange).toHaveBeenCalledWith('SOLANA');
  });

  it('сортировка отдаёт выбранное значение', () => {
    const onChange = vi.fn();
    render(
      <TerminalSelect
        value="volume"
        onChange={onChange}
        label="Сортировка"
        options={[
          ['volume', 'По объёму'],
          ['liquidity', 'По ликвидности'],
        ]}
      />,
    );

    fireEvent.change(screen.getByLabelText('Сортировка'), { target: { value: 'liquidity' } });

    expect(onChange).toHaveBeenCalledWith('liquidity');
  });

  it('список остаётся нативным', () => {
    render(<TerminalSelect value="" onChange={() => {}} label="Сеть" options={CHAINS} />);

    const select = screen.getByLabelText('Сеть');

    // Клавиатура, поиск по первой букве и системный список
    // на телефоне работают потому, что это настоящий `select`.
    expect(select.tagName).toBe('SELECT');
    expect(select.querySelectorAll('option')).toHaveLength(CHAINS.length);
  });

  it('системная стрелка убрана, своя не перехватывает нажатие', () => {
    const { container } = render(
      <TerminalSelect value="" onChange={() => {}} label="Сеть" options={CHAINS} />,
    );

    expect(screen.getByLabelText('Сеть').className).toContain('appearance-none');

    const arrow = container.querySelector('span[aria-hidden]')!;
    expect(arrow.className).toContain('pointer-events-none');
  });

  it('длинное название обрезается, а не заезжает под стрелку', () => {
    render(
      <TerminalSelect
        value="x"
        onChange={() => {}}
        label="Сортировка"
        options={[['x', 'Очень длинное название сортировки, которое не помещается']]}
      />,
    );

    const select = screen.getByLabelText('Сортировка');

    // Правый отступ отведён под значок, текст обрезается многоточием.
    expect(select.className).toContain('truncate');
    expect(select.className).toContain('pr-9');
  });
});

// ───────────────────── Единый контракт стилей ───────────────────────────────

describe('поиск и списки — одна система', () => {
  it('форма поля общая, а не переписанная в каждом месте', () => {
    render(
      <>
        <TerminalSearchField value="" onChange={() => {}} />
        <TerminalSelect value="" onChange={() => {}} label="Сеть" options={CHAINS} />
      </>,
    );

    const search = screen.getByLabelText('Поиск токена');
    const select = screen.getByLabelText('Сеть');

    for (const token of TERMINAL_CONTROL_SHAPE.split(/\s+/).filter(Boolean)) {
      expect(search.className, `поиск: ${token}`).toContain(token);
      expect(select.className, `список: ${token}`).toContain(token);
    }
  });

  it('одинаковая высота 44 пикселя', () => {
    render(
      <>
        <TerminalSearchField value="" onChange={() => {}} />
        <TerminalSelect value="" onChange={() => {}} label="Сеть" options={CHAINS} />
      </>,
    );

    // `h-11` — сорок четыре пикселя, с которых начинается надёжное
    // попадание пальцем.
    expect(screen.getByLabelText('Поиск токена').className).toContain('h-11');
    expect(screen.getByLabelText('Сеть').className).toContain('h-11');
  });

  it('интерфейсный шрифт, а не моноширинный', () => {
    render(<TerminalSearchField value="" onChange={() => {}} />);

    const search = screen.getByLabelText('Поиск токена');

    // `.input` включает `num`: он уместен для сумм и неуместен
    // для тикеров и названий сетей.
    expect(search.className).toContain('font-sans');
    expect(search.className).not.toContain('num');
  });

  it('видимый фокус с accent-обводкой', () => {
    render(<TerminalSelect value="" onChange={() => {}} label="Сеть" options={CHAINS} />);

    const select = screen.getByLabelText('Сеть');

    expect(select.className).toContain('focus-visible:ring-accent/60');
    expect(select.className).toContain('focus-visible:border-accent');
  });

  it('движение отключается по системной настройке', () => {
    render(
      <>
        <TerminalSearchField value="" onChange={() => {}} />
        <TerminalFilterChip active={false} onClick={() => {}}>
          Новые
        </TerminalFilterChip>
      </>,
    );

    expect(screen.getByLabelText('Поиск токена').className).toContain('motion-reduce:transition-none');
    expect(screen.getByRole('button', { name: 'Новые' }).className).toContain(
      'motion-reduce:transition-none',
    );
  });
});

// ───────────────────────── Быстрые фильтры ──────────────────────────────────

describe('быстрые фильтры', () => {
  it('активное состояние читается не только цветом', () => {
    render(
      <TerminalFilterChip active onClick={() => {}}>
        Растущие
      </TerminalFilterChip>,
    );

    const chip = screen.getByRole('button', { name: /Растущие/ });

    // Восемь процентов мужчин не различают красный и зелёный:
    // один цветовой канал состоянием быть не может.
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(chip.querySelector('svg')).toBeTruthy();
  });

  it('неактивный чип не помечен нажатым', () => {
    render(
      <TerminalFilterChip active={false} onClick={() => {}}>
        Растущие
      </TerminalFilterChip>,
    );

    expect(screen.getByRole('button', { name: 'Растущие' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('нажатие доходит до обработчика', () => {
    const onClick = vi.fn();
    render(
      <TerminalFilterChip active={false} onClick={onClick}>
        Новые
      </TerminalFilterChip>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Новые' }));

    expect(onClick).toHaveBeenCalledOnce();
  });

  it('«Проверенные» сохраняет бирюзовый: это цвет проверки, а не роста', () => {
    render(
      <TerminalFilterChip active tone="check" onClick={() => {}}>
        Проверенные
      </TerminalFilterChip>,
    );

    const chip = screen.getByRole('button', { name: /Проверенные/ });

    expect(chip.className).toContain('text-up');
    expect(chip.className).not.toContain('text-accent');
  });

  it('остальные выбранные чипы используют основной accent', () => {
    render(
      <TerminalFilterChip active onClick={() => {}}>
        Падающие
      </TerminalFilterChip>,
    );

    expect(screen.getByRole('button', { name: /Падающие/ }).className).toContain('text-accent');
  });

  it('все чипы одной высоты и без переноса', () => {
    render(
      <TerminalChipRow label="Быстрые фильтры">
        <TerminalFilterChip active onClick={() => {}}>
          Растущие
        </TerminalFilterChip>
        <TerminalFilterChip active={false} tone="check" onClick={() => {}}>
          Проверенные
        </TerminalFilterChip>
      </TerminalChipRow>,
    );

    for (const chip of screen.getAllByRole('button')) {
      expect(chip.className).toContain('h-8');
      expect(chip.className).toContain('whitespace-nowrap');
      expect(chip.className).toContain('shrink-0');
    }
  });
});

// ─────────────────── Отсутствие переполнения на мобильном ───────────────────

describe('панель не выходит за экран', () => {
  it('чипы переносятся по строкам: активный виден всегда', () => {
    render(
      <TerminalChipRow label="Быстрые фильтры">
        {['Растущие', 'Падающие', 'Новые', 'Проверенные', 'Активные 24ч'].map((label) => (
          <TerminalFilterChip key={label} active={label === 'Активные 24ч'} onClick={() => {}}>
            {label}
          </TerminalFilterChip>
        ))}
      </TerminalChipRow>,
    );

    const row = screen.getByRole('group', { name: 'Быстрые фильтры' });

    /*
     * Сначала здесь была горизонтальная прокрутка. На 375 пикселях
     * выбранный чип оказывался за правым краем наполовину: полоса
     * скрыта, и понять, что ряд продолжается, было нельзя. Включённый
     * фильтр, которого не видно, — худший случай: человек не знает,
     * почему список короткий.
     */
    expect(row.className).toContain('flex-wrap');
    expect(row.className).not.toContain('scroll-x');
  });

  it('ни один чип не обрезается и не прячется', () => {
    render(
      <TerminalChipRow label="Быстрые фильтры">
        {['Растущие', 'Падающие', 'Новые', 'Проверенные', 'Активные 24ч'].map((label) => (
          <TerminalFilterChip key={label} active={label === 'Проверенные'} onClick={() => {}}>
            {label}
          </TerminalFilterChip>
        ))}
      </TerminalChipRow>,
    );

    // Все пять в разметке, включая последний и включая активный.
    expect(screen.getAllByRole('button')).toHaveLength(5);
    expect(screen.getByRole('button', { name: /Проверенные/ }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('поля не распирают контейнер длинным содержимым', () => {
    const { container } = render(<TerminalSearchField value="" onChange={() => {}} />);

    // Элементы flex по умолчанию не сжимаются меньше содержимого:
    // один длинный адрес контракта распирал бы всю панель.
    expect(container.firstElementChild!.className).toContain('min-w-0');
  });

  it('поиск отдельной строкой, списки строкой ниже поровну', () => {
    const { container } = render(
      <TerminalFilterBar
        search={<TerminalSearchField value="" onChange={() => {}} />}
        selects={
          <>
            <TerminalSelect value="" onChange={() => {}} label="Сеть" options={CHAINS} />
            <TerminalSelect value="v" onChange={() => {}} label="Сортировка" options={[['v', 'По объёму']]} />
          </>
        }
      />,
    );

    const [searchRow, selectsRow] = container.firstElementChild!.children;

    /*
     * Раскладка одна на всех ширинах — и это исправление дефекта.
     *
     * Прежде стоял `lg:flex-row`: с 1024 пикселей три контрола
     * собирались в строку. Медиазапрос смотрит на ширину окна,
     * а панель живёт в колонке терминала шириной 340–380 пикселей.
     * На широком мониторе условие срабатывало, три контрола делили
     * триста сорок пикселей, и поиск схлопывался до иконки.
     */
    expect(searchRow!.className).not.toContain('lg:flex-row');
    expect(searchRow!.className).toContain('min-w-0');

    // Списки одинаковой ширины: разной они читаются как случайность.
    expect(selectsRow!.className).toContain('grid-cols-2');
    expect(selectsRow!.className).not.toContain('lg:w-[300px]');
  });

  it('поиск не делит строку ни с чем', () => {
    const { container } = render(
      <TerminalFilterBar
        search={<TerminalSearchField value="" onChange={() => {}} />}
        selects={<TerminalSelect value="" onChange={() => {}} label="Сеть" options={CHAINS} />}
      />,
    );

    const [searchRow] = container.firstElementChild!.children;

    // Внутри строки поиска ровно один элемент — сам поиск.
    expect(searchRow!.children).toHaveLength(1);
    expect(searchRow!.querySelector('select')).toBeNull();
  });
});

// ─────────────────────────── Клавиатура ─────────────────────────────────────

describe('клавиатурный фокус', () => {
  it('поиск, очистка и списки попадают в обход', () => {
    render(
      <>
        <TerminalSearchField value="wif" onChange={() => {}} />
        <TerminalSelect value="" onChange={() => {}} label="Сеть" options={CHAINS} />
      </>,
    );

    for (const el of [
      screen.getByLabelText('Поиск токена'),
      screen.getByLabelText('Очистить поиск'),
      screen.getByLabelText('Сеть'),
    ]) {
      // Отрицательный tabindex выкинул бы элемент из обхода незаметно.
      expect(el.getAttribute('tabindex')).not.toBe('-1');
      el.focus();
      expect(document.activeElement).toBe(el);
    }
  });

  it('вкладки фокусируются и переключаются', () => {
    const onChange = vi.fn();
    render(
      <TerminalTabs
        value="own"
        onChange={onChange}
        items={[
          ['own', 'Рынок'],
          ['gems', 'GEMS'],
        ]}
        label="Источник списка"
      />,
    );

    const gems = screen.getByRole('tab', { name: 'GEMS' });

    gems.focus();
    expect(document.activeElement).toBe(gems);

    fireEvent.click(gems);
    expect(onChange).toHaveBeenCalledWith('gems');
  });

  it('активная вкладка помечена и заметна без заливки', () => {
    render(
      <TerminalTabs
        value="own"
        onChange={() => {}}
        items={[
          ['own', 'Рынок'],
          ['gems', 'GEMS'],
        ]}
        label="Источник списка"
      />,
    );

    const active = screen.getByRole('tab', { name: 'Рынок' });

    expect(active.getAttribute('aria-selected')).toBe('true');
    expect(active.className).toContain('border-accent');
    // Заливка спорила бы с чипами фильтров строкой ниже.
    expect(active.className).not.toContain('bg-accent');
  });

  it('у вкладок есть hover и видимый фокус', () => {
    render(
      <TerminalTabs value="own" onChange={() => {}} items={[['gems', 'GEMS']]} label="Источник" />,
    );

    const tab = screen.getByRole('tab', { name: 'GEMS' });

    expect(tab.className).toContain('hover:text-white');
    expect(tab.className).toContain('focus-visible:ring-accent/60');
  });
});
