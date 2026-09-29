import { useState, useEffect, useMemo, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchBonds, COLLECTIONS } from '../api/moex';
import { BondTable, DEFAULT_COLS, Pager, Loading, ErrorBox, Panel, Kpi } from '../components/ui';
import { nf, duration } from '../lib/format';

/* ═══════════════════════════════════════════════════════════════════
   Подборки облигаций — один компонент на два маршрута:
     /collections        → сетка карточек всех подборок
     /collections/:slug  → конкретная подборка (сводка + таблица)
   Фильтрация — через COLLECTIONS[].test(bond) на реальных данных MOEX.
   ═══════════════════════════════════════════════════════════════════ */

const PER_PAGE = 50;

/* ── Сводные метрики по набору бумаг ── */
function summarize(list) {
  const ytms = list.map(b => b.ytm).filter(v => v != null);
  const durs = list.map(b => b.durationDays).filter(v => v != null);
  return {
    count: list.length,
    avgYtm: ytms.length ? ytms.reduce((s, v) => s + v, 0) / ytms.length : null,
    avgDur: durs.length ? durs.reduce((s, v) => s + v, 0) / durs.length : null,
  };
}

export default function Collections() {
  const { slug } = useParams();

  const [bonds, setBonds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);

  /* ── загрузка всех выпусков MOEX (нужна в обоих режимах) ── */
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setBonds(await fetchBonds());
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // при переходе между подборками — с первой страницы
  useEffect(() => { setPage(1); }, [slug]);

  /* ── Режим списка: считаем попадания по каждой подборке ── */
  const cards = useMemo(
    () => COLLECTIONS.map(c => {
      const hit = bonds.filter(c.test);
      return { ...c, ...summarize(hit) };
    }),
    [bonds],
  );

  /* ── Режим подборки ── */
  const collection = useMemo(
    () => COLLECTIONS.find(c => c.slug === slug) || null,
    [slug],
  );

  // Бумаги подборки; отдельно считаем скрытые из-за ytm == null
  const { rows, hiddenNull } = useMemo(() => {
    if (!collection) return { rows: [], hiddenNull: 0 };
    const matched = bonds.filter(collection.test);
    const rows = matched.filter(b => b.ytm != null);
    return { rows, hiddenNull: matched.length - rows.length };
  }, [bonds, collection]);

  const stat = useMemo(() => summarize(rows), [rows]);

  const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  const cur = Math.min(page, pages);
  const slice = useMemo(
    () => rows.slice((cur - 1) * PER_PAGE, cur * PER_PAGE),
    [rows, cur],
  );

  if (loading && !bonds.length) return <Loading />;
  if (error && !bonds.length) return <ErrorBox error={error} onRetry={load} />;

  /* ═══════════════ Режим списка подборок ═══════════════ */
  if (!slug) {
    return (
      <div>
        <div className="page-h">
          <div className="page-t">◆ Подборки облигаций</div>
          <div className="page-s">
            Готовые фильтры по {bonds.length} выпускам Московской биржи
          </div>
        </div>

        {error && (
          <div className="err" style={{ textAlign: 'left', paddingBottom: 10 }}>
            Не удалось обновить данные: {String(error)}
            <button className="btn btn-sm" style={{ marginLeft: 10 }} onClick={load}>Повторить</button>
          </div>
        )}

        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))' }}>
          {cards.map(c => (
            <Link key={c.slug} to={'/collections/' + c.slug} style={{ color: 'inherit', textDecoration: 'none' }}>
              <div className="bcard">
                <div style={{ fontWeight: 700, fontSize: 14 }}>{c.title}</div>
                <div className="c-2" style={{ fontSize: 11.5, marginTop: 4, lineHeight: 1.45 }}>{c.desc}</div>
                <div style={{ marginTop: 11, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <span className="tag b">{c.count} бумаг</span>
                  {c.avgYtm != null && <span className="tag g">средняя {nf(c.avgYtm, 2)}%</span>}
                  {c.avgDur != null && <span className="tag">{duration(c.avgDur)}</span>}
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    );
  }

  /* ═══════════════ Слаг не найден ═══════════════ */
  if (!collection) {
    return (
      <div>
        <div className="page-h">
          <div className="page-s">
            <Link to="/collections">Все подборки</Link> / <span className="c-3">{slug}</span>
          </div>
          <div className="page-t">Подборка не найдена</div>
        </div>
        <Panel>
          <div className="empty">
            Подборки «{slug}» нет в списке.
            <div style={{ marginTop: 10 }}>
              <Link className="btn" to="/collections">← Все подборки</Link>
            </div>
          </div>
        </Panel>
      </div>
    );
  }

  /* ═══════════════ Режим конкретной подборки ═══════════════ */
  return (
    <div>
      {/* Хлебные крошки */}
      <div className="page-s" style={{ marginBottom: 6 }}>
        <Link to="/collections">Все подборки</Link> / <span className="c-2">{collection.title}</span>
      </div>

      <div className="page-h">
        <div className="page-t">◆ {collection.title}</div>
        <div className="page-s">
          {collection.desc} · показано {rows.length} из {bonds.length} выпусков
          <Link className="btn btn-sm" style={{ marginLeft: 10 }} to={'/screener?cat=' + collection.slug}>
            Открыть в скринере
          </Link>
          <button className="btn btn-sm" style={{ marginLeft: 6 }} onClick={load} disabled={loading}>
            {loading ? 'Обновление…' : '↻ Обновить'}
          </button>
        </div>
      </div>

      {/* Сводка */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginBottom: 12 }}>
        <Kpi label="Бумаг в подборке" value={stat.count} sub={`из ${bonds.length} выпусков`} />
        <Kpi label="Средняя доходность" value={stat.avgYtm == null ? '—' : nf(stat.avgYtm, 2) + '%'} sub="YTM, среднее по выборке" />
        <Kpi label="Средняя дюрация" value={duration(stat.avgDur)} sub="взвешено по выпускам" />
      </div>

      {error && (
        <div className="err" style={{ textAlign: 'left', paddingBottom: 10 }}>
          Не удалось обновить данные: {String(error)}
          <button className="btn btn-sm" style={{ marginLeft: 10 }} onClick={load}>Повторить</button>
        </div>
      )}

      <Panel
        pad={false}
        title={`Выпуски подборки · стр. ${cur} из ${pages}`}
        right={<span className="kpi-s">{rows.length} шт. · по {PER_PAGE} на страницу</span>}
      >
        {!rows.length ? (
          <div className="empty">
            В подборке «{collection.title}» сейчас нет бумаг с достоверной доходностью.
            <div style={{ marginTop: 10 }}>
              <Link className="btn" to="/collections">← Все подборки</Link>
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

        {/* Сноска о скрытых бумагах с недостоверной доходностью */}
        {hiddenNull > 0 && (
          <div className="kpi-s" style={{ padding: '10px 16px', borderTop: '1px solid var(--border)' }}>
            Скрыто {hiddenNull} вып. с недостоверной доходностью: MOEX отдаёт для них значение вне
            допустимого диапазона (−50…300 %), поэтому такие бумаги не участвуют в сводке и таблице.
          </div>
        )}
      </Panel>
    </div>
  );
}