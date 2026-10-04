import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { nf, pct, dateShort, ytmClass, duration, money, timeLeft, slugify } from '../lib/format';
import { COUPON_LABEL, COUPON_TAG } from '../api/moex';

/* ═══════════════════ Мелкие блоки ═══════════════════ */

export function Loading({ text = 'Загрузка данных с Московской биржи…' }) {
  return <div className="loading">{text}</div>;
}

export function ErrorBox({ error, onRetry }) {
  return (
    <div className="err">
      Не удалось загрузить данные: {String(error)}
      {onRetry && <div style={{ marginTop: 10 }}><button className="btn" onClick={onRetry}>Повторить</button></div>}
    </div>
  );
}

/* color — цвет значения из палитры выпуска (lib/kpiColors): у оригинала цвет
   плитки говорит, о чём цифра. Если у значения есть своя пометка (cls,
   например «биржа отдаёт недостоверное значение»), она важнее палитры:
   предупреждение нельзя перекрасить в спокойный синий. */
export function Kpi({ label, value, sub, cls = '', color }) {
  return (
    <div className="kpi-card">
      <div className="kpi-l">{label}</div>
      <div className={'kpi-v ' + cls} style={color && !cls ? { color } : undefined}>{value}</div>
      {sub && <div className="kpi-s">{sub}</div>}
    </div>
  );
}

export function Panel({ title, right, children, pad = true, style }) {
  return (
    <section className="panel" style={style}>
      {title && (
        <div className="panel-h">
          <div className="panel-t">{title}</div>
          {right}
        </div>
      )}
      <div className={pad ? 'panel-b' : ''}>{children}</div>
    </section>
  );
}

export function CouponTag({ kind }) {
  return <span className={'tag ' + (COUPON_TAG[kind] || '')}>{COUPON_LABEL[kind] || '—'}</span>;
}

export function LevelTag({ level }) {
  const cls = level === 1 ? 'g' : level === 2 ? 'a' : 'r';
  return <span className={'tag ' + cls}>{level ?? '—'}</span>;
}

/* ── рейтинг ─────────────────────────────────────────────────────── *
 *
 * Значок рейтинга из таблицы котировок smart-lab: AAA…D. Агентства и
 * даты присвоения в источнике нет, поэтому это ориентир, а не выписка
 * из отчёта агентства — так и написано в подсказке.
 *
 * Цвет по месту на шкале (1 — D, 20 — AAA): инвестиционный уровень
 * (BBB- и выше) зелёный, середина синяя, спекулятивный — янтарный,
 * преддефолтные и дефолт — красный.
 */
export const RATING_HINT = 'Рейтинг по данным таблицы котировок smart-lab.ru. '
  + 'Агентство и дата присвоения в источнике не указаны, рейтинг относится к эмитенту '
  + 'и потому одинаков у всех его выпусков. Это ориентир, а не выписка из отчёта '
  + 'рейтингового агентства. Прочерк — эмитента нет в источнике: рейтинг есть '
  + 'примерно у 70 % бумаг нашего списка.';

/* Подсказка для рейтинга, который взят по эмитенту: у самой бумаги значка
   в источнике нет, значение — из других выпусков того же эмитента. */
export const RATING_ISSUER_HINT = 'Рейтинг эмитента по данным smart-lab.ru: '
  + 'этот выпуск в таблице источника показан без рейтинга, значение взято по другим '
  + 'выпускам того же эмитента. Агентство и дата присвоения в источнике не указаны. '
  + 'Пунктир под значком означает именно такой случай.';

function ratingClass(code) {
  if (code == null) return '';
  if (code >= 17) return 'g';
  if (code >= 13) return 'b';
  if (code >= 10) return 'a';
  return 'r';
}

export function RatingTag({ rating, code, own = true, title }) {
  if (!rating) return <span className="c-3" title={RATING_HINT}>—</span>;
  const hint = title || (own ? RATING_HINT : RATING_ISSUER_HINT);
  /* Пунктир — единственное отличие «по эмитенту» от «значок у самой бумаги»:
     подчёркивать надо, иначе мы бы выдавали одно за другое. */
  const style = own ? undefined : { borderBottom: '1px dotted currentColor' };
  return <span className={'tag ' + ratingClass(code)} style={style} title={hint}>{rating}</span>;
}

/* «1 раз», «2 раза», «12 раз». Число выплат — это счётчик, а не измерение,
   и запись «1,0» или «2,0 раз в год» читается как ошибка округления. */
export function timesWord(n) {
  const r = Math.round(n);
  const tail = r % 100, last = r % 10;
  const word = (tail >= 11 && tail <= 14) ? 'раз' : last === 1 ? 'раз' : last >= 2 && last <= 4 ? 'раза' : 'раз';
  return r + ' ' + word;
}

export function YtmCell({ b }) {
  if (b.ytm == null) {
    return <span className="c-3" title="Доходность недоступна или аномальна">{b.ytmRaw != null ? 'н/д' : '—'}</span>;
  }
  return (
    <span className={ytmClass(b.ytm)}>
      {nf(b.ytm, 2)}%
      {b.yieldDateType === 'OFFER' && <span className="c-3" style={{ fontSize: 9, marginLeft: 2 }}>оф</span>}
    </span>
  );
}

/* ═══════════════════ Таблица облигаций ═══════════════════ */

const COLS = {
  name: {
    label: 'Выпуск', sort: b => b.shortname,
    /* Подстрока как у bondradar.pro: категория и уровень листинга.
       Раньше здесь стоял ISIN — он и так виден в карточке выпуска,
       а в списке из 3000 строк только мешал читать название. */
    cell: b => (
      <>
        <div style={{ fontWeight: 600 }}>
          {b.shortname}
          {/* Пометка биржевого допуска. Без неё строка выпуска, который
              доступен только квалифицированным, выглядит как обычная бумага. */}
          {b.isQualified === true && (
            <span
              className="tag a"
              style={{ marginLeft: 6, fontSize: 10 }}
              title="Выпуск предназначен только для квалифицированных инвесторов. Окончательно допуск определяет ваш брокер."
            >
              квал
            </span>
          )}
        </div>
        <div className="c-3" style={{ fontSize: 10 }}>
          {b.isOfz ? 'гос · ОФЗ' : b.isSubfederal ? 'гос · регион' : 'корп'}
          {b.listLevel ? ` · ${b.listLevel} ур.` : ''}
          {b.isCurrency && b.currency ? ` · ${b.currency}` : ''}
        </div>
      </>
    ),
  },
  couponsPerYear: {
    label: 'Купонов/год', sort: b => (b.couponPeriod ? 365 / b.couponPeriod : -1),
    cell: b => {
      const n = b.couponPeriod ? Math.round(365 / b.couponPeriod) : null;
      if (!n) return <span className="c-3">—</span>;
      /* 1 раз, 2–4 раза, 5+ раз; 11–14 — всегда «раз». */
      const tail = n % 100;
      const last = n % 10;
      const word = (tail >= 11 && tail <= 14) ? 'раз' : last === 1 ? 'раз' : last >= 2 && last <= 4 ? 'раза' : 'раз';
      return <span className="c-2">{n} {word}</span>;
    },
  },
  ytm: { label: 'YTM', sort: b => b.ytm ?? -999, cell: b => <YtmCell b={b} /> },
  coupon: {
    label: 'Купон', sort: b => b.couponPercent ?? -999,
    cell: b => (b.couponPercent == null ? <span className="c-3">—</span> : nf(b.couponPercent, 2) + '%'),
  },
  kind: { label: 'Тип', nosort: true, cell: b => <CouponTag kind={b.couponKind} /> },
  price: {
    label: 'Цена', sort: b => b.price ?? -999,
    cell: b => <span className="mono">{b.price == null ? '—' : nf(b.price, 2)}</span>,
  },
  nkd: {
    label: 'НКД', sort: b => b.nkd ?? -999,
    cell: b => <span className="mono c-2">{b.nkd == null ? '—' : nf(b.nkd, 2)}</span>,
  },
  duration: {
    label: 'Дюрация', sort: b => b.durationDays ?? 1e9,
    cell: b => <span className="c-2">{duration(b.durationDays)}</span>,
  },
  mat: {
    label: 'Погашение', sort: b => b.matDate || '9999',
    cell: b => <span className="mono" style={{ fontSize: 11 }}>{dateShort(b.matDate)}</span>,
  },
  offer: {
    label: 'Оферта', sort: b => b.offerDate || '9999',
    cell: b => (b.offerDate
      ? <span className="mono" style={{ fontSize: 11 }}>{dateShort(b.offerDate)}</span>
      : <span className="c-3">—</span>),
  },
  level: { label: 'Лист.', sort: b => b.listLevel ?? 9, cell: b => <LevelTag level={b.listLevel} /> },
  rating: {
    /* Сортируем по коду шкалы, а не по значку: строками «AAA» меньше,
       чем «A-», и порядок получился бы обратный желаемому. */
    label: 'Рейтинг',
    sort: b => b.ratingCode ?? -1,
    hint: RATING_HINT,
    cell: b => <RatingTag rating={b.rating} code={b.ratingCode} own={b.ratingOwn} />,
  },
  turnover: {
    label: 'Оборот', sort: b => b.turnover || 0,
    cell: b => <span className="mono c-2" style={{ fontSize: 11 }}>{b.turnover ? money(b.turnover) : '—'}</span>,
  },
  currency: { label: 'Вал.', nosort: true, cell: b => (b.isCurrency ? <span className="tag a">{b.currency}</span> : <span className="c-3">RUB</span>) },
  zspread: {
    /* MOEX отдаёт ZSPREAD уже в процентных пунктах (46.22 = 46,22 %),
       а не в базисных. Раньше здесь было деление на 100 — колонка
       показала бы 0,46 % вместо 46,22 %. В таблицы она не выводилась,
       поэтому ошибка не проявлялась. */
    label: 'Z-спред', sort: b => b.zSpread ?? -999,
    hint: 'Премия к безрисковой кривой ОФЗ, в процентных пунктах: сколько бумага платит сверх государственной с той же дюрацией. У ОФЗ около нуля, у корпоратов тем больше, чем выше риск. Считает сама биржа; показываем только там, где её доходность достоверна — примерно у половины выпусков.',
    cell: b => (b.zSpread == null
      ? <span className="c-3">—</span>
      : <span className={'mono ' + (b.zSpread > 5 ? 'c-r' : b.zSpread > 0 ? 'c-g' : 'c-3')}>{nf(b.zSpread, 2)}%</span>),
  },
  currentYield: {
    label: 'Куп. дох.', sort: b => b.currentYield ?? -999,
    cell: b => (b.currentYield == null
      ? <span className="c-3">—</span>
      : <span className="mono">{nf(b.currentYield, 2)}%</span>),
  },
  lotCost: {
    label: 'Стоимость лота, ₽', sort: b => b._lotCost ?? -999,
    cell: b => {
      const c = b._lotCost;
      return c != null ? <span className="mono">{nf(c, 0)}</span> : <span className="c-3">—</span>;
    },
  },
};

export const DEFAULT_COLS = ['name', 'rating', 'ytm', 'coupon', 'price', 'nkd', 'duration', 'mat', 'offer', 'level', 'turnover'];

export function BondTable({ bonds, cols = DEFAULT_COLS, limit, linkTo = true, initialSort = 'ytm', onRow }) {
  const [sortKey, setSortKey] = useState(initialSort);
  const [asc, setAsc] = useState(false);

  const sorted = useMemo(() => {
    const col = COLS[sortKey];
    if (!col?.sort) return bonds;
    const arr = [...bonds].sort((a, b) => {
      const av = col.sort(a), bv = col.sort(b);
      if (av == null) return 1; if (bv == null) return -1;
      if (typeof av === 'string' || typeof bv === 'string') return String(av).localeCompare(String(bv), 'ru');
      return av - bv;
    });
    return asc ? arr : arr.reverse();
  }, [bonds, sortKey, asc]);

  const rows = limit ? sorted.slice(0, limit) : sorted;

  function click(k) {
    if (!COLS[k]?.sort) return;
    if (k === sortKey) setAsc(a => !a);
    else { setSortKey(k); setAsc(false); }
  }

  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            {cols.map(k => (
              <th
                key={k}
                className={COLS[k]?.nosort ? 'nosort' : ''}
                onClick={() => click(k)}
                title={COLS[k]?.hint}
              >
                {COLS[k]?.label || k}
                {sortKey === k && (asc ? ' ↑' : ' ↓')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(b => (
            <tr
              key={b.secid}
              /* onRow — быстрый просмотр окном, как в оригинале: клик по
                 строке списка открывает попап, а не уводит на страницу.
                 Без onRow — прежний переход на карточку выпуска. */
              onClick={() => {
                if (onRow) onRow(b);
                else if (linkTo) location.hash = '#/bond/' + b.isin;
              }}
              title={onRow ? 'Открыть карточку выпуска окном' : undefined}
            >
              {cols.map(k => (
                <td key={k}>
                  {k === 'name' && linkTo && !onRow
                    ? <Link to={'/bond/' + b.isin} onClick={e => e.stopPropagation()}>{COLS[k].cell(b)}</Link>
                    : COLS[k].cell(b)}
                </td>
              ))}
            </tr>
          ))}
          {!rows.length && (
            <tr><td colSpan={cols.length} className="empty">Ничего не найдено</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ═══════════════════ Пагинация ═══════════════════ */

export function Pager({ page, pages, onChange, total, perPage }) {
  if (pages <= 1) return null;
  const nums = [];
  const push = n => nums.push(n);
  push(1);
  for (let i = page - 2; i <= page + 2; i++) if (i > 1 && i < pages) push(i);
  if (pages > 1) push(pages);

  const uniq = [...new Set(nums)].sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  uniq.forEach(n => {
    if (n - prev > 1) out.push('…' + n);
    out.push(n);
    prev = n;
  });

  return (
    <div className="pager">
      <button onClick={() => onChange(1)} disabled={page === 1}>«</button>
      <button onClick={() => onChange(page - 1)} disabled={page === 1}>‹</button>
      {out.map(n => typeof n === 'string'
        ? <span key={n} className="info">{n.slice(1)}</span>
        : <button key={n} className={n === page ? 'on' : ''} onClick={() => onChange(n)}>{n}</button>)}
      <button onClick={() => onChange(page + 1)} disabled={page === pages}>›</button>
      <button onClick={() => onChange(pages)} disabled={page === pages}>»</button>
      <span className="info">стр. {page} из {pages} · {total} шт.</span>
    </div>
  );
}

/* ═══════════════════ Карточка-ссылка эмитента ═══════════════════ */

export function IssuerLink({ bond, children }) {
  if (!bond?.issuerKey) return <span>{children}</span>;
  return <Link to={'/issuer/' + bond.issuerKey}>{children}</Link>;
}

export { money, nf, pct, dateShort, duration, timeLeft, slugify };