import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchPlacementNews } from '../api/moex';
import { Panel, Loading, ErrorBox, Kpi } from '../components/ui';

/* ═══════════════════════════════════════════════════════════════════
   Первичные размещения — /placements.

   ЧЕСТНО О ТОМ, ЧТО ЗДЕСЬ ЕСТЬ И ЧЕГО НЕТ:
   MOEX не публикует в открытом API ни книгу заявок, ни ориентир купона,
   ни дату размещения выпуска. Единственный машиночитаемый источник —
   новостная лента биржи, где появляются анонсы «О порядке сбора заявок
   и заключения сделок при размещении облигаций серии …».

   Поэтому это ЛЕНТА АНОНСОВ, а не база размещений. Купонов и объёмов
   здесь нет и выдумывать их мы не будем.
   ═══════════════════════════════════════════════════════════════════ */

/** «2026-09-29 18:45:00» → «29.09.2026, 18:45» */
function fmtDateTime(s) {
  if (!s) return '—';
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T]?(\d{2}:\d{2})?/);
  if (!m) return String(s);
  const [, y, mo, d, t] = m;
  return `${d}.${mo}.${y}${t ? ', ' + t : ''}`;
}

/** «Акционерное общество "Сбербанк…"» — укорачиваем до сути. */
function shortenIssuer(title) {
  return String(title)
    .replace(/Публичное акционерное общество\s*/gi, 'ПАО ')
    .replace(/Акционерное общество\s*/gi, 'АО ')
    .replace(/Общество с ограниченной ответственностью\s*/gi, 'ООО ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Серия выпуска из заголовка анонса, если её удаётся выделить. */
function seriesOf(title) {
  const m = String(title).match(/серии\s+([A-Za-zА-Яа-я0-9_\-]+)/);
  return m ? m[1] : null;
}

export default function Placements() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      setRows(await fetchPlacementNews());
      setLoading(false);
    } catch (e) {
      setError(e); setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <Loading text="Загрузка анонсов размещений с Московской биржи…" />;
  if (error) return <ErrorBox error={error} onRetry={load} />;

  const latest = rows[0]?.publishedAt || null;
  const oldest = rows[rows.length - 1]?.publishedAt || null;

  return (
    <div>
      <div className="page-h">
        <div className="page-t">◈ Первичные размещения</div>
        <div className="page-s">
          Анонсы сбора заявок с новостной ленты Московской биржи
        </div>
        <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={load}>↻ Обновить</button>
          <Link className="btn btn-sm" to="/screener">Скринер облигаций</Link>
        </div>
      </div>

      {/* ── Что здесь есть, а чего нет ────────────────────────────── */}
      <Panel style={{ marginBottom: 14 }}>
        <div className="c-2" style={{ fontSize: 11.5, lineHeight: 1.7 }}>
          Это <b>лента анонсов</b>, а не база первичных размещений. Московская биржа не отдаёт
          в открытом API ни <b>книгу заявок</b>, ни <b>ориентир купона</b>, ни <b>дату размещения</b> выпуска —
          единственное, что публикуется машиночитаемо, это новостные сообщения вида
          «О порядке сбора заявок и заключения сделок при размещении облигаций серии …».
          {' '}Мы показываем ровно их. Купонов, объёмов и цен здесь нет — они появятся
          в карточке выпуска после начала торгов.
        </div>
      </Panel>

      {/* ── Сводка ────────────────────────────────────────────────── */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', marginBottom: 14 }}>
        <Kpi label="Анонсов в ленте" value={rows.length} sub="все размещения, не только облигации" />
        <Kpi label="Свежий анонс" value={latest ? fmtDateTime(latest) : '—'} sub="последнее сообщение ленты" />
        <Kpi label="Лента с" value={oldest ? fmtDateTime(oldest) : '—'} sub="биржа хранит короткий период" />
      </div>

      {/* ── Список анонсов ────────────────────────────────────────── */}
      {rows.length === 0 ? (
        <Panel title="Анонсы размещений">
          <div className="empty">
            В текущей ленте новостей Московской биржи анонсов размещений нет.
            Лента короткая, поэтому в спокойные дни здесь может быть пусто — это не ошибка.
          </div>
        </Panel>
      ) : (
        <Panel title="Анонсы размещений" pad={false}
          right={<span className="c-3" style={{ fontSize: 11 }}>{rows.length} шт. · источник — новости MOEX</span>}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 140 }}>ДАТА</th>
                  <th style={{ width: 150 }}>СЕРИЯ</th>
                  <th>АНОНС</th>
                  <th style={{ width: 70 }}>ИСТОЧНИК</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(n => {
                  const series = seriesOf(n.title);
                  /* Текст анонса без служебной шапки и без серии —
                     серия уже вынесена в отдельную колонку. */
                  const body = shortenIssuer(
                    n.title
                      .replace(/^О порядке сбора заявок и заключения сделок при размещении облигаций\s*/i, '')
                      .replace(/серии\s+[A-Za-zА-Яа-я0-9_\-]+/i, '')
                      .replace(/\s+/g, ' ')
                      .trim(),
                  );
                  return (
                    <tr key={n.id}>
                      <td className="mono c-2" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(n.publishedAt)}</td>
                      <td className="mono">{series || '—'}</td>
                      <td>{body}</td>
                      <td>
                        {n.url
                          ? <a className="btn btn-sm" href={n.url} target="_blank" rel="noopener noreferrer" title="Открыть сообщение на сайте MOEX">MOEX ↗</a>
                          : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <div className="c-3" style={{ fontSize: 11, marginTop: 10, lineHeight: 1.6 }}>
        Данные предоставляются «как есть» и не являются индивидуальной инвестиционной рекомендацией.
        {' '}Параметры выпуска появляются в его карточке после начала торгов.
      </div>
    </div>
  );
}
