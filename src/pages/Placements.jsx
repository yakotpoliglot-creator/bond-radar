import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchPlacements, fetchRatings, couponKind, COUPON_LABEL, COUPON_TAG } from '../api/moex';
import { Panel, Loading, ErrorBox, Kpi, timesWord, RatingTag } from '../components/ui';
import { ytmClass, nf } from '../lib/format';

/* ═══════════════════════════════════════════════════════════════════
   Первичные размещения — /placements.

   Данные собирает робот (scripts/placements.mjs) из сообщений
   Московской биржи и кладёт в placements.json рядом с сайтом. Здесь
   только показ: список разобранных анонсов, фильтры и карточки.

   ЧЕСТНО О ТОМ, ЧТО ЗДЕСЬ ЕСТЬ И ЧЕГО НЕТ.

   Есть: эмитент, серия, регистрационный номер, ISIN, дата начала
   размещения, период сбора заявок с точным временем, режим и цена
   размещения, андеррайтер. По уже размещённым выпускам — фактический
   объём, количество бумаг, цена и доля размещённых.

   Нет и не будет выдумано:
     · рейтинги — у источника нет ни агентства, ни даты присвоения;
     · ориентир купона ДО размещения — ставку раскрывает эмитент, а не
       биржа, в сообщениях биржи её нет;
     · книга заявок — биржа её не публикует.

   Купон, тип купона и дата погашения подтягиваются из торговых данных
   биржи по ISIN или регистрационному номеру — но только после того,
   как бумага появилась в списках. До размещения там прочерки.
   ═══════════════════════════════════════════════════════════════════ */

const DAY = 864e5;

/* ── форматирование ──────────────────────────────────────────────── */

/** «2026-10-05» → «05.10.2026» */
function fmtDate(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '—';
}

/** «2028-03-01» → «03.2028» — как в карточках выпусков. */
function fmtMonth(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})/);
  return m ? `${m[2]}.${m[1]}` : '—';
}

/** Деньги коротко: 9 901 480 000 → «9,9 млрд ₽» */
function fmtMoney(v, cur = '₽') {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  const s = n >= 1e12 ? `${(n / 1e12).toFixed(2).replace('.', ',')} трлн`
    : n >= 1e9 ? `${(n / 1e9).toFixed(2).replace('.', ',')} млрд`
      : n >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.', ',')} млн`
        : n >= 1e3 ? `${Math.round(n / 1e3)} тыс.`
          : String(n);
  return `${s} ${cur}`;
}

/** Процент с запятой: 13.89 → «13,89 %» */
function fmtPct(v, digits = 2) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return `${Number(v).toFixed(digits).replace('.', ',')} %`;
}

/** Сколько дней между двумя датами (по календарю, без времени). */
function daysBetween(fromIso, toIso) {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / DAY);
}

/** Сегодняшняя дата в виде «2026-10-01» по местному календарю. */
function todayIso(now = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** «Акционерное общество "Сбербанк КИБ"» → «АО "Сбербанк КИБ"» */
function shortIssuer(name) {
  return String(name || '')
    .replace(/Публичное акционерное общество\s*/gi, 'ПАО ')
    .replace(/Акционерное общество\s*/gi, 'АО ')
    .replace(/Общество с ограниченной ответственностью\s*/gi, 'ООО ')
    .replace(/\s+\)/g, ')')
    .replace(/\s+/g, ' ')
    .trim();
}

/** «биржевые облигации процентные неконвертируемые … серии 001Р-05» → «001Р-05» */
function seriesOf(item) {
  const src = `${item.series || ''} ${item.title || ''}`;
  const m = src.match(/серии\s+([A-Za-zА-Яа-я0-9_\-/]+)/i);
  return m ? m[1] : null;
}

/** Купон: «23,50 %», «Ключевая ставка» или честное «по формуле».

    У структурных выпусков (СберИОС и подобных) биржа отдаёт в поле
    купона 0,01 % — это не ставка, а заглушка: доход зависит от
    базового актива. Печатать «0,01 %» рядом с такой бумагой значит
    вводить читателя в заблуждение, поэтому пишем прямо. */
function couponText(bond, kind) {
  if (!bond) return '—';
  if (kind === 'struct') return 'по формуле';
  if (bond.couponPercent != null) return fmtPct(bond.couponPercent);
  if (bond.couponDetails && /ставка|%/i.test(bond.couponDetails)) return bond.couponDetails;
  return '—';
}

/* ── статус размещения ───────────────────────────────────────────── */

/**
 * Что происходит с выпуском прямо сейчас. Считаем по расписанию из
 * анонса биржи: период предварительного сбора заявок, а если его нет —
 * по дате размещения.
 */
function statusOf(item, now = new Date()) {
  const today = todayIso(now);
  const book = item.book || null;

  if (item.kind === 'suspend') return { text: 'торги приостановлены', cls: 'r' };

  if (item.kind === 'results') {
    const share = item.sharePlaced != null ? ` · размещено ${fmtPct(item.sharePlaced, 1)}` : '';
    return { text: `итоги подведены${share}`, cls: 'g' };
  }

  if (book && book.from && book.to) {
    if (today < book.from) {
      const d = daysBetween(today, book.from);
      return { text: `сбор заявок с ${fmtDate(book.from)} · через ${d} ${timesWord(d).split(' ')[1]}`, cls: 'b' };
    }
    if (today > book.to) return { text: `сбор заявок закрыт ${fmtDate(book.to)}`, cls: '' };
    return {
      text: `сбор заявок идёт до ${fmtDate(book.to)}${book.daily ? ` · ежедневно ${book.daily}` : ''}`,
      cls: 'a', live: true,
    };
  }

  if (item.placementStart) {
    const d = daysBetween(today, item.placementStart);
    if (d > 0) return { text: `размещение ${fmtDate(item.placementStart)} · через ${d} ${timesWord(d).split(' ')[1]}`, cls: 'b' };
    if (d === 0) return { text: 'размещение сегодня', cls: 'a', live: true };
    return { text: `размещение прошло ${fmtDate(item.placementStart)}`, cls: '' };
  }

  return { text: 'дата размещения не объявлена', cls: '' };
}

/* ── фильтры ─────────────────────────────────────────────────────── */

const CHIPS = [
  { id: 'all', label: 'Все' },
  { id: 'fix', label: 'Фиксированный' },
  { id: 'float', label: 'Флоатер' },
  { id: 'qual', label: 'Только для квалов' },
  { id: 'unqual', label: 'Без квала' },
];

const COUPON_STEPS = [
  { id: 'any', label: 'любой', min: null },
  { id: '16', label: 'от 16 %', min: 16 },
  { id: '18', label: 'от 18 %', min: 18 },
  { id: '20', label: 'от 20 %', min: 20 },
  { id: '22', label: 'от 22 %', min: 22 },
];

const TERM_STEPS = [
  { id: 'any', label: 'любой', min: 0, max: 100 },
  { id: 'y1', label: 'до 1 года', min: 0, max: 1 },
  { id: 'y3', label: '1–3 года', min: 1, max: 3 },
  { id: 'y5', label: '3–5 лет', min: 3, max: 5 },
  { id: 'y10', label: '5–10 лет', min: 5, max: 10 },
  { id: 'y10p', label: 'больше 10 лет', min: 10, max: 100 },
];

/** Срок до погашения в годах — по дате погашения из торговых данных. */
function termYears(item, today) {
  const mat = item.bond?.matDate || item.bond?.offerDate;
  if (!mat) return null;
  const d = daysBetween(today, String(mat).slice(0, 10));
  return d == null ? null : d / 365.25;
}

/* ── карточка ────────────────────────────────────────────────────── */

function PlacementCard({ item, kind, today, ratings }) {
  const bond = item.bond || null;
  const status = statusOf(item, new Date());
  const ck = bond ? couponKind({ COUPON_DETAILS: bond.couponDetails, BONDTYPE: bond.bondType }) : null;
  const series = seriesOf(item);
  const term = termYears(item, today);
  const linkId = bond?.secid || item.isin;

  /* Рейтинг берём из нашего файла рейтингов — того же, что показывает
     карточка выпуска. Биржа его не публикует, поэтому в анонсе его нет,
     а в брокере он есть: без него доходность не с чем соотнести.
     Рейтинг у источника эмитентский, поэтому у разных выпусков одного
     эмитента он один и тот же — это нормально, так и должно быть. */
  const rating = ratings?.ratings?.[item.isin]?.r || null;
  const ratingCode = ratings?.ratings?.[item.isin]?.c ?? null;

  /* Выплат в год: из периода купона, а не «примерно». 365 делим на период
     в днях — так же, как в карточке выпуска. */
  const perYear = bond?.couponPeriodDays > 0 ? 365 / bond.couponPeriodDays : null;

  return (
    <div className="pl-card">
      <div className="pl-top">
        <div className="pl-issuer" title={item.issuer || item.series || ''}>
          {shortIssuer(item.issuer) || 'Эмитент не указан'}
        </div>
        {item.url && (
          <a className="pl-src" href={item.url} target="_blank" rel="noopener noreferrer"
            title="Сообщение Московской биржи — первоисточник">MOEX ↗</a>
        )}
      </div>

      <div className="pl-badges">
        {ck && <span className={'tag ' + (COUPON_TAG[ck] || '')}>{COUPON_LABEL[ck]}</span>}
        {bond?.qualified === true && <span className="tag a">только для квалов</span>}
        {bond?.qualified === false && <span className="tag">без квала</span>}
        {bond?.traded === false && <span className="tag b">ещё не торгуется</span>}
        {series && <span className="tag">{series}</span>}
      </div>

      <div className={'pl-status ' + (status.cls ? 'tag ' + status.cls : '')}>{status.text}</div>

      <div className="pl-rows">
        <div><span>Купон</span><b title={bond?.couponDetails || ''}>{couponText(bond, ck)}</b></div>
        {kind === 'results' ? (
          <>
            <div><span>Размещено</span><b>{fmtMoney(item.volumePlaced, bond?.currency === 'SUR' || !bond?.currency ? '₽' : bond.currency)}</b></div>
            <div><span>Доля выпуска</span><b>{item.sharePlaced != null ? fmtPct(item.sharePlaced, 1) : '—'}</b></div>
            <div><span>Цена</span><b>{item.actualPrice != null ? `${item.actualPrice.toLocaleString('ru-RU')} ₽` : '—'}</b></div>
            <div><span>Размещение</span><b>{fmtDate(item.placementStart)}{item.placementEnd && item.placementEnd !== item.placementStart ? ` – ${fmtDate(item.placementEnd)}` : ''}</b></div>
          </>
        ) : (
          <>
            <div><span>Дата размещения</span><b>{fmtDate(item.placementStart)}</b></div>
            <div><span>Цена</span><b>{item.priceRub != null ? `${item.priceRub.toLocaleString('ru-RU')} ₽` : '—'}{item.pricePercent != null ? ` (${item.pricePercent} %)` : ''}</b></div>
            <div><span>Сбор заявок</span><b>{item.book?.from ? `${fmtDate(item.book.from)} – ${fmtDate(item.book.to)}` : (item.collectTime || '—')}</b></div>
            <div><span>Погашение</span><b>{bond?.matDate ? fmtMonth(bond.matDate) : '—'}{term != null ? ` · ${term.toFixed(1).replace('.', ',')} г.` : ''}</b></div>
          </>
        )}

        {/* ── То, что видно в брокере ────────────────────────────────
            Прочерк здесь означает «биржа ещё не публикует»: до первых
            сделок ни цены, ни доходности не существует, и рисовать ноль
            вместо них значило бы выдумать данные. */}
        <div>
          <span>Рейтинг</span>
          <b>{rating
            ? <RatingTag rating={rating} code={ratingCode} />
            : <span className="c-3" style={{ fontSize: 10.5 }}>источник не публикует</span>}</b>
        </div>
        <div>
          <span>Доходность</span>
          {/* `> 0`, а не `!= null`: без сделок биржа отдаёт доходность
              ровно нулём, и «0,00 %» читалось бы как настоящая ставка.
              В файле от прошлых прогонов робота такие нули ещё есть. */}
          <b>{bond?.ytm > 0
            ? <span className={ytmClass(bond.ytm)}>{fmtPct(bond.ytm)}
              {bond.yieldDateType === 'OFFER' ? ' к оферте' : ''}</span>
            : <span className="c-3">—</span>}</b>
        </div>
        <div>
          <span>Цена · НКД</span>
          <b>{bond?.price > 0
            ? <>{fmtPct(bond.price)}
              <span className="c-3"> · НКД {bond.nkd == null ? '—' : nf(bond.nkd, 2) + ' ₽'}</span></>
            : <span className="c-3">—</span>}</b>
        </div>
        <div>
          <span>Ближайший купон</span>
          <b>{bond?.nextCoupon ? fmtDate(bond.nextCoupon) : <span className="c-3">—</span>}</b>
        </div>
        <div>
          <span>Выплат в год</span>
          <b>{perYear == null ? <span className="c-3">—</span> : timesWord(perYear)}
            {bond?.couponPeriodDays ? <span className="c-3"> · период {bond.couponPeriodDays} дн.</span> : null}</b>
        </div>
        <div>
          <span>Оферта</span>
          <b>{bond?.offerDate ? fmtDate(bond.offerDate) : <span className="c-3">оферты нет</span>}</b>
        </div>
      </div>

      <div className="pl-foot">
        <span className="c-3 mono">{item.regNumber || item.isin || '—'}</span>
        {linkId ? (
          <Link className="btn btn-sm" to={`/bond/${linkId}`}>Подробнее →</Link>
        ) : (
          <span className="c-3" style={{ fontSize: 11 }}>бумаги ещё нет в торговых списках</span>
        )}
      </div>
    </div>
  );
}

/* ── страница ────────────────────────────────────────────────────── */

export default function Placements() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('future');
  const [chip, setChip] = useState('all');
  const [coupon, setCoupon] = useState('any');
  const [term, setTerm] = useState('any');
  const [ratings, setRatings] = useState(null);
  const [, setTick] = useState(0);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      /* Рейтинги — отдельный маленький файл. Если его нет, карточки
         работают как раньше: в строке «Рейтинг» будет честное «источник
         не публикует», а не пустое место. */
      const [d, r] = await Promise.all([
        fetchPlacements(),
        fetchRatings().catch(() => null),
      ]);
      if (!d) throw new Error('Файл placements.json не найден');
      setData(d);
      setRatings(r);
      setLoading(false);
    } catch (e) {
      setError(e); setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  /* Раз в минуту пересчитываем статусы: «сбор заявок идёт» и счётчики
     дней должны обновляться у открытой страницы. При скрытой вкладке
     не тикаем — незачем. */
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') setTick(t => t + 1);
    }, 60000);
    return () => clearInterval(id);
  }, []);

  const items = data?.items || [];
  const today = todayIso();

  const groups = useMemo(() => {
    const future = [];
    const pending = [];
    const past = [];
    const paused = [];
    const today0 = todayIso();
    /* Дата, по которой судим «впереди или уже прошло»: конец сбора
       заявок, а если его в анонсе нет — дата размещения. */
    const when = x => x.book?.to || x.placementStart || null;

    for (const x of items) {
      if (x.kind === 'results') past.push(x);
      else if (x.kind === 'suspend') paused.push(x);
      else if ((when(x) || '9999-99-99') >= today0) future.push(x);
      else pending.push(x);
    }

    /* Впереди — от ближайших к дальним. Ждут итогов и итоги — от свежих
       к старым: читателю важнее то, что произошло только что. */
    future.sort((a, b) => String(when(a)).localeCompare(String(when(b))));
    const desc = (a, b) => String(when(b) || b.publishedAt).localeCompare(String(when(a) || a.publishedAt));
    pending.sort(desc);
    past.sort(desc);
    paused.sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
    return { future, pending, past, paused };
  }, [items]);

  const rows = useMemo(() => {
    const src = groups[tab] || [];
    const step = COUPON_STEPS.find(s => s.id === coupon);
    const termStep = TERM_STEPS.find(s => s.id === term);
    return src.filter(x => {
      const ck = x.bond ? couponKind({ COUPON_DETAILS: x.bond.couponDetails, BONDTYPE: x.bond.bondType }) : null;
      if (chip === 'fix' && ck !== 'fix') return false;
      if (chip === 'float' && ck !== 'float') return false;
      if (chip === 'qual' && x.bond?.qualified !== true) return false;
      if (chip === 'unqual' && x.bond?.qualified !== false) return false;
      if (step?.min != null && !(x.bond?.couponPercent >= step.min)) return false;
      if (termStep && termStep.id !== 'any') {
        const y = termYears(x, today);
        if (y == null || y < termStep.min || y >= termStep.max) return false;
      }
      return true;
    });
  }, [tab, groups, chip, coupon, term, today]);

  if (loading) return <Loading text="Читаем первичные размещения Московской биржи…" />;
  if (error) return <ErrorBox error={error} onRetry={load} />;

  const nearest = groups.future[0];
  const placedSum = groups.past.reduce((s, x) => s + (x.volumePlaced || 0), 0);

  return (
    <div>
      <div className="page-h">
        <div className="page-t">◈ Первичка</div>
        <div className="page-s">
          Размещения облигаций по сообщениям Московской биржи: даты, сбор заявок, цена, итоги
        </div>
        <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-sm" onClick={load}>↻ Обновить</button>
          <Link className="btn btn-sm" to="/screener">Скринер облигаций</Link>
          {data?.generatedAt && (
            <span className="c-3" style={{ fontSize: 11 }}>
              собрано {fmtDate(data.generatedAt)} в {String(data.generatedAt).slice(11, 16)} ·
              обновляется роботом раз в 3 часа
            </span>
          )}
        </div>
      </div>

      {/* ── Сводка ────────────────────────────────────────────────── */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(165px, 1fr))', marginBottom: 14 }}>
        <Kpi label="Впереди размещений" value={groups.future.length}
          sub={nearest ? `ближайшее ${fmtDate(nearest.book?.to || nearest.placementStart)}` : 'в окне анонсов нет'} />
        <Kpi label="Размещено за окно" value={fmtMoney(placedSum)} sub={`${groups.past.length} выпусков, фактические объёмы`} />
        <Kpi label="Сбор заявок идёт" value={items.filter(x => statusOf(x).live).length} sub="по расписанию из анонсов" />
        <Kpi label="Ждут итогов" value={groups.pending.length} sub="объявлены, итогов ещё нет" />
      </div>

      {/* ── Вкладки и фильтры ─────────────────────────────────────── */}
      <Panel pad={false} style={{ marginBottom: 14 }}>
        <div className="pl-controls">
          <div className="pl-tabs">
            <button className={'chip' + (tab === 'future' ? ' on' : '')} onClick={() => setTab('future')}>
              Впереди · {groups.future.length}
            </button>
            <button className={'chip' + (tab === 'pending' ? ' on' : '')} onClick={() => setTab('pending')}>
              Ждут итогов · {groups.pending.length}
            </button>
            <button className={'chip' + (tab === 'past' ? ' on' : '')} onClick={() => setTab('past')}>
              Итоги · {groups.past.length}
            </button>
            <button className={'chip' + (tab === 'paused' ? ' on' : '')} onClick={() => setTab('paused')}>
              Приостановки · {groups.paused.length}
            </button>
          </div>

          <div className="pl-filters">
            <div className="pl-chips">
              {CHIPS.map(c => (
                <button key={c.id} className={'chip' + (chip === c.id ? ' on' : '')} onClick={() => setChip(c.id)}>
                  {c.label}
                </button>
              ))}
            </div>
            <label className="pl-sel">Купон:
              <select value={coupon} onChange={e => setCoupon(e.target.value)}>
                {COUPON_STEPS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </label>
            <label className="pl-sel">Срок:
              <select value={term} onChange={e => setTerm(e.target.value)}>
                {TERM_STEPS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </label>
            <span className="c-3" style={{ fontSize: 11 }}>найдено {rows.length}</span>
          </div>
        </div>
      </Panel>

      {/* ── Карточки ──────────────────────────────────────────────── */}
      {rows.length === 0 ? (
        <Panel>
          <div className="empty">
            В этом окне таких размещений нет. Робот собирает анонсы за последние {data?.window?.days || 45} дней
            и обновляет файл раз в три часа — в спокойные дни список короткий, это не ошибка.
          </div>
        </Panel>
      ) : (
        <div className="pl-grid">
          {rows.map(x => (
            <PlacementCard key={x.id} item={x} kind={x.kind} today={today} ratings={ratings} />
          ))}
        </div>
      )}

      {/* ── Что здесь есть, а чего нет ────────────────────────────── */}
      <Panel title="Что здесь есть, а чего нет" style={{ marginTop: 14 }}>
        <div className="c-2" style={{ fontSize: 11.5, lineHeight: 1.75 }}>
          Источник — <b>сообщения Московской биржи о размещениях</b>: у каждой карточки ссылка MOEX ↗ на
          первоисточник. Робот читает их и складывает в файл рядом с сайтом.
          <br />
          <b>Есть:</b> эмитент, серия, регистрационный номер, ISIN, дата начала размещения, период сбора заявок
          с временем, режим и цена размещения, андеррайтер; по завершённым выпускам — фактический объём,
          количество бумаг и доля размещённых.
          <br />
          <b>Как в брокере:</b> рейтинг, доходность (к погашению или к оферте — биржа помечает сама), цена и НКД,
          ближайший купон, число выплат в год, оферта. Рейтинг — из нашего отдельного файла (сводная таблица
          smart-lab): агентства и даты присвоения в нём нет, и это рейтинг эмитента, один на все его выпуски.
          Всё остальное появляется <i>после</i> выхода бумаги на торги: до первых сделок ни цены, ни доходности
          не существует, и прочерк там честнее нуля.
          <br />
          <b>Нет и не выдумано:</b> <b>обеспечение и поручитель</b> — этого не публикует никто из открытых
          источников: ни биржа, ни раскрытие. Такое есть только в эмиссионных документах, руками. Поэтому
          строки «обеспечение» здесь нет вовсе — пустая строка выглядела бы как «обеспечения нет», а это
          было бы уже утверждение, которого мы не проверяли. Дальше: ориентир купона <i>до</i> размещения —
          ставку раскрывает эмитент, а не биржа; книга заявок — биржа её не публикует.
          <br />
          <b>Полнота:</b> робот показывает то, что биржа успела опубликовать. Если эмитент объявил размещение
          только своим раскрытием, не через биржу, его в списке не будет.
        </div>
      </Panel>

      <div className="c-3" style={{ fontSize: 11, marginTop: 10, lineHeight: 1.6 }}>
        Данные предоставляются «как есть» и не являются индивидуальной инвестиционной рекомендацией.
      </div>
    </div>
  );
}
