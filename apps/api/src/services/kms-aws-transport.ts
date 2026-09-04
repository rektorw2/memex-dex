import type { KmsTransport } from './kms-ed25519-adapters.js';
import { SignerError } from './solana-signer-contract.js';

/**
 * Транспорт до AWS KMS.
 *
 * Единственное место, где проект обращается к облаку за подписью.
 * Всё, что можно проверить без сети, проверено выше по стеку; здесь
 * остаётся вызов и приведение ответа к нашему виду.
 *
 * **Ленивая загрузка обязательна.** SDK импортируется динамически и
 * только тогда, когда провайдер действительно выбран. Статический
 * импорт создал бы ту же беду, что уже была с Prisma: модуль,
 * который всего лишь подключили, начинает искать регион, читать
 * цепочку учётных данных и падать в окружении, где ни того, ни
 * другого нет и не должно быть. Тесты при этом показывают ноль
 * падений и завершаются ненулевым кодом.
 *
 * **Учётные данные сюда не передаются.** Ни параметром, ни полем
 * конфигурации. Их находит стандартная цепочка SDK — переменные
 * окружения, роль задачи, профиль. Секрет, прошедший через сигнатуру
 * бизнес-метода, рано или поздно окажется в журнале вызовов.
 */

export interface AwsTransportOptions {
  region: string;
  /**
   * Идентификатор ключа.
   *
   * Наружу не выходит: имя ресурса рассказывает об аккаунте и
   * регионе больше, чем нужно кому бы то ни было.
   */
  keyId: string;
  /** Часы. Вынесены наружу ради проверяемости замера задержки. */
  now?: () => number;
}

/** Тип клиента без статического импорта: только для внутренних полей. */
type KmsClientLike = {
  send(command: unknown): Promise<Record<string, unknown>>;
  destroy?(): void;
};

/**
 * Клиент создаётся при первом вызове и переиспользуется.
 *
 * Не при импорте и не в конструкторе: конструктор вызывают, чтобы
 * описать конфигурацию, а не чтобы пойти в сеть.
 */
export class AwsKmsTransport implements KmsTransport {
  private client: KmsClientLike | null = null;
  private commands: Record<string, new (input: unknown) => unknown> | null = null;

  constructor(private readonly options: AwsTransportOptions) {}

  /** Был ли клиент создан. Нужно тестам и диагностике. */
  get instantiated(): boolean {
    return this.client !== null;
  }

  private async load(): Promise<{
    client: KmsClientLike;
    commands: Record<string, new (input: unknown) => unknown>;
  }> {
    if (this.client && this.commands) {
      return { client: this.client, commands: this.commands };
    }
    if (!this.options.region) throw new SignerError('SIGNER_REGION_NOT_CONFIGURED', false);
    if (!this.options.keyId) throw new SignerError('SIGNER_KEY_NOT_CONFIGURED', false);

    let sdk: Record<string, unknown>;
    try {
      // Динамический импорт: без выбранного провайдера этот модуль
      // не загружается вовсе и ничего не ищет в окружении.
      sdk = (await import('@aws-sdk/client-kms')) as unknown as Record<string, unknown>;
    } catch {
      throw new SignerError('SIGNER_SDK_UNAVAILABLE', false);
    }

    const KMSClient = sdk.KMSClient as new (config: { region: string }) => KmsClientLike;
    /*
     * Конфигурация — только регион.
     *
     * Ни ключей, ни токенов: их находит стандартная цепочка SDK.
     * Передать их сюда значит завести второй способ хранить секрет,
     * который однажды разойдётся с первым.
     */
    this.client = new KMSClient({ region: this.options.region });
    this.commands = {
      DescribeKey: sdk.DescribeKeyCommand as new (input: unknown) => unknown,
      GetPublicKey: sdk.GetPublicKeyCommand as new (input: unknown) => unknown,
      Sign: sdk.SignCommand as new (input: unknown) => unknown,
    };
    return { client: this.client, commands: this.commands };
  }

  async call(operation: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { client, commands } = await this.load();
    const Command = commands[operation];
    /*
     * Список операций закрытый.
     *
     * Транспорт, умеющий вызвать что угодно по имени, — это тот же
     * «подпиши произвольные байты», только уровнем ниже.
     */
    if (!Command) throw new SignerError('SIGNER_OPERATION_NOT_ALLOWED', false);

    try {
      return await client.send(new Command(payload));
    } catch (error: unknown) {
      throw classifyAwsError(error);
    }
  }

  /** Закрытие клиента. Несозданный закрывать нечего. */
  destroy(): void {
    this.client?.destroy?.();
    this.client = null;
    this.commands = null;
  }
}

/**
 * Ошибка провайдера в наш код.
 *
 * Наружу выходит классификация, а не сообщение: текст AWS содержит
 * имя ресурса, идентификатор аккаунта и регион.
 *
 * Отдельно выделено «неизвестно, что произошло». Разорванное
 * соединение не отвечает на вопрос, успела ли подпись создаться, и
 * повторять такой вызов автоматически нельзя — иначе под одним
 * намерением окажутся две подписи.
 */
export function classifyAwsError(error: unknown): SignerError {
  const name = errorName(error);

  switch (name) {
    case 'DisabledException':
    case 'KMSInvalidStateException':
      return new SignerError('SIGNER_KEY_STATE_INVALID', false);
    case 'InvalidKeyUsageException':
      return new SignerError('SIGNER_KEY_USAGE_INVALID', false);
    case 'NotFoundException':
    case 'InvalidArnException':
      return new SignerError('SIGNER_KEY_NOT_FOUND', false);
    case 'AccessDeniedException':
      return new SignerError('SIGNER_ACCESS_DENIED', false);
    case 'UnsupportedOperationException':
      return new SignerError('SIGNER_OPERATION_NOT_ALLOWED', false);
    case 'ThrottlingException':
    case 'LimitExceededException':
      return new SignerError('SIGNER_RATE_LIMITED', true);
    case 'CredentialsProviderError':
    case 'CredentialsError':
      return new SignerError('SIGNER_CREDENTIALS_UNAVAILABLE', false);
    case 'DependencyTimeoutException':
    case 'KeyUnavailableException':
    case 'KMSInternalException':
    case 'TimeoutError':
      /*
       * Ответ не получен. Успела подпись создаться или нет —
       * неизвестно, и это единственный честный ответ.
       */
      return new SignerError('SIGNER_AMBIGUOUS', false);
    default:
      return new SignerError('SIGNER_AMBIGUOUS', false);
  }
}

function errorName(error: unknown): string {
  if (error == null || typeof error !== 'object') return '';
  const candidate = error as { name?: unknown; __type?: unknown };
  if (typeof candidate.name === 'string' && candidate.name.length > 0) return candidate.name;
  // AWS иногда кладёт тип в `__type` вида `com.amazonaws...#Exception`.
  if (typeof candidate.__type === 'string') return candidate.__type.split('#').at(-1) ?? '';
  return '';
}
