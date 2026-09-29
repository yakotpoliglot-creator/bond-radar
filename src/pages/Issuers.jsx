import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchBonds } from '../api/moex';
import { Panel, Loading, ErrorBox, Pager } from '../components/ui';
import { nf, money } from '../lib/format';

/* ═══════════════════════════════════════════════════════════════════
   Каталог эмитентов — /issuers.
   Группируем загруженный список облигаций по issuerKey(REGNUMBER).
   ═══════════════════════════════════════════════════════════════════ */

const PER_PAGE = 50;

const SORTS = [
  { key: 'count', label: 'По числу выпусков' },
  { key: 'alpha', label: 'По алфавиту' },
  { key: 'volume', label: 'По объёму' },
];

export default function Issuers() {
  const [all, setAll] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('count');
  const [page, setPage] = useState(1);

  /* ── загрузка ──────────────────────────────────────────────────── */
  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null);
    (async () => {
      try {
        const data = await fetchBonds();
        if (alive) { setAll(data); setLoading(false); }
      } catch (e) {
        if (alive) { setError(e); setLoading(false); }
      }
    })();
    return () => { alive = false; };
  }, []);

  /* ── группировка по коду эмитента ──────────────────────────────── */
  const issuers = useMemo(() => {
    const map = new Map();
    for (const b of all) {
      if (!b.issuerKey) continue;              // без кода эмитента группировать нечего
      let g = map.get(b.issuerKey);
      if (!g) {
        g = { key: b.issuerKey, bonds: [], name: b.shortname || b.name, volume: 0, ytms: [] };
        map.set(b.issuerKey, g);
      }
      g.bonds.push(b);
      const v = (b.issuesize || 0) * (b.faceValue || 0);
      if (Number.isFinite(v)) g.volume += v;
      if (b.ytm != null) g.ytms.push(b.ytm);
    }
    return [...map.values()]
      .filter(g => g.bonds.length)               // пустые группы отбрасываем
      .map(g => ({
        ...g,
        count: g.bonds.length,
        avgYtm: g.ytms.length ? g.ytms.reduce((a, b) => a + b, 0) / g.ytms.length : null,
        // название берём по первой бумаге эмитента
        name: g.bonds[0].shortname || g.bonds[0].name || g.key,
        search: (g.bonds[0].shortname + ' ' + (g.bonds[0].name || '')).toLowerCase(),
      }));
  }, [all]);

  /* ── поиск и сортировка ────────────────────────────────────────── */
  const list = useMemo(() => {
    const query = q.trim().toLowerCase();
    let out = issuers;
    if (query) {
      out = out.filter(g =>
        g.search.includes(query) ||
        g.key.toLowerCase().includes(query) ||
        g.bonds.some(b => (b.isin || '').toLowerCase().includes(query)));
    }
    const arr = [...out];
    if (sort === 'alpha') arr.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    else if (sort === 'volume') arr.sort((a, b) => b.volume - a.volume);
    else arr.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru'));
    return arr;
  }, [issuers, q, sort]);

  /* Смена поиска/сортировки — всегда возвращаемся на первую страницу. */
  useEffect(() => { setPage(1); }, [q, sort]);

  const pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
  const current = Math.min(page, pages);
  const slice = list.slice((current - 1) * PER_PAGE, current * PER_PAGE);

  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;

  return (
    <div>
      {/* ── Заголовок ─────────────────────────────────────────────── */}
      <div className="page-h">
        <div className="page-t">Эмитенты</div>
        <div className="page-s">
          Всего в каталоге {nf(issuers.length, 0)} эмитентов · {nf(all.length, 0)} выпусков
          {q.trim() ? <> · найдено {nf(list.length, 0)}</> : null}
        </div>
      </div>

      {/* ── Поиск и сортировка ────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <input
          className="inp"
          style={{ minWidth: 280 }}
          placeholder="Поиск по названию или коду эмитента, ISIN…"
          value={q}
          onChange={e => setQ(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {SORTS.map(s => (
            <span key={s.key} className={'chip' + (sort === s.key ? ' on' : '')} onClick={() => setSort(s.key)}>
              {s.label}
            </span>
          ))}
        </div>
      </div>

      {/* ── Таблица эмитентов ─────────────────────────────────────── */}
      <Panel pad={false}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th className="nosort">Эмитент</th>
                <th className="nosort">Код</th>
                <th className="nosort">Выпусков</th>
                <th className="nosort">Объём</th>
                <th className="nosort">Средняя YTM</th>
                <th className="nosort">Ссылка</th>
              </tr>
            </thead>
            <tbody>
              {slice.map(g => (
                <tr key={g.key} onClick={() => { location.hash = '#/issuer/' + g.key; }}>
                  <td style={{ fontWeight: 600 }}>{g.name}</td>
                  <td className="mono c-2">{g.key}</td>
                  <td className="mono">{nf(g.count, 0)}</td>
                  <td className="mono c-2">{money(g.volume)}</td>
                  <td className="mono">{g.avgYtm == null ? <span className="c-3">—</span> : nf(g.avgYtm, 2) + '%'}</td>
                  <td>
                    <Link to={'/issuer/' + g.key} onClick={e => e.stopPropagation()}>все выпуски →</Link>
                  </td>
                </tr>
              ))}
              {!slice.length && (
                <tr><td colSpan={6} className="empty">Ничего не найдено</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <Pager page={current} pages={pages} onChange={setPage} total={list.length} perPage={PER_PAGE} />
      </Panel>
    </div>
  );
}