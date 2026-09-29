/* ═══════════════════════════════════════════════════════════════════
   Мой портфель — позиции в localStorage (usePortfolio).
   Позиция: { id, isin, secid, shortname, qty, buyPrice, buyDate }

   Важно про цены: облигации на Мосбирже котируются в ПРОЦЕНТАХ от
   номинала (98,5 = 98,5% номинала), акции — в рублях. Приводим всё
   к рублям за одну бумагу, поэтому цена покупки вводится в рублях
   за бумагу (для облигации — «грязная» цена, включая НКД).
   НКД показываем отдельно и в расчёт прибыли не включаем.
   ═══════════════════════════════════════════════════════════════════ */
import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { fetchBonds, fetchStocks } from '../api/moex';
import { Panel, Kpi, Loading, ErrorBox } from '../components/ui';
import { usePortfolio } from '../lib/store';
import { nf, money, chgClass } from '../lib/format';

/* Облигация или акция: у облигаций из normalize() всегда есть поле faceValue */
const isBond = item => !!item && 'faceValue' in item;

/* Цена одной бумаги в рублях */
function unitPrice(item) {
  if (!item) return null;
  if (isBond(item)) {
    if (item.price == null) return null;
    const face = item.faceValue ?? 1000;   // если номинал неизвестен — считаем 1000 ₽
    return item.price / 100 * face;
  }
  return item.price ?? null;
}

/* Поиск бумаги в списке по ISIN или тикеру */
function findIn(list, p) {
  const isin = (p.isin || '').toUpperCase();
  const secid = (p.secid || '').toUpperCase();
  return list.find(x =>
    (isin && (x.isin || '').toUpperCase() === isin) ||
    (secid && (x.secid || '').toUpperCase() === secid)
  ) || null;
}

export default function PortfolioPage() {
  const { positions, add, remove } = usePortfolio();
  const [bonds, setBonds] = useState([]);
  const [stocks, setStocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ code: '', qty: '', buyPrice: '' });
  const [formErr, setFormErr] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true); setError(null);
    try { setBonds(await fetchBonds()); }
    catch (e) { setError(e); }
    finally { setLoading(false); }
  }

  /* Если среди позиций есть бумаги, которых нет среди облигаций,
     один раз догружаем список акций (нужен для текущей цены). */
  useEffect(() => {
    if (!bonds.length || stocks.length) return;
    if (!positions.some(p => !findIn(bonds, p))) return;
    let alive = true;
    fetchStocks().then(s => { if (alive) setStocks(s); }).catch(() => {});
    return () => { alive = false; };
  }, [bonds, positions, stocks.length]);

  /* Расчёт по каждой позиции */
  const rows = useMemo(() => positions.map(p => {
    const bond = findIn(bonds, p);
    const stock = bond ? null : findIn(stocks, p);
    const item = bond || stock;
    const cur = unitPrice(item);

    const invested = p.qty * p.buyPrice;                 // вложено, ₽
    const value = cur == null ? null : p.qty * cur;      // текущая стоимость, ₽
    const pl = value == null ? null : value - invested;
    const plPct = (value == null || !invested) ? null : pl / invested * 100;

    return {
      p, bond, item, cur, invested, value, pl, plPct,
      nkd: bond?.nkd ?? null,
      priced: value != null,
    };
  }), [positions, bonds, stocks]);

  const totalInvested = rows.reduce((a, r) => a + r.invested, 0);
  /* Позиции без найденной цены учитываем по цене покупки, чтобы итог не «прыгал» */
  const totalValue = rows.reduce((a, r) => a + (r.value ?? r.invested), 0);
  const totalPl = totalValue - totalInvested;
  const totalPct = totalInvested ? totalPl / totalInvested * 100 : null;
  const totalNkd = rows.reduce((a, r) => a + (r.nkd != null ? r.nkd * r.p.qty : 0), 0);
  const unpriced = rows.filter(r => !r.priced).length;
  const showNkd = rows.some(r => r.nkd != null);

  /* Добавление позиции: название подтягиваем из списка биржи */
  async function submit(e) {
    e.preventDefault();
    const code = form.code.trim().toUpperCase();
    const qty = Number(form.qty);
    const buyPrice = Number(form.buyPrice);

    if (!code) { setFormErr('Укажите ISIN или тикер бумаги'); return; }
    if (!(qty > 0)) { setFormErr('Количество должно быть больше нуля'); return; }
    if (!(buyPrice >= 0) || Number.isNaN(buyPrice)) { setFormErr('Проверьте цену покупки'); return; }

    setFormErr(null); setBusy(true);

    let item = null;
    try {
      const bs = bonds.length ? bonds : await fetchBonds();
      if (!bonds.length) setBonds(bs);
      item = bs.find(b =>
        (b.isin || '').toUpperCase() === code || (b.secid || '').toUpperCase() === code
      ) || null;

      if (!item) {
        const ss = stocks.length ? stocks : await fetchStocks();
        if (!stocks.length) setStocks(ss);
        item = ss.find(s =>
          (s.isin || '').toUpperCase() === code || (s.secid || '').toUpperCase() === code
        ) || null;
      }
    } catch {
      /* сеть отвалилась — добавляем как есть, с введённым кодом вместо названия */
    }

    add({
      isin: item?.isin || code,
      secid: item?.secid || code,
      shortname: item?.shortname || code,
      qty,
      buyPrice,
      buyDate: new Date().toISOString().slice(0, 10),
    });

    setForm({ code: '', qty: '', buyPrice: '' });
    setBusy(false);
  }

  if (loading) return <Loading text="Загрузка портфеля…" />;
  if (error) return <ErrorBox error={error} onRetry={load} />;

  return (
    <div>
      <div className="page-h">
        <div className="page-t">▥ Мой портфель</div>
        <div className="page-s">
          Позиции хранятся только в вашем браузере (localStorage) · цены — ISS MOEX в реальном времени
        </div>
      </div>

      {/* ── Форма добавления ─────────────────────────────────────── */}
      <Panel title="Добавить позицию">
        <form className="filters" onSubmit={submit}>
          <div className="fg">
            <label>ISIN или тикер</label>
            <input
              className="inp"
              style={{ width: 220 }}
              placeholder="RU000A10… / SU26238RMFS4 / SBER"
              value={form.code}
              onChange={e => setForm(f => ({ ...f, code: e.target.value }))}
            />
          </div>
          <div className="fg">
            <label>Количество</label>
            <input
              className="inp"
              style={{ width: 110 }}
              type="number"
              min="1"
              step="1"
              placeholder="10"
              value={form.qty}
              onChange={e => setForm(f => ({ ...f, qty: e.target.value }))}
            />
          </div>
          <div className="fg">
            <label>Цена покупки, ₽ за бумагу</label>
            <input
              className="inp"
              style={{ width: 160 }}
              type="number"
              min="0"
              step="0.01"
              placeholder="985.50"
              value={form.buyPrice}
              onChange={e => setForm(f => ({ ...f, buyPrice: e.target.value }))}
            />
          </div>
          <button className="btn btn-green" type="submit" disabled={busy}>
            {busy ? 'Ищем бумагу…' : 'Добавить'}
          </button>
        </form>
        <div className="c-3" style={{ fontSize: 11, marginTop: 10, lineHeight: 1.6 }}>
          Название бумаги подтягивается автоматически: сначала ищет среди облигаций,
          затем среди акций. Цена покупки — в рублях за одну бумагу; для облигаций
          это «грязная» цена (с НКД), как в отчёте брокера.
        </div>
        {formErr && <div className="err" style={{ textAlign: 'left', paddingTop: 8 }}>{formErr}</div>}
      </Panel>

      <div style={{ height: 14 }} />

      {!positions.length ? (
        <Panel>
          <div className="empty" style={{ padding: '42px 20px' }}>
            <div style={{ fontSize: 15, marginBottom: 8 }}>Портфель пуст</div>
            <div style={{ marginBottom: 14 }}>
              Добавьте первую позицию через форму выше — укажите ISIN или тикер,
              количество и цену покупки.
            </div>
            <Link className="btn" to="/screener">Выбрать бумагу в скринере</Link>
          </div>
        </Panel>
      ) : (
        <>
          {/* ── Сводка ────────────────────────────────────────────── */}
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', marginBottom: 14 }}>
            <Kpi label="Вложено" value={money(totalInvested)} sub={`${positions.length} позиций`} />
            <Kpi
              label="Текущая стоимость"
              value={money(totalValue)}
              sub={unpriced ? `без цены: ${unpriced} поз. — учтены по цене покупки` : 'по текущим ценам'}
            />
            <Kpi
              label="Прибыль / убыток"
              value={(totalPl > 0 ? '+' : '') + money(totalPl)}
              cls={chgClass(totalPl)}
              sub={totalPct == null ? '—' : (totalPct > 0 ? '+' : '') + nf(totalPct, 2) + '%'}
            />
            <Kpi
              label="Доходность портфеля"
              value={totalPct == null ? '—' : (totalPct > 0 ? '+' : '') + nf(totalPct, 2) + '%'}
              cls={chgClass(totalPct)}
              sub="к вложенным средствам"
            />
            <Kpi
              label="НКД к получению"
              value={money(totalNkd)}
              sub="не входит в прибыль выше"
            />
          </div>

          {/* ── Таблица позиций ───────────────────────────────────── */}
          <Panel title="Позиции" pad={false}>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Бумага</th>
                    <th>Кол-во</th>
                    <th>Цена покупки</th>
                    <th>Текущая цена</th>
                    <th>Вложено</th>
                    <th>Стоимость</th>
                    <th>П/У, ₽</th>
                    <th>П/У, %</th>
                    <th>Вес</th>
                    {showNkd && <th>НКД на бумагу</th>}
                    <th className="nosort">Дата покупки</th>
                    <th className="nosort"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => {
                    const p = r.p;
                    const weight = totalValue ? (r.value ?? r.invested) / totalValue * 100 : null;
                    return (
                      <tr key={p.id}>
                        <td>
                          {r.bond
                            ? <Link to={'/bond/' + r.bond.isin} style={{ fontWeight: 600 }}>{r.bond.shortname}</Link>
                            : <span style={{ fontWeight: 600 }}>{p.shortname}</span>}
                          <div className="mono c-3" style={{ fontSize: 10 }}>
                            {p.isin}{p.secid && p.secid !== p.isin ? ' · ' + p.secid : ''}
                            {r.bond ? '' : (r.item ? ' · акция' : ' · нет в списке биржи')}
                          </div>
                        </td>
                        <td className="mono">{nf(p.qty, 0)}</td>
                        <td className="mono">{nf(p.buyPrice, 2)}</td>
                        <td className="mono">{r.cur == null ? <span className="c-3">н/д</span> : nf(r.cur, 2)}</td>
                        <td className="mono c-2">{money(r.invested)}</td>
                        <td className="mono">{r.value == null ? '—' : money(r.value)}</td>
                        <td className={'mono ' + chgClass(r.pl)}>
                          {r.pl == null ? '—' : (r.pl > 0 ? '+' : '') + money(r.pl)}
                        </td>
                        <td className={chgClass(r.plPct)}>
                          {r.plPct == null ? '—' : (r.plPct > 0 ? '+' : '') + nf(r.plPct, 2) + '%'}
                        </td>
                        <td className="mono c-2">{weight == null ? '—' : nf(weight, 1) + '%'}</td>
                        {showNkd && (
                          <td className="mono c-2">{r.nkd == null ? '—' : nf(r.nkd, 2)}</td>
                        )}
                        <td className="mono c-3" style={{ fontSize: 11 }}>{p.buyDate || '—'}</td>
                        <td>
                          <button className="btn btn-sm" onClick={() => remove(p.id)}>Удалить</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>

          <div className="c-3" style={{ fontSize: 11, marginTop: 10, lineHeight: 1.6 }}>
            Как считаем: цена облигации переводится из процентов от номинала в рубли
            (для бумаг с неизвестным номиналом берём 1000 ₽), акции — по последней цене сделки.
            НКД показан отдельной колонкой и в прибыль не включён: он вернётся при продаже
            или купоне. Валютные выпуски пересчитываются по номиналу в валюте, без курса ЦБ.
          </div>
        </>
      )}
    </div>
  );
}