-- CreateEnum
CREATE TYPE "PlanCode" AS ENUM ('EXPIRED', 'TRIAL', 'PRO', 'SEMI_AUTO', 'FULL_AUTO');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "SubscriptionSource" AS ENUM ('PAYMENT', 'TRIAL', 'ADMIN_GRANT', 'PROMO', 'MIGRATION');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('BRIDGE', 'COINBASE');

-- CreateEnum
CREATE TYPE "PaymentState" AS ENUM ('CREATED', 'KYC_REQUIRED', 'AWAITING_FUNDS', 'IN_REVIEW', 'FUNDS_RECEIVED', 'PAYMENT_SUBMITTED', 'PAID', 'UNDELIVERABLE', 'FAILED', 'MANUAL_REVIEW_REQUIRED');

-- CreateEnum
CREATE TYPE "KycState" AS ENUM ('NOT_STARTED', 'INCOMPLETE', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'PAUSED', 'OFFBOARDED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailCodeAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "emailCodeExpires" TIMESTAMP(3),
ADD COLUMN     "emailCodeHash" TEXT,
ADD COLUMN     "emailCodeIssuedAt" TIMESTAMP(3),
ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "plan" "PlanCode" NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "source" "SubscriptionSource" NOT NULL DEFAULT 'PAYMENT',
    "externalReference" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntitlementAudit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "previousPlan" "PlanCode" NOT NULL,
    "nextPlan" "PlanCode" NOT NULL,
    "reason" TEXT NOT NULL,
    "source" "SubscriptionSource" NOT NULL,
    "actorUserId" TEXT,
    "metadata" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EntitlementAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentCustomer" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL DEFAULT 'BRIDGE',
    "externalKycLinkId" TEXT,
    "externalCustomerId" TEXT,
    "kycState" "KycState" NOT NULL DEFAULT 'NOT_STARTED',
    "tosAccepted" BOOLEAN NOT NULL DEFAULT false,
    "kycUrl" TEXT,
    "tosUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentCustomer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionPayment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "customerId" TEXT,
    "plan" "PlanCode" NOT NULL,
    "priceAmount" DECIMAL(24,8) NOT NULL,
    "priceCurrency" TEXT NOT NULL,
    "termDays" INTEGER NOT NULL,
    "sourceCurrency" TEXT NOT NULL,
    "sourceAmount" DECIMAL(24,8) NOT NULL,
    "destinationCurrency" TEXT NOT NULL,
    "destinationChain" TEXT NOT NULL,
    "destinationAddress" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL DEFAULT 'BRIDGE',
    "providerTransferId" TEXT,
    "partnerUserRef" TEXT,
    "checkoutExpiresAt" TIMESTAMP(3),
    "clientReference" TEXT NOT NULL,
    "state" "PaymentState" NOT NULL DEFAULT 'CREATED',
    "depositMessage" TEXT,
    "depositBankName" TEXT,
    "depositAccountNumber" TEXT,
    "depositRoutingNumber" TEXT,
    "deliveredAmount" DECIMAL(24,8),
    "providerFee" DECIMAL(24,8),
    "exchangeFee" DECIMAL(24,8),
    "purchaseAmount" DECIMAL(24,8),
    "purchaseCurrency" TEXT,
    "purchaseNetwork" TEXT,
    "paymentSubtotal" DECIMAL(24,8),
    "paymentTotal" DECIMAL(24,8),
    "paymentCurrency" TEXT,
    "networkFee" DECIMAL(24,8),
    "deliveredToAddress" TEXT,
    "providerTxType" TEXT,
    "destinationTxHash" TEXT,
    "receiptUrl" TEXT,
    "reviewReason" TEXT,
    "grantedSubscriptionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "SubscriptionPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookReceipt" (
    "id" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL DEFAULT 'BRIDGE',
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventCreatedAt" TIMESTAMP(3) NOT NULL,
    "outcome" TEXT NOT NULL,
    "paymentId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Subscription_userId_status_startsAt_idx" ON "Subscription"("userId", "status", "startsAt");

-- CreateIndex
CREATE INDEX "Subscription_status_expiresAt_idx" ON "Subscription"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "Subscription_source_createdByUserId_idx" ON "Subscription"("source", "createdByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_source_externalReference_key" ON "Subscription"("source", "externalReference");

-- CreateIndex
CREATE INDEX "EntitlementAudit_userId_occurredAt_idx" ON "EntitlementAudit"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "EntitlementAudit_subscriptionId_occurredAt_idx" ON "EntitlementAudit"("subscriptionId", "occurredAt");

-- CreateIndex
CREATE INDEX "EntitlementAudit_actorUserId_occurredAt_idx" ON "EntitlementAudit"("actorUserId", "occurredAt");

-- CreateIndex
CREATE INDEX "PaymentCustomer_externalCustomerId_idx" ON "PaymentCustomer"("externalCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentCustomer_userId_provider_key" ON "PaymentCustomer"("userId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPayment_partnerUserRef_key" ON "SubscriptionPayment"("partnerUserRef");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPayment_clientReference_key" ON "SubscriptionPayment"("clientReference");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPayment_grantedSubscriptionId_key" ON "SubscriptionPayment"("grantedSubscriptionId");

-- CreateIndex
CREATE INDEX "SubscriptionPayment_userId_createdAt_idx" ON "SubscriptionPayment"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "SubscriptionPayment_state_createdAt_idx" ON "SubscriptionPayment"("state", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPayment_provider_providerTransferId_key" ON "SubscriptionPayment"("provider", "providerTransferId");

-- CreateIndex
CREATE INDEX "WebhookReceipt_receivedAt_idx" ON "WebhookReceipt"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookReceipt_provider_eventId_key" ON "WebhookReceipt"("provider", "eventId");

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntitlementAudit" ADD CONSTRAINT "EntitlementAudit_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentCustomer" ADD CONSTRAINT "PaymentCustomer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "PaymentCustomer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_grantedSubscriptionId_fkey" FOREIGN KEY ("grantedSubscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────
-- Ниже — SQL, добавленный вручную. Prisma частичные индексы
-- не описывает, поэтому эти два ограничения живут здесь.
-- ─────────────────────────────────────────────────────────────────────

-- Один действующий план на пользователя.
--
-- Проверку выполняет Postgres на каждой вставке: два одновременных
-- платежа не могут создать две активные подписки, сколько бы проверок
-- ни было в коде и в каком бы порядке они ни выполнялись.
--
-- Индекс частичный намеренно: истории он не мешает. У одного
-- пользователя может лежать сколько угодно отменённых и истёкших
-- договоров — под ограничение попадают только строки со статусом
-- ACTIVE.
CREATE UNIQUE INDEX "Subscription_one_active_per_user"
  ON "Subscription" ("userId")
  WHERE "status" = 'ACTIVE';

-- Один пробный период на пользователя за всё время.
--
-- Условие по плану, а не по статусу: истёкший пробный период тоже
-- занимает место. Ограничение «один *действующий* пробный период»
-- обходилось бы ожиданием пяти суток и повторной активацией,
-- и обходилось бы бесконечно.
--
-- Обычный @@unique([userId, plan]) сюда не годится: он заодно
-- запретил бы купить PRO во второй раз после отмены первого.
CREATE UNIQUE INDEX "Subscription_one_trial_per_user"
  ON "Subscription" ("userId")
  WHERE "plan" = 'TRIAL';
