import { describe, expect, it } from 'vitest';
import {
  PAPER_TEST_ADDRESS_PREFIX,
  PAPER_TEST_ORIGIN,
  isPaperTestAddress,
  paperTestSourceVerdict,
  paperTestWriteAllowed,
  type PaperTestSourceInput,
} from './paper-test-source.js';
import { isLivePaperSignalOrigin, isPaperSignalOrigin } from './paper-agent.js';

/** Единственное сочетание, при котором источник разрешён. */
const allowed: PaperTestSourceInput = {
  testSourceEnabled: true,
  executionMode: 'paper',
  liveExecutionEnabled: false,
  withdrawalsEnabled: false,
  solanaNetwork: 'devnet',
  actorRole: 'ADMIN',
};

describe('допуск к управляемому источнику', () => {
  it('разрешён только при полном наборе условий', () => {
    expect(paperTestSourceVerdict(allowed)).toEqual({ allowed: true });
  });

  it('выключенная настройка запрещает всё остальное', () => {
    // Значение по умолчанию. Ни один другой признак его не отменяет.
    expect(paperTestSourceVerdict({ ...allowed, testSourceEnabled: false })).toEqual({
      allowed: false,
      reason: 'TEST_SOURCE_DISABLED',
    });
  });

  it('режим live запрещает источник', () => {
    expect(paperTestSourceVerdict({ ...allowed, executionMode: 'live' })).toEqual({
      allowed: false,
      reason: 'EXECUTION_MODE_NOT_PAPER',
    });
  });

  it('включённое исполнение запрещает источник', () => {
    /*
     * Отдельная проверка, а не то же самое, что режим. Подделанный
     * сигнал при включённом исполнении стоит денег, и совпадение
     * любого из двух признаков достаточно для запрета.
     */
    expect(paperTestSourceVerdict({ ...allowed, liveExecutionEnabled: true })).toEqual({
      allowed: false,
      reason: 'LIVE_EXECUTION_ENABLED',
    });
  });

  it('включённые выводы запрещают источник', () => {
    expect(paperTestSourceVerdict({ ...allowed, withdrawalsEnabled: true })).toEqual({
      allowed: false,
      reason: 'WITHDRAWALS_ENABLED',
    });
  });

  it('mainnet запрещён в обоих написаниях', () => {
    for (const network of ['mainnet', 'mainnet-beta']) {
      expect(paperTestSourceVerdict({ ...allowed, solanaNetwork: network })).toEqual({
        allowed: false,
        reason: 'MAINNET_FORBIDDEN',
      });
    }
  });

  it('обычный пользователь не допускается', () => {
    for (const role of ['USER', 'user', 'admin', '']) {
      expect(paperTestSourceVerdict({ ...allowed, actorRole: role })).toEqual({
        allowed: false,
        reason: 'ADMIN_REQUIRED',
      });
    }
  });

  it('запрет контура важнее отсутствия прав', () => {
    // Человеку без прав незачем узнавать, включён ли источник.
    expect(
      paperTestSourceVerdict({ ...allowed, testSourceEnabled: false, actorRole: 'USER' }),
    ).toEqual({ allowed: false, reason: 'TEST_SOURCE_DISABLED' });
  });

  it('неизвестный режим исполнения не считается paper', () => {
    // Fail-closed: «не paper» — это всё, кроме `paper`.
    expect(paperTestSourceVerdict({ ...allowed, executionMode: '' }).allowed).toBe(false);
    expect(paperTestSourceVerdict({ ...allowed, executionMode: 'PAPER' }).allowed).toBe(false);
  });
});

describe('тестовые данные отделены от боевых', () => {
  it('тестовый адрес узнаётся по префиксу', () => {
    expect(isPaperTestAddress(`${PAPER_TEST_ADDRESS_PREFIX}abc`)).toBe(true);
  });

  it('настоящий mint тестовым не считается', () => {
    // Официальный USDC на Solana.
    expect(isPaperTestAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(false);
  });

  it('в base58 нет нуля — совпадение невозможно по алфавиту', () => {
    /*
     * Это не договорённость, а свойство кодировки: адрес Solana
     * не может начинаться с `TEST0`, потому что `0` в base58
     * исключён специально ради нечитаемости похожих символов.
     */
    expect(PAPER_TEST_ADDRESS_PREFIX).toContain('0');
  });

  it('запись разрешена только в тестовое пространство', () => {
    /*
     * Главный запрет всего файла. Цена в `Token` общая для всего
     * приложения: запись туда из тестового контура изменила бы то,
     * что видят все, — и это была бы подмена production market data.
     */
    expect(paperTestWriteAllowed(`${PAPER_TEST_ADDRESS_PREFIX}xyz`)).toBe(true);
    expect(paperTestWriteAllowed('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(false);
    expect(paperTestWriteAllowed('')).toBe(false);
  });

  it('тестовое происхождение не считается живым сигналом', () => {
    /*
     * Иначе проверка чинила бы отчётность: тестовые прогоны попадали
     * бы в метрики живой ленты и делали бы их лучше, чем на самом деле.
     */
    expect(isLivePaperSignalOrigin(PAPER_TEST_ORIGIN)).toBe(false);
    expect(isPaperSignalOrigin(PAPER_TEST_ORIGIN)).toBe(false);
  });
});
