-- Кошелёк, выбранный для LIVE-операций агента, по сетям. Только добавление.
--
-- Выбор хранится на сервере: подготовка LIVE-операции читает его и
-- проверяет принадлежность кошелька пользователю. Интерфейс лишь
-- показывает и меняет выбор. Ни DROP, ни ALTER существующих таблиц.
--
-- Внешний ключ на User задаётся в самой таблице: отдельный ALTER
-- после CREATE оставил бы окно, в котором таблица есть, а связи нет.
-- Уникальность «одна запись на сеть» — последним оператором: без неё
-- таблица считается применённой наполовину, и загрузчик останавливается.

CREATE TABLE IF NOT EXISTS "AgentLiveWallet" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "network" "Chain" NOT NULL,
  "walletId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AgentLiveWallet_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AgentLiveWallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "AgentLiveWallet_userId_network_key"
  ON "AgentLiveWallet" ("userId", "network");
