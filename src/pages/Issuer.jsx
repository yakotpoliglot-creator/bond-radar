import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchBonds, fetchIssuerInfo, fetchEmitter, fetchGirboByInn, girboUrl, bondsOfIssuer, COUPON_LABEL, moexReportsUrl } from '../api/moex';
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
  const [girbo, setGirbo] = useState(null);
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

  /* ── бухгалтерская отчётность из ГИР БО ФНС (по ИНН эмитента) ──── *
   * Файл girbo.json собирает робот раз в неделю: ФНС не отдаёт CORS,
   * поэтому браузер не может обратиться к bo.nalog.gov.ru напрямую.
   */
  useEffect(() => {
    let alive = true;
    setGirbo(null);
    const inn = emitter?.inn || info?.inn;
    if (!inn) return;
    fetchGirboByInn(inn).then(r => { if (alive) setGirbo(r); }).catch(() => {});
    return () => { alive = false; };
  }, [emitter?.inn, info?.inn]);

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

    /* Состав портфеля выпусков — как блок «На что смотреть» на
       bondradar.pro. Всё считается из того же списка, без новых запросов.
       Число выпусков «только для квалов» показать не можем: биржа
       отдаёт признак ISQUALIFIEDINVESTORS лишь в подробной карточке
       выпуска, а не в общем списке, и тянуть 50+ карточек ради одной
       цифры не станем. */
    const byKind = k => bonds.filter(b => b.couponKind === k).length;

    return {
      count: bonds.length,
      total,
      avgYtm: ytms.length ? ytms.reduce((a, b) => a + b, 0) / ytms.length : null,
      avgDur: durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : null,
      matFrom: mats[0] || null,
      matTill: mats[mats.length - 1] || null,
      currencies,
      fix: byKind('fix'),
      float: byKind('float'),
      amort: bonds.filter(b => b.isAmort).length,
      offer: bonds.filter(b => b.offerDate).length,
      currencyBonds: bonds.filter(b => b.isCurrency).length,
      subfederal: bonds.filter(b => b.isSubfederal).length,
      withYtm: ytms.length,
      yearFrom: mats[0] ? mats[0].slice(0, 4) : null,
      yearTill: mats.length ? mats[mats.length - 1].slice(0, 4) : null,
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

      {/* ── Состав выпусков: «на что смотреть» ────────────────────────
          Считается целиком из того же списка бумаг, что уже загружен,
          поэтому не требует ни одного лишнего запроса к бирже. */}
      <Panel title="На что смотреть в выпусках" style={{ marginBottom: 14 }}>
        <ul className="facts">
          <li>
            <b>{nf(summary.count, 0)}</b>{' '}
            {summary.count === 1 ? 'выпуск' : summary.count < 5 ? 'выпуска' : 'выпусков'} в обращении
            {summary.yearFrom && summary.yearTill
              ? <> с погашением с <b>{summary.yearFrom}</b> по <b>{summary.yearTill}</b> год</>
              : null}.
          </li>
          {summary.fix > 0 && (
            <li>
              С фиксированным купоном — <b>{summary.fix}</b>
              {summary.float > 0 ? <>, флоатеров — <b>{summary.float}</b></> : null}.
              {' '}У флоатера купон привязан к ставке, поэтому его доходность заранее неизвестна.
            </li>
          )}
          {summary.amort > 0 && (
            <li>
              С амортизацией номинала — <b>{summary.amort}</b>: номинал возвращают частями,
              поэтому цена и доходность считаются сложнее, чем у обычной бумаги.
            </li>
          )}
          {summary.offer > 0 && (
            <li>
              С офертой — <b>{summary.offer}</b>: эмитент может выкупить бумагу раньше срока
              погашения, и тогда доходность считается к оферте, а не к погашению.
            </li>
          )}
          {summary.currencyBonds > 0 && (
            <li>
              Валютных — <b>{summary.currencyBonds}</b>: доходность зависит ещё и от курса,
              а не только от купона.
            </li>
          )}
          {summary.subfederal > 0 && (
            <li>
              Субфедеральных — <b>{summary.subfederal}</b>: это региональные займы,
              их надёжность опирается на бюджет региона, а не на выручку компании.
            </li>
          )}
          {summary.withYtm < summary.count && (
            <li className="c-3">
              По <b>{summary.count - summary.withYtm}</b> выпускам доходность не показана:
              биржа отдаёт недостоверное значение или по бумаге не было сделок.
            </li>
          )}
        </ul>
      </Panel>

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
          <b>Кредитного рейтинга здесь нет</b> — MOEX его в открытом API не отдаёт:
          в реестре 14 полей, ни одного рейтингового. А вот бухгалтерская отчётность
          есть — она берётся из ГИР БО ФНС, блоком ниже.
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

      {/* ── Бухгалтерская отчётность из ГИР БО ФНС ────────────────── */}
      {girbo && !girbo.closed && girbo.years?.length ? (
        <Panel
          title="Бухгалтерская отчётность"
          style={{ marginTop: 14 }}
          right={<span className="c-3" style={{ fontSize: 11 }}>ГИР БО ФНС · тыс. → ₽</span>}
        >
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="nosort">ГОД</th>
                  <th className="nosort">ВЫРУЧКА</th>
                  <th className="nosort">АКТИВЫ</th>
                  <th className="nosort">ОПУБЛИКОВАНО</th>
                </tr>
              </thead>
              <tbody>
                {girbo.years.map(y => (
                  <tr key={y.year} style={{ cursor: 'default' }}>
                    <td className="mono" style={{ fontWeight: 600 }}>{y.year}</td>
                    <td className="mono">{money(y.revenue)}</td>
                    <td className="mono">{money(y.assets)}</td>
                    <td className="c-3" style={{ fontSize: 11 }}>{y.publishedAt ? dateShort(y.publishedAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="c-2" style={{ fontSize: 11.5, lineHeight: 1.7, marginTop: 12 }}>
            Источник — <b>Государственный информационный ресурс бухгалтерской отчётности</b> ФНС России
            {' '}(<span className="mono">bo.nalog.gov.ru</span>), который ведётся по Федеральному закону
            № 402-ФЗ «О бухгалтерском учёте», ст. 18. Данные публичные, регистрация не нужна.
            <br />
            <b>Важно понимать:</b> это отчётность <b>по РСБУ</b> — то есть самого юридического лица,
            которое выпустило облигации. Она может заметно отличаться от консолидированной
            отчётности группы по МСФО, которую публикуют для инвесторов: у материнской компании
            выручка бывает в разы меньше, чем у всей группы.
            <br />
            Показаны только <b>выручка и валюта баланса</b> — то, что ФНС отдаёт открыто.
            EBITDA, чистый долг и ICR требуют полной формы отчётности, а её часть организаций
            закрывает от публичного доступа: ФНС отвечает «Organization closed for public use»,
            и мы это ограничение уважаем, а не обходим.
            {girbo.name ? <span className="c-3"> Организация в реестре: {girbo.name}.</span> : null}
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            <a className="btn btn-sm" href={girboUrl(girbo.girboId)} target="_blank" rel="noopener noreferrer">
              Открыть в ГИР БО ↗
            </a>
          </div>
        </Panel>
      ) : girbo?.closed ? (
        <Panel title="Бухгалтерская отчётность" style={{ marginTop: 14 }}>
          <div className="c-2" style={{ fontSize: 11.5, lineHeight: 1.7 }}>
            Организация <b>закрыла свою отчётность</b> от публичного доступа в ГИР БО ФНС.
            Это её право, и мы его уважаем — обходить ограничение не будем.
          </div>
        </Panel>
      ) : null}
    </div>
  );
}