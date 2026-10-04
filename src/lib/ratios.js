import { nf } from './format';

/* ═══════════════════════════════════════════════════════════════════
   Коэффициенты и светофор: пороги «норма / внимание / риск».

   Вынесено из components/Fundamentals отдельным модулем по двум
   причинам: (1) тем же светофором пользуется карточка предприятия на
   странице выпуска — пороги должны быть одни на весь сайт, а не
   скопированы дважды; (2) файл с компонентом, который экспортирует
   ещё и функции, ломает быструю перезагрузку React (fast refresh) и
   сыпет предупреждениями линтера.

   Пороги — отраслевые условности, а не факт из отчёта: долг 3× EBITDA
   для девелопера и для нефтяной компании значит разное. Это подписано
   прямо в интерфейсе там, где коэффициенты показываются.
   ═══════════════════════════════════════════════════════════════════ */
/* ── Светофор по коэффициентам ──────────────────────────────────────
   tone(v) → 'good' | 'warn' | 'bad' | 'na'
   Пороги подобраны как ориентир «дорого/нормально/дёшево» и
   «крепко/терпимо/рискованно». Это не рекомендация. */
export const RATIOS = [
  {
    key: 'pe', label: 'P/E', unit: '×',
    hint: 'Цена / годовая прибыль. Сколько лет прибыли стоит компания',
    tone: v => (v == null ? 'na' : v <= 0 ? 'na' : v < 8 ? 'good' : v < 20 ? 'warn' : 'bad'),
  },
  {
    key: 'evEbitda', label: 'EV/EBITDA', unit: '×',
    hint: 'Стоимость компании с долгом / EBITDA. Ниже — дешевле',
    tone: v => (v == null ? 'na' : v <= 0 ? 'na' : v < 5 ? 'good' : v < 10 ? 'warn' : 'bad'),
  },
  {
    key: 'debtEbitda', label: 'Долг/EBITDA', unit: '×',
    hint: 'Сколько лет EBITDA нужно, чтобы расплатиться со ВСЕМ долгом. '
      + 'Считаем сами: в источнике под этой подписью лежит чистый долг',
    tone: v => (v == null ? 'na' : v < 0 ? 'good' : v < 2 ? 'good' : v < 4 ? 'warn' : 'bad'),
  },
  {
    key: 'netDebtEbitda', label: 'Чистый долг/EBITDA', unit: '×',
    hint: 'То же, но из долга вычтены деньги на счетах. Обычно главный '
      + 'показатель нагрузки: отрицательный значит денег больше, чем долга',
    tone: v => (v == null ? 'na' : v < 0 ? 'good' : v < 1.5 ? 'good' : v < 3 ? 'warn' : 'bad'),
  },
  {
    key: 'interestCoverage', label: 'Покрытие процентов', unit: '×',
    hint: 'Сколько раз EBITDA покрывает проценты по долгу. Меньше 1,5 — '
      + 'долг обслуживается на пределе',
    tone: v => (v == null ? 'na' : v > 5 ? 'good' : v > 2 ? 'warn' : 'bad'),
  },
  {
    key: 'roe', label: 'ROE', unit: '%',
    hint: 'Отдача на собственный капитал',
    tone: v => (v == null ? 'na' : v > 15 ? 'good' : v > 5 ? 'warn' : 'bad'),
  },
  {
    key: 'roa', label: 'ROA', unit: '%',
    hint: 'Отдача на все активы',
    tone: v => (v == null ? 'na' : v > 8 ? 'good' : v > 3 ? 'warn' : 'bad'),
  },
  {
    key: 'ebitdaMargin', label: 'EBITDA-маржа', unit: '%',
    hint: 'Доля EBITDA в выручке — операционная эффективность',
    tone: v => (v == null ? 'na' : v > 20 ? 'good' : v > 10 ? 'warn' : 'bad'),
  },
  {
    key: 'netMargin', label: 'Чистая маржа', unit: '%',
    hint: 'Доля чистой прибыли в выручке',
    tone: v => (v == null ? 'na' : v > 10 ? 'good' : v > 3 ? 'warn' : 'bad'),
  },
  {
    key: 'ps', label: 'P/S', unit: '×',
    hint: 'Капитализация / выручка',
    tone: v => (v == null ? 'na' : v <= 0 ? 'na' : v < 1 ? 'good' : v < 3 ? 'warn' : 'bad'),
  },
  {
    key: 'pbv', label: 'P/BV', unit: '×',
    hint: 'Капитализация / балансовая стоимость. Ниже 1 — дешевле баланса',
    tone: v => (v == null ? 'na' : v <= 0 ? 'na' : v < 1 ? 'good' : v < 3 ? 'warn' : 'bad'),
  },
];

export const TONE_LABEL = { good: 'в норме', warn: 'внимание', bad: 'риск', na: 'нет данных' };

/** Значение метрики за самый свежий год, где оно есть. */
export function latest(metric) {
  if (!metric?.values) return null;
  const years = Object.keys(metric.values).sort();
  const y = years[years.length - 1];
  return y ? { year: y, value: metric.values[y] } : null;
}

/* ── Метрики для карточки предприятия ────────────────────────────────
   Тот же светофор и те же пороги, что в панели коэффициентов, но только
   три показателя — ровно те, что стоят плитками в карточке у оригинала:
   долг к EBITDA, маржа по EBITDA и чистая маржа. Нужны они там, где
   таблице места нет: на карточке выпуска (components/IssuerCard).
   Считает по-прежнему этот файл, чтобы «норма» на карточке и в панели
   коэффициентов не разошлась. */
export const CARD_RATIO_KEYS = ['debtEbitda', 'ebitdaMargin', 'netMargin'];

export function ratioStats(fin, keys = CARD_RATIO_KEYS) {
  const m = fin?.metrics;
  if (!m) return [];
  return keys.map(k => {
    const r = RATIOS.find(x => x.key === k);
    const l = r ? latest(m[k]) : null;
    if (!r || !l) return null;
    return { key: k, label: r.label, hint: r.hint, unit: r.unit, value: l.value, year: l.year, tone: r.tone(l.value) };
  }).filter(Boolean);
}

/* Свежий отчётный период одной строкой — как «Отчётность МСФО 2026 ·
   1 полугодие · выручка 1880,0 млрд ₽ · чистая прибыль 286,1 млрд ₽»
   в карточке у оригинала. Годовая таблица отвечает «как менялось»,
   эта строка — «что показали в последнем отчёте», и на карточке
   выпуска хватает её одной. */
export function latestPeriodLine(q) {
  const p = q?.periods?.[q.periods.length - 1];
  if (!p) return null;
  const val = k => q?.metrics?.[k]?.values?.[p.label] ?? null;
  const parts = [];
  for (const [k, label] of [['revenue', 'выручка'], ['ebitda', 'EBITDA'], ['netProfit', 'чистая прибыль']]) {
    const v = val(k);
    if (v != null) parts.push(`${label} ${nf(v, 1)} млрд ₽`);
  }
  if (!parts.length) return null;
  return { label: p.label, date: p.date, text: parts.join(' · ') };
}
