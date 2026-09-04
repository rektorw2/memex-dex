-- Подготовка и подпись транзакций Solana. Только добавление:
-- ни одна существующая колонка не меняет тип, не переименовывается
-- и не удаляется, ни одна денежная строка не переписывается.
--
-- Отправки здесь нет. Состояний SUBMITTED, CONFIRMED и FINALIZED
-- в модели не предусмотрено намеренно: подпись и отправка — разные
-- события, и склеивать их в один статус значит однажды показать
-- «отправлено» про перевод, которого не было.

CREATE TABLE IF NOT EXISTS "TransactionIntent" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "walletId" TEXT NOT NULL,
  "network" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,

  -- Денежная часть. После APPROVED не меняется.
  -- Суммы текстом: u64 не помещается в число с плавающей точкой,
  -- а округление здесь стоит ровно столько, сколько округлило.
  "mint" TEXT,
  "rawAmount" TEXT NOT NULL,
  "sourceAddress" TEXT NOT NULL,
  "destinationAddress" TEXT NOT NULL,
  "feeLimitLamports" TEXT NOT NULL,
  "slippageBps" INTEGER NOT NULL,
  "allowedProgramIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

  "recentBlockhash" TEXT NOT NULL,
  "lastValidBlockHeight" TEXT NOT NULL,
  -- Хранится хеш, а не сообщение: полная транзакция в базе — это
  -- содержимое чужих переводов там, где его читают все.
  "messageHash" TEXT NOT NULL,
  "policyVersion" TEXT NOT NULL,

  "state" TEXT NOT NULL DEFAULT 'DRAFT',
  "approvedAt" TIMESTAMP(3),
  "approvedBy" TEXT,

  "keyProvider" TEXT,
  "keyId" TEXT,
  "keyVersion" TEXT,
  "keyFingerprint" TEXT,

  "signingClaimedBy" TEXT,
  "signingClaimedAt" TIMESTAMP(3),
  "signature" TEXT,
  "signedAt" TIMESTAMP(3),
  "failureCode" TEXT,

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TransactionIntent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TransactionIntent_userId_state_idx"
  ON "TransactionIntent" ("userId", "state");
CREATE INDEX IF NOT EXISTS "TransactionIntent_state_expiresAt_idx"
  ON "TransactionIntent" ("state", "expiresAt");

-- Попытка подписи. Отвечает не «чем кончилось», а «что происходило»:
-- неоднозначный ответ провайдера обязан оставить след, по которому
-- видно, что повторять нельзя до ручного разбора.
CREATE TABLE IF NOT EXISTS "SigningAttempt" (
  "id" TEXT NOT NULL,
  "intentId" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "code" TEXT,
  "keyVersion" TEXT,
  "claimedBy" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt" TIMESTAMP(3),
  CONSTRAINT "SigningAttempt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SigningAttempt_intentId_startedAt_idx"
  ON "SigningAttempt" ("intentId", "startedAt");

-- Одно намерение — одна подпись.
--
-- Последняя линия обороны после атомарного захвата: если захват
-- когда-нибудь окажется обойдён, база всё равно не даст записать
-- вторую подпись под тем же намерением.
CREATE UNIQUE INDEX IF NOT EXISTS "SigningAttempt_one_success_per_intent"
  ON "SigningAttempt" ("intentId") WHERE "outcome" = 'SUCCEEDED';
