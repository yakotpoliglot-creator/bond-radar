import { useState, useEffect, useMemo } from 'react';
import { fetchAllBondsFull } from '../api/moex';

/* ═══════════════════════════════════════════════════════════
   Screener Page — Bond screener with filters
   ═══════════════════════════════════════════════════════════ */

function ytmColor(ytm) {
  if (ytm == null) return 'var(--text3)';
  const v = parseFloat(ytm);
  if (v > 30) return 'var(--red)';
  if (v > 18) return 'var(--amber)';
  if (v > 10) return 'var(--text)';
  return 'var(--green)';
}

function couponType(r) {
  const t = (r.BONDTYPE || '').toLowerCase();
  const d = (r.COUPON_DETAILS || '').toLowerCase();
  if (t.includes('плава')) return 'Флоатер';
  if (t.includes('перемен') || d.includes('ключевая') || d.includes('руония') || d.includes('ruonia') || d.includes('ипц')) return 'Флоатер';
  if (t.includes('дисконт')) return 'Дисконт';
  if (t.includes('структур')) return 'Структурная';
  if (t.includes('суборд')) return 'Суборд';
  if (t.includes('фиксир') || t.includes('известн')) return 'Фикс';
  return r.BONDTYPE || '—';
}

function listLevelClass(lv) {
  if (lv === 1) return 'badge-green';
  if (lv === 2) return 'badge-amber';
  if (lv === 3) return 'badge-red';
  return 'badge-amber';
}

function ratingClass(rating) {
  if (!rating) return null;
  const r = rating.toUpperCase();
  if (r.startsWith('AAA') || r.startsWith('AA')) return 'green';
  if (r.startsWith('A') || r.startsWith('BBB')) return '';
  if (r.startsWith('BB') || r.startsWith('B')) return 'amber';
  return 'red';
}

export default function ScreenerPage() {
  const [bonds, setBonds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filters, setFilters] = useState({
    ytmMin: '', ytmMax: '',
    couponType: 'all',
    rating: 'all',
    listLevel: 'all',
    search: '',
  });
  const [sortCol, setSortCol] = useState('YIELDATPREVWAPRICE');
  const [sortAsc, setSortAsc] = useState(false);

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true); setError(null);
    try {
      const data = await fetchAllBondsFull();
      setBonds(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  const filtered = useMemo(() => {
    let result = bonds;
    // Filter by YTM
    if (filters.ytmMin) {
      result = result.filter(b => {
        const y = parseFloat(b.YIELDATPREVWAPRICE);
        return !isNaN(y) && y >= parseFloat(filters.ytmMin);
      });
    }
    if (filters.ytmMax) {
      result = result.filter(b => {
        const y = parseFloat(b.YIELDATPREVWAPRICE);
        return !isNaN(y) && y <= parseFloat(filters.ytmMax);
      });
    }
    // Filter by coupon type
    if (filters.couponType !== 'all') {
      result = result.filter(b => couponType(b) === filters.couponType);
    }
    // Filter by list level
    if (filters.listLevel !== 'all') {
      result = result.filter(b => String(b.LISTLEVEL) === filters.listLevel);
    }
    // Search by name/ISIN
    if (filters.search) {
      const q = filters.search.toLowerCase();
      result = result.filter(b =>
        (b.SHORTNAME || '').toLowerCase().includes(q) ||
        (b.SECID || '').toLowerCase().includes(q) ||
        (b.ISIN || '').toLowerCase().includes(q)
      );
    }
    // Sort
    result = [...result].sort((a, b) => {
      const av = a[sortCol], bv = b[sortCol];
      if (av == null) return 1; if (bv == null) return -1;
      const cmp = typeof av === 'string'
        ? av.localeCompare(bv)
        : parseFloat(av) - parseFloat(bv);
      return sortAsc ? cmp : -cmp;
    });
    return result;
  }, [bonds, filters, sortCol, sortAsc]);

  function handleSort(col) {
    if (sortCol === col) setSortAsc(!sortAsc);
    else { setSortCol(col); setSortAsc(false); }
  }

  function sortArrow(col) {
    if (sortCol !== col) return '';
    return sortAsc ? ' ↑' : ' ↓';
  }

  if (loading) return <div className="loading">Загрузка данных с Московской биржи...</div>;
  if (error) return <div className="error">Ошибка: {error}</div>;

  return (
    <div>
      <div className="page-header">
        <div className="page-title">🔍 Скринер облигаций</div>
        <div className="page-subtitle">
          {bonds.length} выпусков на Мосбирже · показано {filtered.length}
          <button className="btn" style={{ marginLeft: 12 }} onClick={loadData}>🔄 Обновить</button>
        </div>
      </div>

      {/* Filters */}
      <div className="filters-bar">
        <div className="filter-group">
          <span className="filter-label">Поиск</span>
          <input className="filter-input" placeholder="Название / ISIN" value={filters.search}
            onChange={e => setFilters(f => ({ ...f, search: e.target.value }))} />
        </div>
        <div className="filter-group">
          <span className="filter-label">YTM от</span>
          <input className="filter-input" type="number" step="0.1" placeholder="0" value={filters.ytmMin}
            onChange={e => setFilters(f => ({ ...f, ytmMin: e.target.value }))} />
        </div>
        <div className="filter-group">
          <span className="filter-label">YTM до</span>
          <input className="filter-input" type="number" step="0.1" placeholder="100" value={filters.ytmMax}
            onChange={e => setFilters(f => ({ ...f, ytmMax: e.target.value }))} />
        </div>
        <div className="filter-group">
          <span className="filter-label">Тип купона</span>
          <select className="filter-select" value={filters.couponType}
            onChange={e => setFilters(f => ({ ...f, couponType: e.target.value }))}>
            <option value="all">Все</option>
            <option value="Фикс">Фикс</option>
            <option value="Флоатер">Флоатер</option>
            <option value="Дисконт">Дисконт</option>
            <option value="Суборд">Суборд</option>
          </select>
        </div>
        <div className="filter-group">
          <span className="filter-label">Уровень листинга</span>
          <select className="filter-select" value={filters.listLevel}
            onChange={e => setFilters(f => ({ ...f, listLevel: e.target.value }))}>
            <option value="all">Все</option>
            <option value="1">1 уровень</option>
            <option value="2">2 уровень</option>
            <option value="3">3 уровень</option>
          </select>
        </div>
      </div>

      {/* Table */}
      <div style={{ overflowX: 'auto' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th onClick={() => handleSort('SHORTNAME')}>Название{sortArrow('SHORTNAME')}</th>
              <th onClick={() => handleSort('YIELDATPREVWAPRICE')}>YTM{sortArrow('YIELDATPREVWAPRICE')}</th>
              <th onClick={() => handleSort('COUPONPERCENT')}>Купон{sortArrow('COUPONPERCENT')}</th>
              <th onClick={() => handleSort('PREVPRICE')}>Цена{sortArrow('PREVPRICE')}</th>
              <th onClick={() => handleSort('ACCRUEDINT')}>НКД{sortArrow('ACCRUEDINT')}</th>
              <th onClick={() => handleSort('MATDATE')}>Погашение{sortArrow('MATDATE')}</th>
              <th>Тип</th>
              <th onClick={() => handleSort('LISTLEVEL')}>Листинг{sortArrow('LISTLEVEL')}</th>
              <th onClick={() => handleSort('PREVLEGALCLOSEPRICE')}>Закр.{sortArrow('PREVLEGALCLOSEPRICE')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 200).map(b => (
              <tr key={b.SECID}>
                <td style={{ maxWidth: 250, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  <div style={{ fontWeight: 500 }}>{b.SHORTNAME}</div>
                  <div className="mono text3">{b.ISIN}</div>
                </td>
                <td style={{ color: ytmColor(b.YIELDATPREVWAPRICE), fontWeight: 600 }}>
                  {b.YIELDATPREVWAPRICE != null ? parseFloat(b.YIELDATPREVWAPRICE).toFixed(2) + '%' : '—'}
                </td>
                <td>
                  {b.COUPONPERCENT != null ? parseFloat(b.COUPONPERCENT).toFixed(2) + '%' : '—'}
                </td>
                <td className="mono">
                  {b.PREVPRICE != null ? parseFloat(b.PREVPRICE).toFixed(2) : '—'}
                </td>
                <td className="mono text3">
                  {b.ACCRUEDINT != null ? parseFloat(b.ACCRUEDINT).toFixed(2) : '—'}
                </td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {b.MATDATE && b.MATDATE !== '0000-00-00' ? new Date(b.MATDATE).toLocaleDateString('ru', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}
                </td>
                <td>
                  <span className="badge badge-green">{couponType(b)}</span>
                </td>
                <td>
                  <span className={`badge ${listLevelClass(b.LISTLEVEL)}`}>{b.LISTLEVEL || '—'}</span>
                </td>
                <td className="mono">
                  {b.PREVLEGALCLOSEPRICE != null ? parseFloat(b.PREVLEGALCLOSEPRICE).toFixed(2) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length > 200 && (
          <div style={{ textAlign: 'center', padding: 16, color: 'var(--text3)' }}>
            Показаны первые 200 из {filtered.length}. Поиск сужает выборку.
          </div>
        )}
      </div>
    </div>
  );
}