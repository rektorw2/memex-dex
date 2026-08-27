# Phase 4 readiness

Дата аудита: 2026-08-27. Этот документ описывает состояние кода, а не
разрешение принимать или отправлять реальные средства.

## Итог

| Контур | Статус | Подтверждение |
| --- | --- | --- |
| Изоляция PAPER/LIVE | READY | `packages/core/src/phase4.ts`, `apps/api/src/workers/paper-agent-isolation.test.ts`, `apps/api/src/chains/solana-live-block.test.ts` |
| LIVE state machines и Semi-Auto proposal schema | READY как контракт | `phase4.ts`, `LiveAgentProposal`, `SolanaTransaction`, `phase4.test.ts` |
| Mock Solana deposit pipeline | READY для тестов | `solana-deposit-pipeline.ts`, `solana-deposit-pipeline.test.ts` |
| Постоянный checkpoint и атомарное зачисление | PARTIAL | `PrismaSolanaDepositRepository` и additive schema готовы; реальный source/worker отсутствует |
| On-chain reconciliation | PARTIAL | чистое сравнение и reorg issue готовы; нет production chain reader/scheduler |
| Solana confirmation/finality orchestrator | PARTIAL | mock transport, bounded reconciliation и фактический fill готовы; production RPC transport отсутствует |
| KMS | PARTIAL | production-safe interface, test adapter и audit wrapper готовы; AWS/GCP adapters честно возвращают unavailable |
| Выводы | PARTIAL | state machine, atomic/idempotent test contract, limits и audit готовы; Prisma/RPC execution не подключены |
| Compliance | PARTIAL | интерфейсы и `NOT_CONFIGURED` guards готовы; KYC/AML/sanctions providers отсутствуют |
| `/agent` Phase 4 UX | READY как заблокированный preview | PAPER/LIVE разделены; все LIVE controls disabled; funding adapter назван неподключённым |
| Реальные пополнения | BLOCKED | нет production event source, RPC credentials и запущенного worker |
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

1. Автоматически увидеть реальный перевод SOL/USDC и зачислить его.
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
KMS_SIGNING_ENABLED=false
LIVE_AGENT_CONTROL_MODE=semi-auto
```

## Миграция

`20260827160000_add_phase4_live_foundation` — additive-only: новые enum,
таблицы и индексы. В ней нет `DROP`, `DELETE` или `TRUNCATE`; существующие
денежные строки не переписываются. Production migration не выполнялась.
