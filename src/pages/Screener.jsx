import { useState, useEffect, useMemo, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { fetchBonds, COLLECTIONS, COUPON_LABEL, daysUntil } from '../api/moex';
import { BondTable, DEFAULT_COLS, Pager, Loading, ErrorBox, Panel, Kpi } from '../components/ui';
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
};

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

  // YTM от / до — бумаги с недостоверной доходностью диапазон не проходят
  const min = f.ytmMin === '' ? null : +f.ytmMin;
  const max = f.ytmMax === '' ? null : +f.ytmMax;
  if (min != null || max != null) {
    if (b.ytm == null) return false;
    if (min != null && !Number.isNaN(min) && b.ytm < min) return false;
    if (max != null && !Number.isNaN(max) && b.ytm > max) return false;
  }

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

  return true;
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
    return { rows: out, hiddenAnomaly: hidden };
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
        right={<span className="kpi-s">{rows.length} шт. по фильтру · по {PER_PAGE} на страницу</span>}
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
            <BondTable bonds={slice} cols={DEFAULT_COLS} />
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