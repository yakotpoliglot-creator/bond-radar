import { useState, useEffect, useMemo, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { fetchBonds, fetchRatings, COLLECTIONS, COUPON_LABEL, daysUntil } from '../api/moex';
import { BondTable, Pager, Loading, ErrorBox, Panel, Kpi, RATING_HINT } from '../components/ui';
import BondPopup from '../components/BondPopup';
import { nf, dateTime } from '../lib/format';
import { useFavorites } from '../lib/store';

/* ═══════════════════════════════════════════════════════════════════
   Скринер облигаций — все выпуски MOEX: TQCB (корпоративные) + TQOB (ОФЗ), ≈3095 шт.
   Данные: fetchBonds() → iss.moex.com. Сортировка — внутри BondTable.
   ═══════════════════════════════════════════════════════════════════ */

const PER_PAGE = 50;

/* Корзины по сроку до погашения: [днейОт, днейДо] */
const MATURITY = {
  all: null,
  lt1: [0, 365],        // до 1 года
  '1-3': [365, 1095],   // 1–3 года
  '3-5': [1095, 1825],  // 3–5 лет
  '5+': [1825, Infinity],
};

const MATURITY_LABEL = {
  all: 'Все',
  lt1: 'до 1 года',
  '1-3': '1–3 года',
  '3-5': '3–5 лет',
  '5+': '5+ лет',
};

/* Рейтинг «не ниже»: место на шкале smart-lab (1 — D, 20 — AAA).
   Номер в значении — код шкалы, он же в ratings.json. */
const RATING_MIN = {
  all: null,
  inv: 11,      // инвестиционный уровень: BBB- и выше
  a: 14,        // A- и выше
  aa: 17,       // AA- и выше
  aaa: 20,      // только AAA
};

const RATING_LABEL = {
  all: 'Любой',
  inv: 'BBB- и выше',
  a: 'A- и выше',
  aa: 'AA- и выше',
  aaa: 'Только AAA',
};

/* Рейтинг «не выше»: вторая половина той же шкалы (1 — D, 20 — AAA).
   Нужна целям вроде «рискнуть», где интересны как раз бумаги пониже
   качеством. Коды идут по шагу шкалы: BBB+ = 13, BB+ = 10, B+ = 7. */
const RATING_MAX = {
  all: null,
  bbb: 13,      // BBB+ и ниже
  bb: 10,       // BB+ и ниже
  b: 7,         // B+ и ниже
};

const RATING_MAX_LABEL = {
  all: 'Любой',
  bbb: 'не выше BBB+',
  bb: 'не выше BB+',
  b: 'не выше B+',
};

/* ── Цели: «что вы хотите сделать с деньгами?» ─────────────────────
   Взято по образцу платного скринера (bondradar.pro): вместо того чтобы
   самому переводить свою задачу в рейтинг, срок и частоту купона,
   человек выбирает цель — а мы подставляем под неё готовый набор уже
   существующих фильтров. Новой логики отбора здесь нет: только
   предустановки, и они подписаны прямо на карточке цели, чтобы было
   видно, по каким условиям отобраны бумаги.

   Цвет и иконка — тоже с оригинала: там у каждой цели свой цветовой токен
   (щит у «сохранить», график у «заработать», календарь у дохода, часы у
   «припарковать», треугольник у «рискнуть», волны у флоатеров). Это не
   украшательство: по цвету цель находится глазами быстрее, чем по тексту,
   а заказчик смотрит сайт в очках. Иконки 16×16, обводка 1.8 — как в
   оригинале; у нас они чуть крупнее (18px). */
const GOALS = [
  { slug: 'sohranit', title: 'Сохранить', desc: 'надёжно, AAA–AA, 1–3 года', color: 'blue',
    icon: <><path d="M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z" /><path d="M5.8 8l1.6 1.6L10.4 6.6" /></>,
    preset: { rating: 'aa', ratingMax: 'all', maturity: '1-3', freq: 'all', kind: 'all' } },
  { slug: 'zarabotat', title: 'Заработать', desc: 'выше рынка, A и выше, 3–5 лет', color: 'green',
    icon: <path d="M2 12l4-4 3 3 5-6" />,
    preset: { rating: 'a', ratingMax: 'all', maturity: '3-5', freq: 'all', kind: 'all' } },
  { slug: 'dohod', title: 'Получать доход', desc: 'каждый месяц, рейтинг BBB- и выше', color: 'amber',
    icon: <><rect x="3" y="4" width="10" height="9" rx="2" /><path d="M5 4V2m6 2V2M3 7h10" /></>,
    preset: { rating: 'inv', ratingMax: 'all', maturity: 'all', freq: 'monthly', kind: 'all' } },
  { slug: 'priparkovat', title: 'Припарковать', desc: 'до 1 года, только AAA', color: 'purple',
    icon: <><circle cx="8" cy="8" r="5.5" /><path d="M8 5.5V8l1.5 1.5" /></>,
    preset: { rating: 'aaa', ratingMax: 'all', maturity: 'lt1', freq: 'all', kind: 'all' } },
  { slug: 'risknut', title: 'Рискнуть', desc: 'высокая доходность, BBB+ и ниже', color: 'red',
    icon: <><path d="M8 2l6 12H2L8 2z" /><path d="M8 7v3m0 2v.5" /></>,
    preset: { rating: 'all', ratingMax: 'bbb', maturity: 'all', freq: 'all', kind: 'all' } },
  { slug: 'floatery', title: 'Флоатеры', desc: 'плавающий купон, рейтинг A и выше', color: 'cyan',
    icon: <path d="M2 6q2-3 4 0t4 0 4 0M2 11q2-3 4 0t4 0 4 0" />,
    preset: { rating: 'a', ratingMax: 'all', maturity: 'all', freq: 'all', kind: 'float' } },
];

/* Значения фильтров по умолчанию (hideAnomaly включён по требованию).
   rating: 'aaa' — по просьбе заказчика скринер по умолчанию показывает
   только бумаги с рейтингом AAA: это самый короткий путь к надёжному
   списку. Ограничение видно в подписи и снимается кнопкой «Весь рынок»,
   чтобы его нельзя было принять за «на рынке больше ничего нет». */
const DEFAULT_FILTERS = {
  search: '',
  ytmMin: '',
  ytmMax: '',
  kind: 'all',
  level: 'all',
  rating: 'aaa',       // рейтинг не ниже (данные smart-lab); AAA по умолчанию
  ratingMax: 'all',    // рейтинг не выше — нужен целям вроде «рискнуть»
  maturity: 'all',
  turnoverMin: '',
  hideAnomaly: true,
  budget: '',          // бюджет — у меня есть N ₽
  /* ── добавлено по образцу платного скринера ═─────────────────────
     Всё это Мосбиржа отдаёт бесплатно, просто мы раньше не выводили. */
  zMin: '',            // Z-спред от, п.п. — премия к кривой ОФЗ
  zMax: '',
  durMin: '',          // дюрация от, лет — чувствительность к ставке
  durMax: '',
  priceMin: '',        // цена от, % номинала
  priceMax: '',
  curMin: '',          // купонная доходность сейчас, %
  curMax: '',
  freq: 'all',         // частота купона
  currency: 'all',     // валюта номинала
  access: 'all',       // допуск: all — все, any — для всех, qual — только для квалов
  onlyOnePerIssuer: false,  // не больше одного выпуска эмитента
  soonMaturity: false,      // погашение в ближайший год
  noAmort: false,           // без амортизации
  noOffer: false,           // без оферты
};

/* Частота купона по периоду в днях. Границы взяты с запасом:
   биржа отдаёт 30 / 91 / 182 / 365, но бывают выплаты по календарю.
   Заполнено у всех выпусков, однако у 334 дисконтных период равен 0
   (купона нет вовсе), а у ~247 биржа отдаёт мусор вроде 6268 — такие
   в корзины не попадают и видны только при «Любой». */
const FREQ_RANGES = {
  monthly: [25, 45],
  quarterly: [80, 100],
  semi: [170, 200],
  annual: [340, 400],
};

const FREQ_LABEL = {
  all: 'Любая',
  monthly: 'Ежемесячно',
  quarterly: 'Раз в квартал',
  semi: 'Раз в полгода',
  annual: 'Раз в год',
};

/* Колонки скринера — шире, чем в подборках: показываем те метрики,
   по которым фильтруем, чтобы результат можно было проверить глазами. */
const SCREENER_COLS = [
  'name', 'rating', 'ytm', 'zspread', 'coupon', 'currentYield',
  'price', 'duration', 'mat', 'offer', 'couponsPerYear', 'level', 'turnover',
];

/* Диапазонный фильтр: пустое поле — не ограничивает.
   Значение null (нет данных) диапазон не проходит — иначе «от 10»
   пропускало бы бумаги, про которые мы просто ничего не знаем. */
function inRange(v, minS, maxS) {
  const min = minS === '' ? null : +minS;
  const max = maxS === '' ? null : +maxS;
  const hasMin = min != null && !Number.isNaN(min);
  const hasMax = max != null && !Number.isNaN(max);
  if (!hasMin && !hasMax) return true;
  if (v == null) return false;
  if (hasMin && v < min) return false;
  if (hasMax && v > max) return false;
  return true;
}

/* ── Проверка одной бумаги по всем фильтрам (кроме аномальной доходности) ── */
function matchFilters(b, f) {
  // Поиск по названию / ISIN / SECID
  if (f.search) {
    const q = f.search.trim().toLowerCase();
    if (q) {
      const hit =
        (b.shortname || '').toLowerCase().includes(q) ||
        (b.name || '').toLowerCase().includes(q) ||
        (b.isin || '').toLowerCase().includes(q) ||
        (b.secid || '').toLowerCase().includes(q);
      if (!hit) return false;
    }
  }

  // Доходность к погашению: бумаги с недостоверной доходностью диапазон не проходят
  if (!inRange(b.ytm, f.ytmMin, f.ytmMax)) return false;

  // Z-спред — премия к кривой ОФЗ, процентные пункты
  if (!inRange(b.zSpread, f.zMin, f.zMax)) return false;

  // Дюрация в годах (у нас хранится в днях)
  const durYears = b.durationDays != null ? b.durationDays / 365 : null;
  if (!inRange(durYears, f.durMin, f.durMax)) return false;

  // Цена, % номинала
  if (!inRange(b.price, f.priceMin, f.priceMax)) return false;

  // Купонная доходность сейчас
  if (!inRange(b.currentYield, f.curMin, f.curMax)) return false;

  // Тип купона
  if (f.kind !== 'all' && b.couponKind !== f.kind) return false;

  // Уровень листинга
  if (f.level !== 'all' && String(b.listLevel) !== f.level) return false;

  /* Рейтинг «не ниже»: сравниваем по месту на шкале (1 — D, 20 — AAA).
     Бумага без рейтинга условие не проходит: про неё мы просто ничего
     не знаем, и пропускать её значило бы обещать то, чего нет. */
  const rMin = RATING_MIN[f.rating];
  if (rMin != null && !(b.ratingCode != null && b.ratingCode >= rMin)) return false;

  /* Рейтинг «не выше» — вторая половина шкалы. Как и в случае «не ниже»,
     бумага без рейтинга условие не проходит: иначе цель «рискнуть»
     набивалась бы бумагами, о качестве которых мы ничего не знаем. */
  const rMax = RATING_MAX[f.ratingMax];
  if (rMax != null && !(b.ratingCode != null && b.ratingCode <= rMax)) return false;

  // Бюджет: «у меня есть N ₽». Стоимость покупки одного лота
  // = (цена / 100 × номинал + НКД) × размер лота.
  // Считаем по lotCostRub: у валютной бумаги номинал в валюте, а НКД
  // биржа отдаёт в рублях — без пересчёта по курсу фильтр врал бы
  // (см. комментарий у withFx в api/moex.js).
  if (f.budget) {
    const bgt = +f.budget;
    const cost = b.lotCostRub ?? (b.price != null && b.lotSize != null
      ? (b.price / 100 * (b.faceValue || 1000) + (b.nkd || 0)) * b.lotSize
      : null);
    if (bgt > 0 && cost != null && cost > bgt) return false;
  }
  const range = MATURITY[f.maturity];
  if (range) {
    if (!b.matDate) return false;
    const d = daysUntil(b.matDate);
    if (!(d > range[0] && d <= range[1])) return false;
  }

  // Оборот от, ₽ — отсекаем неликвид
  if (f.turnoverMin !== '') {
    const t = +f.turnoverMin;
    if (!Number.isNaN(t) && (b.turnover || 0) < t) return false;
  }

  // Частота купона
  const fr = FREQ_RANGES[f.freq];
  if (fr) {
    if (b.couponPeriod == null) return false;
    if (!(b.couponPeriod >= fr[0] && b.couponPeriod <= fr[1])) return false;
  }

  /* Валюта номинала. Рублёвый выпуск — не «валютный»: у него isCurrency
     false, поэтому одним сравнением не обойтись, иначе «Рубль» давал бы
     пустой список. */
  if (f.currency !== 'all') {
    if (f.currency === 'RUB') {
      if (b.isCurrency) return false;
    } else if (!b.isCurrency || b.currency !== f.currency) {
      return false;
    }
  }

  /* Допуск. Биржевой признак: 1 — выпуск только для квалифицированных,
     0 — для всех, null — биржа его не отдала (робот ещё не собрал). null не
     проходит ни один из точных вариантов: обещать «доступна всем» про
     непроверенную бумагу нельзя. */
  if (f.access === 'any' && b.isQualified !== false) return false;
  if (f.access === 'qual' && b.isQualified !== true) return false;

  // Погашение в ближайший год
  if (f.soonMaturity) {
    if (!b.matDate) return false;
    const d = daysUntil(b.matDate);
    if (!(d > 0 && d <= 365)) return false;
  }

  // Без амортизации — номинал гасится целиком в конце
  if (f.noAmort && b.isAmort) return false;

  // Без оферты — досрочного выкупа нет, доходность считается к погашению
  if (f.noOffer && b.hasOffer) return false;

  return true;
}

/* Не больше одного выпуска эмитента.
   Оставляем самый ликвидный: по нему реальнее всего купить и продать,
   а доходность остальных выпусков того же эмитента почти такая же. */
function onePerIssuer(list) {
  const best = new Map();
  for (const b of list) {
    const key = b.issuerKey || b.isin || b.secid;
    const cur = best.get(key);
    if (!cur || (b.turnover || 0) > (cur.turnover || 0)) best.set(key, b);
  }
  return [...best.values()];
}

/* Пара полей «от / до» для числового диапазона.
   Пустое поле = без ограничения с этой стороны. */
function RangePair({ label, unit, from, to, onFrom, onTo, step = '0.1', width = 76 }) {
  return (
    <div className="fg">
      <label>{label}{unit ? `, ${unit}` : ''}</label>
      <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
        <input
          className="inp" style={{ width }} type="number" step={step} placeholder="от"
          value={from} onChange={e => onFrom(e.target.value)}
        />
        <span className="c-3" style={{ fontSize: 11 }}>—</span>
        <input
          className="inp" style={{ width }} type="number" step={step} placeholder="до"
          value={to} onChange={e => onTo(e.target.value)}
        />
      </div>
    </div>
  );
}

/* Галочка-фильтр с подсказкой. */
function CheckFilter({ label, title, checked, onChange }) {
  return (
    <div className="fg">
      <label style={{ minHeight: 14 }}>&nbsp;</label>
      <label
        title={title}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, minHeight: 30,
          fontSize: 12, fontWeight: 400, textTransform: 'none',
          letterSpacing: 0, color: 'var(--text2)', cursor: 'pointer',
        }}
      >
        <input
          type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)}
          style={{ accentColor: 'var(--accent)', width: 14, height: 14 }}
        />
        {label}
      </label>
    </div>
  );
}

export default function Screener() {
  const loc = useLocation();
  const nav = useNavigate();
  const { list: favList } = useFavorites();

  const [bonds, setBonds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [onlyFav, setOnlyFav] = useState(false);   // доп. фильтр «только избранное»
  const [page, setPage] = useState(1);
  const [popup, setPopup] = useState(null);        // быстрый просмотр бумаги окном

  /* Сколько выпусков с уже проверенным допуском: признак собирает робот
     (public/qual.json). Если файла ещё нет или он неполный, честно скажем,
     у скольких выпусков биржа признак не отдала. */
  const qualKnown = bonds.filter(b => b.isQualified != null).length;
  /* Режим отбора: свои фильтры или цель. В режиме цели ручные фильтры
     скрыты — как на образце: человек видит ровно те условия, которые
     задала цель, и не смешивает их со своими прошлыми экспериментами. */
  const [mode, setMode] = useState('own');
  const [goal, setGoal] = useState(null);          // slug выбранной цели

  /* ── загрузка данных MOEX ── */
  const load = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchBonds({ force });
      setBonds(data);
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(false); }, [load]);

  /* ── подборка из hash-роутинга: #/screener?cat=<slug> ── */
  const catSlug = new URLSearchParams(loc.search).get('cat');
  const collection = useMemo(
    () => COLLECTIONS.find(c => c.slug === catSlug) || null,
    [catSlug],
  );

  /* ── поиск из ссылки: #/screener?q=ВТБ ────────────────────────────
     Приходит с карточки акции («Найти облигации этого эмитента»).
     Раньше эта кнопка вела просто на /screener, и обещание не
     выполнялось: человек видел все 3000 выпусков и пустое поле поиска.
     Заполняем поле один раз на каждый новый q — дальше пользователь
     правит его сам, и перебивать его ввод нельзя. */
  const qParam = new URLSearchParams(loc.search).get('q');

  /* ── когда собраны рейтинги ──────────────────────────────────────
     Рейтинги приходят файлом от робота, а не с биржи. Дату сбора
     показываем прямо на странице: если робот однажды перестанет
     обновлять данные, это будет видно, а не останется незамеченным. */
  const [ratingInfo, setRatingInfo] = useState(null);
  useEffect(() => { fetchRatings().then(setRatingInfo); }, []);

  /* ── фильтрация ── */
  const { rows, hiddenAnomaly } = useMemo(() => {
    const out = [];
    let hidden = 0;
    for (const b of bonds) {
      // фильтр подборки
      if (collection && !collection.test(b)) continue;
      // только избранное
      if (onlyFav && !favList.includes(b.isin)) continue;
      // остальные фильтры
      if (!matchFilters(b, filters)) continue;
      // аномальная доходность (ytm == null при «битом» ytmRaw)
      if (b.ytm == null) {
        if (filters.hideAnomaly) { hidden++; continue; }
      }
      // стоимость лота для колонки «Можно купить» при заданном бюджете.
      // lotCostRub уже учитывает курс для валютных бумаг.
      b._lotCost = b.lotCostRub ?? ((b.price != null && b.lotSize != null)
        ? (b.price / 100 * (b.faceValue || 1000) + (b.nkd || 0)) * b.lotSize
        : null);
      out.push(b);
    }
    // «не больше одного выпуска эмитента» применяем последним —
    // сначала отсеиваем по качеству бумаги, потом выбираем лучшую у эмитента
    const final = filters.onlyOnePerIssuer ? onePerIssuer(out) : out;
    return { rows: final, hiddenAnomaly: hidden };
  }, [bonds, filters, collection, onlyFav, favList]);

  // при смене фильтров/подборки возвращаемся на первую страницу
  useEffect(() => { setPage(1); }, [filters, collection, onlyFav]);

  /* ── Сколько выпусков даёт каждая цель ────────────────────────────
     Считаем по уже загруженному списку, без запросов к бирже. Число на
     карточке цели честнее описания: сразу видно, что «Припарковать» —
     это единицы бумаг, а «Рискнуть» — сотни, и что выбор ограничен не
     только целью, но и тем, у кого вообще есть рейтинг. */
  const goalCounts = useMemo(() => {
    const out = {};
    for (const g of GOALS) {
      const f = { ...DEFAULT_FILTERS, ...g.preset };
      let n = 0;
      for (const b of bonds) {
        if (collection && !collection.test(b)) continue;
        if (onlyFav && !favList.includes(b.isin)) continue;
        if (!matchFilters(b, f)) continue;
        if (b.ytm == null && f.hideAnomaly) continue;
        n++;
      }
      out[g.slug] = n;
    }
    return out;
  }, [bonds, collection, onlyFav, favList]);

  const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  const cur = Math.min(page, pages);
  const slice = useMemo(
    () => rows.slice((cur - 1) * PER_PAGE, cur * PER_PAGE),
    [rows, cur],
  );

  const avgYtm = useMemo(() => {
    const vals = rows.map(b => b.ytm).filter(v => v != null);
    if (!vals.length) return null;
    return vals.reduce((s, v) => s + v, 0) / vals.length;
  }, [rows]);

  const set = patch => setFilters(f => ({ ...f, ...patch }));
  /* Сброс возвращает к тем значениям, с которыми страница открылась.
     AAA по умолчанию — решение заказчика, поэтому и после сброса оно
     остаётся: иначе кнопка «Сбросить» тихо отменяла бы договорённость. */
  const reset = () => { setFilters(DEFAULT_FILTERS); setOnlyFav(false); setGoal(null); setPage(1); };

  /* ── Применение цели ────────────────────────────────────────────
     Цель задаёт свои измерения целиком (рейтинг, срок, частоту купона),
     поэтому остальные условия берём из DEFAULT_FILTERS: иначе выбор цели
     после ручных экспериментов оставлял бы чужие ограничения. Поиск
     сохраняем — его человек вводил сам. */
  const goalBySlug = slug => GOALS.find(g => g.slug === slug) || null;
  const applyGoal = g => {
    setGoal(g.slug);
    setFilters({ ...DEFAULT_FILTERS, search: filters.search, ...g.preset });
    setPage(1);
  };

  /* Подставляем поиск из адреса (пришёл с карточки акции). Эффект стоит
     здесь, а не рядом с чтением qParam: set объявлен выше только тут. */
  useEffect(() => {
    if (qParam) { set({ search: qParam }); setPage(1); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qParam]);

  /* ── Выгрузка отфильтрованного списка в CSV ──
     Разделитель «;» и BOM — чтобы Excel в русской локали открыл файл
     сразу, без танцев с кодировкой. Числа отдаём с точкой: Excel поймёт. */
  const exportCsv = () => {
    const cols = [
      ['Выпуск', b => b.shortname],
      ['ISIN', b => b.isin],
      ['Рейтинг (smart-lab)', b => b.rating],
      ['Цена, %', b => b.price],
      ['YTM, %', b => b.ytm],
      ['Z-спред, п.п.', b => b.zSpread],
      ['Купон, %', b => b.couponPercent],
      ['Куп. доходность, %', b => b.currentYield],
      ['Дюрация, лет', b => (b.durationDays == null ? null : (b.durationDays / 365).toFixed(2))],
      ['Оферта', b => b.offerDate],
      ['Погашение', b => b.matDate],
      ['Листинг', b => b.listLevel],
      ['Оборот, ₽', b => b.turnover],
    ];
    const esc = v => {
      if (v == null) return '';
      const s = String(v);
      return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [cols.map(c => esc(c[0])).join(';')];
    for (const b of rows) lines.push(cols.map(c => esc(c[1](b))).join(';'));
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bond-radar-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (loading && !bonds.length) return <Loading />;
  if (error && !bonds.length) return <ErrorBox error={error} onRetry={() => load(true)} />;

  return (
    <div>
      {/* ── Заголовок: честно показываем, сколько записей прошло фильтр ── */}
      <div className="page-h">
        <div className="page-t">☰ Скринер облигаций</div>
        <div className="page-s">
          показано <b>{rows.length}</b> из <b>{bonds.length}</b> выпусков
          {collection && <> · подборка «{collection.title}»</>}
          <button
            className="btn btn-sm"
            style={{ marginLeft: 10 }}
            onClick={() => load(true)}
            disabled={loading}
          >
            {loading ? 'Обновление…' : '↻ Обновить'}
          </button>
        </div>
      </div>

      {/* ── Плашка активной подборки из ссылки ── */}
      {catSlug && (
        collection ? (
          <div className="filters" style={{ marginBottom: 12, alignItems: 'center' }}>
            <span className="tag b" style={{ padding: '5px 10px', fontSize: 11.5 }}>
              Подборка: {collection.title}
            </span>
            <button className="btn btn-sm" onClick={() => nav('/screener')}>Снять</button>
          </div>
        ) : (
          <div className="err" style={{ textAlign: 'left', padding: '8px 0 12px' }}>
            Подборка «{catSlug}» не найдена — фильтр по ней не применён.
            <button className="btn btn-sm" style={{ marginLeft: 10 }} onClick={() => nav('/collections')}>
              Все подборки
            </button>
          </div>
        )
      )}

      {/* ── Режим отбора: свои фильтры или цель ─────────────────────
          Как на образце: «по цели» — тот же скринер, но условия задаёт
          цель, а ручные фильтры скрыты, чтобы они не спорили друг с
          другом незаметно для человека. */}
      <div className="mode-sw">
        <button
          type="button"
          className={'chip' + (mode === 'own' ? ' on' : '')}
          onClick={() => { setMode('own'); setGoal(null); }}
        >
          Свои фильтры
        </button>
        <button
          type="button"
          className={'chip' + (mode === 'goal' ? ' on' : '')}
          onClick={() => setMode('goal')}
        >
          По цели
        </button>
      </div>

      {mode === 'goal' && (
        <Panel
          title="Что вы хотите сделать с деньгами?"
          style={{ marginBottom: 12 }}
          right={<span className="c-3" style={{ fontSize: 12 }}>цель подставляет условия отбора</span>}
        >
          <div className="goal-grid">
            {GOALS.map(g => {
              const on = goal === g.slug;
              const n = goalCounts[g.slug] || 0;
              return (
                <button
                  key={g.slug}
                  type="button"
                  className={'goal-card' + (on ? ' on' : '')}
                  /* Цвет цели отдаём в CSS двумя переменными: иконка берёт
                     цвет, квадрат под ней — его светлую подложку. */
                  style={{ '--gc': `var(--${g.color})`, '--gcbg': `var(--${g.color}-bg)` }}
                  onClick={() => applyGoal(g)}
                  title={`Подставит условия: ${g.desc}`}
                >
                  <span className="goal-ico">
                    <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor"
                      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      {g.icon}
                    </svg>
                  </span>
                  <span className="goal-t">{g.title}</span>
                  <span className="goal-d">{g.desc}</span>
                  <span className="goal-n">
                    {n ? <>{nf(n, 0)} <span className="u">вып.</span></> : <span className="u">ничего не подходит</span>}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Условия цели раскрываем словами: цель — это не «рекомендация»,
              а набор фильтров, и человек должен видеть, каких именно. */}
          <div className="kpi-s" style={{ marginTop: 10, lineHeight: 1.65 }}>
            {goal ? (
              <>
                Цель «{goalBySlug(goal)?.title}» — это условия: {goalBySlug(goal)?.desc}. Рейтинг —
                эмитента, по данным smart-lab.ru; срок и купон — по данным Мосбиржи. Бумаги без
                рейтинга в выборку не попадают: про них мы ничего не знаем.{' '}
                <span
                  style={{ cursor: 'pointer', textDecoration: 'underline' }}
                  onClick={() => { setGoal(null); setFilters({ ...DEFAULT_FILTERS, search: filters.search }); }}
                >
                  Снять цель
                </span>
              </>
            ) : (
              <>Выберите цель — покажем выпуски, которые под неё подходят, и напишем, по каким условиям
                они отобраны. Нужны свои условия — переключитесь на «Свои фильтры».</>
            )}
          </div>
        </Panel>
      )}

      {/* ── Сводка ── */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginBottom: 12 }}>
        <Kpi label="Всего выпусков" value={bonds.length} sub="TQCB + TQOB, MOEX" />
        <Kpi label="Отфильтровано" value={rows.length} sub={bonds.length ? nf(rows.length / bonds.length * 100, 1) + '% от рынка' : ''} />
        <Kpi label="Средняя доходность" value={avgYtm == null ? '—' : nf(avgYtm, 2) + '%'} sub="по выборке" />
      </div>

      {/* ── Фильтры ── */}
      {/* Про рейтинг по умолчанию говорим там, где человек ищет фильтры:
          иначе «показано 12 из 3095» читается как «на рынке всего 12 бумаг». */}
      {mode === 'own' && filters.rating === 'aaa' && filters.ratingMax === 'all' && (
        <div className="kpi-s" style={{ marginBottom: 8, lineHeight: 1.6 }}>
          По умолчанию показаны только выпуски с рейтингом AAA.{' '}
          <span
            style={{ cursor: 'pointer', textDecoration: 'underline' }}
            onClick={() => set({ rating: 'all' })}
          >
            Показать весь рынок
          </span>
        </div>
      )}
      {mode === 'own' && (
      <Panel title="Фильтры" style={{ marginBottom: 12 }}>
        <div className="filters">
          <div className="fg">
            <label>Поиск</label>
            <input
              className="inp"
              style={{ width: 220 }}
              placeholder="Название / ISIN / SECID"
              value={filters.search}
              onChange={e => set({ search: e.target.value })}
            />
            {qParam && filters.search === qParam && (
              <div className="c-3" style={{ fontSize: 10.5, marginTop: 3 }}>
                подставлено из карточки акции ·{' '}
                <span style={{ cursor: 'pointer', textDecoration: 'underline' }}
                  onClick={() => set({ search: '' })}>очистить</span>
              </div>
            )}
          </div>

          <div className="fg">
            <label>YTM от, %</label>
            <input
              className="inp"
              style={{ width: 90 }}
              type="number"
              step="0.1"
              placeholder="0"
              value={filters.ytmMin}
              onChange={e => set({ ytmMin: e.target.value })}
            />
          </div>

          <div className="fg">
            <label>YTM до, %</label>
            <input
              className="inp"
              style={{ width: 90 }}
              type="number"
              step="0.1"
              placeholder="300"
              value={filters.ytmMax}
              onChange={e => set({ ytmMax: e.target.value })}
            />
          </div>

          <div className="fg">
            <label>Тип купона</label>
            <select className="sel" value={filters.kind} onChange={e => set({ kind: e.target.value })}>
              <option value="all">Все</option>
              {Object.entries(COUPON_LABEL)
                .filter(([k]) => k !== 'other')
                .map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </div>

          <div className="fg">
            <label>Уровень листинга</label>
            <select className="sel" value={filters.level} onChange={e => set({ level: e.target.value })}>
              <option value="all">Все</option>
              <option value="1">1 уровень</option>
              <option value="2">2 уровень</option>
              <option value="3">3 уровень</option>
            </select>
          </div>

          {/* Рейтинг — данные smart-lab. Бумага без рейтинга условие
              «не ниже» не проходит; это написано в подсказке. */}
          <div className="fg">
            <label title={RATING_HINT}>Рейтинг не ниже</label>
            <select className="sel" value={filters.rating} onChange={e => set({ rating: e.target.value })}>
              {Object.entries(RATING_LABEL).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </div>

          {/* Ограничение сверху — для поиска доходности пониже качеством.
              Рейтинг относится к эмитенту (данные smart-lab.ru). */}
          <div className="fg">
            <label title={RATING_HINT}>Рейтинг не выше</label>
            <select className="sel" value={filters.ratingMax} onChange={e => set({ ratingMax: e.target.value })}>
              {Object.entries(RATING_MAX_LABEL).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </div>

          <div className="fg">
            <label>Срок до погашения</label>
            <select className="sel" value={filters.maturity} onChange={e => set({ maturity: e.target.value })}>
              {Object.entries(MATURITY_LABEL).map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </select>
          </div>

          <div className="fg">
            <label>Оборот от, ₽</label>
            <input
              className="inp"
              style={{ width: 130 }}
              type="number"
              step="1000"
              placeholder="например 1 000 000"
              value={filters.turnoverMin}
              onChange={e => set({ turnoverMin: e.target.value })}
            />
          </div>

          <div className="fg">
            <label>У меня есть, ₽</label>
            <input
              className="inp"
              style={{ width: 130 }}
              type="number"
              step="100"
              placeholder="например 11 500"
              value={filters.budget}
              onChange={e => set({ budget: e.target.value })}
              title="Покажет только бумаги, один лот которых стоит не дороже этой суммы"
            />
          </div>

          {/* ── Z-спред: премия к кривой ОФЗ. Главная метрика скринера ── */}
          <RangePair
            label="Z-спред" unit="п.п."
            from={filters.zMin} to={filters.zMax}
            onFrom={v => set({ zMin: v })} onTo={v => set({ zMax: v })}
          />

          <RangePair
            label="Дюрация" unit="лет"
            from={filters.durMin} to={filters.durMax}
            onFrom={v => set({ durMin: v })} onTo={v => set({ durMax: v })}
          />

          <RangePair
            label="Цена" unit="% номинала" step="1"
            from={filters.priceMin} to={filters.priceMax}
            onFrom={v => set({ priceMin: v })} onTo={v => set({ priceMax: v })}
          />

          <RangePair
            label="Купонная доходность" unit="%"
            from={filters.curMin} to={filters.curMax}
            onFrom={v => set({ curMin: v })} onTo={v => set({ curMax: v })}
          />

          <div className="fg">
            <label>Частота купона</label>
            <select className="sel" value={filters.freq} onChange={e => set({ freq: e.target.value })}>
              {Object.entries(FREQ_LABEL).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </div>

          <div className="fg">
            <label>Валюта номинала</label>
            <select className="sel" value={filters.currency} onChange={e => set({ currency: e.target.value })}>
              <option value="all">Любая</option>
              <option value="RUB">Рубль</option>
              <option value="USD">Доллар</option>
              <option value="EUR">Евро</option>
              <option value="CNY">Юань</option>
            </select>
          </div>

          <div className="fg">
            <label>Допуск</label>
            <select
              className="sel"
              value={filters.access}
              onChange={e => set({ access: e.target.value })}
              title="Биржевой признак «бумаги для квалифицированных инвесторов». Биржа публикует его по каждому выпуску отдельно; окончательно допуск определяет ваш брокер, а не сайт."
            >
              <option value="all">Все</option>
              <option value="any">Для всех (не для квалов)</option>
              <option value="qual">Только для квалифицированных</option>
            </select>
            {qualKnown < bonds.length && (
              <div className="c-3" style={{ fontSize: 10.5 }}>
                проверено {qualKnown} из {bonds.length}
              </div>
            )}
          </div>

          <CheckFilter
            label="Один выпуск на эмитента"
            title="Оставить у каждого эмитента только самый ликвидный выпуск. У одного эмитента бумаг может быть много, и они почти повторяют друг друга — так список короче и понятнее."
            checked={filters.onlyOnePerIssuer}
            onChange={v => set({ onlyOnePerIssuer: v })}
          />

          <CheckFilter
            label="Погашение до года"
            title="Только бумаги, которые гасятся в ближайшие 12 месяцев."
            checked={filters.soonMaturity}
            onChange={v => set({ soonMaturity: v })}
          />

          <CheckFilter
            label="Без амортизации"
            title="Исключить бумаги, у которых номинал возвращают частями. У них доходность считается сложнее и цена не так показательна."
            checked={filters.noAmort}
            onChange={v => set({ noAmort: v })}
          />

          <CheckFilter
            label="Без оферты"
            title="Исключить бумаги с досрочным выкупом (put). У них доходность считается к оферте, а не к погашению, и ставка купона после оферты может быть другой."
            checked={filters.noOffer}
            onChange={v => set({ noOffer: v })}
          />

          <div className="fg">
            <label>Достоверность</label>
            <label
              title="У части выпусков MOEX отдаёт битую доходность (значение вне допустимого диапазона −50…300 %). Такие бумаги показываются как «н/д» и по умолчанию исключены из выборки, чтобы не портить сортировку и средние."
              style={{
                display: 'flex', alignItems: 'center', gap: 6, minHeight: 30,
                fontSize: 12, fontWeight: 400, textTransform: 'none',
                letterSpacing: 0, color: 'var(--text2)', cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={filters.hideAnomaly}
                onChange={e => set({ hideAnomaly: e.target.checked })}
                style={{ accentColor: 'var(--accent)', width: 14, height: 14 }}
              />
              Скрыть аномальную доходность
            </label>
          </div>

          <div className="fg">
            <label>Личное</label>
            <button
              className={'chip' + (onlyFav ? ' on' : '')}
              style={{ minHeight: 30 }}
              onClick={() => setOnlyFav(v => !v)}
              title="Оставить только бумаги из избранного"
            >
              ★ Избранное ({favList.length})
            </button>
          </div>

          <div className="fg">
            <label>&nbsp;</label>
            <button className="btn" onClick={reset}>Сбросить фильтры</button>
          </div>
        </div>

        {/* Сноска про скрытые «битые» доходности */}
        {filters.hideAnomaly && hiddenAnomaly > 0 && (
          <div className="kpi-s" style={{ marginTop: 10 }}>
            Скрыто {hiddenAnomaly} вып. с недостоверной доходностью — снимите галочку, чтобы показать их.
          </div>
        )}
        {error && bonds.length > 0 && (
          <div className="err" style={{ textAlign: 'left', paddingTop: 10 }}>
            Обновление не удалось: {String(error)}
          </div>
        )}
      </Panel>
      )}

      {/* ── Таблица + пагинация ── */}
      <Panel
        pad={false}
        title={`Результаты · стр. ${cur} из ${pages}`}
        right={
          <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span className="kpi-s">{rows.length} шт. по фильтру · по {PER_PAGE} на страницу</span>
            <button
              className="btn btn-sm"
              onClick={exportCsv}
              disabled={!rows.length}
              title="Скачать все найденные выпуски (не только текущую страницу) в CSV — открывается в Excel"
            >
              ↓ CSV
            </button>
          </span>
        }
      >
        {!rows.length ? (
          <div className="empty">
            Под фильтры не попал ни один выпуск из {bonds.length}.
            <div style={{ marginTop: 10 }}>
              <button className="btn" onClick={reset}>Сбросить фильтры</button>
            </div>
          </div>
        ) : (
          <>
            <BondTable
              bonds={slice}
              cols={filters.budget ? [...SCREENER_COLS, 'lotCost'] : SCREENER_COLS}
              onRow={setPopup}
            />
            <Pager
              page={cur}
              pages={pages}
              onChange={setPage}
              total={rows.length}
              perPage={PER_PAGE}
            />
          </>
        )}
      </Panel>

      {/* Источник и дата сбора. Это единственное место, где видно, что
          робот рейтингов жив: молчаливо устаревшие данные заметить иначе
          нечем, а «обновляется само» без проверки — это обещание, а не факт. */}
      {ratingInfo?.generatedAt && (
        <div className="c-3 rating-src" style={{ fontSize: 11, marginTop: 10, lineHeight: 1.6 }}>
          Кредитные рейтинги — по данным таблицы котировок{' '}
          <a href="https://smart-lab.ru/q/bonds/" target="_blank" rel="noopener noreferrer">smart-lab.ru</a>,
          собраны {dateTime(ratingInfo.generatedAt)}
          {ratingInfo.stats?.withRating ? ` · значений: ${ratingInfo.stats.withRating}` : ''}.
          Агентство и дата присвоения в источнике не указаны, рейтинг относится к эмитенту.
          Котировки, доходности и карточки выпусков грузятся с Московской биржи при каждом открытии страницы.
        </div>
      )}

      {/* Быстрый просмотр бумаги из списка: клик по строке открывает окно,
          как в оригинале, а на полную страницу выпуска ведёт кнопка уже
          внутри окна. */}
      {popup && <BondPopup key={popup.isin} bond={popup} onClose={() => setPopup(null)} />}
    </div>
  );
}