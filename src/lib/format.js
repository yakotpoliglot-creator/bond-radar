/* ── Форматирование чисел и дат ─────────────────────────────────── */

export const nf = (v, digits = 2) =>
  v == null || Number.isNaN(+v) ? '—' : (+v).toLocaleString('ru-RU', {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  });

export const pct = (v, digits = 2) => (v == null || Number.isNaN(+v) ? '—' : nf(v, digits) + '%');

/** Компактные деньги: 89 263 961 → 89,3 млн ₽ */
export function money(v, currency = 'RUB') {
  if (v == null || Number.isNaN(+v)) return '—';
  const n = +v;
  const sym = currency === 'RUB' ? '₽' : currency;
  const abs = Math.abs(n);
  if (abs >= 1e12) return nf(n / 1e12, 2) + ' трлн ' + sym;
  if (abs >= 1e9) return nf(n / 1e9, 2) + ' млрд ' + sym;
  if (abs >= 1e6) return nf(n / 1e6, 1) + ' млн ' + sym;
  if (abs >= 1e3) return nf(n / 1e3, 0) + ' тыс. ' + sym;
  return nf(n, 0) + ' ' + sym;
}

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/** 2027-02-12 → 12.02.2027 */
export function date(d) {
  if (!d || d === '0000-00-00') return '—';
  const [y, m, day] = d.split('-');
  return `${day}.${m}.${y}`;
}

/** 2027-02-12 → 12 фев 2027 */
export function dateShort(d) {
  if (!d || d === '0000-00-00') return '—';
  const [y, m, day] = d.split('-');
  return `${+day} ${MONTHS[+m - 1]} ${y}`;
}

/**
 * Полная отметка времени от роботов: 2026-10-01T12:17:11.237Z → 01.10.2026 12:17 UTC.
 *
 * Отдельная функция нужна потому, что date() рассчитан на короткую дату
 * «2026-10-01» и разбирает строку по дефису. На полной отметке он выдавал
 * «01T12:17:11.237Z.10.2026» — это я увидел на живой странице, а не
 * предположил. Здесь время отрезается до вызова date().
 */
export function dateTime(v) {
  if (!v) return '—';
  const s = String(v);
  const [d, t] = s.split('T');
  const day = date(d);
  return t ? `${day} ${t.slice(0, 5)} UTC` : day;
}

/** Дней → «4 мес.» / «1,4 года» */
export function duration(days) {
  if (days == null) return '—';
  if (days < 31) return days + ' дн.';
  const months = days / 30.44;
  if (months < 24) return nf(months, months < 10 ? 1 : 0) + ' мес.';
  return nf(months / 12, 1) + ' г.';
}

/** «через 5 мес.» */
export function timeLeft(dateStr) {
  if (!dateStr) return '';
  const days = Math.round((new Date(dateStr + 'T00:00:00') - new Date()) / 86400000);
  if (days < 0) return 'прошло';
  if (days < 31) return `через ${days} дн.`;
  const m = Math.round(days / 30.44);
  if (m < 24) return `через ${m} мес.`;
  return `через ${nf(m / 12, 1)} г.`;
}

/**
 * Сколько лет осталось до даты — числом, для калькулятора.
 *
 * Отдельная функция, а не расчёт внутри компонента: `new Date()`
 * не является чистой функцией, и вызывать её прямо в теле компонента
 * нельзя (правило чистоты React). Здесь тот же приём, что у timeLeft.
 * Возвращает null, если даты нет или она уже прошла.
 */
export function yearsUntil(dateStr) {
  if (!dateStr) return null;
  const days = Math.round((new Date(dateStr + 'T00:00:00') - new Date()) / 86400000);
  if (days <= 0) return null;
  return Math.round(days / 365 * 10) / 10;
}

/**
 * Купоны из графика выплат, попадающие в срок владения.
 *
 * Из графика берём ДАТЫ — они точные, и число выплат получается точным.
 * А вот суммы у многих выпусков не заполнены: у Россет1Р11 из 39 будущих
 * купонов сумма известна у нуля (плавающая ставка). Поэтому отдельно
 * считаем, у скольких выплат сумма есть, и вызывающий код решает:
 * все известны — берём точную сумму, иначе оцениваем по текущей ставке.
 *
 * Рублёвую сумму биржа отдаёт готовой (valueRub, курс на дату выплаты) —
 * это важно для валютных выпусков, где самим курс не угадать.
 *
 * Пустой результат — это тоже ответ («в этот срок выплат не будет»),
 * поэтому при наличии графика возвращаем объект, а не null.
 */
export function couponsWithin(coupons, years, rate = 1) {
  if (!Array.isArray(coupons) || !coupons.length || !(years > 0)) return null;
  /* Считаем от полуночи и с запасом в сутки. Без этого купон, совпадающий
     с датой погашения, выпадал из окна на один день: у РЖД 1Р-21R
     погашение 2027-06-11, окно кончалось 2027-06-10, и вместо двух
     выплат мы считали одну — доходность выходила 8,5 % против 14,5 %
     у биржи. Ошибка была ровно в один день. */
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const until = new Date(today.getTime() + (Math.round(years * 365) + 1) * 86400000);
  const untilIso = `${until.getFullYear()}-${String(until.getMonth() + 1).padStart(2, '0')}-${String(until.getDate()).padStart(2, '0')}`;

  let count = 0, known = 0, totalRub = 0, seen = false;
  for (const c of coupons) {
    if (!c?.date || c.date < todayIso || c.date > untilIso) continue;
    seen = true;
    count++;
    const rub = c.valueRub != null ? c.valueRub : (c.value != null ? c.value * rate : null);
    if (rub != null) { known++; totalRub += rub; }
  }
  return seen ? { count, known, totalRub, byRub: count > 0 && known === count } : null;
}

/**
 * Последний ИЗВЕСТНЫЙ купон по графику — оценка для плавающей ставки.
 *
 * У бумаг с плавающим купоном биржа отдаёт даты будущих выплат, но не
 * суммы: у Россет1Р11 из 38 будущих купонов сумма известна у нуля, и
 * в поле ставки тоже ноль. Считать такие купоны нулём нельзя — выходило
 * «−0,1 % годовых» у бумаги с доходностью 16,5 %. Ближайшая разумная
 * оценка — размер последней известной выплаты: ставка сбросится, но это
 * единственное, на что можно опереться, и мы честно называем это оценкой.
 */
export function lastKnownCoupon(coupons, rate = 1) {
  if (!Array.isArray(coupons) || !coupons.length) return null;
  let best = null;
  for (const c of coupons) {
    if (!c?.date) continue;
    const rub = c.valueRub != null ? c.valueRub : (c.value != null ? c.value * rate : null);
    if (rub == null || rub <= 0) continue;
    if (!best || c.date > best.date) best = { date: c.date, rub };
  }
  return best ? best.rub : null;
}

/** Класс окраски для доходности */
export function ytmClass(v) {
  if (v == null) return 'c-3';
  if (v >= 25) return 'c-r';
  if (v >= 18) return 'c-a';
  if (v >= 10) return 'c-2';
  return 'c-g';
}

/** Класс окраски для изменения цены */
export const chgClass = v => (v == null ? 'c-3' : v > 0 ? 'c-g' : v < 0 ? 'c-r' : 'c-3');

export const chgStr = v => (v == null ? '—' : (v > 0 ? '+' : '') + nf(v, 2) + '%');

/* ── Треугольники направления ──────────────────────────────────────
   Приём с bondradar.pro: изменение показывается не одним цветом, а
   цветом плюс треугольником ▲ / ▼. Цвет виден не всем (дальтонизм,
   тёмная тема, плохой экран), а направление стрелки читается всегда.
   При нуле и при отсутствии данных стрелки нет — рисовать «▲ 0,00 %»
   значило бы придумывать движение, которого не было. */

/** Треугольник: «▲», «▼» или пустая строка. */
export const chgArrow = v => (v == null || v === 0 ? '' : v > 0 ? '▲' : '▼');

/** Изменение с треугольником: «▲ +1,06 %». */
export const chgStrA = v => {
  if (v == null) return '—';
  const a = chgArrow(v);
  return (a ? a + ' ' : '') + (v > 0 ? '+' : '') + nf(v, 2) + '%';
};

/** Класс для «таблетки» изменения: chg up / chg down / chg flat. */
export const chgPill = v => (v == null || v === 0 ? 'chg flat' : v > 0 ? 'chg up' : 'chg down');

/* ── Окраска доходности ────────────────────────────────────────────
   Пороги взяты у bondradar.pro дословно — там в отрисовке строки
   главной стоит:
       ytm >= 24 ? red : ytm >= 18 ? amber : green
   Смысл не в «плохо/хорошо», а в ориентире: до 18% — доходность
   в пределах обычной корпоративной, 18–24% — уже заметно выше
   рынка, от 24% — territory, где рынок требует премию за риск.
   Зелёный здесь НЕ значит «покупай», красный — не значит «не бери»;
   это шкала доходности, а не рекомендация. */
export const ytmTone = v => (v == null ? '' : v >= 24 ? 'c-r' : v >= 18 ? 'c-a' : 'c-g');

/** Тот же порог, но числом — для сортировок и легенд. */
export const YTM_TONE_EDGES = [18, 24];

/** Транслитерация для slug эмитента */
export function slugify(s) {
  const map = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',
    н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',
    э:'e',ю:'yu',я:'ya' };
  return (s || '').toLowerCase().split('').map(c => map[c] !== undefined ? map[c] : c)
    .join('').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}