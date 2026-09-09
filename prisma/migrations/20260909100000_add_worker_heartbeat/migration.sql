-- Пульс воркера агента. Только добавление: одна новая таблица,
-- ни DROP, ни ALTER существующих таблиц.
--
-- Нужна, когда воркеры работают в отдельном процессе: API не видит
-- их памяти и без этой строки может ответить на /health/agent только
-- «неизвестно». Воркер пишет начало и успешное завершение прохода.
-- Индексов кроме первичного ключа нет: строка одна на воркер.

CREATE TABLE IF NOT EXISTS "WorkerHeartbeat" (
  "name" TEXT NOT NULL,
  "processId" TEXT NOT NULL,
  "hostname" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "lastTickStartedAt" TIMESTAMP(3),
  "lastTickCompletedAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("name")
);
