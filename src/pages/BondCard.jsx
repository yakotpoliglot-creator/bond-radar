import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import Chart from 'chart.js/auto';
import { fetchBonds, fetchBondCard, fetchIssuerInfo, fetchEmitter, fetchGirboByInn, fetchGirboDate, fetchFundamentals, findIssuerFundamentals, moexReportsUrl, moexIssueUrl } from '../api/moex';
import { BondTable, Panel, Kpi, Loading, ErrorBox, CouponTag, LevelTag, RatingTag, timesWord } from '../components/ui';
import YieldCalculator from '../components/YieldCalculator';
import IssuerCard from '../components/IssuerCard';
import Modal from '../components/Modal';
import { ratioStats, latestPeriodLine } from '../lib/ratios';
import { nf, money, date, dateShort, dateTime, duration, timeLeft, chgStrA } from '../lib/format';
import { KPI_COLOR, couponColor, priceColor, ytmColor } from '../lib/kpiColors';
import { useFavorites } from '../lib/store';

/* ═══════════════════════════════════════════════════════════════════
   Карточка выпуска — главная страница проекта.
   Маршрут: /bond/:id, где :id — ISIN или SECID.
   Данные: fetchBonds() (список + похожие), fetchBondCard() (детали),
   fetchIssuerInfo() (формальное имя эмитента и ИНН).
   ═══════════════════════════════════════════════════════════════════ */

/** Сегодняшняя дата в виде YYYY-MM-DD — для отделения прошедших купонов. */
function todayStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Цвет из CSS-переменных темы (для Chart.js нужен конкретный цвет). */
function cssVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch { return fallback; }
}

/** Согласование числительного с существительным: «41 выплата», «5 выплат».
    Нужно для подписи графика купонов — «41 купонов» читать нельзя. */
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** Колонки мини-таблиц похожих выпусков. */
const SIMILAR_COLS = ['name', 'ytm', 'coupon', 'price', 'duration', 'mat', 'offer', 'level'];

export default function BondCard() {
  const { id } = useParams();
  const { has, toggle } = useFavorites();

  const [bonds, setBonds] = useState([]);
  const [card, setCard] = useState(null);
  const [issuer, setIssuer] = useState(null);
  const [girbo, setGirbo] = useState(null);        // отчётность эмитента, ГИР БО ФНС
  const [girboDate, setGirboDate] = useState(null); // когда робот собрал girbo.json
  const [emitter, setEmitter] = useState(null);     // реестр MOEX: ОГРН, адрес, сайт, капитализация
  const [fdata, setFdata] = useState(null);         // МСФО smart-lab — грузится фоном, для плиток метрик
  const [cardOpen, setCardOpen] = useState(false);  // карточка предприятия — окном, как в оригинале
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const canvasRef = useRef(null);   // <canvas> графика купонов
  const chartRef = useRef(null);    // экземпляр Chart.js (уничтожаем в cleanup)

  /* ── загрузка данных ───────────────────────────────────────────── */
  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null); setCard(null); setIssuer(null); setGirbo(null);

    (async () => {
      try {
        // Список и карточка — параллельно; карточка не должна ронять страницу.
        const [all, c] = await Promise.all([
          fetchBonds(),
          fetchBondCard(id).catch(() => null),
        ]);
        if (!alive) return;
        setBonds(all);
        setCard(c);
        setLoading(false);

        // Формальное имя эмитента — отдельным запросом, не блокирует рендер.
        const info = await fetchIssuerInfo(id).catch(() => null);
        if (alive) setIssuer(info);
      } catch (e) {
        if (alive) { setError(e); setLoading(false); }
      }
    })();

    return () => { alive = false; };
  }, [id]);

  /* ── отчётность эмитента: ГИР БО ФНС по ИНН ──────────────────────
     Ждём именно ИНН из fetchIssuerInfo: по названию организация в
     реестре не ищется, и ошибка здесь означала бы чужие цифры в
     карточке выпуска. Пока ИНН нет — просто ничего не показываем. */
  useEffect(() => {
    if (!issuer?.inn) return;
    let alive = true;
    fetchGirboByInn(issuer.inn).then(r => { if (alive) setGirbo(r); }).catch(() => {});
    fetchGirboDate().then(d => { if (alive) setGirboDate(d); }).catch(() => {});
    return () => { alive = false; };
  }, [issuer?.inn]);

  /* ── реестр эмитента: ОГРН, адрес, сайт, капитализация ──────────
     Один запрос к реестру MOEX и только когда id эмитента уже известен:
     без него карточка предприятия показала бы одно название. */
  useEffect(() => {
    if (issuer?.id == null) return;
    let alive = true;
    fetchEmitter(issuer.id).then(r => { if (alive) setEmitter(r); }).catch(() => {});
    return () => { alive = false; };
  }, [issuer?.id]);

  /** Бумага в общем списке (TQCB + TQOB) по ISIN или SECID. */
  const bond = useMemo(() => {
    const key = (id || '').toUpperCase();
    return bonds.find(b => b.isin === key || b.secid === key) || null;
  }, [bonds, id]);

  /* ── МСФО компании: метрики для карточки предприятия ──────────────
     Файл со всей отчётностью весит 2,5 МБ, поэтому грузим его фоном и
     не ждём: карточка сначала показывает реквизиты и РСБУ из ГИР БО, а
     плитки метрик появляются, когда файл доехал. Браузер кэширует его —
     тот же файл читает страница эмитента, так что платим один раз на
     весь сайт. Матчим по названию: у эмитента облигаций тикера нет. */
  useEffect(() => {
    let alive = true;
    fetchFundamentals()
      .then(f => {
        if (!alive) return;
        setFdata(findIssuerFundamentals(f, [
          emitter?.title, emitter?.shortTitle, issuer?.title, issuer?.name, bond?.name,
        ]));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [emitter?.title, emitter?.shortTitle, issuer?.title, issuer?.name, bond?.name]);

  /* Тот же светофор и те же пороги, что в панели коэффициентов
     страницы эмитента: считает Fundamentals, карточка только показывает. */
  const stats = useMemo(() => ratioStats(fdata?.data?.fin), [fdata]);
  const period = useMemo(() => latestPeriodLine(fdata?.data?.q), [fdata]);

  const isFav = bond ? has(bond.isin) : false;

  /* ── график купонных выплат ────────────────────────────────────── */
  const couponsSorted = useMemo(
    () => [...(card?.coupons || [])].filter(c => c.date && c.value != null)
      .sort((a, b) => a.date.localeCompare(b.date)),
    [card],
  );

  useEffect(() => {
    if (!canvasRef.current || !couponsSorted.length) return;

    const today = todayStr();
    const past = cssVar('--text3', '#999999');       // прошедшие купоны — приглушённые
    const future = cssVar('--accent', '#15803d');    // будущие — акцентный цвет
    const text3 = cssVar('--text3', '#999999');
    const border = cssVar('--border', '#e8e6e1');

    const chart = new Chart(canvasRef.current, {
      type: 'bar',
      data: {
        labels: couponsSorted.map(c => dateShort(c.date)),
        datasets: [{
          label: 'Купон, ₽',
          data: couponsSorted.map(c => c.value),
          backgroundColor: couponsSorted.map(c => (c.date < today ? past : future)),
          borderRadius: 3,
          maxBarThickness: 38,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: items => {
                const c = couponsSorted[items[0].dataIndex];
                return (c.date < today ? 'Выплачен · ' : 'Предстоит · ') + date(c.date);
              },
              label: c => {
                const row = couponsSorted[c.dataIndex];
                const prc = row.valuePrc != null ? ` (${nf(row.valuePrc, 2)}% от номинала)` : '';
                return `Купон: ${nf(row.value, 2)} ₽${prc}`;
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: text3, font: { size: 9 }, maxRotation: 60, autoSkip: true, maxTicksLimit: 24 },
          },
          y: {
            grid: { color: border },
            ticks: { color: text3, font: { size: 10 }, callback: v => nf(v, 0) },
          },
        },
      },
    });

    chartRef.current = chart;
    // Уничтожаем график при размонтировании/смене бумаги
    return () => { chart.destroy(); chartRef.current = null; };
  }, [couponsSorted]);

  /* ── производные показатели ────────────────────────────────────── */
  const paymentsPerYear = useMemo(() => {
    if (bond?.couponPeriod) return 365 / bond.couponPeriod;
    if (card?.couponFrequency) return +card.couponFrequency;
    return null;
  }, [bond, card]);

  // Купонная доходность к цене = купон % / цена * 100
  const couponToPrice = bond?.couponPercent != null && bond?.price
    ? (bond.couponPercent / bond.price) * 100
    : null;

  /* Флоатер: ставка купонов вперёд неизвестна, поэтому и купон, и доходность
     у него в палитре оригинала янтарные — зелёный обещал бы больше, чем есть. */
  const isFloater = bond?.couponKind === 'float';

  /* ── похожие выпуски: 4 группы как на bondradar ────────────────── */
  const similar = useMemo(() => {
    if (!bond) return [];
    const others = bonds.filter(b => b.isin !== bond.isin);
    const groups = [];

    if (bond.issuerKey) {
      const g = others.filter(b => b.issuerKey === bond.issuerKey);
      if (g.length) groups.push({ title: 'Тот же эмитент', desc: bond.issuerKey, list: g });
    }

    if (bond.listLevel != null && bond.ytm != null) {
      const g = others.filter(b =>
        b.listLevel === bond.listLevel &&
        b.ytm != null &&
        Math.abs(b.ytm - bond.ytm) <= 3);
      if (g.length) {
        groups.push({
          title: 'Тот же уровень листинга и близкая доходность',
          desc: `листинг ${bond.listLevel} · YTM ${nf(bond.ytm, 2)}% ± 3 п.п.`,
          list: g,
        });
      }
    }

    if (bond.durationDays != null) {
      /* ±25% от дюрации — но у коротких бумаг это окно вырождается
         в доли дня, и в «соседи» попадала случайная выборка. Поэтому
         снизу окно не меньше 30 дней. */
      const pad = Math.max(bond.durationDays * 0.25, 30);
      const lo = bond.durationDays - pad, hi = bond.durationDays + pad;
      const g = others.filter(b => b.durationDays != null && b.durationDays >= lo && b.durationDays <= hi);
      if (g.length) {
        groups.push({
          title: 'Близкая дюрация',
          desc: `${duration(bond.durationDays)} ± ${Math.round(pad)} дн.`,
          list: g,
        });
      }
    }

    if (bond.matDate) {
      const year = bond.matDate.slice(0, 4);
      const g = others.filter(b => b.matDate && b.matDate.slice(0, 4) === year);
      if (g.length) groups.push({ title: `Погашение в ${year} году`, desc: `год погашения ${year}`, list: g });
    }

    return groups;
  }, [bonds, bond]);

  /* ── состояния загрузки / ошибки / отсутствия бумаги ───────────── */
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;

  const known = bond || (card && Object.keys(card.description || {}).length);
  if (!known) {
    return (
      <Panel title="Выпуск не найден">
        <div className="empty">
          По идентификатору <span className="mono">{id}</span> ничего не найдено на Московской бирже.
          <div style={{ marginTop: 12 }}>
            <Link className="btn" to="/screener">Открыть скринер облигаций →</Link>
          </div>
        </div>
      </Panel>
    );
  }

  // Поля бумаги могут отсутствовать (нет в общем списке) — берём из карточки MOEX.
  const shortname = bond?.shortname || card?.shortname || id;
  const fullname = bond?.name || card?.issueName || card?.description?.NAME || shortname;
  const isin = bond?.isin || card?.description?.ISIN || id;
  const secid = bond?.secid || card?.secid || id;
  const typeName = card?.typename || bond?.bondType || bond?.bondSubtype || null;
  const matDate = bond?.matDate || (card?.description?.MATDATE !== '0000-00-00' ? card?.description?.MATDATE : null);
  const offerDate = bond?.offerDate || (card?.description?.OFFERDATE !== '0000-00-00' ? card?.description?.OFFERDATE : null);
  const qualOnly = card?.isQualified || bond?.isQualified;

  const today = todayStr();

  /* Ближайшая будущая выплата — отмечаем её в графике: у длинных
     выпусков (у СФО бывает 40+ строк) иначе не видно, что платят
     следующим, а именно это и ищут глазами. */
  const nextCouponDate = couponsSorted.find(c => c.date >= today)?.date ?? null;

  return (
    <div>
      {/* ── Шапка выпуска ─────────────────────────────────────────── */}
      <div className="page-h">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <div className="page-t">{shortname}</div>
            <div className="page-s">{fullname}</div>
            <div className="page-s mono" style={{ marginTop: 6 }}>
              ISIN {isin}
              {bond?.regnumber ? <> · REGN {bond.regnumber}</> : null}
              {typeName ? <> · {typeName}</> : null}
            </div>
            {issuer?.title && (
              <div className="page-s" style={{ marginTop: 4 }}>
                Эмитент: {issuer.title}
                {issuer.inn ? <> · ИНН <span className="mono">{issuer.inn}</span></> : null}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              className={'btn' + (isFav ? ' btn-green' : '')}
              onClick={() => bond && toggle(bond.isin)}
              disabled={!bond}
              title={bond ? 'Добавить или убрать из избранного' : 'Бумаги нет в списке MOEX'}
            >
              {isFav ? '★ В избранном' : '★ В избранное'}
            </button>
            {bond?.issuerKey && (
              <Link className="btn" to={'/issuer/' + bond.issuerKey}>Все выпуски эмитента →</Link>
            )}
            {moexReportsUrl(card?.issuerId) && (
              <a className="btn" href={moexReportsUrl(card.issuerId)} target="_blank" rel="noopener noreferrer"
                title="Официальная отчётность эмитента на сайте Московской биржи">
                Отчётность эмитента ↗
              </a>
            )}
            {moexIssueUrl(secid, bond?.board) && (
              <a className="btn" href={moexIssueUrl(secid, bond?.board)} target="_blank" rel="noopener noreferrer"
                title="Карточка выпуска на сайте Московской биржи">
                На MOEX ↗
              </a>
            )}
          </div>
        </div>

        {/* ── Флаги риска ─────────────────────────────────────────── */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
          {card?.hasDefault && <span className="tag r" style={{ fontWeight: 700 }}>ДЕФОЛТ</span>}
          {card?.hasTechDefault && <span className="tag a" style={{ fontWeight: 700 }}>Технический дефолт</span>}
          {qualOnly && <span className="tag p">Только для квалов</span>}
          {bond?.isAmort && <span className="tag">Амортизация</span>}
          {bond?.isCurrency && <span className="tag a">{bond.currency}</span>}
          {bond?.couponKind && <CouponTag kind={bond.couponKind} />}
          {bond?.listLevel != null && <>Уровень листинга: <LevelTag level={bond.listLevel} /></>}
          {card?.rating && <>Рейтинг: <RatingTag rating={card.rating} code={card.ratingCode} own={card.ratingOwn} /></>}
        </div>
      </div>

      {/* ── Плитки KPI ────────────────────────────────────────────── */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginBottom: 14 }}>
        <Kpi
          label="Цена, %"
          value={bond?.price == null ? '—' : nf(bond.price, 2)}
          color={priceColor(bond?.price)}
          /* 548 выпусков из 3095 сегодня не торговались, и по ним биржа
             отдаёт цену предыдущего дня. Показывать её как текущую —
             значит выдать вчерашнее число за сегодняшнее, поэтому
             говорим прямо, от какого дня цена и что изменения нет. */
          sub={bond?.priceSrc === 'prev'
            ? (bond?.priceChange == null
              ? 'предыдущий торговый день, сегодня сделок не было'
              : chgStrA(bond.priceChange) + ' за день')
            : (bond?.priceChange == null ? 'от номинала' : (chgStrA(bond.priceChange) + ' за день'))}
        />
        <Kpi
          label="Доходность, %"
          value={bond?.ytm == null ? 'н/д' : nf(bond.ytm, 2)}
          color={bond?.ytm == null ? KPI_COLOR.muted : ytmColor(isFloater)}
          sub={bond?.ytm == null && bond?.ytmRaw != null
            ? `MOEX отдаёт недостоверное значение ${nf(bond.ytmRaw, 2)}%`
            : bond?.ytmSuspect
              ? `биржа даёт два разных значения: ${nf(bond.ytm, 2)}% и ${nf(bond.ytmAlt, 2)}% — по неликвидным выпускам верного может не быть`
              : (bond?.yieldDateType === 'OFFER' ? 'к оферте' : 'к погашению')}
        />
        <Kpi
          label="Купон, %"
          value={bond?.couponPercent == null ? '—' : nf(bond.couponPercent, 2)}
          color={bond?.couponPercent == null ? KPI_COLOR.muted : couponColor(isFloater, bond.couponPercent)}
          /* Купон MOEX отдаёт в валюте выпуска. У валютной бумаги
             писать «₽» нельзя: 47,50 — это доллары, а не рубли.
             Рядом даём рублёвый эквивалент по курсу биржи. */
          sub={bond?.couponValue == null ? 'ставка unknown' : (
            nf(bond.couponValue, 2) + (bond.currency === 'RUB' ? ' ₽' : ' ' + bond.currency) + ' за выплату'
            + (bond.isCurrency && bond.fxRate ? ` (≈ ${nf(bond.couponValue * bond.fxRate, 0)} ₽)` : '')
          )}
        />
        <Kpi
          label="Купон к цене, %"
          value={couponToPrice == null ? '—' : nf(couponToPrice, 2)}
          color={couponToPrice == null ? KPI_COLOR.muted : KPI_COLOR.couponToPrice}
          sub="купон % ÷ цена × 100"
        />
        <Kpi
          label="Выплат в год"
          value={paymentsPerYear == null ? '—' : timesWord(paymentsPerYear)}
          color={KPI_COLOR.payments}
          sub={bond?.couponPeriod ? `период ${bond.couponPeriod} дн.` : 'по данным MOEX'}
        />
        <Kpi
          label="Дюрация"
          value={duration(bond?.durationDays)}
          color={bond?.durationDays == null ? KPI_COLOR.muted : KPI_COLOR.duration}
          sub={bond?.durationDays != null ? nf(bond.durationDays, 0) + ' дней' : '—'}
        />
        <Kpi
          label="Номинал"
          value={bond?.faceValue == null ? '—' : nf(bond.faceValue, 0) + (bond.currency === 'RUB' ? ' ₽' : ' ' + bond.currency)}
          color={KPI_COLOR.face}
          sub={bond?.isAmort ? 'амортизируется' : 'постоянный'}
        />
        <Kpi
          label="Оферта"
          value={offerDate ? dateShort(offerDate) : '—'}
          color={offerDate ? KPI_COLOR.offer : KPI_COLOR.muted}
          sub={offerDate ? timeLeft(offerDate) : 'оферты нет'}
        />
        {/* Погашение отдельной плиткой, а не только строчкой в примечании:
            в брокере эти две даты стоят рядом, и человек ищет их рядом.
            Раньше дата погашения была спрятана в тексте ниже. */}
        <Kpi
          label="Погашение"
          value={matDate ? dateShort(matDate) : '—'}
          color={matDate ? KPI_COLOR.maturity : KPI_COLOR.muted}
          sub={matDate ? timeLeft(matDate) : 'даты нет'}
        />
      </div>

      {/* ── Карточка предприятия ─────────────────────────────────────
          Как в оригинале: на карточке выпуска стоит короткая карточка
          «О компании» — кто за бумагой и метрики отчётности плитками, —
          а полная карточка с реквизитами и отчётностью открывается
          окном (кнопка «Карточка предприятия»), а не второй страницей.
          Прозу про бизнес и риски не пишем — заказчик просил
          редакционное не делать. */}
      <IssuerCard
        variant="card"
        title={emitter?.title || issuer?.title}
        shortTitle={emitter?.shortTitle}
        inn={emitter?.inn || issuer?.inn}
        ogrn={emitter?.ogrn}
        country={emitter?.country}
        website={emitter?.website}
        rating={bond?.rating}
        ratingCode={bond?.ratingCode}
        bonds={bond ? [bond] : []}
        girbo={girbo}
        girboDate={girboDate}
        issuerKey={bond?.issuerKey}
        stats={stats}
        period={period}
        onExpand={() => setCardOpen(true)}
      />

      {/* ── Та же карточка окном ─────────────────────────────────────
          Один компонент на два вида: короткая карточка выше и подробная
          в окне. Текст рисует один код, поэтому карточка на странице и
          в окне не могут разойтись. */}
      <Modal
        open={cardOpen}
        onClose={() => setCardOpen(false)}
        title={emitter?.shortTitle || emitter?.title || issuer?.title || 'Карточка предприятия'}
        subtitle={'Карточка предприятия' + (emitter?.inn || issuer?.inn ? ` · ИНН ${emitter?.inn || issuer?.inn}` : '')}
      >
        <IssuerCard
          variant="detail"
          showBrief
          title={emitter?.title || issuer?.title}
          shortTitle={emitter?.shortTitle}
          inn={emitter?.inn || issuer?.inn}
          ogrn={emitter?.ogrn}
          okpo={emitter?.okpo}
          country={emitter?.country}
          legalAddress={emitter?.legalAddress}
          postalAddress={emitter?.postalAddress}
          website={emitter?.website}
          capitalization={emitter?.capitalization}
          emitterCapitalization={emitter?.emitterCapitalization}
          capitalUpdatedAt={emitter?.capitalizationUpdatedAt}
          rating={bond?.rating}
          ratingCode={bond?.ratingCode}
          bonds={bond ? [bond] : []}
          girbo={girbo}
          girboDate={girboDate}
          issuerKey={bond?.issuerKey}
          emitterId={issuer?.id ?? emitter?.id}
          stats={stats}
          period={period}
        />
      </Modal>

      {/* ── Калькулятор: «у меня есть сумма и срок» ────────────────
          Считает на уже загруженных данных выпуска, без новых запросов.
          График купонов передаём внутрь: по нему суммы выплат точнее,
          чем «ставка × число выплат» — особенно у валютных выпусков,
          где курс пересчёта у каждого свой.
          key — чтобы при переходе на другой выпуск поля сбросились
          и срок пересчитался под новую дату погашения. */}
      <YieldCalculator
        key={bond?.isin || bond?.secid}
        bond={bond}
        coupons={card?.coupons}
        amortizations={card?.amortizations}
        amortCapped={!!card?.amortizationsCapped}
      />

      {/* ── График купонных выплат ────────────────────────────────── */}
      {couponsSorted.length > 0 && (
        <Panel title="График купонных выплат" style={{ marginBottom: 14 }}
          right={<span className="c-3" style={{ fontSize: 11 }}>прошедшие / будущие</span>}>
          <div style={{ height: 260, position: 'relative' }}>
            <canvas ref={canvasRef} />
          </div>
        </Panel>
      )}

      {/* ── Купоны, амортизация, оферты ───────────────────────────── */}
      <Panel title="Купоны и амортизация" pad={false} style={{ marginBottom: 14 }}
        right={<span className="c-3" style={{ fontSize: 11, display: 'flex', gap: 8, alignItems: 'center' }}>
          <span>
            {(card?.coupons || []).length}{' '}
            {plural((card?.coupons || []).length, 'выплата', 'выплаты', 'выплат')}
            {card?.couponsCapped ? ', показаны не все' : ''}
          </span>
          <span className="tag" style={{ fontSize: 10 }} title="Данные Московской биржи (ISS)">ISS</span>
        </span>}>
        {card?.couponsCapped && (
          <div className="c-3" style={{ fontSize: 10.5, padding: '8px 12px 0', lineHeight: 1.6 }}>
            У этого выпуска выплат больше, чем отдаёт биржа: она присылает не более
            100 строк графика. Здесь показаны первые сто — последние выплаты могут
            быть не видны.
          </div>
        )}
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th className="nosort">№</th>
                <th className="nosort">Дата купона</th>
                <th className="nosort">Размер, ₽</th>
                <th className="nosort">% от номинала</th>
                <th className="nosort">Остаточный номинал</th>
                <th className="nosort">Статус</th>
              </tr>
            </thead>
            <tbody>
              {(card?.coupons || []).map((c, idx) => {
                const isPast = c.date && c.date < today;
                return (
                  <tr key={'c' + c.date} className={isPast ? 'c-3' : ''}>
                    <td className="mono c-3" style={{ fontSize: 11 }}>{idx + 1}</td>
                    <td className="mono">{date(c.date)}</td>
                    <td className="mono">{c.value == null ? '—' : nf(c.value, 2)}</td>
                    <td className="mono">{c.valuePrc == null ? '—' : nf(c.valuePrc, 2) + '%'}</td>
                    <td className="mono c-2">{c.faceValue == null ? '—' : nf(c.faceValue, 2)}</td>
                    <td className="c-3" style={{ fontSize: 11 }}>
                      {isPast ? 'выплачен' : (c.date === nextCouponDate ? 'ближайшая' : 'предстоит')}
                    </td>
                  </tr>
                );
              })}
              {!(card?.coupons || []).length && (
                <tr><td colSpan={5} className="empty">Купонный график по этой бумаге биржа не публикует — у неё либо один купон в конце срока, либо выплаты не расписаны</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {(card?.amortizations || []).length > 0 && (
          <div className="tbl-wrap" style={{ borderTop: '1px solid var(--border)' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th className="nosort">Амортизация</th>
                  <th className="nosort">Сумма, ₽</th>
                  <th className="nosort">% от номинала</th>
                  <th className="nosort">Остаток после выплаты</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  let face = bond?.faceValue ?? null;
                  return (card.amortizations || []).map(a => {
                    if (face != null && a.value != null) face = face - a.value;
                    const isPast = a.date && a.date < today;
                    return (
                      <tr key={'a' + a.date} className={isPast ? 'c-3' : ''}>
                        <td className="mono">{date(a.date)}</td>
                        <td className="mono">{a.value == null ? '—' : nf(a.value, 2)}</td>
                        <td className="mono">{a.valuePrc == null ? '—' : nf(a.valuePrc, 2) + '%'}</td>
                        <td className="mono c-2">{face == null ? '—' : nf(face, 2)}</td>
                      </tr>
                    );
                  });
                })()}
              </tbody>
            </table>
          </div>
        )}

        {(card?.offers || []).length > 0 && (
          <div className="tbl-wrap" style={{ borderTop: '1px solid var(--border)' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th className="nosort">Оферта</th>
                  <th className="nosort">Период предъявления</th>
                  <th className="nosort">Цена выкупа, %</th>
                  <th className="nosort">Тип</th>
                </tr>
              </thead>
              <tbody>
                {(card.offers || []).map(o => {
                  const isPast = o.end && o.end < today;
                  return (
                    <tr key={'o' + o.date} className={isPast ? 'c-3' : ''}>
                      <td className="mono">{date(o.date)}</td>
                      <td className="mono c-2" style={{ fontSize: 11 }}>
                        {o.start ? date(o.start) : '—'} — {o.end ? date(o.end) : '—'}
                      </td>
                      <td className="mono">{o.price == null ? '—' : nf(o.price, 2)}</td>
                      <td className="c-3" style={{ fontSize: 11 }}>{o.type || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* ── Похожие выпуски ───────────────────────────────────────── */}
      {similar.map(g => (
        <Panel key={g.title} title={g.title} pad={false} style={{ marginBottom: 14 }}
          right={<span className="c-3" style={{ fontSize: 11 }}>
            {g.desc} · показано {Math.min(6, g.list.length)} из {g.list.length}
          </span>}>
          <BondTable bonds={g.list} cols={SIMILAR_COLS} limit={6} />
        </Panel>
      ))}

      {/* ── Справка по выпуску ────────────────────────────────────── */}
      <Panel title="Справка по выпуску">
        {(() => {
          // Средний дневной оборот считаем по выпускам того же эмитента.
          const peers = bond?.issuerKey ? bonds.filter(b => b.issuerKey === bond.issuerKey) : [];
          const withTurn = peers.filter(b => b.turnover != null);
          const avgTurn = withTurn.length
            ? withTurn.reduce((s, b) => s + b.turnover, 0) / withTurn.length
            : null;
          return (
            <div style={{ fontSize: 12.5, lineHeight: 1.75, color: 'var(--text2)' }}>
              <p style={{ marginTop: 0 }}>
                {shortname} ({isin}) — {typeName || 'облигация'}.
                {bond?.couponPercent != null
                  ? ` Купон ${nf(bond.couponPercent, 2)}% годовых`
                  : ' Купонная ставка MOEX не раскрыта'}
                {paymentsPerYear != null ? `, выплаты ${timesWord(paymentsPerYear)} в год` : ''}
                {bond?.couponValue != null ? `, размер купона ${nf(bond.couponValue, 2)} ₽` : ''}.
              </p>
              <p>
                {offerDate
                  ? `Ближайшая оферта — ${date(offerDate)} (${timeLeft(offerDate)}).`
                  : 'Оферта (досрочный выкуп) не предусмотрена.'}
                {matDate ? ` Погашение — ${date(matDate)} (${timeLeft(matDate)}).` : ''}
              </p>
              <p>
                {bond?.durationDays != null
                  ? `Дюрация ${duration(bond.durationDays)} (${nf(bond.durationDays, 0)} дней). `
                  : 'Дюрация MOEX не рассчитана. '}
                {bond?.nkd != null ? `НКД ${nf(bond.nkd, 2)} ₽. ` : ''}
                {avgTurn != null
                  ? `Средний дневной оборот по выпускам эмитента — ${money(avgTurn)} (по ${withTurn.length} вып.). `
                  : ''}
                {bond?.turnover ? `Оборот текущей сессии ${money(bond.turnover)}. ` : ''}
                Объём выпуска — {bond?.issuesize != null ? nf(bond.issuesize, 0) + ' шт.' : '—'}
                {bond?.issuesize != null && bond?.faceValue != null
                  ? ` (${money(bond.issuesize * bond.faceValue)} по номиналу)`
                  : ''}.
              </p>
              <p className="c-3">
                {card?.rating
                  ? <>{card.ratingOwn
                    ? `Рейтинг ${card.rating} взят из таблицы котировок smart-lab.ru`
                    : `Рейтинг ${card.rating} — рейтинг эмитента по данным smart-lab.ru; сам этот выпуск `
                      + 'в таблице источника показан без рейтинга, значение взято по другим выпускам того же эмитента'}
                    {card.ratingAt ? `, данные собраны ${dateTime(card.ratingAt)}` : ''}.
                    {' '}Агентство и дата присвоения в источнике не указаны, рейтинг относится к эмитенту. Это
                    ориентир, а не выписка из отчёта рейтингового агентства. </>
                  : <>Кредитного рейтинга этой бумаги в источнике рейтингов (таблица котировок smart-lab.ru)
                    нет — вероятно, её там просто не показывают. </>}
                Отчётности и показателей вроде EBITDA в данных Московской биржи нет — такие сведения по выпуску
                здесь не приводятся. Бухгалтерская отчётность эмитента (выручка и активы по годам) берётся из
                ГИР БО ФНС и показана в карточке эмитента.
              </p>
              <p className="c-3" style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginBottom: 0 }}>
                Не является индивидуальной инвестиционной рекомендацией.
              </p>
            </div>
          );
        })()}
      </Panel>

      {/* Крот. Стоит внизу карточки и служит картинкой превью: тот же
          файл указан в og:image, поэтому при отправке ссылки в мессенджер
          подтягивается он же. Адрес относительный — Vite добавит базу
          /bond-radar/ сам; в метатегах база прописана руками, потому что
          внешние сервисы относительные пути не понимают. */}
      <div style={{ marginTop: 14, textAlign: 'center' }}>
        <img
          src="krot.png"
          alt=""
          width={260}
          style={{ maxWidth: '100%', height: 'auto', borderRadius: 10, opacity: 0.9 }}
        />
      </div>
    </div>
  );
}