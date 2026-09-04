// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { depositNetworkStatus, type FundingSafetyState } from '@memex/core';

/**
 * Что страница агента показывает обычному человеку про депозиты.
 *
 * Проверяется не вёрстка, а граница: наружу выходят четыре
 * формулировки и ни одной внутренней подробности. Номер слота,
 * адрес узла и код ошибки RPC на странице для всех — это и утечка
 * устройства, и ложное ощущение поломки там, где идёт проверка.
 */

const page = readFileSync(fileURLToPath(new URL('./page.tsx', import.meta.url)), 'utf8');

/** Исходник без комментариев: объяснение — не код. */
const code = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('состояние приёма депозитов', () => {
  it('выключенный контур важнее любого состояния защёлки', () => {
    // «Приостановлены» подразумевает, что вообще-то они работают
    // и скоро вернутся. Человек будет ждать того, чего нет.
    for (const safety of ['HEALTHY', 'DEGRADED', 'PAUSED', 'REVIEW_REQUIRED'] as FundingSafetyState[]) {
      expect(depositNetworkStatus({ fundingEnabled: false, safety }), safety)
        .toBe('NOT_CONNECTED');
    }
  });

  it('включённый контур различает четыре положения', () => {
    const at = (safety: FundingSafetyState) =>
      depositNetworkStatus({ fundingEnabled: true, safety });

    expect(at('HEALTHY')).toBe('VALIDATING');
    expect(at('DEGRADED')).toBe('VALIDATING');
    expect(at('PAUSED')).toBe('PAUSED');
    expect(at('REVIEW_REQUIRED')).toBe('REVIEW_REQUIRED');
  });

  it('недоступность узла не пугает человека', () => {
    // DEGRADED означает «мы не видим», а не «что-то сломалось
    // с деньгами». Отдельной тревожной формулировки он не заслуживает.
    expect(depositNetworkStatus({ fundingEnabled: true, safety: 'DEGRADED' }))
      .toBe(depositNetworkStatus({ fundingEnabled: true, safety: 'HEALTHY' }));
  });
});

describe('страница агента', () => {
  it('содержит все четыре формулировки', () => {
    for (const text of [
      'Сеть депозитов проверяется',
      'Депозиты временно приостановлены',
      'Требуется проверка',
      'LIVE-пополнения ещё не подключены',
    ]) {
      expect(page, text).toContain(text);
    }
  });

  it('не показывает checkpoint, слоты и адрес узла', () => {
    for (const leak of [
      'checkpoint', 'Checkpoint', 'slot', 'Slot',
      'SOLANA_RPC_URL', 'rpcUrl', 'endpoint',
      'leaseOwner', 'scannedThrough',
    ]) {
      expect(code, leak).not.toContain(leak);
    }
  });

  it('не показывает внутренние коды ошибок RPC', () => {
    expect(code).not.toMatch(/SOLANA_RPC_[A-Z_]+/);
    expect(code).not.toMatch(/lastErrorCode/);
  });

  it('не обещает работающие пополнения', () => {
    // Страница не должна создавать впечатление, что реальные
    // переводы уже принимаются.
    expect(code).not.toMatch(/Пополнения работают|Депозиты включены|Приём открыт/);
  });

  it('не даёт обычному пользователю снять защёлку', () => {
    expect(code).not.toMatch(/latch\/clear|clearFundingSafety|Снять защёлку|Возобновить приём/);
  });

  it('переход состояния анимирован и уважает настройку системы', () => {
    const badge = code.slice(code.indexOf('data-deposit-status'));
    const chunk = badge.slice(0, 400);

    expect(chunk).toContain('transition-colors');
    // Человеку, отключившему анимацию, её не показывают.
    expect(chunk).toContain('motion-reduce:transition-none');
  });

  it('состояние объявлено как статус для программ чтения с экрана', () => {
    expect(code).toMatch(/role="status"[\s\S]{0,200}data-deposit-status/);
  });

  it('незнакомое состояние не выдаётся за рабочее', () => {
    /*
     * Переносы строк убираются перед проверкой: тест обязан отвечать
     * за поведение, а не за то, где prettier поставил перевод строки.
     */
    const flat = code.replace(/\s+/g, ' ');

    // Новое значение с сервера не должно превращаться в «проверяется».
    expect(flat).toContain('?? DEPOSIT_STATUS.NOT_CONNECTED');
  });

  it('объясняет, что подпись не означает отправку', () => {
    // Самое дорогое недоразумение этого этапа: человек решает, что
    // транзакция ушла, потому что увидел слово «подписано».
    expect(page).toContain('Подпись не означает отправку');
    expect(page).toContain('Отправка ещё не подключена');
  });

  it('показывает стадии намерения понятными словами', () => {
    for (const label of [
      'Предложение', 'Подтверждение', 'Безопасная подпись', 'Отправка заблокирована',
    ]) {
      expect(page, label).toContain(label);
    }
  });

  it('отправка показана шагом, а не убрана из списка', () => {
    /*
     * Убрать последний шаг значило бы дать прочитать «подписано»
     * как «отправлено»: человек, видящий список выполненным до
     * конца, считает дело сделанным.
     */
    expect(page).toContain("code: 'BROADCAST_LOCKED'");
    expect(page).toContain('locked: true');
  });

  it('состояние ключа названо словами, а не кодом', () => {
    for (const text of [
      'подпись выключена',
      'ключ ещё не подтверждён',
      'нужен разбор вручную',
    ]) {
      expect(page, text).toContain(text);
    }
  });

  it('противоречивые статусы собрать невозможно', () => {
    /*
     * Раньше рядом могли оказаться «KMS выключен» и «подписант
     * готов»: они считались из разных переменных и расходились.
     *
     * Проверяется источник: страница читает одно поле состояния,
     * пришедшее с сервера, и не складывает картинку из флагов.
     */
    expect(page).not.toMatch(/signing\?\.(ready|signingEnabled)\s*(\?|&&|\|\|)/);
    expect(page).toContain('status.signing?.status');
  });

  it('старый ответ API не роняет страницу', () => {
    /*
     * Фронт и API выкатываются раздельно: страница успевает
     * получить ответ без нового поля.
     */
    expect(page).toContain("status.signing?.status ?? 'SIGNING_OFF'");
  });

  it('не показывает имя ресурса ключа и внутренние подробности подписи', () => {
    for (const leak of [
      'keyId', 'keyVersionName', 'resourceName', 'arn:aws',
      'projects/', 'keyRings', 'cryptoKeys',
      'privateKey', 'secretKey', 'credentials',
    ]) {
      expect(code, leak).not.toContain(leak);
    }
  });

  it('не обещает работающие сделки и отправку', () => {
    expect(code).not.toMatch(/Отправлено|Транзакция отправлена|Сделки работают|broadcastAvailable: true/);
  });

  it('стадии анимированы с уважением к настройке системы', () => {
    const block = code.slice(code.indexOf('data-intent-stage'));
    expect(block.slice(0, 400)).toContain('motion-reduce:transition-none');
  });

  it('блок подписи переживает старый ответ сервера', () => {
    const flat = code.replace(/\s+/g, ' ');
    expect(flat).toContain('status.signing?.network');
    expect(code).toMatch(/signing\?:/);
  });

  it('отсутствующее поле не роняет страницу', () => {
    /*
     * Статика и API выкладываются раздельно: браузер какое-то время
     * держит новую страницу против старого сервера. Обязательное поле
     * означало бы белый экран у человека, который ни при чём.
     */
    const flat = code.replace(/\s+/g, ' ');

    expect(flat).toContain('status.depositNetwork?.status');
    expect(code).toMatch(/depositNetwork\?:/);
  });
});
