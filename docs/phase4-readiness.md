# Phase 4 readiness

Дата последнего обновления: 2026-09-04 (Phase 4E). Этот документ описывает состояние кода, а не
разрешение принимать или отправлять реальные средства.

## Итог

| Контур | Статус | Подтверждение |
| --- | --- | --- |
| Изоляция PAPER/LIVE | READY | `packages/core/src/phase4.ts`, `apps/api/src/workers/paper-agent-isolation.test.ts`, `apps/api/src/chains/solana-live-block.test.ts` |
| LIVE state machines и Semi-Auto proposal schema | READY как контракт | `phase4.ts`, `LiveAgentProposal`, `SolanaTransaction`, `phase4.test.ts` |
| Mock Solana deposit pipeline | READY для тестов | `solana-deposit-pipeline.ts`, `solana-deposit-pipeline.test.ts` |
| Solana RPC deposit reader | PARTIAL | read-only source, позиционный instruction index и fail-closed разбор готовы; живой devnet-прогон NOT_RUN |
| Devnet preflight и dry-run | READY как инструмент | genesis-hash, latency, классификация отказов, бюджет просмотра; сетевой запуск за оператором |
| Safety latch | READY | поднимает сверка, снимает только ADMIN с записью в audit log |
| KMS signing contracts | IMPLEMENTED_NOT_VALIDATED | протокольные адаптеры AWS/GCP готовы; провайдер не выбран, транспорт не написан, живого вызова не было |
| Transaction Intent lifecycle | PARTIAL | источник, маршруты, аудит, истечение и подпись готовы; broadcast отсутствует по конструкции |
| Постоянный checkpoint и атомарное зачисление | PARTIAL | Prisma repository, lease и empty-range checkpoint готовы; funding заблокирован startup guard |
| On-chain reconciliation | PARTIAL | чистое сравнение и reorg issue готовы; production scheduler отсутствует |
| Solana confirmation/finality orchestrator | PARTIAL | mock transport, bounded reconciliation и фактический fill готовы; production RPC transport отсутствует |
| KMS | PARTIAL | production-safe interface, test adapter и audit wrapper готовы; AWS/GCP adapters честно возвращают unavailable |
| Выводы | PARTIAL | state machine, atomic/idempotent test contract, limits и audit готовы; Prisma/RPC execution не подключены |
| Compliance | PARTIAL | интерфейсы и `NOT_CONFIGURED` guards готовы; KYC/AML/sanctions providers отсутствуют |
| `/agent` Phase 4 UX | READY как заблокированный preview | PAPER/LIVE разделены; все LIVE controls disabled; funding adapter назван неподключённым |
| Реальные пополнения | BLOCKED | RPC source не проходил live-валидацию, reconciliation scheduler и разрешение запуска отсутствуют |
| Реальные сделки/выводы | BLOCKED | нет production signer/RPC/reconciliation и compliance approval |
| Mainnet launch | BLOCKED | external providers, legal/custody decision, operational runbooks and production migration remain open |

`READY как контракт` не означает `READY для средств`: это означает, что
переходы и отрицательные сценарии определены и проверяются без сети.

## Что существовало до Phase 4 foundation

- кастодиальная модель `Wallet`, зашифрованный ключевой материал и локальная
  envelope-encryption: `prisma/schema.prisma`, `apps/api/src/services/crypto.ts`;
- `Balance`, `LedgerEntry`, `Deposit`, `Withdrawal` и операции блокировки:
  `prisma/schema.prisma`, `apps/api/src/services/balances.ts`;
- whitelist SOL/USDC и точные decimals/minimum:
  `packages/core/src/deposit.ts`;
- PAPER Agent Phase 1–3 и отдельный PAPER capital ledger:
  `apps/api/src/workers/paper-agent.ts`, `docs/paper-agent.md`;
- Bridge/Coinbase subscription payments — отдельный money flow, не funding.

## Что добавлено

### Funding

- identity `signature:instructionIndex`, поэтому два перевода одной транзакции
  учитываются раздельно;
- raw provider event не содержит `userId`: владелец определяется только по
  активному `HOT_DEPOSIT` адресу в нашей БД;
- checkpoint lease, overlap после restart, finality-only credit, duplicate
  handling и reorg → manual review;
- `Deposit`, `LedgerEntry`, `Balance` и `SolanaDepositEvent=CREDITED` создаются
  в одной serializable transaction;
- canonical USDC mint, SOL/USDC decimals, minimum и confirmations проверяются
  до денежной записи;
- reconciliation обнаруживает missing/orphan/amount/destination/reorg mismatch
  и ничего не «исправляет» молча.

### Первый сетевой срез: read-only Solana RPC

- `SolanaRpcDepositEventSource` читает `getSignaturesForAddress`,
  `getSignatureStatuses` и `getTransaction` через транспорт, который не
  раскрывает RPC URL, API key или тело ответа в ошибке;
- сканируются owner-адрес и детерминированный canonical USDC ATA; SPL
  destination нормализуется обратно к owner, но право собственности всё равно
  повторно определяется базой перед зачислением;
- одна подпись, найденная по нескольким адресам, загружается один раз, а
  несколько transfer-инструкций получают стабильные отдельные индексы;
- source сообщает полностью просмотренный head slot, поэтому пустой диапазон
  тоже продвигает checkpoint; превышение окна пагинации завершает цикл ошибкой
  без продвижения checkpoint;
- последние 512 слотов перечитываются для защиты от краткой задержки индекса
  RPC и гонки добавления нового адреса; уникальность события не допускает
  повторного зачисления;
- первый запуск требует явно заданный bootstrap slot. Неограниченный backfill
  от genesis запрещён;
- worker подключён к общему lifecycle, но при безопасных значениях окружения
  не запускается. Общий Phase 4 startup blocker всё ещё не позволяет включить
  `FUNDING_ENABLED=true`.

### Phase 4C: подготовка к devnet

- `npm run solana:deposit-preflight` определяет сеть по genesis hash, измеряет
  задержку каждого метода и различает TIMEOUT / RATE_LIMITED /
  HISTORY_UNSUPPORTED / MALFORMED_RESPONSE / UNAUTHORIZED / NETWORK_MISMATCH;
- endpoint берётся только из `SOLANA_PREFLIGHT_RPC_URL`; без неё команда
  завершается, не сделав ни одного вызова. Ни URL, ни query, ни ключ не
  попадают в отчёт и журнал;
- `--dry-run` читает цепочку и печатает сводку, не имея доступа к базе:
  Prisma в модуль не импортируется;
- бюджет просмотра считается явно. `newAddressLookbackSlots = 216000` при
  `pageSize 100 × maxPages 10` выдерживает адрес не активнее ~41 подписи
  в час; сверх этого выдаётся `INSUFFICIENT_SCAN_BUDGET` вместо молчаливого
  сокращения окна;
- тестовый SPL-токен devnet задаётся отдельной переменной, называется
  `devnet test token` и запрещён на старте вне devnet и в production.
  Боевой whitelist не изменялся;
- защёлку снимает только ADMIN, роль читается из базы, снятие требует
  причины и попадает в `AuditLog`.

Живой запрос к devnet в этой работе не выполнялся: endpoint не предоставлен.
Статус сетевой проверки — `NOT_RUN`.

### Phase 4D–4E: подпись и жизненный цикл

- AWS KMS (`ED25519_SHA_512`, `MessageType: RAW`) и Google Cloud KMS
  (`EC_SIGN_ED25519`, поле `data`) подтверждены официальной документацией
  как способные подписывать Solana в режиме PureEdDSA;
- провайдер **не выбран**. Оба адаптера остаются в состоянии
  `NOT_CONFIGURED`, credentials не заводились, облачные ресурсы не
  создавались. Итоговый статус контура — `IMPLEMENTED_NOT_VALIDATED`;
- кодировка подписи EdDSA и предел размера сообщения у Google остаются
  `NOT_VERIFIED`: в документации их нет, и они обрабатываются защитно;
- намерение рождается только из предложения агента или служебной devnet-
  фикстуры администратора. Клиент не передаёт ни байтов, ни программ,
  ни адресов, ни сумм, ни blockhash — список запрещённых полей проверяется;
- `SIGNED` — конечное состояние. Переходов к отправке в машине нет,
  транспорт broadcast не импортируется ни одним модулем контура;
- одно предложение порождает не больше одного живого намерения, одно
  намерение — не больше одной подписи: оба правила закреплены частичными
  уникальными индексами, а не проверками в памяти.

Этот срез не делает пополнения рабочими. Ещё отсутствуют live-проверка
выбранного RPC, устойчивое обнаружение исчезнувшей pending-транзакции после
рестарта, reconciliation scheduler и операционная процедура выбора bootstrap
slot. До их появления hard blocker снимать нельзя.

### Execution, KMS, withdrawal, compliance

- подпись RPC не считается подтверждением; `SUBMITTED`, `CONFIRMED` и
  `FINALIZED` — разные состояния;
- broadcast claim сохраняется до RPC; `AMBIGUOUS` только reconciles и никогда
  не даёт повторный broadcast;
- KMS interface не возвращает private key при signing и пишет только безопасные
  metadata audit events;
- withdrawal contract требует finalized funds, compliance approval, limits,
  atomic lock, idempotency и ручное approval;
- отсутствие любого compliance provider никогда не превращается в approval.

## Что всё ещё невозможно с реальными средствами

1. Запустить автоматическое зачисление реального перевода SOL/USDC: read-only
   источник уже существует, но worker намеренно заблокирован.
2. Подписать или отправить swap в Solana mainnet.
3. Подтвердить Semi-Auto предложение и начать реальное исполнение.
4. Подписать, отправить или финализировать реальный вывод.
5. Получить KYC/AML/sanctions/source-of-funds approval.
6. Включить LIVE через браузер или только комбинацией env-флагов.

`apps/api/src/chains/solana.ts` жёстко возвращает
`LIVE_SOLANA_EXECUTION_NOT_IMPLEMENTED` для non-paper execution. Startup guard
останавливает процесс при любом Phase 4 network flag, даже если оператор
ошибочно выставил readiness-флаги.

## Внешние блокеры

- выбранный Solana RPC/indexer с SLA, archive access и finality semantics;
- production AWS KMS или GCP KMS account, credentials, IAM policy, rotation и
  recovery procedure;
- KYC/AML/sanctions providers и юридическое решение по custody;
- production deposit address policy, hot/cold limits и incident runbook;
- dry-run production migration audit и отдельное разрешение владельца системы.

## Safe defaults

```env
EXECUTION_MODE=paper
FUNDING_ENABLED=false
LIVE_AGENT_ENABLED=false
LIVE_EXECUTION_ENABLED=false
WITHDRAWALS_ENABLED=false
LIVE_RPC_READY=false
LIVE_RECONCILIATION_ENABLED=false
LIVE_MIGRATIONS_READY=false
LIVE_AGENT_CONTROL_MODE=semi-auto
SOLANA_DEPOSIT_SOURCE=disabled

# Контур подписи транзакций Solana. Отдельный от custody encryption.
SOLANA_SIGNING_ENABLED=false
SOLANA_SIGNER_PROVIDER=unavailable
KMS_PREFLIGHT_ALLOW_SIGN=false
```

## Три контура, которые нельзя путать

Слово «KMS» встречалось в именах переменных двух разных подсистем, и
это склеило их в одну. Из-за склейки интерфейс сообщал одно
состояние, а воркер подписи находился в другом.

| Контур | Что делает | Переменные |
|---|---|---|
| Custody encryption | Шифрует сохранённый key material | `KMS_PROVIDER`, `KMS_LOCAL_MASTER_KEY`, `AWS_KMS_KEY_ID` |
| Transaction signer | Подписывает транзакции Solana облачным Ed25519 | `SOLANA_SIGNING_ENABLED`, `SOLANA_SIGNER_PROVIDER`, `SOLANA_SIGNER_KEY_ID`, `AWS_REGION` |
| Broadcast | Отправляет подписанное в сеть | не существует; `broadcastAvailable` — константа `false` |

Единственный переключатель подписи — `SOLANA_SIGNING_ENABLED`.
Настоящий вызов `Sign` не зависит ни от какого другого boolean.

`KMS_SIGNING_ENABLED` объявлен устаревшим. Он относился к готовности
LIVE-контура и подписью не управлял:

- отсутствие и `false` принимаются без изменений;
- `true` останавливает старт с указанием, куда переехала настройка;
- несовпадение значений не разрешается в пользу «включено»;
- вне слоя совместимости в `env.ts` флаг не читается — за этим
  следит контрактный тест.

Состояние контура считает одна чистая функция,
`transactionSigningState` в `@memex/core`. Её используют startup
guards, фабрика подписанта, воркер, API, `/agent` и админская
диагностика. Повторного расчёта по частям нет нигде.

Проверить конфигурацию, ничего не меняя и никуда не обращаясь:

```bash
npm run phase4:config-audit
```

## Миграция

`20260827160000_add_phase4_live_foundation` — additive-only: новые enum,
таблицы и индексы. В ней нет `DROP`, `DELETE` или `TRUNCATE`; существующие
денежные строки не переписываются. Production migration не выполнялась.
