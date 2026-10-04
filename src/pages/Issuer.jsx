import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchBonds, fetchIssuerInfo, fetchEmitter, fetchGirboByInn, fetchGirboDate, bondsOfIssuer, fetchIssuerProfile, fetchFundamentals, findIssuerFundamentals, COUPON_LABEL } from '../api/moex';
import { BondTable, Panel, Kpi, Loading, ErrorBox } from '../components/ui';
import Fundamentals from '../components/Fundamentals';
import IssuerCard from '../components/IssuerCard';
import Modal from '../components/Modal';
import { ratioStats, latestPeriodLine } from '../lib/ratios';
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
  /* Дата сбора файла отчётности: видно, не устарел ли он — робот ходит в
     ФНС раз в неделю. */
  const [girboDate, setGirboDate] = useState(null);
  /* МСФО-отчётность компании со smart-lab: находится по названию
     эмитента среди собранных тикеров акций. Только точное совпадение. */
  const [fdata, setFdata] = useState(null);
  const [cardOpen, setCardOpen] = useState(false);   // карточка предприятия — окном

  /* Плитки для окна считает тот же модуль порогов (lib/ratios), что и
     панель коэффициентов ниже: цвет карточки и панели не разойдётся. */
  const popupStats = useMemo(() => ratioStats(fdata?.data?.fin), [fdata]);
  const popupPeriod = useMemo(() => latestPeriodLine(fdata?.data?.q), [fdata]);
  const [passport, setPassport] = useState(null);
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

  /* ── паспорта выпусков: имя эмитента и признак «для квалов» ───── *
   * В списочном блоке биржи этих полей нет вовсе — они лежат только
   * в описании конкретной бумаги, по одному запросу на выпуск.
   * Поэтому берём первые 12 бумаг эмитента, а не весь список: у Сбера
   * 359 выпусков, и 359 запросов ради одной колонки — это уже не
   * вежливость, а наглость. Если покрытие неполное, так и напишем. */
  useEffect(() => {
    let alive = true;
    setPassport(null);
    if (!bonds.length) return;
    fetchIssuerProfile(bonds, { limit: 12, concurrency: 4 })
      .then(r => { if (alive) setPassport(r); })
      .catch(() => {});
    return () => { alive = false; };
  }, [bonds]);

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

  useEffect(() => {
    let alive = true;
    fetchGirboDate().then(d => { if (alive) setGirboDate(d); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  /* ── МСФО компании со smart-lab (по названию эмитента) ─────────── *
   * У эмитента облигаций нет тикера акции, поэтому отчётность ищем по
   * названию компании. Сопоставление строгое — только точное совпадение
   * после нормализации. «Банк ДОМ.РФ» и «ДОМ.РФ» — разные организации,
   * и показать отчётность одной на странице другой значит выдать чужое
   * за своё. Лучше не показать ничего, чем показать не то.
   */
  useEffect(() => {
    let alive = true;
    setFdata(null);
    const names = [emitter?.title, info?.title, first?.name, first?.shortname];
    if (!names.some(Boolean)) return;
    fetchFundamentals()
      .then(f => { if (alive) setFdata(findIssuerFundamentals(f, names)); })
      .catch(() => {});
    return () => { alive = false; };
  }, [emitter?.title, info?.title, first?.name, first?.shortname]);

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

  /* Лучший рейтинг среди выпусков — как в каталоге эмитентов: у одного
     эмитента бумаги бывают с разными рейтингами (старые и новые серии),
     а карточка показывает и лучший, и распределение целиком. */
  const bestRating = useMemo(() => {
    let best = null;
    for (const b of bonds) {
      if (b.ratingCode == null) continue;
      if (!best || b.ratingCode > best.ratingCode) best = { ratingCode: b.ratingCode, rating: b.rating };
    }
    return best;
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

  const title = info?.title || passport?.issuerName || first?.name || first?.shortname || key;
  const sub = info?.title ? (first?.name || first?.shortname) : null;

  /* Признак «только для квалифицированных инвесторов» биржа публикует
     ПОШТУЧНО, в паспорте выпуска. Считаем по тем, что успели проверить. */
  const qualStat = (() => {
    if (!passport || !passport.covered) return null;
    const list = Object.values(passport.byIsin);
    return {
      checked: list.length,
      qualOnly: list.filter(p => p.issuersQualified).length,
      complete: !passport.partial,
    };
  })();

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
        <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link className="btn btn-sm" to="/issuers">← Все эмитенты</Link>
          {/* Карточка предприятия — окном, как в оригинале: раньше она
              стояла прямо на этой странице и дублировала карточку
              выпуска. */}
          <button
            className="btn btn-sm"
            onClick={() => setCardOpen(true)}
            title="Открыть карточку предприятия отдельным окном"
          >
            Карточка предприятия ⤢
          </button>
        </div>
      </div>

      {/* ── Вводный абзац ─────────────────────────────────────────────
          Всё в нём — арифметика по уже загруженному списку выпусков.
          Ни одного оценочного утверждения о надёжности эмитента здесь
          нет: для этого нужны кредитные рейтинги, а биржа их не отдаёт. */}
      <div className="lead">
        <b>{title}</b> — {summary.count}{' '}
        {summary.count === 1 ? 'выпуск' : summary.count < 5 ? 'выпуска' : 'выпусков'} в обращении
        {summary.yearFrom && summary.yearTill
          ? <> с погашением с <b>{summary.yearFrom}</b> по <b>{summary.yearTill}</b> год</>
          : null}
        {summary.fix > 0 || summary.float > 0 ? <>: {summary.fix > 0 ? <><b>{summary.fix}</b> с фиксированным купоном</> : null}
          {summary.fix > 0 && summary.float > 0 ? ', ' : ''}
          {summary.float > 0 ? <><b>{summary.float}</b> с плавающим</> : null}</> : null}
        {summary.amort > 0 ? <>, <b>{summary.amort}</b> с амортизацией номинала</> : null}
        {summary.offer > 0 ? <>, <b>{summary.offer}</b> с офертой</> : null}.
        {summary.avgYtm != null
          ? <> Средняя доходность к погашению по {summary.withYtm} выпускам, где биржа её отдаёт, — <b>{nf(summary.avgYtm, 2)}%</b>.</>
          : null}
        {summary.withYtm < summary.count
          ? <> По {summary.count - summary.withYtm} выпускам доходность не показана: биржа отдаёт недостоверное значение или сделок не было.</>
          : null}
        {qualStat
          ? <> Допуск считаем по паспортам выпусков: проверено <b>{qualStat.checked}</b>
            {qualStat.checked === 1 ? ' выпуск' : ' выпусков'}, из них только для квалифицированных
            инвесторов — <b>{qualStat.qualOnly}</b>
            {qualStat.complete ? '' : ' (у эмитента их больше, проверены не все)'}.</>
          : null}
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
      <Panel title="Выпуски в обращении" pad={false}
        right={<span className="c-3" style={{ fontSize: 11 }}>сортировка по умолчанию — погашение</span>}>
        <BondTable
          bonds={filtered}
          initialSort="mat"
          cols={['name', 'kind', 'ytm', 'coupon', 'price', 'currentYield', 'offer', 'mat', 'level', 'turnover']}
        />
      </Panel>


      {/* ── Карточка предприятия окном ──────────────────────────────
          Тот же компонент, что и на карточке выпуска: блок «О компании»
          плюс реквизиты, РСБУ и строка про поручителя. Раньше этот блок
          стоял прямо здесь и дублировался на карточке выпуска — теперь
          он один и открывается окном. */}
      <Modal
        open={cardOpen}
        onClose={() => setCardOpen(false)}
        title={emitter?.shortTitle || emitter?.title || info?.title || 'Карточка предприятия'}
        subtitle={'Карточка предприятия' + (info?.inn || emitter?.inn ? ` · ИНН ${info?.inn || emitter?.inn}` : '')}
      >
        <IssuerCard
          variant="detail"
          showBrief
          title={emitter?.title || info?.title}
          shortTitle={emitter?.shortTitle}
          inn={emitter?.inn || info?.inn}
          ogrn={emitter?.ogrn}
          okpo={emitter?.okpo}
          country={emitter?.country}
          legalAddress={emitter?.legalAddress}
          postalAddress={emitter?.postalAddress}
          website={emitter?.website}
          capitalization={emitter?.capitalization}
          emitterCapitalization={emitter?.emitterCapitalization}
          capitalUpdatedAt={emitter?.capitalizationUpdatedAt}
          rating={bestRating?.rating}
          ratingCode={bestRating?.ratingCode}
          bonds={bonds}
          girbo={girbo}
          girboDate={girboDate}
          emitterId={info?.id ?? emitter?.id}
          stats={popupStats}
          period={popupPeriod}
        />
      </Modal>

      {/* ── МСФО компании со smart-lab ────────────────────────────── *
       * Показываем перед бухгалтерской отчётностью: МСФО богаче —
       * там есть EBITDA и коэффициенты, которых в РСБУ не бывает. */}
      {fdata && (
        <div style={{ marginTop: 14 }}>
          <div className="c-3" style={{ fontSize: 11, marginBottom: 8, lineHeight: 1.65 }}>
            Отчётность найдена по названию эмитента — тикер <b>{fdata.ticker}</b>
            {fdata.data?.n ? ` (${fdata.data.n})` : ''}. Это данные <b>компании</b>, а облигации
            может выпускать другое юридическое лицо той же группы: финансы группы и финансы
            конкретного заёмщика — не одно и то же.
          </div>
          <Fundamentals
            data={fdata.data}
            right={<span className="c-3" style={{ fontSize: 10.5 }}>источник — smart-lab.ru</span>}
          />
        </div>
      )}

    </div>
  );
}