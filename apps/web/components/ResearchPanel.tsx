'use client';

import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';

/**
 * Разбор токена: проверяемые факты и отдельно — трактовка модели.
 *
 * Две части разнесены сознательно. «Активен mint authority» — факт,
 * который читается из контракта и перепроверяется за минуту.
 * «Команда выглядит анонимной» — суждение, которое может быть ошибочным.
 * Смешивать их в один вывод значит выдавать догадку за проверенное.
 */

interface Props {
  tokenId: string;
  research: any | null;
  isAdmin: boolean;
  onUpdated: () => void;
}

const SENTIMENT: Record<string, { label: string; cls: string }> = {
  positive: { label: 'позитивный', cls: 'text-up' },
  neutral: { label: 'нейтральный', cls: 'text-muted' },
  negative: { label: 'негативный', cls: 'text-down' },
  unknown: { label: 'не определён', cls: 'text-muted' },
};

export function ResearchPanel({ tokenId, research, isAdmin, onUpdated }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(force: boolean) {
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/tokens/${tokenId}/research`, {
        method: 'POST',
        body: JSON.stringify({ force }),
      });
      onUpdated();
    } catch (e) {
      setError(errorMessage(e, 'Разбор не выполнен'));
    } finally {
      setBusy(false);
    }
  }

  const sec = research?.security ?? {};
  const socials = research?.socials ?? {};
  const ai = research?.ai;
  const warnings: string[] = sec.warnings ?? [];

  return (
    <div className="panel p-4 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="font-medium">Разбор проекта</h2>
        {isAdmin && (
          <button
            onClick={() => run(Boolean(research))}
            disabled={busy}
            className="btn-ghost text-xs"
          >
            {busy ? 'Собираем…' : research ? 'Обновить разбор' : 'Запустить разбор'}
          </button>
        )}
      </div>

      {error && (
        <p className="text-xs text-down bg-down/10 border border-down/30 rounded p-2">{error}</p>
      )}

      {!research ? (
        <p className="text-sm text-muted">
          {isAdmin
            ? 'Разбор ещё не проводился. Соберём права контракта, распределение по держателям, каналы проекта и поищем упоминания в сети.'
            : 'Разбор этого токена ещё не проводился.'}
        </p>
      ) : (
        <>
          {/* Проверяемые факты о контракте */}
          <section>
            <h3 className="text-sm font-medium mb-2">Контракт</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
              <Fact label="Продажа" ok={sec.isHoneypot === false} bad={sec.isHoneypot === true}
                    value={sec.isHoneypot === true ? 'заблокирована' : sec.isHoneypot === false ? 'работает' : 'нет данных'} />
              <Fact label="Эмиссия" ok={sec.mintable === false} bad={sec.mintable === true}
                    value={sec.mintable === true ? 'можно допечатать' : sec.mintable === false ? 'закрыта' : 'нет данных'} />
              <Fact label="Заморозка" ok={sec.freezable === false} bad={sec.freezable === true}
                    value={sec.freezable === true ? 'возможна' : sec.freezable === false ? 'невозможна' : 'нет данных'} />
              <Fact label="Налог продажи"
                    value={sec.sellTaxPct != null ? `${sec.sellTaxPct.toFixed(1)}%` : 'нет данных'}
                    bad={(sec.sellTaxPct ?? 0) > 10} />
              <Fact label="У создателя"
                    value={sec.creatorPct != null ? `${sec.creatorPct.toFixed(1)}%` : 'нет данных'}
                    bad={(sec.creatorPct ?? 0) > 15} />
              <Fact label="Топ-10 держат"
                    value={sec.top10Pct != null ? `${sec.top10Pct.toFixed(0)}%` : 'нет данных'}
                    bad={(sec.top10Pct ?? 0) > 50} />
            </div>

            {warnings.length > 0 && (
              <ul className="mt-3 space-y-1.5 text-sm">
                {warnings.map((w, i) => (
                  <li key={i} className="flex gap-2 text-muted">
                    <span className="text-down shrink-0">•</span>{w}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Каналы проекта */}
          {(socials.twitter || socials.telegram || socials.websites?.length > 0) && (
            <section>
              <h3 className="text-sm font-medium mb-2">Каналы проекта</h3>
              <div className="flex flex-wrap gap-2 text-xs">
                {socials.websites?.map((w: string) => (
                  <Ext key={w} href={w}>Сайт</Ext>
                ))}
                {socials.twitter && (
                  <Ext href={`https://x.com/${socials.twitter}`}>X · @{socials.twitter}</Ext>
                )}
                {socials.telegram && (
                  <Ext href={`https://t.me/${socials.telegram}`}>Telegram</Ext>
                )}
                {socials.discord && <Ext href={socials.discord}>Discord</Ext>}
              </div>
              {socials.description && (
                <p className="text-sm text-muted mt-3 leading-relaxed">{socials.description}</p>
              )}
            </section>
          )}

          {/* Трактовка модели */}
          {ai ? (
            <section className="border-t border-border pt-4">
              <div className="flex items-center gap-3 mb-2 flex-wrap">
                <h3 className="text-sm font-medium">Репутация</h3>
                <span
                  className={`text-xl num ${
                    ai.riskScore > 60 ? 'text-down' : ai.riskScore > 30 ? 'text-yellow-400' : 'text-up'
                  }`}
                >
                  {ai.riskScore}
                </span>
                <span className="text-xs text-muted">из 100</span>
                {ai.sentiment && (
                  <span className={`text-xs ${SENTIMENT[ai.sentiment]?.cls ?? 'text-muted'}`}>
                    фон {SENTIMENT[ai.sentiment]?.label ?? ai.sentiment}
                  </span>
                )}
              </div>

              <p className="text-sm text-muted leading-relaxed">{ai.summary}</p>

              {ai.riskFactors?.length > 0 && (
                <ul className="mt-3 space-y-1.5 text-sm">
                  {ai.riskFactors.map((f: string, i: number) => (
                    <li key={i} className="flex gap-2 text-muted">
                      <span className="text-down shrink-0">•</span>{f}
                    </li>
                  ))}
                </ul>
              )}

              {ai.sources?.length > 0 && (
                <div className="mt-3">
                  <p className="text-xs text-muted mb-1.5">Источники:</p>
                  <div className="flex flex-wrap gap-2">
                    {ai.sources.map((s: any, i: number) => (
                      <Ext key={i} href={s.url}>{(s.title || s.url).slice(0, 40)}</Ext>
                    ))}
                  </div>
                </div>
              )}

              <p className="text-xs text-muted mt-4 leading-relaxed">
                Эта часть — трактовка языковой модели по найденным в сети
                публикациям, а не проверенный факт. Модель может ошибаться
                и пропускать информацию. Оценка репутации намеренно отделена
                от технической: расхождение между ними само по себе сигнал.
              </p>
            </section>
          ) : (
            <section className="border-t border-border pt-4">
              <p className="text-sm text-muted">
                Репутационный анализ не выполнялся: ключ модели не настроен.
                Факты о контракте выше собраны без него.
              </p>
            </section>
          )}

          <p className="text-xs text-muted">
            Обновлено {new Date(research.updatedAt).toLocaleString('ru')}
            {research.status === 'partial' && ' · часть источников не ответила'}
            {research.factSources?.length > 0 &&
              ` · источники фактов: ${research.factSources.map((s: any) => s.name).join(', ')}`}
          </p>
        </>
      )}
    </div>
  );
}

function Fact({ label, value, ok, bad }: { label: string; value: string; ok?: boolean; bad?: boolean }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className={`text-sm ${bad ? 'text-down' : ok ? 'text-up' : 'text-muted'}`}>{value}</div>
    </div>
  );
}

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="px-2 py-1 rounded bg-border text-muted hover:text-white transition-colors truncate max-w-[220px]"
    >
      {children} ↗
    </a>
  );
}
