/* ═══════════════════════════════════════════════════════════════════
   Акции Мосбиржи (основной режим TQBR, ~260 бумаг с ценой).
   Данные берём одним запросом fetchStocks() — кэша в слое данных нет,
   поэтому список грузим один раз при монтировании.
   ═══════════════════════════════════════════════════════════════════ */
import { useState, useEffect, useMemo } from 'react';
import { fetchStocks } from '../api/moex';
import { Panel, Kpi, Loading, ErrorBox, Pager } from '../components/ui';
import { nf, money, chgClass, chgStr } from '../lib/format';

const PER_PAGE = 50;

/* Колонки: label — заголовок, sort — значение для сортировки, cell — ячейка */
const COLS = {
  secid: {
    label: 'Тикер', sort: s => s.secid,
    cell: s => <span className="mono" style={{ fontWeight: 600 }}>{s.secid}</span>,
  },
  name: {
    label: 'Название', sort: s => s.shortname,
    cell: s => (
      <div style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' }} title={s.name}>
        {s.shortname}
      </div>
    ),
  },
  price: {
    label: 'Цена', sort: s => s.price ?? -1,
    cell: s => <span className="mono">{nf(s.price, 2)}</span>,
  },
  change: {
    label: 'Изм. за день', sort: s => s.change ?? -999,
    cell: s => <span className={chgClass(s.change)}>{chgStr(s.change)}</span>,
  },
  open: {
    label: 'Открытие', sort: s => s.open ?? -1,
    cell: s => <span className="mono c-2">{s.open == null ? '—' : nf(s.open, 2)}</span>,
  },
  low: {
    label: 'Мин.', sort: s => s.low ?? -1,
    cell: s => <span className="mono c-2">{s.low == null ? '—' : nf(s.low, 2)}</span>,
  },
  high: {
    label: 'Макс.', sort: s => s.high ?? -1,
    cell: s => <span className="mono c-2">{s.high == null ? '—' : nf(s.high, 2)}</span>,
  },
  turnover: {
    label: 'Оборот', sort: s => s.turnover || 0,
    cell: s => <span className="mono">{s.turnover ? money(s.turnover) : '—'}</span>,
  },
  numTrades: {
    label: 'Сделок', sort: s => s.numTrades ?? -1,
    cell: s => <span className="mono c-2">{s.numTrades == null ? '—' : nf(s.numTrades, 0)}</span>,
  },
  capitalization: {
    label: 'Капитализация', sort: s => s.capitalization ?? -1,
    cell: s => <span className="mono">{s.capitalization ? money(s.capitalization) : '—'}</span>,
  },
};

const ORDER = ['secid', 'name', 'price', 'change', 'open', 'low', 'high', 'turnover', 'numTrades', 'capitalization'];

export default function StocksPage() {
  const [stocks, setStocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [sortKey, setSortKey] = useState('turnover');
  const [asc, setAsc] = useState(false);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true); setError(null);
    try { setStocks(await fetchStocks()); }
    catch (e) { setError(e); }
    finally { setLoading(false); }
  }

  /* Поиск по тикеру, названию и ISIN */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return stocks;
    return stocks.filter(s =>
      (s.secid || '').toLowerCase().includes(q) ||
      (s.shortname || '').toLowerCase().includes(q) ||
      (s.name || '').toLowerCase().includes(q) ||
      (s.isin || '').toLowerCase().includes(q)
    );
  }, [stocks, query]);

  /* Сортировка по выбранной колонке */
  const sorted = useMemo(() => {
    const col = COLS[sortKey];
    if (!col) return filtered;
    const arr = [...filtered].sort((a, b) => {
      const av = col.sort(a), bv = col.sort(b);
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'string' || typeof bv === 'string') return String(av).localeCompare(String(bv), 'ru');
      return av - bv;
    });
    return asc ? arr : arr.reverse();
  }, [filtered, sortKey, asc]);

  const pages = Math.max(1, Math.ceil(sorted.length / PER_PAGE));
  const current = Math.min(page, pages);
  const rows = sorted.slice((current - 1) * PER_PAGE, current * PER_PAGE);

  /* KPI считаем по всему списку, а не по текущей странице */
  const up = stocks.filter(s => s.change > 0).length;
  const down = stocks.filter(s => s.change < 0).length;
  const turnoverSum = stocks.reduce((a, s) => a + (s.turnover || 0), 0);

  const top10 = useMemo(
    () => [...stocks].sort((a, b) => (b.turnover || 0) - (a.turnover || 0)).slice(0, 10),
    [stocks]
  );

  function click(k) {
    if (k === sortKey) setAsc(a => !a);
    else { setSortKey(k); setAsc(false); }
  }

  if (loading) return <Loading text="Загрузка акций с Московской биржи…" />;
  if (error) return <ErrorBox error={error} onRetry={load} />;

  return (
    <div>
      <div className="page-h">
        <div className="page-t">◈ Акции Мосбиржи</div>
        <div className="page-s">
          Основной режим TQBR · {nf(stocks.length, 0)} бумаг с ценой · источник — ISS MOEX
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', marginBottom: 14 }}>
        <Kpi label="Бумаг" value={nf(stocks.length, 0)} sub={`в выборке ${nf(filtered.length, 0)}`} />
        <Kpi
          label="Растёт"
          value={nf(up, 0)}
          cls="c-g"
          sub={stocks.length ? nf(up / stocks.length * 100, 0) + '% рынка' : '—'}
        />
        <Kpi
          label="Падает"
          value={nf(down, 0)}
          cls="c-r"
          sub={stocks.length ? nf(down / stocks.length * 100, 0) + '% рынка' : '—'}
        />
        <Kpi label="Оборот за день" value={money(turnoverSum)} sub="сумма по всем бумагам" />
      </div>

      <Panel
        title="Все акции"
        right={
          <input
            className="inp"
            style={{ width: 240 }}
            placeholder="Поиск: тикер или название"
            value={query}
            onChange={e => { setQuery(e.target.value); setPage(1); }}
          />
        }
        pad={false}
      >
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                {ORDER.map(k => (
                  <th key={k} onClick={() => click(k)}>
                    {COLS[k].label}{sortKey === k && (asc ? ' ↑' : ' ↓')}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(s => (
                <tr key={s.secid}>
                  {ORDER.map(k => <td key={k}>{COLS[k].cell(s)}</td>)}
                </tr>
              ))}
              {!rows.length && (
                <tr><td colSpan={ORDER.length} className="empty">Ничего не найдено</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <Pager page={current} pages={pages} onChange={setPage} total={sorted.length} perPage={PER_PAGE} />
      </Panel>

      <div style={{ height: 14 }} />

      <Panel title="Топ-10 по обороту" pad={false}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th className="nosort">#</th>
                <th className="nosort">Тикер</th>
                <th className="nosort">Название</th>
                <th className="nosort">Оборот</th>
                <th className="nosort">Изм. за день</th>
              </tr>
            </thead>
            <tbody>
              {top10.map((s, i) => (
                <tr key={s.secid}>
                  <td className="mono c-3">{i + 1}</td>
                  <td><span className="mono" style={{ fontWeight: 600 }}>{s.secid}</span></td>
                  <td style={{ textAlign: 'left', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {s.shortname}
                  </td>
                  <td className="mono">{money(s.turnover)}</td>
                  <td className={chgClass(s.change)}>{chgStr(s.change)}</td>
                </tr>
              ))}
              {!top10.length && (
                <tr><td colSpan={5} className="empty">Нет данных</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}