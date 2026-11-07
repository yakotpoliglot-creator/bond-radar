import { useEffect, useId, useMemo, useState } from 'react';
import { fetchIndexHistory, curveAt, median, daysUntil } from '../api/moex';
import { nf, chgStrA, chgPill, ytmTone } from '../lib/format';
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

/* ── Искровой график без зависимостей ─────────────────────────────── *
 * Как на образце: линия с заливкой, точкой на последнем значении и
 * подписью краёв. Градиент задаём в SVG, а не картинкой, чтобы он
 * пересчитывался при смене темы и ширины.
 */
function Sparkline({ values, w = 280, h = 64, up, left, right }) {
  const gid = useId().replace(/:/g, '');
  const pts = values.filter(v => Number.isFinite(v));
  if (pts.length < 2) return <div className="c-3" style={{ fontSize: 11, height: h }}>нет истории</div>;

  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const step = w / (pts.length - 1);
  /* Поля сверху и снизу, чтобы линия не липла к краям рамки. */
  const y = v => h - 7 - ((v - min) / span) * (h - 16);
  const d = pts.map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${d} L${w},${h} L0,${h} Z`;
  const color = up ? 'var(--green)' : 'var(--red)';
  const lastY = y(pts[pts.length - 1]);

  return (
    <div className="spark">
      {/* Точка последнего значения лежит поверх svg и в своём контейнере:
          внутри svg с preserveAspectRatio="none" она растянулась бы в овал. */}
      <div className="spark-plot">
        <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none"
          style={{ display: 'block' }} aria-hidden="true">
          <defs>
            <linearGradient id={`sg${gid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.26" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#sg${gid})`} />
          <path d={d} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round"
            vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="spark-dot" style={{ background: color, top: `calc(${(lastY / h) * 100}% - 3.5px)` }} />
      </div>
      {(left || right) && (
        <span className="spark-ends">
          <span>{left}</span>
          <span>{right}</span>
        </span>
      )}
    </div>
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
    <Panel
      title={title}
      right={
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="c-3" style={{ fontSize: 10.5 }}>{secid}</span>
          {/* Изменение за период — в шапке, как на образце: значение
              меняется вместе с выбранным периодом, и рядом с ним это
              читается сразу. */}
          {stats && stats.periodPct != null && (
            <span className={chgPill(stats.periodPct)}
              title={'Изменение за ' + PERIODS.find(p => p.key === period)?.label.toLowerCase()}>
              {chgStrA(stats.periodPct)} за {PERIODS.find(p => p.key === period)?.label.toLowerCase()}
            </span>
          )}
        </span>
      }
    >
      {!stats ? (
        <div className="c-3" style={{ fontSize: 12, padding: '8px 0' }}>
          {failed ? 'Индекс недоступен — биржа не отдала историю.' : 'Загрузка графика…'}
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em' }}>
              {nf(stats.last, 2)}
            </span>
            {stats.dayPct != null && (
              <span className="c-3" style={{ fontSize: 11 }}>
                за день <span className={chgPill(stats.dayPct)}>{chgStrA(stats.dayPct)}</span>
              </span>
            )}
          </div>

          <div style={{ display: 'flex', gap: 4, margin: '10px 0 8px' }}>
            {PERIODS.map(p => (
              <span key={p.key} className={'chip' + (period === p.key ? ' on' : '')}
                style={{ padding: '2px 8px', fontSize: 10.5 }}
                onClick={() => setPeriod(p.key)}>{p.label}</span>
            ))}
          </div>

          <Sparkline
            values={stats.values}
            up={up}
            left={stats.date}
            right={note}
          />
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
      list.push({ label: r.label, value: v, sub: r.note, tone: 'rate' });
    }

    [1, 5, 10].forEach(y => {
      const v = curveAt(curve, y);
      list.push({ label: `ОФЗ ${y} ${y === 1 ? 'год' : 'лет'}`, value: v, sub: 'из кривой доходности', tone: 'ofz' });
    });

    /* Корпораты первого уровня листинга — биржевой аналог «надёжных» */
    if (bonds?.length) {
      const safe = bonds.filter(b => !b.isOfz && !b.isSubfederal && b.listLevel === 1 && b.ytm != null);
      const vdo = bonds.filter(b => !b.isOfz && !b.isSubfederal && b.listLevel === 3 && b.ytm != null && b.ytm >= 20);
      list.push({ label: 'Корпораты 1 уровня', value: median(safe.map(b => b.ytm)), sub: `медиана по ${safe.length} вып.`, tone: 'corp' });
      list.push({ label: 'ВДО (медиана)', value: median(vdo.map(b => b.ytm)), sub: `медиана по ${vdo.length} вып.`, tone: 'vdo' });
    }

    return list;
  }, [rates, curve, bonds]);

  /* Длину полосы считаем от самого большого значения в списке, а не от
     100 %: все доходности лежат в узком коридоре 13–26 %, и на шкале до
     100 % полосы были бы неразличимы. Общая шкала при этом сохраняется —
     именно она и позволяет сравнивать строки между собой. */
  const top = Math.max(...rows.map(r => (Number.isFinite(r.value) ? r.value : 0)), 1);

  return (
    <Panel title="Где сейчас доходность" pad={false}>
      <div className="rate-bars">
        {rows.map(r => {
          const pct = Number.isFinite(r.value) ? Math.max(1.5, (r.value / top) * 100) : 0;
          return (
            <div className="rate-row" key={r.label}>
              <div className="rate-head">
                <span className="rate-label">{r.label}</span>
                <span className="rate-val mono">{r.value == null ? '—' : nf(r.value, 2) + '%'}</span>
              </div>
              <div className="rate-track" title={r.sub}>
                <div className={'rate-fill t-' + r.tone} style={{ width: pct + '%' }} />
              </div>
            </div>
          );
        })}
      </div>
      <div className="c-3" style={{ fontSize: 10.5, padding: '9px 14px', borderTop: '1px solid var(--border)', lineHeight: 1.6 }}>
        Полоса — та же доходность, только длиной: так строки видно одна относительно другой.
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
                    <td className="mono" style={{ fontWeight: 700 }}>
                      <span className={ytmTone(b.ytm)}>{nf(b.ytm, 2)}%</span>
                      {/* 3-й уровень листинга — повышенный риск: биржа допускает
                          такие бумаги к торгам с меньшими требованиями. */}
                      {b.listLevel === 3 && (
                        <span className="c-r" style={{ fontSize: 9, fontWeight: 700, marginLeft: 4 }}
                          title="3 уровень листинга — повышенный риск">▲</span>
                      )}
                    </td>
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