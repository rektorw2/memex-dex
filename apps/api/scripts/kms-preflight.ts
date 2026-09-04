/**
 * Проверка контура подписи.
 *
 * Запуск: `npm run solana:kms-preflight`
 *
 * По умолчанию ничего не подписывает: читает конфигурацию,
 * спрашивает у KMS метаданные ключа, вычисляет адрес Solana и, если
 * задан devnet-узел, берёт blockhash.
 *
 * Настоящий вызов `Sign` требует `KMS_PREFLIGHT_ALLOW_SIGN=true` и
 * даже тогда подписывает перевод самому себе на ноль лампортов.
 *
 * Транзакция не отправляется и не симулируется: транспорт broadcast
 * в этот скрипт не импортируется.
 */

import { env } from '../src/lib/env.js';
import { signingStateFromConfig } from '../src/services/signing-state.js';
import { FetchSolanaRpcClient } from '../src/services/solana-rpc-deposit-source.js';
import { SolanaBlockhashProvider } from '../src/services/solana-blockhash-provider.js';
import {
  createSolanaSigner,
  expectedFingerprint,
  resetSignerFactory,
} from '../src/services/signer-factory.js';
import { runKmsPreflight, type KmsPreflightReport } from '../src/services/kms-preflight.js';

async function main(): Promise<void> {
  const signer = createSolanaSigner();

  /*
   * Провайдер blockhash создаётся только при заданном адресе узла.
   *
   * Подставить сюда публичный mainnet по умолчанию нельзя: проверка
   * ушла бы в боевую сеть, а отчёт выглядел бы успешным.
   */
  const rpc = env.SOLANA_PREFLIGHT_RPC_URL
    ? new FetchSolanaRpcClient(env.SOLANA_PREFLIGHT_RPC_URL, 10_000)
    : null;

  const blockhash = rpc
    ? new SolanaBlockhashProvider(rpc, {
        network: env.SOLANA_NETWORK,
        // Для проверки сеть читать можно и при выключенной подписи:
        // это чтение, и оно ничего не подписывает.
        signingEnabled: true,
      })
    : null;

  const report = await runKmsPreflight({
    provider: env.SOLANA_SIGNER_PROVIDER,
    network: env.SOLANA_NETWORK,
    signer,
    blockhash,
    expectedFingerprint: expectedFingerprint(),
    allowSign: env.KMS_PREFLIGHT_ALLOW_SIGN,
    // Общий расчёт — тот же, что у воркера и интерфейса.
    signingAllowed: signingStateFromConfig().allowsKmsCall,
  });

  print(report);
  resetSignerFactory();
  process.exit(report.status === 'FAILED' ? 1 : 0);
}

function print(report: KmsPreflightReport): void {
  /*
   * Печатается провайдер, сеть, отпечаток и адрес.
   *
   * Ни имени ресурса ключа, ни адреса узла, ни учётных данных:
   * первое выдаёт аккаунт и регион, второе может содержать
   * API-ключ в пути.
   */
  console.log(`\nПровайдер: ${report.provider}`);
  console.log(`Сеть:      ${report.network}`);

  for (const step of report.steps) {
    const mark = step.outcome === 'PASS' ? '✓' : step.outcome === 'SKIPPED' ? '·' : '✗';
    const note = step.code ?? step.detail ?? '';
    const latency = step.latencyMs == null ? '' : `  ${step.latencyMs} мс`;
    console.log(`  ${mark} ${step.name}${note ? `  ${note}` : ''}${latency}`);
  }

  if (report.identity) {
    console.log(
      `\nОтпечаток ключа: ${report.identity.fingerprint}` +
      `\nАдрес Solana:    ${report.identity.solanaAddress}` +
      `\nВерсия ключа:    ${report.identity.keyVersion}`,
    );
  }

  console.log(`\nИтог: ${verdictText(report)}\n`);

  if (report.status === 'IMPLEMENTED_NOT_VALIDATED') {
    console.log(
      'Настоящий вызов Sign не выполнялся. Провайдер, у которого ни\n' +
      'разу не просили подпись, готовым не считается: включите\n' +
      'KMS_PREFLIGHT_ALLOW_SIGN=true, чтобы подписать безденежную\n' +
      'проверочную транзакцию.\n',
    );
  }
}

function verdictText(report: KmsPreflightReport): string {
  switch (report.status) {
    case 'READY':
      return 'подпись проверена настоящим вызовом';
    case 'IMPLEMENTED_NOT_VALIDATED':
      return 'реализовано, живой подписи не было';
    case 'NOT_CONFIGURED':
      return 'провайдер не настроен';
    case 'NOT_RUN':
      return 'сеть не проверялась';
    default:
      return 'непригодно';
  }
}

main().catch((error: unknown) => {
  // Наружу выходит только тип ошибки: сообщение может содержать
  // имя ресурса или адрес узла.
  console.error(error instanceof Error ? error.name : 'KMS_PREFLIGHT_FAILED');
  process.exit(1);
});
