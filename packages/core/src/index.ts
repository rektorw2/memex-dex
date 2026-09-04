export * from './money.js';
export * from './position.js';
export * from './fees.js';
export * from './orders.js';
export * from './copy.js';
export * from './risk.js';
export * from './wallet-score.js';

// Один токен — один оцениваемый исход, и один контракт
// результативности со своим знаменателем.
export * from './favorites-sync.js';
export * from './wallet-token-outcome.js';
export * from './wallet-performance.js';
export * from './token-ref.js';
export * from './copy-pending.js';
export * from './auto-exit.js';
export * from './withdrawal.js';
export * from './scam-gate.js';
export * from './api-scopes.js';
export * from './exit-presets.js';
export * from './cross-source.js';
export * from './round-trip.js';
// Из impersonation остались только checkSanity и пороги: проверка
// подделок переехала в token-registry.
export { checkSanity, MAX_PLAUSIBLE_LIQUIDITY_USD, MAX_PLAUSIBLE_CHANGE_PCT } from './impersonation.js';
export * from './risk-model.js';
export * from './market-listing.js';
export * from './token-registry.js';
// Модель OKX и реестр токенизированных акций. Разделены намеренно:
// первое — про формат чужих ответов, второе — про подделки под бумаги.
export * from './okx-model.js';
export * from './rwa.js';
// Шкала риска для показа человеку: подписи, знаки, время, кратность.
// Отдельно от risk-model.ts — тот про допуск, эта про читаемость.
export * from './risk-scale.js';
// Состояние пула. Отдельно от проверки контракта: та отвечает
// «можно ли продать в принципе», эта — «есть ли кому продать сейчас».
export * from './pool-health.js';
export * from './downsample.js';
// Уверенность в оценке кошелька — отдельно от самой оценки.
export * from './wallet-confidence.js';
// Расчёт результата кошелька: что считать сделкой, учёт позиций,
// четыре независимые оценки вместо одной.
export * from './economic-trade.js';
export * from './position-ledger.js';
export * from './wallet-pnl.js';
export * from './smart-score-v2.js';
// Модели кошельков OKX и разбор ответов. Чистая часть интеграции:
// проверяется тестами без сети и без ключей.
export * from './okx-wallet-model.js';
// Живые события и раскладка подписок. Тоже чистая часть: сокета здесь нет.
export * from './okx-ws-model.js';
// Сигналы Smart Money/KOL/Whale — отдельный формат OKX.
export * from './okx-signal.js';
// Детерминированные правила и бухгалтерия автономного paper-агента.
// Никакого транспорта или боевого исполнения этот модуль не импортирует.
export * from './paper-agent.js';
export * from './paper-allocation.js';
// История DEX — единственный источник точных количеств.
export * from './okx-dex-history.js';

// Что считать одной экономической сделкой: идентичность по источнику,
// сложение fill'ов и сверка истории с живой лентой.
export * from './economic-identity.js';
// Полнота истории и позиции с неизвестной себестоимостью.
export * from './ledger-completeness.js';
export * from './decimal-fit.js';

// Состояния результата: пустота, ожидание и недостаток истории — разное.
export * from './pnl-display.js';

// Ключ избранного кошелька: сеть плюс нормализованный адрес.
export * from './favorite-key.js';

// Полнота проверок: неизвестное не равно безопасному.
export * from './risk-completeness.js';

// Перевод ответов провайдеров в обязательные проверки.
export * from './risk-signal-adapter.js';

// Типы кошельков OKX: у каждого эндпоинта свой словарь.
export * from './okx-wallet-type.js';

// Детерминированный допуск автоматической покупки.
export * from './risk-gate-decision.js';

// Права по плану подписки и пробному периоду.
export * from './subscription-catalog.js';
export * from './payment-state.js';
export * from './payment-provider.js';
export * from './access-indicator.js';
export * from './auth-rules.js';
export * from './entitlements.js';
export * from './route-access.js';
export * from './api-base.js';
export * from './discovery-filters.js';
export * from './chart-state.js';
export * from './candle-history.js';
export * from './chart-live.js';

// Веса вынесены из проверки: россыпью по коду их нельзя было
// ни прочитать целиком, ни сложить в голове.
export * from './risk-weights.js';

// Что мы знаем о токене (статус проверки) и кого проверять
// следующим (политика очереди).
export * from './check-status.js';
export * from './check-queue.js';

// Чем закончился проход к провайдеру и стоит ли отступить.
export * from './provider-cycle.js';

// Тарификация OKX: какой endpoint из какой квоты списывается,
// сколько её на каждом плане и кого тормозить у предела.
export * from './okx-tiers.js';
export * from './okx-budget.js';
export * from './plans-presentation.js';
export * from './deposit.js';
export * from './phase4.js';

// Сверка зачислений с цепочкой: что считать расхождением, когда
// исчезновение транзакции перестаёт быть сбоем сети и что при этом
// происходит с контуром пополнений.
export * from './solana-reconciliation.js';

// Помещается ли окно просмотра в пределы одного прохода и с какого
// слота вообще начинать в первый раз.
export * from './solana-scan-budget.js';

// Умеет ли хранилище ключей подписывать Solana, и что именно
// подписывается: намерение, собранное сервером, а не байты клиента.
export * from './kms-compatibility.js';
export * from './transaction-intent.js';

// Откуда берётся намерение, что вправе прислать клиент и что
// остаётся в журнале после каждого перехода.
export * from './intent-lifecycle.js';

// Чей ключ подписывает, свеж ли blockhash и что показывать
// человеку про готовность контура подписи.
export * from './signing-identity.js';
export * from './transaction-signing-state.js';
export * from './email-verification.js';
export * from './email-message.js';
