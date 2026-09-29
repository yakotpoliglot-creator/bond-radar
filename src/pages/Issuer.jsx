import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchBonds, fetchIssuerInfo, fetchEmitter, bondsOfIssuer, COUPON_LABEL, moexReportsUrl } from '../api/moex';
import { BondTable, Panel, Kpi, Loading, ErrorBox } from '../components/ui';
import { nf, money, dateShort } from '../lib/format';

/* ═══════════════════════════════════════════════════════════════════
   Страница эмитента — /issuer/:key.
   :key — код эмитента вида 16493-A (результат issuerKey(REGNUMBER)).
   Данные целиком из уже загруженного списка fetchBonds().
   ═══════════════════════════════════════════════════════════════════ */

export default function Issuer() {
  const { key } = useParams();

  const [all, setAll] = useState([]);
  const [info, setInfo] = useState(null);
  const [emitter, setEmitter] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [kind, setKind] = useState('all'); // фильтр по типу купона

  /* ── загрузка списка бумаг ─────────────────────────────────────── */
  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null); setKind('all');
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

  /** Бумаги текущего эмитента. */
  const bonds = useMemo(() => bondsOfIssuer(all, key), [all, key]);

  const first = bonds[0] || null;

  /* ── формальное имя и ИНН эмитента (по ISIN первой бумаги) ─────── */
  useEffect(() => {
    let alive = true;
    setInfo(null);
    if (!first?.isin) return;
    fetchIssuerInfo(first.isin).then(r => { if (alive) setInfo(r); }).catch(() => {});
    return () => { alive = false; };
  }, [first?.isin]);

  /* ── официальный реестр MOEX: ОГРН, адреса, сайт, капитализация ── */
  useEffect(() => {
    let alive = true;
    setEmitter(null);
    if (info?.id == null) return;
    fetchEmitter(info.id).then(r => { if (alive) setEmitter(r); }).catch(() => {});
    return () => { alive = false; };
  }, [info?.id]);

  /* ── доступные типы купона для фильтра ─────────────────────────── */
  const kinds = useMemo(() => {
    const set = new Set(bonds.map(b => b.couponKind).filter(Boolean));
    return [...set].sort();
  }, [bonds]);

  const filtered = useMemo(
    () => (kind === 'all' ? bonds : bonds.filter(b => b.couponKind === kind)),
    [bonds, kind],
  );

  /* ── сводка по эмитенту ────────────────────────────────────────── */
  const summary = useMemo(() => {
    const total = bonds.reduce((s, b) => {
      const v = (b.issuesize || 0) * (b.faceValue || 0);
      return s + (Number.isFinite(v) ? v : 0);
    }, 0);

    const ytms = bonds.map(b => b.ytm).filter(v => v != null);
    const durs = bonds.map(b => b.durationDays).filter(v => v != null);
    const mats = bonds.map(b => b.matDate).filter(Boolean).sort();
    const currencies = [...new Set(bonds.map(b => b.currency).filter(Boolean))];

    return {
      count: bonds.length,
      total,
      avgYtm: ytms.length ? ytms.reduce((a, b) => a + b, 0) / ytms.length : null,
      avgDur: durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : null,
      matFrom: mats[0] || null,
      matTill: mats[mats.length - 1] || null,
      currencies,
    };
  }, [bonds]);

  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;

  /* ── по ключу ничего не нашлось ────────────────────────────────── */
  if (!bonds.length) {
    return (
      <Panel title="Эмитент не найден">
        <div className="empty">
          По коду <span className="mono">{key}</span> выпусков не найдено.
          <div style={{ marginTop: 12 }}>
            <Link className="btn" to="/issuers">← Все эмитенты</Link>
          </div>
        </div>
      </Panel>
    );
  }

  const title = info?.title || info?.name || first.name || first.shortname;
  const sub = info?.title ? (first.name || first.shortname) : null;

  return (
    <div>
      {/* ── Шапка эмитента ────────────────────────────────────────── */}
      <div className="page-h">
        <div className="page-t">{title}</div>
        <div className="page-s">
          {sub ? sub + ' · ' : ''}
          код эмитента <span className="mono">{key}</span>
          {info?.inn ? <> · ИНН <span className="mono">{info.inn}</span></> : null}
        </div>
        <div style={{ marginTop: 8 }}>
          <Link className="btn btn-sm" to="/issuers">← Все эмитенты</Link>
        </div>
      </div>

      {/* ── Сводка ────────────────────────────────────────────────── */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginBottom: 14 }}>
        <Kpi label="Выпусков" value={nf(summary.count, 0)} sub={`показано ${filtered.length}`} />
        <Kpi label="Объём в обращении" value={money(summary.total)} sub="сумма выпуск × номинал" />
        <Kpi label="Средняя доходность" value={summary.avgYtm == null ? '—' : nf(summary.avgYtm, 2) + '%'} sub={`по ${bonds.filter(b => b.ytm != null).length} вып.`} />
        <Kpi label="Средняя дюрация" value={summary.avgDur == null ? '—' : nf(summary.avgDur / 30.44, 1) + ' мес.'} sub={summary.avgDur == null ? '—' : nf(summary.avgDur, 0) + ' дней'} />
        <Kpi
          label="Погашение"
          value={summary.matFrom === summary.matTill ? dateShort(summary.matFrom) : `${dateShort(summary.matFrom)} —`}
          sub={summary.matFrom === summary.matTill ? 'единственная дата' : dateShort(summary.matTill)}
        />
        <Kpi label="Валюты" value={summary.currencies.join(', ') || '—'} sub="по номиналу выпусков" />
      </div>

      {/* ── Фильтр по типу купона ─────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
        <span className="c-3" style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px' }}>Тип купона</span>
        <span className={'chip' + (kind === 'all' ? ' on' : '')} onClick={() => setKind('all')}>Все · {bonds.length}</span>
        {kinds.map(k => (
          <span key={k} className={'chip' + (kind === k ? ' on' : '')} onClick={() => setKind(k)}>
            {COUPON_LABEL[k] || k} · {bonds.filter(b => b.couponKind === k).length}
          </span>
        ))}
      </div>

      {/* ── Все выпуски эмитента (сортировка по погашению) ────────── */}
      <Panel title="Выпуски эмитента" pad={false}
        right={<span className="c-3" style={{ fontSize: 11 }}>сортировка по умолчанию — погашение</span>}>
        <BondTable bonds={filtered} initialSort="mat" />
      </Panel>

      {/* ── Официальные данные эмитента (реестр MOEX) ─────────────── */}
      <Panel title="Данные об эмитенте" style={{ marginTop: 14 }}>
        <table className="tbl" style={{ width: '100%' }}>
          <tbody>
            <tr>
              <td className="c-3" style={{ width: 190 }}>Полное наименование</td>
              <td>{emitter?.title || info?.title || '—'}</td>
            </tr>
            <tr>
              <td className="c-3">ИНН</td>
              <td className="mono">{emitter?.inn || info?.inn || '—'}</td>
            </tr>
            <tr>
              <td className="c-3">ОГРН</td>
              <td className="mono">{emitter?.ogrn || '—'}</td>
            </tr>
            <tr>
              <td className="c-3">Юридический адрес</td>
              <td>{emitter?.legalAddress || '—'}</td>
            </tr>
            <tr>
              <td className="c-3">Почтовый адрес</td>
              <td>{emitter?.postalAddress || '—'}</td>
            </tr>
            <tr>
              <td className="c-3">Сайт</td>
              <td>
                {emitter?.website
                  ? <a href={emitter.website} target="_blank" rel="noopener noreferrer">{emitter.website}</a>
                  : '—'}
              </td>
            </tr>
            <tr>
              <td className="c-3">Капитализация эмитента</td>
              <td>
                {emitter?.emitterCapitalization != null ? money(emitter.emitterCapitalization) : '—'}
                {emitter?.capitalization != null && emitter.capitalization !== emitter.emitterCapitalization
                  ? <span className="c-3" style={{ marginLeft: 8, fontSize: 11 }}>группа компаний: {money(emitter.capitalization)}</span>
                  : null}
              </td>
            </tr>
          </tbody>
        </table>

        <div className="c-2" style={{ fontSize: 11.5, lineHeight: 1.7, marginTop: 12 }}>
          Источник — реестр эмитентов Московской биржи (<span className="mono">iss.moex.com/iss/emitters</span>).
          {' '}
          <b>Кредитного рейтинга и финансовой отчётности здесь нет</b> — MOEX их в открытом API не отдаёт:
          в реестре 14 полей, ни одного рейтингового. Отчётность можно посмотреть на сайте биржи по ссылке ниже.
          {emitter?.capitalizationUpdatedAt
            ? <span className="c-3"> Капитализация обновлена {String(emitter.capitalizationUpdatedAt).slice(0, 16)}.</span>
            : null}
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          {moexReportsUrl(info?.id)
            ? <a className="btn btn-sm" href={moexReportsUrl(info.id)} target="_blank" rel="noopener noreferrer">
                Отчётность эмитента на MOEX ↗
              </a>
            : null}
          <Link className="btn btn-sm" to={`/issuer/${key}`} onClick={() => window.scrollTo(0, 0)}>↑ Наверх</Link>
        </div>
      </Panel>
    </div>
  );
}