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