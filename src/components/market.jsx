import { useEffect, useMemo, useState } from 'react';
import { fetchIndexHistory, curveAt, median, daysUntil } from '../api/moex';
import { nf } from '../lib/format';
import { Panel } from './ui';

/* ═══════════════════════════════════════════════════════════════════
   Рыночные таблицы с главной — как на bondradar.pro.

   Что здесь есть и чего нет (честно):
   ЕСТЬ  — ключевая ставка и RUSFAR (MOEX отдаёт их как индексы
           KEYRATE и RUSFAR), ОФЗ на 1/5/10 лет из кривой доходности,
           медианы по корпоратам и ВДО, индексы RGBI и корпоратов,
           выпуски ОФЗ/регионов и топ корпоратов по доходности.
   НЕТ   — RUONIA и ставки по вкладам: Московская биржа их не публикует,
           а Банк России не отдаёт данные в браузер (нет CORS).
           Колонки «РЕЙТ.» тоже нет: рейтингов агентств в открытом API
           биржи не существует, а выдумывать их мы не станем.
   ═══════════════════════════════════════════════════════════════════ */

const PERIODS = [
  { key: '1W', label: 'Нед', days: 7 },
  { key: '1M', label: '1М', days: 31 },
  { key: '3M', label: '3М', days: 92 },
  { key: '6M', label: '6М', days: 183 },
  { key: '1Y', label: '1Г', days: 366 },
];

function isoDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Срок до погашения человеческим языком: «2.4 г», «7 мес». */
export function termLabel(days) {
  if (days == null || !Number.isFinite(days) || days <= 0) return '—';
  const y = days / 365.25;
  if (y >= 1) return nf(y, 1) + ' г';
  return Math.max(1, Math.round(days / 30.44)) + ' мес';
}

/* ── Искровой график без зависимостей ─────────────────────────────── */
function Sparkline({ values, w = 280, h = 52, up }) {
  const pts = values.filter(v => Number.isFinite(v));
  if (pts.length < 2) return <div className="c-3" style={{ fontSize: 11, height: h }}>нет истории</div>;

  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const step = w / (pts.length - 1);
  const y = v => h - 4 - ((v - min) / span) * (h - 8);
  const d = pts.map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${d} L${w},${h} L0,${h} Z`;
  const color = up ? 'var(--green)' : 'var(--red)';

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none"
      style={{ display: 'block', overflow: 'visible' }} aria-hidden="true">
      <path d={area} fill={color} opacity="0.08" />
      <path d={d} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

/* ── Карточка индекса: значение, изменение, период, график ────────── */
function IndexCard({ secid, title, note, initialPeriod = '3M' }) {
  const [period, setPeriod] = useState(initialPeriod);
  const [rows, setRows] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    const days = PERIODS.find(p => p.key === period)?.days || 92;
    /* Берём с запасом, чтобы корректно посчитать изменение за период */
    fetchIndexHistory(secid, { from: isoDaysAgo(days + 7) })
      .then(r => { if (alive) setRows(r && r.length ? r.filter(x => x.close != null) : null); })
      .catch(() => { if (alive) { setRows(null); setFailed(true); } });
    return () => { alive = false; };
  }, [secid, period]);

  const stats = useMemo(() => {
    if (!rows || rows.length < 2) return null;
    const last = rows[rows.length - 1].close;
    const prev = rows[rows.length - 2].close;
    const days = PERIODS.find(p => p.key === period)?.days || 92;
    const from = isoDaysAgo(days);
    const base = rows.find(r => r.date >= from)?.close ?? rows[0].close;
    return {
      last,
      dayPct: prev ? ((last - prev) / prev) * 100 : null,
      periodPct: base ? ((last - base) / base) * 100 : null,
      values: rows.map(r => r.close),
      date: rows[rows.length - 1].date,
    };
  }, [rows, period]);

  const up = stats?.periodPct != null ? stats.periodPct >= 0 : true;

  return (
    <Panel title={title} right={<span className="c-3" style={{ fontSize: 11 }}>{secid}</span>}>
      {!stats ? (
        <div className="c-3" style={{ fontSize: 12, padding: '8px 0' }}>
          {failed ? 'Индекс недоступен — биржа не отдала историю.' : 'Загрузка графика…'}
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 22, fontWeight: 700 }}>
              {nf(stats.last, 2)}
            </span>
            <span className={up ? 'c-g' : 'c-r'} style={{ fontSize: 12, fontWeight: 600 }}>
              {stats.periodPct == null ? '—' : (stats.periodPct >= 0 ? '+' : '') + nf(stats.periodPct, 2) + '%'}
            </span>
            <span className="c-3" style={{ fontSize: 11 }}>за {PERIODS.find(p => p.key === period)?.label.toLowerCase()}</span>
            {stats.dayPct != null && (
              <span className="c-3" style={{ fontSize: 11 }}>
                за день <span className={stats.dayPct >= 0 ? 'c-g' : 'c-r'}>{nf(stats.dayPct, 2)}%</span>
              </span>
            )}
          </div>

          <div style={{ display: 'flex', gap: 4, margin: '9px 0 6px' }}>
            {PERIODS.map(p => (
              <span key={p.key} className={'chip' + (period === p.key ? ' on' : '')}
                style={{ padding: '2px 8px', fontSize: 10.5 }}
                onClick={() => setPeriod(p.key)}>{p.label}</span>
            ))}
          </div>

          <Sparkline values={stats.values} up={up} />
          <div className="c-3" style={{ fontSize: 10.5, display: 'flex', justifyContent: 'space-between' }}>
            <span>{stats.date}</span>
            {note ? <span>{note}</span> : null}
          </div>
        </>
      )}
    </Panel>
  );
}

/* ── «Где сейчас доходность» ──────────────────────────────────────── */

/** Живые ставки, которые Московская биржа отдаёт как индексы. */
const RATE_ROWS = [
  { secid: 'KEYRATE', label: 'Ключевая ставка ЦБ', note: 'индекс МосБиржи' },
  { secid: 'RUSFAR', label: 'RUSFAR (репо овернайт)', note: 'ставка репо с ЦК' },
];

function RatesNow({ rates, curve, bonds }) {
  const rows = useMemo(() => {
    const list = [];

    for (const r of RATE_ROWS) {
      const v = rates?.[r.secid]?.value;
      list.push({ label: r.label, value: v, sub: r.note, live: true });
    }

    [1, 5, 10].forEach(y => {
      const v = curveAt(curve, y);
      list.push({ label: `ОФЗ ${y} ${y === 1 ? 'год' : 'лет'}`, value: v, sub: 'из кривой доходности' });
    });

    /* Корпораты первого уровня листинга — биржевой аналог «надёжных» */
    if (bonds?.length) {
      const safe = bonds.filter(b => !b.isOfz && !b.isSubfederal && b.listLevel === 1 && b.ytm != null);
      const vdo = bonds.filter(b => !b.isOfz && !b.isSubfederal && b.listLevel === 3 && b.ytm != null && b.ytm >= 20);
      list.push({ label: 'Корпораты 1 уровня', value: median(safe.map(b => b.ytm)), sub: `медиана по ${safe.length} вып.` });
      list.push({ label: 'ВДО (медиана)', value: median(vdo.map(b => b.ytm)), sub: `медиана по ${vdo.length} вып.` });
    }

    return list;
  }, [rates, curve, bonds]);

  return (
    <Panel title="Где сейчас доходность" pad={false}>
      <table className="tbl">
        <tbody>
          {rows.map(r => (
            <tr key={r.label} style={{ cursor: 'default' }}>
              <td style={{ paddingLeft: 14 }}>{r.label}</td>
              <td className="c-3" style={{ fontSize: 10.5 }}>{r.sub}</td>
              <td className="mono" style={{ textAlign: 'right', fontWeight: 600, paddingRight: 14, whiteSpace: 'nowrap' }}>
                {r.value == null ? '—' : nf(r.value, 2) + '%'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="c-3" style={{ fontSize: 10.5, padding: '9px 14px', borderTop: '1px solid var(--border)', lineHeight: 1.6 }}>
        Ключевая ставка и RUSFAR — живые индексы Московской биржи. Ставки RUONIA и по вкладам
        не показаны: биржа их не публикует, а Банк России не отдаёт данные в браузер.
      </div>
    </Panel>
  );
}

/* ── Таблица «топ выпусков по доходности» ─────────────────────────── *
 * Доходность к погашению нельзя сравнивать между бумагами с разным
 * горизонтом денежного потока. Проверено на данных биржи:
 *   • ТрансФ1P01 — погашение через 10 дней, дюрация 0 → «257 %»
 *   • Самокат02  — купоны кончаются 31.05.2026 при погашении 23.09.2027,
 *                  то есть доходность считается к оферте, а не к концу
 *   • ИнвОбл01   — погашение через 3 дня → «153 %»
 * Числа не врут, но рядом с обычными 15 % они бессмысленны. Поэтому
 * в рейтингах оставляем только бумаги с дюрацией от полугода, ценой не
 * ниже половины номинала и доходностью до 100 % — это отсекает
 * короткие и глубоко дефолтные выпуски. Правило видно в шапке таблицы,
 * а строки с доходностью к оферте помечены явно.
 */
const MIN_PRICE = 50;
const MIN_DURATION_DAYS = 180;
const MAX_YTM = 100;

/** Оставляем только доходности, сопоставимые между собой. */
function comparable(b) {
  return b.ytm != null
    && b.ytm <= MAX_YTM
    && b.price != null && b.price >= MIN_PRICE
    && b.durationDays != null && b.durationDays >= MIN_DURATION_DAYS;
}

function TopByYtm({ title, bonds, empty, note, limit = 5 }) {
  const eligible = useMemo(
    () => (bonds || []).filter(comparable),
    [bonds],
  );

  const rows = useMemo(
    () => [...eligible].sort((a, b) => b.ytm - a.ytm).slice(0, limit),
    [eligible, limit],
  );

  /* Сколько выпусков с доходностью отсеяли как несопоставимые */
  const skipped = useMemo(
    () => (bonds || []).filter(b => b.ytm != null).length - eligible.length,
    [bonds, eligible],
  );

  return (
    <Panel title={title} pad={false}
      right={<span className="c-3" style={{ fontSize: 11 }}>
        {note}{skipped > 0 ? ` · отсеяно ${skipped}` : ''}
      </span>}>
      {!rows.length ? (
        <div className="empty" style={{ padding: '14px' }}>{empty}</div>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th className="nosort">ВЫПУСК</th>
                <th className="nosort">КУПОН</th>
                <th className="nosort">ДОХ. СЕЙЧАС</th>
                <th className="nosort">YTM</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(b => {
                const cur = b.couponPercent != null && b.price ? (b.couponPercent / b.price) * 100 : null;
                return (
                  <tr key={b.secid} onClick={() => { window.location.hash = '#/bond/' + b.secid; }}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{b.shortname}</div>
                      <div className="c-3" style={{ fontSize: 10.5 }}>
                        {termLabel(daysUntil(b.matDate))} · цена {nf(b.price, 1)}%
                        {b.yieldDateType === 'OFFER' ? ' · к оферте' : ''}
                      </div>
                    </td>
                    <td className="mono">{b.couponPercent == null ? '—' : nf(b.couponPercent, 2) + '%'}</td>
                    <td className="mono">{cur == null ? '—' : nf(cur, 2) + '%'}</td>
                    <td className="mono" style={{ fontWeight: 700 }}>{nf(b.ytm, 2)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/* Panel импортируем здесь, чтобы не плодить циклические зависимости */
export { IndexCard, RatesNow, TopByYtm };