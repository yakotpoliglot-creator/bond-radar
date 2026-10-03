/* ═══════════════════════════════════════════════════════════════════
   Акции Мосбиржи (основной режим TQBR, ~260 бумаг с ценой).
   Данные берём одним запросом fetchStocks() — кэша в слое данных нет,
   поэтому список грузим один раз при монтировании.
   ═══════════════════════════════════════════════════════════════════ */
import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchStocks, fetchSectors, fetchFundamentals } from '../api/moex';
import { Panel, Kpi, Loading, ErrorBox, Pager } from '../components/ui';
import { nf, money, chgPill, chgStrA } from '../lib/format';

const PER_PAGE = 50;

/* ═══ Отчётность: откуда числа и почему у части бумаг прочерк ═══════

   fundamentals.json собирает робот со smart-lab; ключ — тикер акции, и он
   совпадает с secid бумаги в списке MOEX, поэтому связь прямая и без
   догадок.

   Берём скользящие 12 месяцев (LTM), когда они есть: это свежее последнего
   годового отчёта. Где LTM нет — последний год. Видно это в колонке
   «Отчёт»: смешивать одно с другим молча нельзя, иначе у одной компании
   в колонке окажется октябрь, а у другой декабрь.

   Прочерк — это НЕ ноль. У банков выручки и EBITDA не бывает вовсе (так
   устроен их учёт), у части компаний источник их не публикует, а кто-то
   ещё не отчитался. Прочерк так и остаётся прочерком. */
function fundOf(fdata, secid) {
  const t = fdata?.tickers?.[secid];
  const fin = t?.fin;
  if (!fin?.metrics) return null;

  const ltm = fin.ltm || {};
  const years = fin.years || [];
  const last = years.length ? years[years.length - 1] : null;
  /* Признак «есть скользящие» — по главным строкам. Если LTM есть, но
     конкретного показателя в нём нет, берём год: показать прочерк там,
     где число есть, было бы хуже. */
  const hasLtm = ltm.revenue != null || ltm.ebitda != null || ltm.netProfit != null;
  const pick = (k) => {
    if (hasLtm && ltm[k] != null) return ltm[k];
    const v = last != null ? fin.metrics[k]?.values?.[last] : undefined;
    return v == null ? null : v;
  };

  return {
    period: hasLtm ? '12 мес.' : (last || null),
    revenue: pick('revenue'),
    ebitda: pick('ebitda'),
    ebitdaMargin: pick('ebitdaMargin'),
    netProfit: pick('netProfit'),
    netMargin: pick('netMargin'),
    debtEbitda: pick('debtEbitda'),
    netDebtEbitda: pick('netDebtEbitda'),
    interestCoverage: pick('interestCoverage'),
    pe: pick('pe'),
    divYield: pick('divYield'),
    employees: pick('employees'),
  };
}

/* Деньги отчётности приходят в МИЛЛИАРДАХ рублей: 4642 — это 4,64 трлн.
   Общий money() здесь не годится: он принимает рубли и на числе 4642
   выдал бы «4,64 тыс. ₽» — ошибку в миллиард раз. Поймал это на сверке
   колонки с карточкой компании, где та же цифра подписана «млрд ₽». */
function finMoney(v) {
  if (v == null) return '—';
  const abs = Math.abs(v);
  if (abs >= 1000) return nf(v / 1000, 2) + ' трлн ₽';
  return nf(v, 1) + ' млрд ₽';
}

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
    cell: s => <span className={chgPill(s.change)}>{chgStrA(s.change)}</span>,
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
  /* Отрасль приходит не из паспорта бумаги, а из состава отраслевых
     индексов Мосбиржи — см. fetchSectors() в api/moex.js. Прочерк
     означает, что биржа эту бумагу ни в один отраслевой индекс не
     включает; выдумывать отрасль вместо прочерка мы не будем. */
  sector: {
    label: 'Сектор', sort: s => s.sector || '\uffff',
    cell: s => (s.sector
      ? <span className="tag">{s.sector}</span>
      : <span className="c-3">—</span>),
  },

  /* ── отчётность ────────────────────────────────────────────────── */
  period: {
    label: 'Отчёт', sort: s => s.f?.period || '',
    cell: s => (s.f?.period
      ? <span className="c-2" style={{ fontSize: 10.5 }}>{s.f.period}</span>
      : <span className="c-3">нет данных</span>),
  },
  revenue: {
    label: 'Выручка', sort: s => s.f?.revenue ?? -1,
    cell: s => <span className="mono">{finMoney(s.f?.revenue)}</span>,
  },
  /* EBITDA у банков не бывает — у них другая структура отчёта. Прочерк
     здесь означает «показателя нет», а не «компания ничего не заработала»;
     это же видно и в образце, с которым нас сравнивают. */
  ebitda: {
    label: 'EBITDA', sort: s => s.f?.ebitda ?? -1,
    cell: s => <span className="mono" style={{ fontWeight: 600 }}>
      {finMoney(s.f?.ebitda)}
    </span>,
  },
  ebitdaMargin: {
    label: 'EBITDA-маржа', sort: s => s.f?.ebitdaMargin ?? -1,
    cell: s => <span className="mono">{s.f?.ebitdaMargin == null ? '—' : nf(s.f.ebitdaMargin, 1) + ' %'}</span>,
  },
  netProfit: {
    label: 'Чистая прибыль', sort: s => s.f?.netProfit ?? -1,
    cell: s => <span className={'mono ' + ((s.f?.netProfit ?? 0) < 0 ? 'c-r' : '')}>
      {finMoney(s.f?.netProfit)}
    </span>,
  },
  netMargin: {
    label: 'Чистая маржа', sort: s => s.f?.netMargin ?? -1,
    cell: s => <span className="mono">{s.f?.netMargin == null ? '—' : nf(s.f.netMargin, 1) + ' %'}</span>,
  },
  /* Пороги — наше суждение, а не факт из отчёта: для девелопера и для
     нефтянки долг в три EBITDA значит разное. Подписываем это прямо,
     чтобы светофор не читался как сигнал к покупке. */
  debtEbitda: {
    label: 'Долг/EBITDA', sort: s => s.f?.debtEbitda ?? 1e9,
    cell: s => {
      const v = s.f?.debtEbitda;
      if (v == null) return <span className="c-3">—</span>;
      const cls = v < 1.5 ? 'c-g' : v < 3 ? 'c-y' : 'c-r';
      return <span className={'mono ' + cls}>{nf(v, 2)}</span>;
    },
  },
  netDebtEbitda: {
    label: 'Чистый долг/EBITDA', sort: s => s.f?.netDebtEbitda ?? 1e9,
    cell: s => {
      const v = s.f?.netDebtEbitda;
      if (v == null) return <span className="c-3">—</span>;
      const cls = v < 0 ? 'c-g' : v < 1.5 ? 'c-g' : v < 3 ? 'c-y' : 'c-r';
      return <span className={'mono ' + cls}>{nf(v, 2)}</span>;
    },
  },
  interestCoverage: {
    label: 'Покрытие процентов', sort: s => s.f?.interestCoverage ?? -1,
    cell: s => {
      const v = s.f?.interestCoverage;
      if (v == null) return <span className="c-3">—</span>;
      const cls = v > 5 ? 'c-g' : v > 2 ? 'c-y' : 'c-r';
      return <span className={'mono ' + cls}>{nf(v, 2)}</span>;
    },
  },
  /* Отрицательный P/E — это не «дешёвая компания», а убыток: у Северстали
     источник отдал −850, и печатать такое число рядом с обычными значило бы
     предлагать сравнение, которого не существует. Пишем словом. */
  pe: {
    label: 'P/E', sort: s => (s.f?.pe != null && s.f.pe > 0 ? s.f.pe : 1e9),
    cell: s => {
      const v = s.f?.pe;
      if (v == null) return <span className="c-3">—</span>;
      if (v <= 0) return <span className="c-3" style={{ fontSize: 10.5 }}>убыток</span>;
      return <span className="mono">{nf(v, 1)}</span>;
    },
  },
  divYield: {
    label: 'Дивдоходность', sort: s => s.f?.divYield ?? -1,
    cell: s => <span className="mono">{s.f?.divYield == null ? '—' : nf(s.f.divYield, 2) + ' %'}</span>,
  },
};

/* ── два вида таблицы ────────────────────────────────────────────────

   Торговые данные и отчётность в одной таблице не помещаются: вместе это
   двадцать шесть колонок, в которых перестаёшь что-либо видеть. Поэтому
   переключатель, а не одна длинная простыня. */
const VIEW_MARKET = ['secid', 'name', 'price', 'change', 'open', 'low', 'high', 'turnover', 'numTrades', 'capitalization', 'sector'];
const VIEW_FIN = ['secid', 'name', 'price', 'capitalization', 'period', 'revenue', 'ebitda', 'ebitdaMargin', 'netProfit', 'netMargin', 'debtEbitda', 'netDebtEbitda', 'interestCoverage', 'pe', 'divYield'];
const VIEWS = [
  { id: 'market', label: 'Торговые данные', cols: VIEW_MARKET },
  { id: 'fin', label: 'Отчётность и мультипликаторы', cols: VIEW_FIN },
];

export default function StocksPage() {
  const nav = useNavigate();
  const [stocks, setStocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [sortKey, setSortKey] = useState('turnover');
  const [asc, setAsc] = useState(false);
  const [view, setView] = useState('market');
  const [onlyFin, setOnlyFin] = useState(false);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true); setError(null);
    try {
      /* Список бумаг, отрасли и отчётность грузим параллельно. Если
         отраслевой индекс не ответит, страница всё равно покажет акции —
         просто с прочерками в колонке «Сектор». Отрасли важны, но не
         настолько, чтобы из-за них пропадала вся таблица.

         Отчётность — отдельный файл на 2,3 МБ, собранный роботом;
         в слое данных он кэшируется, поэтому карточка компании его
         второй раз не тянет. Если файла нет или он не разобрался,
         таблица работает как раньше — с прочерками, а не с нулями. */
      const [list, sectors, fdata] = await Promise.all([
        fetchStocks(),
        fetchSectors().catch(() => ({})),
        fetchFundamentals().catch(() => null),
      ]);
      setStocks(list.map(s => ({
        ...s,
        sector: sectors[s.secid] || null,
        f: fundOf(fdata, s.secid),
      })));
    } catch (e) { setError(e); }
    finally { setLoading(false); }
  }

  const cols = (VIEWS.find(v => v.id === view) || VIEWS[0]).cols;

  /* Переключение вида: колонки меняются целиком, поэтому и сортировка
     должна встать на что-то осмысленное в новом виде. Иначе после
     перехода на отчётность таблица осталась бы отсортированной по
     обороту, которого в ней уже нет. */
  function switchView(id) {
    setView(id);
    setSortKey(id === 'fin' ? 'ebitda' : 'turnover');
    setAsc(false);
    setPage(1);
  }

  /* Поиск по тикеру, названию и ISIN */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let arr = stocks;
    if (onlyFin) arr = arr.filter(s => s.f && s.f.period);
    if (!q) return arr;
    return arr.filter(s =>
      (s.secid || '').toLowerCase().includes(q) ||
      (s.shortname || '').toLowerCase().includes(q) ||
      (s.name || '').toLowerCase().includes(q) ||
      (s.isin || '').toLowerCase().includes(q)
    );
  }, [stocks, query, onlyFin]);

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
  const withFin = stocks.filter(s => s.f && s.f.period).length;
  /* EBITDA есть не у всех, и это не пробел источника: у банков её не
     бывает физически — в их отчётности нет ни выручки, ни EBITDA. */
  const withEbitda = stocks.filter(s => s.f?.ebitda != null).length;

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
          Основной режим TQBR · {nf(stocks.length, 0)} акций с ценой (обыкновенные и привилегированные) ·
          торговые данные — ISS MOEX, отчётность — файл робота со smart-lab
        </div>
        <div className="c-3" style={{ fontSize: 11, marginTop: 4 }}>
          Переключатель над таблицей меняет вид: торговые данные или отчётность
          с мультипликаторами. Нажмите на бумагу — откроется карточка с графиком,
          отчётностью по годам и калькулятором доходности. Заголовки колонок сортируют таблицу.
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
        <Kpi
          label="С отчётностью"
          value={nf(withFin, 0)}
          sub={`из ${nf(stocks.length, 0)} · файл собирает робот`}
        />
        <Kpi
          label="EBITDA известна"
          value={nf(withEbitda, 0)}
          sub="у банков её не бывает вовсе"
        />
      </div>

      {/* ── Вид таблицы и фильтр ─────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        {VIEWS.map(v => (
          <button
            key={v.id}
            className={'chip' + (v.id === view ? ' on' : '')}
            onClick={() => switchView(v.id)}
          >
            {v.label}
          </button>
        ))}
        <button
          className={'chip' + (onlyFin ? ' on' : '')}
          onClick={() => { setOnlyFin(v => !v); setPage(1); }}
          title="Оставить только те бумаги, по которым есть отчётность"
        >
          только с отчётностью
        </button>
        <span className="c-3" style={{ fontSize: 11.5, marginLeft: 'auto' }}>
          {view === 'fin'
            ? 'числа — из отчётности компаний, «Отчёт» показывает период: 12 мес. или год'
            : 'цены и обороты — с Московской биржи'}
        </span>
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
                {cols.map(k => (
                  <th key={k} onClick={() => click(k)}>
                    {COLS[k].label}{sortKey === k && (asc ? ' ↑' : ' ↓')}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(s => (
                <tr key={s.secid} onClick={() => nav('/stock/' + s.secid)}
                  title={'Открыть карточку ' + s.shortname}>
                  {cols.map(k => <td key={k}>{COLS[k].cell(s)}</td>)}
                </tr>
              ))}
              {!rows.length && (
                <tr><td colSpan={cols.length} className="empty">Ничего не найдено</td></tr>
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
                <tr key={s.secid} onClick={() => nav('/stock/' + s.secid)}>
                  <td className="mono c-3">{i + 1}</td>
                  <td><span className="mono" style={{ fontWeight: 600 }}>{s.secid}</span></td>
                  <td style={{ textAlign: 'left', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {s.shortname}
                  </td>
                  <td className="mono">{money(s.turnover)}</td>
                  <td><span className={chgPill(s.change)}>{chgStrA(s.change)}</span></td>
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