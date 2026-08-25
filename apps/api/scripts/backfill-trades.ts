/**
 * Свёртка старых дублей экономических сделок и пересчёт рейтингов.
 *
 * По умолчанию ничего не пишет. Изменение базы — только с `--apply`,
 * и это не формальность: свёртка меняет суммы в записях, по которым
 * считаются позиции.
 *
 *   npm run trades:backfill                       пробный прогон
 *   npm run trades:backfill -- --wallet=Gx…928f   один кошелёк
 *   npm run trades:backfill -- --apply            запись
 *   npm run trades:backfill -- --rescore          пересчёт кошельков
 *
 * На боевой базе `--apply` не запускается без отдельного решения.
 */

import { prisma } from '../src/lib/prisma.js';
import { backfillEconomicTrades } from '../src/services/trade-backfill.js';
import { rescoreAllWallets } from '../src/workers/wallet-tracker.js';

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function value(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split('=').slice(1).join('=') || undefined;
}

function num(name: string): number | undefined {
  const raw = value(name);
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

async function main(): Promise<void> {
  const apply = flag('apply');

  console.log(apply ? '=== ЗАПИСЬ В БАЗУ ===' : '=== Пробный прогон: база не изменяется ===');

  const report = await backfillEconomicTrades({
    apply,
    wallet: value('wallet'),
    chain: value('chain'),
    limit: num('limit'),
    batchSize: num('batch-size'),
  });

  console.log('\nСвёртка сделок');
  console.log(`  просмотрено строк:        ${report.scanned}`);
  console.log(`  найдено групп:            ${report.groups}`);
  console.log(`  групп с несколькими fill: ${report.multiFillGroups}`);
  console.log(`  станут свёрнутыми:        ${report.wouldSupersede}`);
  console.log(`  неоднозначных групп:      ${report.ambiguousGroups}`);
  console.log(`  затронуто кошельков:      ${report.walletsAffected}`);
  console.log(`  длительность:             ${report.durationMs} мс`);

  if (apply) {
    console.log(`  записано канонических:    ${report.canonicalWritten}`);
    console.log(`  помечено свёрнутыми:      ${report.supersededWritten}`);
  } else if (report.groups > 0) {
    /*
     * Оценка времени по пробному прогону, а не выдуманная константа.
     * Запись стоит дороже чтения, поэтому запас втрое.
     */
    const perGroup = report.durationMs / Math.max(1, report.groups);
    console.log(
      `\n  ожидаемое время записи:   примерно ${Math.ceil((perGroup * report.groups * 3) / 1000)} с`,
    );
    console.log('  повторите с --apply, чтобы записать');
  }

  if (flag('rescore')) {
    const r = await rescoreAllWallets({ apply, batchSize: num('batch-size'), limit: num('limit') });

    console.log('\nПересчёт кошельков');
    console.log(`  просмотрено:              ${r.scanned}`);
    console.log(`  ждали пересчёта:          ${r.staleFound}`);
    console.log(`  обновлено:                ${r.updated}`);
    console.log(`  без изменений:            ${r.unchanged}`);
    console.log(`  оценка снята:             ${r.scoreCleared}`);
    console.log(`  нарушений инвариантов:    ${r.invariantViolations}`);

    /*
     * Наблюдаемая идемпотентность.
     *
     * Второй прогон подряд обязан не изменить ни одного значимого
     * поля. Если он что-то меняет, расчёт зависит от чего-то, кроме
     * данных, — и это стоит увидеть до боевого запуска, а не после.
     */
    if (r.scanned > 0 && r.unchanged === r.scanned) {
      console.log('  повторный прогон ничего не меняет: расчёт устойчив');
    }

    if (!apply) console.log('  повторите с --apply, чтобы записать');
  }
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
