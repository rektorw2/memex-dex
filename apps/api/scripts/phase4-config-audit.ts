import { env } from '../src/lib/env.js';
import { signingStateFromConfig } from '../src/services/signing-state.js';

/**
 * Аудит конфигурации Phase 4. Только чтение.
 *
 * Ничего не меняет, никуда не ходит, учётных данных не касается.
 * Существует потому, что расхождение флагов невозможно увидеть,
 * глядя на один файл: `KMS_SIGNING_ENABLED` стоял в Render,
 * `SOLANA_SIGNING_ENABLED` — в коде, и оба выглядели правильными
 * там, где на них смотрели.
 *
 * Три контура показаны раздельно и намеренно названы по-разному.
 * Общее слово «KMS» в именах переменных и было тем, что склеило
 * custody encryption с подписью транзакций.
 *
 * Секретов, идентификаторов ресурсов и адресов узлов вывод не
 * содержит ни при каком состоянии: команду запускают в том числе
 * при демонстрации экрана.
 */

const OK = '  ок  ';
const WARN = ' важно';
const INFO = '  --  ';

function main(): void {
  const signing = signingStateFromConfig();

  line();
  head('Контур 1. Custody encryption — шифрование сохранённых ключей');
  row(
    env.KMS_PROVIDER === 'local' ? INFO : OK,
    'KMS_PROVIDER',
    env.KMS_PROVIDER,
    env.KMS_PROVIDER === 'local'
      ? 'локальный мастер-ключ; для LIVE и приёма средств не годится'
      : 'production-хранилище',
  );
  row(
    env.KMS_LOCAL_MASTER_KEY ? INFO : INFO,
    'KMS_LOCAL_MASTER_KEY',
    // Значение не печатается никогда. Только факт наличия.
    env.KMS_LOCAL_MASTER_KEY ? 'задан' : 'не задан',
    'мастер-ключ конвертного шифрования',
  );
  note('К подписи транзакций Solana этот контур отношения не имеет.');

  line();
  head('Контур 2. Transaction signer — подпись транзакций Solana');
  row(
    signing.facts.signingEnabled ? WARN : OK,
    'SOLANA_SIGNING_ENABLED',
    String(signing.facts.signingEnabled),
    'канонический переключатель; единственный, от которого зависит Sign',
  );
  row(
    signing.facts.signerProvider === 'unavailable' ? OK : WARN,
    'SOLANA_SIGNER_PROVIDER',
    signing.facts.signerProvider,
    'провайдер подписи',
  );
  row(
    env.SOLANA_NETWORK === 'devnet' ? OK : WARN,
    'SOLANA_NETWORK',
    env.SOLANA_NETWORK,
    'подпись разрешена только в devnet',
  );
  row(
    env.KMS_PREFLIGHT_ALLOW_SIGN ? WARN : OK,
    'KMS_PREFLIGHT_ALLOW_SIGN',
    String(env.KMS_PREFLIGHT_ALLOW_SIGN),
    'отдельное разрешение на настоящий Sign в проверке контура',
  );
  row(
    env.SOLANA_SIGNER_KEY_ID ? INFO : OK,
    'SOLANA_SIGNER_KEY_ID',
    // Идентификатор ресурса не печатается: он рассказывает об
    // аккаунте и регионе больше, чем нужно кому бы то ни было.
    env.SOLANA_SIGNER_KEY_ID ? 'задан' : 'не задан',
    'идентификатор ключа подписи',
  );
  row(
    env.SOLANA_PREFLIGHT_RPC_URL ? INFO : OK,
    'SOLANA_PREFLIGHT_RPC_URL',
    // Адрес узла не печатается по той же причине.
    env.SOLANA_PREFLIGHT_RPC_URL ? 'задан' : 'не задан',
    'узел devnet для blockhash',
  );

  line();
  head('Контур 3. Broadcast — отправка подписанного');
  row(OK, 'broadcastAvailable', 'false', 'транспорта отправки в проекте нет');
  note('SIGNED не равно SUBMITTED. Подпись и отправка — разные события.');

  line();
  head('Устаревшие флаги');
  if (env.KMS_SIGNING_ENABLED === undefined) {
    row(OK, 'KMS_SIGNING_ENABLED', 'отсутствует', 'окружение уже приведено в порядок');
  } else if (env.KMS_SIGNING_ENABLED === false) {
    row(
      INFO,
      'KMS_SIGNING_ENABLED',
      'false',
      'принимается ради совместимости; можно удалить из окружения',
    );
  } else {
    // До этой ветки дело не доходит: старт остановлен раньше.
    row(WARN, 'KMS_SIGNING_ENABLED', 'true', 'старт остановлен; перейдите на SOLANA_SIGNING_ENABLED');
  }

  line();
  head('Итог');
  console.log(`  Состояние подписи: ${signing.state}`);
  console.log(`  Вызов KMS разрешён: ${signing.allowsKmsCall ? 'да' : 'нет'}`);
  if (signing.blockers.length > 0) {
    console.log('  Почему подпись заблокирована:');
    for (const blocker of signing.blockers) console.log(`    - ${blocker}`);
  }

  const conflicts = findConflicts(signing.facts.signingEnabled);
  if (conflicts.length > 0) {
    console.log('\n  Противоречия в конфигурации:');
    for (const conflict of conflicts) console.log(`    - ${conflict}`);
  }

  line();
  console.log('  Проверка выполнена только по конфигурации.');
  console.log('  Ни одного сетевого вызова и ни одного обращения к KMS.\n');
}

/**
 * Настройки, которые не сочетаются друг с другом.
 *
 * Ищутся именно пары, а не отдельные значения: каждое из них по
 * отдельности выглядит осмысленным, и опасность появляется ровно от
 * сочетания.
 */
function findConflicts(signingEnabled: boolean): string[] {
  const conflicts: string[] = [];

  if (env.KMS_SIGNING_ENABLED === false && signingEnabled) {
    conflicts.push(
      'KMS_SIGNING_ENABLED=false вместе с SOLANA_SIGNING_ENABLED=true: ' +
        'старое окружение говорит «выключено», новое — «включено». ' +
        'Решает новое; старую переменную удалите, чтобы не вводить в заблуждение.',
    );
  }
  if (env.KMS_PREFLIGHT_ALLOW_SIGN && !signingEnabled) {
    conflicts.push(
      'KMS_PREFLIGHT_ALLOW_SIGN=true при выключенной подписи: ' +
        'разрешение подписать не включает подпись и ничего не обходит.',
    );
  }
  if (signingEnabled && env.SOLANA_SIGNER_PROVIDER === 'unavailable') {
    conflicts.push('Подпись включена, но провайдер не выбран.');
  }
  if (signingEnabled && env.SOLANA_NETWORK !== 'devnet') {
    conflicts.push(`Подпись включена в сети ${env.SOLANA_NETWORK}; разрешён только devnet.`);
  }
  if (signingEnabled && env.WITHDRAWALS_ENABLED) {
    conflicts.push('Подпись и выводы включены одновременно: это полный путь денег наружу.');
  }
  return conflicts;
}

function head(text: string): void {
  console.log(`\n  ${text}\n`);
}

function row(mark: string, name: string, value: string, comment: string): void {
  console.log(`  [${mark}] ${name.padEnd(26)} ${value.padEnd(14)} ${comment}`);
}

function note(text: string): void {
  console.log(`\n         ${text}`);
}

function line(): void {
  console.log('\n' + '─'.repeat(78));
}

main();
