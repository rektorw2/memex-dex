'use client';

import { useState, useMemo } from 'react';
import useSWR from 'swr';
import { fetcher, api, fmtUsd, fmtPrice, fmtPct, errorMessage } from '@/lib/api';

interface Target { priceUsd: string; pct: number }

const RISK_OPTIONS = [
  ['LOW', 'Низкий'],
  ['MEDIUM', 'Средний'],
  ['HIGH', 'Высокий'],
  ['DEGEN', 'Дегенский'],
] as const;

const emptyForm = {
  tokenId: '',
  title: '',
  thesis: '',
  risk: 'HIGH' as string,
  entryPriceUsd: '',
  stopLossUsd: '',
  suggestedPct: 3,
  timeHorizon: '',
  isCopyEnabled: false,
};

export function CallManager() {
  const { data: calls, mutate, error, isLoading } = useSWR<any[]>(
    '/admin/calls?limit=100',
    fetcher,
    { refreshInterval: 30_000, shouldRetryOnError: false },
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const drafts = calls?.filter((c) => c.status === 'DRAFT') ?? [];
  const published = calls?.filter((c) => c.status === 'PUBLISHED') ?? [];
  const closed = calls?.filter((c) => !['DRAFT', 'PUBLISHED'].includes(c.status)) ?? [];

  return (
    <div className="grid xl:grid-cols-2 gap-4">
      <CallEditor
        editingId={editingId}
        existing={calls?.find((c) => c.id === editingId)}
        onDone={(msg) => { setEditingId(null); setNotice(msg); mutate(); }}
        onCancel={() => setEditingId(null)}
      />

      <div className="space-y-4">
        {notice && (
          <div className="panel p-3 text-sm border-up/40 bg-up/5 flex items-start gap-2">
            <span className="text-up">✓</span>
            <span className="flex-1">{notice}</span>
            <button onClick={() => setNotice(null)} className="text-muted hover:text-white text-xs">
              ×
            </button>
          </div>
        )}

        {/* Ошибка загрузки списка обязана быть видна: иначе неудачный
            запрос выглядит как пустой список, то есть как «колл не создался». */}
        {error && (
          <div className="panel p-4 border-down/40">
            <p className="text-sm text-down">Не удалось загрузить список коллов</p>
            <p className="text-xs text-muted mt-1">{errorMessage(error)}</p>
            <button onClick={() => mutate()} className="btn-ghost text-xs mt-3">
              Повторить
            </button>
          </div>
        )}

        {isLoading && !calls && (
          <div className="panel p-4 text-sm text-muted">Загрузка списка…</div>
        )}

        {!error && (
          <>
            <CallGroup
              title="Черновики"
              hint="Видны только вам. Публикация фиксирует цену входа по рынку."
              calls={drafts}
              onEdit={setEditingId}
              onChanged={mutate}
            />
            <CallGroup title="Опубликованные" calls={published} onChanged={mutate} />
            {closed.length > 0 && (
              <CallGroup title="Закрытые" calls={closed} onChanged={mutate} collapsed />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────── Редактор ───────────────────────────────────

function CallEditor({
  editingId, existing, onDone, onCancel,
}: {
  editingId: string | null;
  existing?: any;
  onDone: (notice: string) => void;
  onCancel: () => void;
}) {
  const [tokenSearch, setTokenSearch] = useState('');
  const [form, setForm] = useState({ ...emptyForm });
  const [targets, setTargets] = useState<Target[]>([{ priceUsd: '', pct: 50 }]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadedId, setLoadedId] = useState<string | null>(null);

  const [lookupChain, setLookupChain] = useState('SOLANA');
  const [lookupError, setLookupError] = useState<string | null>(null);

  // Поиск по токенам, а не выпадающий список: в витрине сотни позиций,
  // и прокручивать их до нужной невозможно.
  const { data: tokens, mutate: mutateTokens } = useSWR<any[]>(
    `/tokens?limit=60${tokenSearch ? `&search=${encodeURIComponent(tokenSearch)}` : ''}`,
    fetcher,
  );
  const token = tokens?.find((t) => t.id === form.tokenId);

  /**
   * Порядок в списке: сначала добавленные вручную, потом проверенные,
   * дальше по объёму. Токен, который админ только что завёл сам, —
   * почти всегда тот, ради которого он и открыл форму колла.
   */
  const candidates = useMemo(() => {
    const list = (tokens ?? []).filter((t) => !t.isQuote);
    const weight = (t: any) => (t.source === 'manual' ? 0 : t.isVerified ? 1 : 2);
    return [...list].sort((a, b) => weight(a) - weight(b)).slice(0, 30);
  }, [tokens]);

  // Адреса Solana и EVM: длинная строка без пробелов. Точную валидацию
  // делает сервер, здесь достаточно отличить адрес от тикера.
  const looksLikeAddress = /^[A-Za-z0-9]{32,}$/.test(tokenSearch.trim());

  async function addByAddress() {
    setBusy(true);
    setLookupError(null);
    try {
      const r: any = await api('/admin/tokens/lookup', {
        method: 'POST',
        body: JSON.stringify({ chain: lookupChain, address: tokenSearch.trim(), verify: true }),
      });
      await mutateTokens();
      setForm({ ...form, tokenId: r.token.id });
      setTokenSearch('');
    } catch (e) {
      setLookupError(errorMessage(e, 'Не удалось добавить токен'));
    } finally {
      setBusy(false);
    }
  }

  // Подгружаем черновик в форму при переходе в режим правки
  if (editingId && editingId !== loadedId && existing) {
    setLoadedId(editingId);
    setForm({
      tokenId: existing.tokenId,
      title: existing.title,
      thesis: existing.thesis,
      risk: existing.risk,
      entryPriceUsd: existing.entryPriceUsd ?? '',
      stopLossUsd: existing.stopLossUsd ?? '',
      suggestedPct: Number(existing.suggestedPct ?? 3),
      timeHorizon: existing.timeHorizon ?? '',
      isCopyEnabled: existing.isCopyEnabled,
    });
    setTargets(existing.targets?.length ? existing.targets : [{ priceUsd: '', pct: 50 }]);
  }
  if (!editingId && loadedId) {
    setLoadedId(null);
    setForm({ ...emptyForm });
    setTargets([{ priceUsd: '', pct: 50 }]);
  }

  const entry = Number(form.entryPriceUsd || token?.priceUsd || 0);
  const totalPct = targets.reduce((s, t) => s + t.pct, 0);

  /** Ожидаемый результат, если все цели сработают по заданным долям. */
  const expectedReturn = useMemo(() => {
    if (!entry) return null;
    let sum = 0;
    for (const t of targets) {
      const p = Number(t.priceUsd);
      if (!p) return null;
      sum += (p / entry) * (t.pct / 100);
    }
    const rest = Math.max(0, 100 - totalPct) / 100;
    return (sum + rest) * 100 - 100;
  }, [targets, entry, totalPct]);

  const maxLoss = useMemo(() => {
    const sl = Number(form.stopLossUsd);
    if (!sl || !entry) return null;
    return (sl / entry) * 100 - 100;
  }, [form.stopLossUsd, entry]);

  function setTargetMultiple(i: number, mult: number) {
    if (!entry) return;
    setTargets(targets.map((t, j) => (j === i ? { ...t, priceUsd: String(entry * mult) } : t)));
  }

  async function save(publish: boolean) {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        ...form,
        suggestedPct: Number(form.suggestedPct),
        entryPriceUsd: String(form.entryPriceUsd || token?.priceUsd || ''),
        targets: targets.map((t) => ({ priceUsd: String(t.priceUsd), pct: Number(t.pct) })),
      };

      let id = editingId;
      if (id) {
        await api(`/admin/calls/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      } else {
        const r: any = await api('/admin/calls', { method: 'POST', body: JSON.stringify(payload) });
        id = r.call.id;
      }

      if (publish && id) {
        await api(`/admin/calls/${id}/publish`, { method: 'POST' });
      }

      setForm({ ...emptyForm });
      setTargets([{ priceUsd: '', pct: 50 }]);
      onDone(
        publish
          ? 'Колл опубликован — он появился в общей ленте и в списке ниже.'
          : 'Черновик сохранён. Он в списке ниже, опубликовать можно оттуда.',
      );
    } catch (e) {
      setError(errorMessage(e, 'Не удалось сохранить колл'));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Список незаполненного показывается явно.
   *
   * Отключённая кнопка без объяснения — худший вид блокировки: человек
   * видит, что нажатие ничего не даёт, и считает интерфейс сломанным.
   */
  const missing: string[] = [];
  if (!form.tokenId) missing.push('выберите токен');
  if (form.title.trim().length < 3) missing.push('заголовок от 3 символов');
  if (form.thesis.trim().length < 20) {
    missing.push(`тезис — ещё ${20 - form.thesis.trim().length} символов`);
  }
  if (!targets.every((t) => Number(t.priceUsd) > 0)) missing.push('заполните цены целей');
  if (totalPct > 100) missing.push('сумма долей по целям больше 100%');
  if (!(Number(form.suggestedPct) >= 0.1 && Number(form.suggestedPct) <= 25)) {
    missing.push('доля портфеля — от 0.1 до 25%');
  }

  const canSave = missing.length === 0;

  // Цель ниже цены входа — это не цель, а фиксация убытка. Чаще всего
  // след того, что цену входа поменяли уже после расстановки целей.
  const targetsBelowEntry = entry > 0 && targets.some((t) => Number(t.priceUsd) > 0 && Number(t.priceUsd) < entry);

  return (
    <div className="panel p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">{editingId ? 'Правка черновика' : 'Новый колл'}</h2>
        {editingId && (
          <button onClick={onCancel} className="text-xs text-muted hover:text-white">
            отменить правку
          </button>
        )}
      </div>

      {/* Токен */}
      <div>
        <label className="label">Токен</label>
        {token ? (
          <div className="flex items-center gap-3 bg-bg rounded-md p-3">
            <div className="flex-1 min-w-0">
              <div className="font-medium">{token.symbol}</div>
              <div className="text-xs text-muted truncate">
                {token.chain} · {fmtPrice(token.priceUsd)} · ликв. {fmtUsd(token.liquidityUsd)}
                {token.riskScore != null && ` · риск ${token.riskScore}`}
              </div>
            </div>
            <button
              onClick={() => setForm({ ...form, tokenId: '', entryPriceUsd: '' })}
              className="text-xs text-muted hover:text-white shrink-0"
            >
              сменить
            </button>
          </div>
        ) : (
          <>
            <input
              className="input font-sans text-sm"
              placeholder="Тикер или адрес контракта"
              value={tokenSearch}
              onChange={(e) => setTokenSearch(e.target.value)}
            />

            {/* Если введён адрес контракта, а токена в витрине ещё нет —
                добавляем его на месте. Иначе пришлось бы уходить во вкладку
                «Токены» и терять заполненную форму колла. */}
            {looksLikeAddress && candidates.length === 0 && (
              <div className="mt-2 bg-bg rounded-md border border-border p-3 space-y-2">
                <p className="text-xs text-muted">
                  Такого токена в витрине нет. Добавить по адресу?
                </p>
                <div className="flex gap-2">
                  <select
                    className="input text-sm"
                    value={lookupChain}
                    onChange={(e) => setLookupChain(e.target.value)}
                  >
                    <option value="SOLANA">Solana</option>
                    <option value="BNB">BNB Chain</option>
                    <option value="BASE">Base</option>
                    <option value="ETHEREUM">Ethereum</option>
                    <option value="ROBINHOOD">Robinhood Chain</option>
                  </select>
                  <button
                    onClick={addByAddress}
                    disabled={busy}
                    className="btn bg-accent hover:bg-accent/80 text-white text-sm whitespace-nowrap"
                  >
                    {busy ? '...' : 'Добавить'}
                  </button>
                </div>
              </div>
            )}

            {/* Список показываем сразу, не дожидаясь ввода: чаще всего
                нужный токен только что добавлен вручную и лежит наверху. */}
            <div className="mt-1 max-h-56 overflow-auto bg-bg rounded-md border border-border">
              {candidates.length > 0 ? (
                candidates.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => { setForm({ ...form, tokenId: t.id }); setTokenSearch(''); }}
                    className="w-full text-left px-3 py-2 hover:bg-border text-sm flex justify-between gap-2 items-center"
                  >
                    <span className="min-w-0 truncate">
                      {t.symbol}
                      <span className="text-muted text-xs ml-2">{t.chain}</span>
                      {t.source === 'manual' && (
                        <span className="text-accent text-[10px] ml-2" title="Добавлен вами вручную">
                          свой
                        </span>
                      )}
                      {t.isVerified && t.source !== 'manual' && (
                        <span className="text-accent text-[10px] ml-2" title="Проверен">✓</span>
                      )}
                    </span>
                    <span className="num text-xs text-muted shrink-0">{fmtUsd(t.liquidityUsd)}</span>
                  </button>
                ))
              ) : (
                <p className="px-3 py-2 text-xs text-muted">
                  {tokenSearch ? 'Ничего не найдено' : 'В витрине пока нет токенов'}
                </p>
              )}
            </div>

            {lookupError && (
              <p className="text-xs text-down mt-2">{lookupError}</p>
            )}
          </>
        )}
      </div>

      <div>
        <label className="label">Заголовок</label>
        <input
          className="input font-sans"
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
          placeholder="Например: BONK — реактивация экосистемного нарратива"
        />
      </div>

      <div>
        <label className="label">
          Тезис — {form.thesis.length < 20
            ? `ещё ${20 - form.thesis.length} символов`
            : `${form.thesis.length} символов`}
        </label>
        <textarea
          className="input min-h-[110px] font-sans"
          value={form.thesis}
          onChange={(e) => setForm({ ...form, thesis: e.target.value })}
          placeholder="Нарратив, ликвидность, катализаторы и — обязательно — риски."
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Риск</label>
          <select className="input font-sans" value={form.risk}
                  onChange={(e) => setForm({ ...form, risk: e.target.value })}>
            {RISK_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Доля портфеля, %</label>
          <input
            className="input" type="number" step="0.5" min="0.1" max="25"
            value={form.suggestedPct}
            onChange={(e) => {
              // Пустое поле и нечисловой ввод дают NaN, а JSON.stringify(NaN)
              // превращает его в null — сервер отвечал ошибкой валидации,
              // из которой причина не следовала.
              const n = Number(e.target.value);
              setForm({ ...form, suggestedPct: Number.isFinite(n) ? n : 0 });
            }}
          />
        </div>
      </div>

      <div>
        <label className="label">
          Цена входа {!form.entryPriceUsd && token && '(по умолчанию — текущая рыночная)'}
        </label>
        <input
          className="input"
          value={form.entryPriceUsd}
          onChange={(e) => setForm({ ...form, entryPriceUsd: e.target.value })}
          placeholder={token?.priceUsd ?? '0.00'}
        />
      </div>

      {/* Цели */}
      <div>
        <div className="flex justify-between items-baseline">
          <label className="label">Цели</label>
          <span className={`text-xs ${totalPct > 100 ? 'text-down' : 'text-muted'}`}>
            продаём {totalPct}%{totalPct > 100 && ' — больше позиции'}
          </span>
        </div>

        {targets.map((t, i) => (
          <div key={i} className="mb-2">
            <div className="flex gap-2">
              <input
                className="input" placeholder="Цена USD" value={t.priceUsd}
                onChange={(e) => setTargets(targets.map((x, j) => j === i ? { ...x, priceUsd: e.target.value } : x))}
              />
              <input
                className="input w-20" type="number" min="1" max="100" value={t.pct}
                onChange={(e) => setTargets(targets.map((x, j) => j === i ? { ...x, pct: Number(e.target.value) } : x))}
              />
              {targets.length > 1 && (
                <button onClick={() => setTargets(targets.filter((_, j) => j !== i))}
                        className="btn-ghost px-3">×</button>
              )}
            </div>
            {/* Считать «сколько будет 3 икса от 0.0000234» в уме — верный
                способ ошибиться на порядок. Кнопки проставляют цену сами. */}
            {entry > 0 && (
              <div className="flex gap-1 mt-1">
                {[1.5, 2, 3, 5, 10].map((m) => (
                  <button
                    key={m}
                    onClick={() => setTargetMultiple(i, m)}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-border text-muted hover:text-white"
                  >
                    {m}×
                  </button>
                ))}
                {Number(t.priceUsd) > 0 && (
                  <span className="text-[10px] text-muted ml-auto num self-center">
                    {(Number(t.priceUsd) / entry).toFixed(2)}× от входа
                  </span>
                )}
              </div>
            )}
          </div>
        ))}

        {targets.length < 5 && (
          <button onClick={() => setTargets([...targets, { priceUsd: '', pct: 25 }])}
                  className="text-xs text-accent">
            + добавить цель
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Стоп-лосс, USD</label>
          <input className="input" value={form.stopLossUsd}
                 onChange={(e) => setForm({ ...form, stopLossUsd: e.target.value })}
                 placeholder="необязательно" />
        </div>
        <div>
          <label className="label">Горизонт</label>
          <input className="input font-sans" value={form.timeHorizon}
                 onChange={(e) => setForm({ ...form, timeHorizon: e.target.value })}
                 placeholder="свинг, 1-3 недели" />
        </div>
      </div>

      {/* Профиль риска и доходности */}
      {(expectedReturn != null || maxLoss != null) && (
        <div className="bg-bg rounded-md p-3 text-sm space-y-1">
          {expectedReturn != null && (
            <div className="flex justify-between">
              <span className="text-muted">Если цели сработают</span>
              <span className={`num ${expectedReturn >= 0 ? 'text-up' : 'text-down'}`}>
                {fmtPct(expectedReturn)}
              </span>
            </div>
          )}
          {maxLoss != null && (
            <div className="flex justify-between">
              <span className="text-muted">Если сработает стоп</span>
              <span className="num text-down">{fmtPct(maxLoss)}</span>
            </div>
          )}
          {expectedReturn != null && maxLoss != null && maxLoss !== 0 && (
            <div className="flex justify-between pt-1 border-t border-border">
              <span className="text-muted text-xs">Отношение прибыль/риск</span>
              <span className="num text-xs">
                {(expectedReturn / Math.abs(maxLoss)).toFixed(1)} : 1
              </span>
            </div>
          )}
        </div>
      )}

      <label className="flex gap-2 items-center text-sm">
        <input type="checkbox" checked={form.isCopyEnabled} className="accent-accent"
               onChange={(e) => setForm({ ...form, isCopyEnabled: e.target.checked })} />
        Раздать подписчикам копитрейдинга
      </label>

      {targetsBelowEntry && (
        <p className="text-xs text-down bg-down/10 border border-down/30 rounded p-2">
          Есть цель ниже цены входа — колл получится заведомо убыточным.
          Обычно так выходит, когда цену входа изменили после расстановки
          целей: нажмите кнопку кратности заново.
        </p>
      )}

      {error && (
        <p className="text-xs text-down bg-down/10 border border-down/30 rounded p-2">{error}</p>
      )}

      {missing.length > 0 && (
        <div className="text-xs bg-bg rounded-md p-3">
          <p className="text-muted mb-1.5">Чтобы опубликовать, осталось:</p>
          <ul className="space-y-1">
            {missing.map((m, i) => (
              <li key={i} className="flex gap-2 text-muted">
                <span className="text-accent">•</span>{m}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <button onClick={() => save(false)} disabled={!canSave || busy} className="btn-ghost">
          {busy ? '...' : 'Сохранить черновик'}
        </button>
        <button
          onClick={() => save(true)}
          disabled={!canSave || busy}
          title={canSave ? 'Опубликовать колл' : `Не заполнено: ${missing.join(', ')}`}
          className="btn bg-accent hover:bg-accent/80 text-white"
        >
          {busy ? '...' : 'Опубликовать'}
        </button>
      </div>

      <p className="text-xs text-muted">
        При публикации цена входа фиксируется по рынку на этот момент — иначе
        результат колла считался бы от устаревшей цифры.
      </p>
    </div>
  );
}

// ──────────────────────────── Списки коллов ─────────────────────────────────

function CallGroup({
  title, hint, calls, onEdit, onChanged, collapsed,
}: {
  title: string;
  hint?: string;
  calls: any[];
  onEdit?: (id: string) => void;
  onChanged: () => void;
  collapsed?: boolean;
}) {
  const [open, setOpen] = useState(!collapsed);

  return (
    <div className="panel p-4">
      <button onClick={() => setOpen(!open)} className="w-full flex items-baseline justify-between">
        <h2 className="font-medium">{title} <span className="text-muted">{calls.length}</span></h2>
        <span className="text-muted text-xs">{open ? 'свернуть' : 'развернуть'}</span>
      </button>
      {hint && open && <p className="text-xs text-muted mt-1">{hint}</p>}

      {open && (
        <div className="mt-3 space-y-2">
          {calls.map((c) => (
            <CallRow key={c.id} call={c} onEdit={onEdit} onChanged={onChanged} />
          ))}
          {calls.length === 0 && <p className="text-sm text-muted py-2">Пусто</p>}
        </div>
      )}
    </div>
  );
}

function CallRow({ call, onEdit, onChanged }: { call: any; onEdit?: (id: string) => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pnl = call.pnlPct == null ? null : Number(call.pnlPct);

  /**
   * Ошибку обязательно показываем. Раньше здесь не было catch: неудачная
   * публикация отклоняла промис, обработчик молча выходил, и кнопка
   * выглядела просто нерабочей — понять причину было невозможно.
   */
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(errorMessage(e, 'Действие не выполнено'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-bg rounded-md p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium text-sm truncate">{call.title}</div>
          <div className="text-xs text-muted">
            ${call.symbol} · {call.chain} · вход {fmtPrice(call.entryPriceUsd)}
          </div>
        </div>
        {pnl != null && (
          <span className={`num text-sm shrink-0 ${pnl >= 0 ? 'text-up' : 'text-down'}`}>
            {fmtPct(pnl)}
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-2 mt-2">
        {call.status === 'DRAFT' && (
          <>
            <button onClick={() => onEdit?.(call.id)} className="text-xs text-accent">
              править
            </button>
            <button
              onClick={() => act(() => api(`/admin/calls/${call.id}/publish`, { method: 'POST' }))}
              disabled={busy}
              className="text-xs text-up"
            >
              опубликовать
            </button>
            <button
              onClick={() => {
                if (confirm('Удалить черновик?')) {
                  act(() => api(`/admin/calls/${call.id}`, { method: 'DELETE' }));
                }
              }}
              disabled={busy}
              className="text-xs text-down ml-auto"
            >
              удалить
            </button>
          </>
        )}

        {call.status === 'PUBLISHED' && (
          <>
            {(['HIT_TARGET', 'STOPPED_OUT', 'EXPIRED'] as const).map((s) => (
              <button
                key={s}
                onClick={() =>
                  act(() =>
                    api(`/admin/calls/${call.id}/close`, {
                      method: 'POST',
                      body: JSON.stringify({ status: s }),
                    }),
                  )
                }
                disabled={busy}
                className="text-xs text-muted hover:text-white"
              >
                {{ HIT_TARGET: 'цель взята', STOPPED_OUT: 'стоп', EXPIRED: 'истёк' }[s]}
              </button>
            ))}
            {call.peakMultiple && Number(call.peakMultiple) > 0 && (
              <span className="text-xs text-muted ml-auto num">
                пик {Number(call.peakMultiple).toFixed(2)}×
              </span>
            )}
          </>
        )}

        {!['DRAFT', 'PUBLISHED'].includes(call.status) && (
          <span className="text-xs text-muted">
            {call.status === 'HIT_TARGET' ? 'цель взята'
              : call.status === 'STOPPED_OUT' ? 'выбит стоп'
              : call.status === 'EXPIRED' ? 'истёк' : 'отменён'}
            {call.resultPct != null && ` · ${fmtPct(call.resultPct)}`}
          </span>
        )}
      </div>

      {error && (
        <p className="text-xs text-down bg-down/10 border border-down/30 rounded p-2 mt-2">
          {error}
        </p>
      )}
    </div>
  );
}
