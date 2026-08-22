export * from './money.js';
export * from './position.js';
export * from './fees.js';
export * from './orders.js';
export * from './copy.js';
export * from './risk.js';
export * from './wallet-score.js';
export * from './auto-rule.js';
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
export * from './smart-score-v2.js';
// Модели кошельков OKX и разбор ответов. Чистая часть интеграции:
// проверяется тестами без сети и без ключей.
export * from './okx-wallet-model.js';
// Живые события и раскладка подписок. Тоже чистая часть: сокета здесь нет.
export * from './okx-ws-model.js';
// История DEX — единственный источник точных количеств.
export * from './okx-dex-history.js';
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
export * from './entitlements.js';
export * from './route-access.js';
export * from './deposit.js';
export * from './email-verification.js';
export * from './email-message.js';
