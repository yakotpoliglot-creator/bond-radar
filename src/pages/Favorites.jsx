/* ═══════════════════════════════════════════════════════════════════
   Избранное — список ISIN в localStorage (useFavorites).
   Показываем только те выпуски, которые реально есть в списке
   Мосбиржи: один запрос fetchBonds(), дальше фильтр в памяти.
   Таблица своя, в стиле .tbl — так в строку влезает кнопка ★.
   ═══════════════════════════════════════════════════════════════════ */
import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { fetchBonds, daysUntil } from '../api/moex';
import { Panel, Kpi, Loading, ErrorBox, CouponTag, LevelTag } from '../components/ui';
import { useFavorites } from '../lib/store';
import { nf, dateShort, duration, money, ytmClass } from '../lib/format';

export default function FavoritesPage() {
  const { list, toggle } = useFavorites();
  const [bonds, setBonds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true); setError(null);
    try { setBonds(await fetchBonds()); }
    catch (e) { setError(e); }
    finally { setLoading(false); }
  }

  /* Оставляем только бумаги, которые есть в списке биржи */
  const favs = useMemo(() => {
    const set = new Set(list);
    return bonds.filter(b => set.has(b.isin));
  }, [bonds, list]);

  /* Сводка: средняя доходность, средняя дюрация, ближайшее погашение */
  const withYtm = favs.filter(b => b.ytm != null);
  const avgYtm = withYtm.length ? withYtm.reduce((a, b) => a + b.ytm, 0) / withYtm.length : null;

  const withDur = favs.filter(b => b.durationDays != null);
  const avgDur = withDur.length ? withDur.reduce((a, b) => a + b.durationDays, 0) / withDur.length : null;

  const nearest = favs
    .filter(b => b.matDate && daysUntil(b.matDate) >= 0)
    .sort((a, b) => a.matDate.localeCompare(b.matDate))[0] || null;

  if (loading) return <Loading text="Загрузка избранных выпусков…" />;
  if (error) return <ErrorBox error={error} onRetry={load} />;

  /* Пусто: либо в избранном ничего нет, либо бумаги исчезли с биржи */
  if (!favs.length) {
    return (
      <div>
        <div className="page-h">
          <div className="page-t">★ Избранное</div>
          <div className="page-s">Выпуски, которые вы отметили звёздочкой</div>
        </div>
        <Panel>
          <div className="empty" style={{ padding: '42px 20px' }}>
            <div style={{ fontSize: 15, marginBottom: 8 }}>Пока ничего не отмечено</div>
            <div style={{ marginBottom: 14 }}>
              Откройте карточку выпуска и нажмите ★ — он появится здесь.
            </div>
            <Link className="btn" to="/screener">Перейти в скринер облигаций</Link>
            {list.length > 0 && (
              <div className="c-3" style={{ marginTop: 12, fontSize: 11.5 }}>
                В избранном {list.length} ISIN, но ни один не найден в текущем списке Мосбиржи.
              </div>
            )}
          </div>
        </Panel>
      </div>
    );
  }

  return (
    <div>
      <div className="page-h">
        <div className="page-t">★ Избранное</div>
        <div className="page-s">{nf(favs.length, 0)} выпусков · данные ISS MOEX</div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', marginBottom: 14 }}>
        <Kpi label="Выпусков" value={nf(favs.length, 0)} sub="в избранном" />
        <Kpi
          label="Средняя доходность"
          value={avgYtm == null ? '—' : nf(avgYtm, 2) + '%'}
          cls={avgYtm == null ? '' : ytmClass(avgYtm)}
          sub={withYtm.length ? `по ${withYtm.length} выпускам с YTM` : 'нет данных'}
        />
        <Kpi
          label="Средняя дюрация"
          value={duration(avgDur)}
          sub={withDur.length ? `по ${withDur.length} выпускам` : 'нет данных'}
        />
        <Kpi
          label="Ближайшее погашение"
          value={nearest ? dateShort(nearest.matDate) : '—'}
          sub={nearest ? nearest.shortname : 'нет будущих погашений'}
        />
      </div>

      <Panel title="Отмеченные выпуски" pad={false}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Выпуск</th>
                <th>YTM</th>
                <th>Купон</th>
                <th>Тип</th>
                <th>Цена</th>
                <th>НКД</th>
                <th>Дюрация</th>
                <th>Погашение</th>
                <th>Оферта</th>
                <th>Лист.</th>
                <th>Оборот</th>
                <th className="nosort">Избранное</th>
              </tr>
            </thead>
            <tbody>
              {favs.map(b => (
                <tr key={b.secid}>
                  <td>
                    <Link to={'/bond/' + b.isin} style={{ fontWeight: 600 }}>{b.shortname}</Link>
                    <div className="mono c-3" style={{ fontSize: 10 }}>{b.isin}</div>
                  </td>
                  <td>
                    {b.ytm == null
                      ? <span className="c-3">—</span>
                      : <span className={ytmClass(b.ytm)}>{nf(b.ytm, 2)}%</span>}
                  </td>
                  <td>{b.couponPercent == null ? <span className="c-3">—</span> : nf(b.couponPercent, 2) + '%'}</td>
                  <td><CouponTag kind={b.couponKind} /></td>
                  <td className="mono">{b.price == null ? '—' : nf(b.price, 2)}</td>
                  <td className="mono c-2">{b.nkd == null ? '—' : nf(b.nkd, 2)}</td>
                  <td className="c-2">{duration(b.durationDays)}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{dateShort(b.matDate)}</td>
                  <td className="mono" style={{ fontSize: 11 }}>
                    {b.offerDate ? dateShort(b.offerDate) : <span className="c-3">—</span>}
                  </td>
                  <td><LevelTag level={b.listLevel} /></td>
                  <td className="mono c-2" style={{ fontSize: 11 }}>
                    {b.turnover ? money(b.turnover) : '—'}
                  </td>
                  <td>
                    <button
                      className="btn btn-sm"
                      title="Убрать из избранного"
                      onClick={() => toggle(b.isin)}
                    >
                      ★ Убрать
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}