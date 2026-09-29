import { useState, useEffect, useMemo, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { fetchBonds, COLLECTIONS, COUPON_LABEL, daysUntil } from '../api/moex';
import { BondTable, Pager, Loading, ErrorBox, Panel, Kpi } from '../components/ui';
import { nf } from '../lib/format';
import { useFavorites } from '../lib/store';

/* ═══════════════════════════════════════════════════════════════════
   Скринер облигаций — все выпуски MOEX: TQCB (корпоративные) + TQOB (ОФЗ), ≈3095 шт.
   Данные: fetchBonds() → iss.moex.com. Сортировка — внутри BondTable.
   ═══════════════════════════════════════════════════════════════════ */

const PER_PAGE = 50;

/* Корзины по сроку до погашения: [днейОт, днейДо] */
const MATURITY = {
  all: null,
  lt1: [0, 365],        // до 1 года
  '1-3': [365, 1095],   // 1–3 года
  '3-5': [1095, 1825],  // 3–5 лет
  '5+': [1825, Infinity],
};

const MATURITY_LABEL = {
  all: 'Все',
  lt1: 'до 1 года',
  '1-3': '1–3 года',
  '3-5': '3–5 лет',
  '5+': '5+ лет',
};

/* Значения фильтров по умолчанию (hideAnomaly включён по требованию) */
const EMPTY_FILTERS = {
  search: '',
  ytmMin: '',
  ytmMax: '',
  kind: 'all',
  level: 'all',
  maturity: 'all',
  turnoverMin: '',
  hideAnomaly: true,
  /* ── добавлено по образцу платного скринера ═─────────────────────
     Всё это Мосбиржа отдаёт бесплатно, просто мы раньше не выводили. */
  zMin: '',            // Z-спред от, п.п. — премия к кривой ОФЗ
  zMax: '',
  durMin: '',          // дюрация от, лет — чувствительность к ставке
  durMax: '',
  priceMin: '',        // цена от, % номинала
  priceMax: '',
  curMin: '',          // купонная доходность сейчас, %
  curMax: '',
  freq: 'all',         // частота купона
  currency: 'all',     // валюта номинала
  onlyOnePerIssuer: false,  // не больше одного выпуска эмитента
  soonMaturity: false,      // погашение в ближайший год
  noAmort: false,           // без амортизации
};

/* Частота купона по периоду в днях. Границы взяты с запасом:
   биржа отдаёт 30 / 91 / 182 / 365, но бывают выплаты по календарю.
   Заполнено у всех выпусков, однако у 334 дисконтных период равен 0
   (купона нет вовсе), а у ~247 биржа отдаёт мусор вроде 6268 — такие
   в корзины не попадают и видны только при «Любой». */
const FREQ_RANGES = {
  monthly: [25, 45],
  quarterly: [80, 100],
  semi: [170, 200],
  annual: [340, 400],
};

const FREQ_LABEL = {
  all: 'Любая',
  monthly: 'Ежемесячно',
  quarterly: 'Раз в квартал',
  semi: 'Раз в полгода',
  annual: 'Раз в год',
};

/* Колонки скринера — шире, чем в подборках: показываем те метрики,
   по которым фильтруем, чтобы результат можно было проверить глазами. */
const SCREENER_COLS = [
  'name', 'ytm', 'zspread', 'coupon', 'currentYield',
  'price', 'duration', 'mat', 'level', 'turnover',
];

/* Диапазонный фильтр: пустое поле — не ограничивает.
   Значение null (нет данных) диапазон не проходит — иначе «от 10»
   пропускало бы бумаги, про которые мы просто ничего не знаем. */
function inRange(v, minS, maxS) {
  const min = minS === '' ? null : +minS;
  const max = maxS === '' ? null : +maxS;
  const hasMin = min != null && !Number.isNaN(min);
  const hasMax = max != null && !Number.isNaN(max);
  if (!hasMin && !hasMax) return true;
  if (v == null) return false;
  if (hasMin && v < min) return false;
  if (hasMax && v > max) return false;
  return true;
}

/* ── Проверка одной бумаги по всем фильтрам (кроме аномальной доходности) ── */
function matchFilters(b, f) {
  // Поиск по названию / ISIN / SECID
  if (f.search) {
    const q = f.search.trim().toLowerCase();
    if (q) {
      const hit =
        (b.shortname || '').toLowerCase().includes(q) ||
        (b.name || '').toLowerCase().includes(q) ||
        (b.isin || '').toLowerCase().includes(q) ||
        (b.secid || '').toLowerCase().includes(q);
      if (!hit) return false;
    }
  }

  // Доходность к погашению: бумаги с недостоверной доходностью диапазон не проходят
  if (!inRange(b.ytm, f.ytmMin, f.ytmMax)) return false;

  // Z-спред — премия к кривой ОФЗ, процентные пункты
  if (!inRange(b.zSpread, f.zMin, f.zMax)) return false;

  // Дюрация в годах (у нас хранится в днях)
  const durYears = b.durationDays != null ? b.durationDays / 365 : null;
  if (!inRange(durYears, f.durMin, f.durMax)) return false;

  // Цена, % номинала
  if (!inRange(b.price, f.priceMin, f.priceMax)) return false;

  // Купонная доходность сейчас
  if (!inRange(b.currentYield, f.curMin, f.curMax)) return false;

  // Тип купона
  if (f.kind !== 'all' && b.couponKind !== f.kind) return false;

  // Уровень листинга
  if (f.level !== 'all' && String(b.listLevel) !== f.level) return false;

  // Срок до погашения (через daysUntil; бумаги без даты погашения не проходят)
  const range = MATURITY[f.maturity];
  if (range) {
    if (!b.matDate) return false;
    const d = daysUntil(b.matDate);
    if (!(d > range[0] && d <= range[1])) return false;
  }

  // Оборот от, ₽ — отсекаем неликвид
  if (f.turnoverMin !== '') {
    const t = +f.turnoverMin;
    if (!Number.isNaN(t) && (b.turnover || 0) < t) return false;
  }

  // Частота купона
  const fr = FREQ_RANGES[f.freq];
  if (fr) {
    if (b.couponPeriod == null) return false;
    if (!(b.couponPeriod >= fr[0] && b.couponPeriod <= fr[1])) return false;
  }

  // Валюта номинала
  if (f.currency !== 'all') {
    if (!b.isCurrency || b.currency !== f.currency) return false;
  }

  // Погашение в ближайший год
  if (f.soonMaturity) {
    if (!b.matDate) return false;
    const d = daysUntil(b.matDate);
    if (!(d > 0 && d <= 365)) return false;
  }

  // Без амортизации — номинал гасится целиком в конце
  if (f.noAmort && b.isAmort) return false;

  return true;
}

/* Не больше одного выпуска эмитента.
   Оставляем самый ликвидный: по нему реальнее всего купить и продать,
   а доходность остальных выпусков того же эмитента почти такая же. */
function onePerIssuer(list) {
  const best = new Map();
  for (const b of list) {
    const key = b.issuerKey || b.isin || b.secid;
    const cur = best.get(key);
    if (!cur || (b.turnover || 0) > (cur.turnover || 0)) best.set(key, b);
  }
  return [...best.values()];
}

/* Пара полей «от / до» для числового диапазона.
   Пустое поле = без ограничения с этой стороны. */
function RangePair({ label, unit, from, to, onFrom, onTo, step = '0.1', width = 76 }) {
  return (
    <div className="fg">
      <label>{label}{unit ? `, ${unit}` : ''}</label>
      <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
        <input
          className="inp" style={{ width }} type="number" step={step} placeholder="от"
          value={from} onChange={e => onFrom(e.target.value)}
        />
        <span className="c-3" style={{ fontSize: 11 }}>—</span>
        <input
          className="inp" style={{ width }} type="number" step={step} placeholder="до"
          value={to} onChange={e => onTo(e.target.value)}
        />
      </div>
    </div>
  );
}

/* Галочка-фильтр с подсказкой. */
function CheckFilter({ label, title, checked, onChange }) {
  return (
    <div className="fg">
      <label style={{ minHeight: 14 }}>&nbsp;</label>
      <label
        title={title}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, minHeight: 30,
          fontSize: 12, fontWeight: 400, textTransform: 'none',
          letterSpacing: 0, color: 'var(--text2)', cursor: 'pointer',
        }}
      >
        <input
          type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)}
          style={{ accentColor: 'var(--accent)', width: 14, height: 14 }}
        />
        {label}
      </label>
    </div>
  );
}

export default function Screener() {
  const loc = useLocation();
  const nav = useNavigate();
  const { list: favList } = useFavorites();

  const [bonds, setBonds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [onlyFav, setOnlyFav] = useState(false);   // доп. фильтр «только избранное»
  const [page, setPage] = useState(1);

  /* ── загрузка данных MOEX ── */
  const load = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchBonds({ force });
      setBonds(data);
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(false); }, [load]);

  /* ── подборка из hash-роутинга: #/screener?cat=<slug> ── */
  const catSlug = new URLSearchParams(loc.search).get('cat');
  const collection = useMemo(
    () => COLLECTIONS.find(c => c.slug === catSlug) || null,
    [catSlug],
  );

  /* ── фильтрация ── */
  const { rows, hiddenAnomaly } = useMemo(() => {
    const out = [];
    let hidden = 0;
    for (const b of bonds) {
      // фильтр подборки
      if (collection && !collection.test(b)) continue;
      // только избранное
      if (onlyFav && !favList.includes(b.isin)) continue;
      // остальные фильтры
      if (!matchFilters(b, filters)) continue;
      // аномальная доходность (ytm == null при «битом» ytmRaw)
      if (b.ytm == null) {
        if (filters.hideAnomaly) { hidden++; continue; }
      }
      out.push(b);
    }
    // «не больше одного выпуска эмитента» применяем последним —
    // сначала отсеиваем по качеству бумаги, потом выбираем лучшую у эмитента
    const final = filters.onlyOnePerIssuer ? onePerIssuer(out) : out;
    return { rows: final, hiddenAnomaly: hidden };
  }, [bonds, filters, collection, onlyFav, favList]);

  // при смене фильтров/подборки возвращаемся на первую страницу
  useEffect(() => { setPage(1); }, [filters, collection, onlyFav]);

  const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  const cur = Math.min(page, pages);
  const slice = useMemo(
    () => rows.slice((cur - 1) * PER_PAGE, cur * PER_PAGE),
    [rows, cur],
  );

  const avgYtm = useMemo(() => {
    const vals = rows.map(b => b.ytm).filter(v => v != null);
    if (!vals.length) return null;
    return vals.reduce((s, v) => s + v, 0) / vals.length;
  }, [rows]);

  const set = patch => setFilters(f => ({ ...f, ...patch }));
  const reset = () => { setFilters(EMPTY_FILTERS); setOnlyFav(false); setPage(1); };

  /* ── Выгрузка отфильтрованного списка в CSV ──
     Разделитель «;» и BOM — чтобы Excel в русской локали открыл файл
     сразу, без танцев с кодировкой. Числа отдаём с точкой: Excel поймёт. */
  const exportCsv = () => {
    const cols = [
      ['Выпуск', b => b.shortname],
      ['ISIN', b => b.isin],
      ['Цена, %', b => b.price],
      ['YTM, %', b => b.ytm],
      ['Z-спред, п.п.', b => b.zSpread],
      ['Купон, %', b => b.couponPercent],
      ['Куп. доходность, %', b => b.currentYield],
      ['Дюрация, лет', b => (b.durationDays == null ? null : (b.durationDays / 365).toFixed(2))],
      ['Оферта', b => b.offerDate],
      ['Погашение', b => b.matDate],
      ['Листинг', b => b.listLevel],
      ['Оборот, ₽', b => b.turnover],
    ];
    const esc = v => {
      if (v == null) return '';
      const s = String(v);
      return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [cols.map(c => esc(c[0])).join(';')];
    for (const b of rows) lines.push(cols.map(c => esc(c[1](b))).join(';'));
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bond-radar-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (loading && !bonds.length) return <Loading />;
  if (error && !bonds.length) return <ErrorBox error={error} onRetry={() => load(true)} />;

  return (
    <div>
      {/* ── Заголовок: честно показываем, сколько записей прошло фильтр ── */}
      <div className="page-h">
        <div className="page-t">☰ Скринер облигаций</div>
        <div className="page-s">
          показано <b>{rows.length}</b> из <b>{bonds.length}</b> выпусков
          {collection && <> · подборка «{collection.title}»</>}
          <button
            className="btn btn-sm"
            style={{ marginLeft: 10 }}
            onClick={() => load(true)}
            disabled={loading}
          >
            {loading ? 'Обновление…' : '↻ Обновить'}
          </button>
        </div>
      </div>

      {/* ── Плашка активной подборки из ссылки ── */}
      {catSlug && (
        collection ? (
          <div className="filters" style={{ marginBottom: 12, alignItems: 'center' }}>
            <span className="tag b" style={{ padding: '5px 10px', fontSize: 11.5 }}>
              Подборка: {collection.title}
            </span>
            <button className="btn btn-sm" onClick={() => nav('/screener')}>Снять</button>
          </div>
        ) : (
          <div className="err" style={{ textAlign: 'left', padding: '8px 0 12px' }}>
            Подборка «{catSlug}» не найдена — фильтр по ней не применён.
            <button className="btn btn-sm" style={{ marginLeft: 10 }} onClick={() => nav('/collections')}>
              Все подборки
            </button>
          </div>
        )
      )}

      {/* ── Сводка ── */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginBottom: 12 }}>
        <Kpi label="Всего выпусков" value={bonds.length} sub="TQCB + TQOB, MOEX" />
        <Kpi label="Отфильтровано" value={rows.length} sub={bonds.length ? nf(rows.length / bonds.length * 100, 1) + '% от рынка' : ''} />
        <Kpi label="Средняя доходность" value={avgYtm == null ? '—' : nf(avgYtm, 2) + '%'} sub="по выборке" />
      </div>

      {/* ── Фильтры ── */}
      <Panel title="Фильтры" style={{ marginBottom: 12 }}>
        <div className="filters">
          <div className="fg">
            <label>Поиск</label>
            <input
              className="inp"
              style={{ width: 220 }}
              placeholder="Название / ISIN / SECID"
              value={filters.search}
              onChange={e => set({ search: e.target.value })}
            />
          </div>

          <div className="fg">
            <label>YTM от, %</label>
            <input
              className="inp"
              style={{ width: 90 }}
              type="number"
              step="0.1"
              placeholder="0"
              value={filters.ytmMin}
              onChange={e => set({ ytmMin: e.target.value })}
            />
          </div>

          <div className="fg">
            <label>YTM до, %</label>
            <input
              className="inp"
              style={{ width: 90 }}
              type="number"
              step="0.1"
              placeholder="300"
              value={filters.ytmMax}
              onChange={e => set({ ytmMax: e.target.value })}
            />
          </div>

          <div className="fg">
            <label>Тип купона</label>
            <select className="sel" value={filters.kind} onChange={e => set({ kind: e.target.value })}>
              <option value="all">Все</option>
              {Object.entries(COUPON_LABEL)
                .filter(([k]) => k !== 'other')
                .map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </div>

          <div className="fg">
            <label>Уровень листинга</label>
            <select className="sel" value={filters.level} onChange={e => set({ level: e.target.value })}>
              <option value="all">Все</option>
              <option value="1">1 уровень</option>
              <option value="2">2 уровень</option>
              <option value="3">3 уровень</option>
            </select>
          </div>

          <div className="fg">
            <label>Срок до погашения</label>
            <select className="sel" value={filters.maturity} onChange={e => set({ maturity: e.target.value })}>
              {Object.entries(MATURITY_LABEL).map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </select>
          </div>

          <div className="fg">
            <label>Оборот от, ₽</label>
            <input
              className="inp"
              style={{ width: 130 }}
              type="number"
              step="1000"
              placeholder="например 1 000 000"
              value={filters.turnoverMin}
              onChange={e => set({ turnoverMin: e.target.value })}
            />
          </div>

          {/* ── Z-спред: премия к кривой ОФЗ. Главная метрика скринера ── */}
          <RangePair
            label="Z-спред" unit="п.п."
            from={filters.zMin} to={filters.zMax}
            onFrom={v => set({ zMin: v })} onTo={v => set({ zMax: v })}
          />

          <RangePair
            label="Дюрация" unit="лет"
            from={filters.durMin} to={filters.durMax}
            onFrom={v => set({ durMin: v })} onTo={v => set({ durMax: v })}
          />

          <RangePair
            label="Цена" unit="% номинала" step="1"
            from={filters.priceMin} to={filters.priceMax}
            onFrom={v => set({ priceMin: v })} onTo={v => set({ priceMax: v })}
          />

          <RangePair
            label="Купонная доходность" unit="%"
            from={filters.curMin} to={filters.curMax}
            onFrom={v => set({ curMin: v })} onTo={v => set({ curMax: v })}
          />

          <div className="fg">
            <label>Частота купона</label>
            <select className="sel" value={filters.freq} onChange={e => set({ freq: e.target.value })}>
              {Object.entries(FREQ_LABEL).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </div>

          <div className="fg">
            <label>Валюта номинала</label>
            <select className="sel" value={filters.currency} onChange={e => set({ currency: e.target.value })}>
              <option value="all">Любая</option>
              <option value="USD">Доллар</option>
              <option value="EUR">Евро</option>
              <option value="CNY">Юань</option>
            </select>
          </div>

          <CheckFilter
            label="Один выпуск на эмитента"
            title="Оставить у каждого эмитента только самый ликвидный выпуск. У одного эмитента бумаг может быть много, и они почти повторяют друг друга — так список короче и понятнее."
            checked={filters.onlyOnePerIssuer}
            onChange={v => set({ onlyOnePerIssuer: v })}
          />

          <CheckFilter
            label="Погашение до года"
            title="Только бумаги, которые гасятся в ближайшие 12 месяцев."
            checked={filters.soonMaturity}
            onChange={v => set({ soonMaturity: v })}
          />

          <CheckFilter
            label="Без амортизации"
            title="Исключить бумаги, у которых номинал возвращают частями. У них доходность считается сложнее и цена не так показательна."
            checked={filters.noAmort}
            onChange={v => set({ noAmort: v })}
          />

          <div className="fg">
            <label>Достоверность</label>
            <label
              title="У части выпусков MOEX отдаёт битую доходность (значение вне допустимого диапазона −50…300 %). Такие бумаги показываются как «н/д» и по умолчанию исключены из выборки, чтобы не портить сортировку и средние."
              style={{
                display: 'flex', alignItems: 'center', gap: 6, minHeight: 30,
                fontSize: 12, fontWeight: 400, textTransform: 'none',
                letterSpacing: 0, color: 'var(--text2)', cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={filters.hideAnomaly}
                onChange={e => set({ hideAnomaly: e.target.checked })}
                style={{ accentColor: 'var(--accent)', width: 14, height: 14 }}
              />
              Скрыть аномальную доходность
            </label>
          </div>

          <div className="fg">
            <label>Личное</label>
            <button
              className={'chip' + (onlyFav ? ' on' : '')}
              style={{ minHeight: 30 }}
              onClick={() => setOnlyFav(v => !v)}
              title="Оставить только бумаги из избранного"
            >
              ★ Избранное ({favList.length})
            </button>
          </div>

          <div className="fg">
            <label>&nbsp;</label>
            <button className="btn" onClick={reset}>Сбросить фильтры</button>
          </div>
        </div>

        {/* Сноска про скрытые «битые» доходности */}
        {filters.hideAnomaly && hiddenAnomaly > 0 && (
          <div className="kpi-s" style={{ marginTop: 10 }}>
            Скрыто {hiddenAnomaly} вып. с недостоверной доходностью — снимите галочку, чтобы показать их.
          </div>
        )}
        {error && bonds.length > 0 && (
          <div className="err" style={{ textAlign: 'left', paddingTop: 10 }}>
            Обновление не удалось: {String(error)}
          </div>
        )}
      </Panel>

      {/* ── Таблица + пагинация ── */}
      <Panel
        pad={false}
        title={`Результаты · стр. ${cur} из ${pages}`}
        right={
          <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span className="kpi-s">{rows.length} шт. по фильтру · по {PER_PAGE} на страницу</span>
            <button
              className="btn btn-sm"
              onClick={exportCsv}
              disabled={!rows.length}
              title="Скачать все найденные выпуски (не только текущую страницу) в CSV — открывается в Excel"
            >
              ↓ CSV
            </button>
          </span>
        }
      >
        {!rows.length ? (
          <div className="empty">
            Под фильтры не попал ни один выпуск из {bonds.length}.
            <div style={{ marginTop: 10 }}>
              <button className="btn" onClick={reset}>Сбросить фильтры</button>
            </div>
          </div>
        ) : (
          <>
            <BondTable bonds={slice} cols={SCREENER_COLS} />
            <Pager
              page={cur}
              pages={pages}
              onChange={setPage}
              total={rows.length}
              perPage={PER_PAGE}
            />
          </>
        )}
      </Panel>
    </div>
  );
}