import { nf } from '../lib/format';
import { Panel } from './ui';

/* ═══════════════════════════════════════════════════════════════════
   Финансовая отчётность и коэффициенты — данные smart-lab.ru

   Что здесь есть: таблица МСФО по годам (выручка, EBITDA, чистая
   прибыль, долг, наличность…), уже готовые коэффициенты с источника
   (P/E, EV/EBITDA, Долг/EBITDA, ROE, ROA, маржа) и дивидендная история.

   Чего здесь НЕТ и почему:
     • «разбора отчётности» словами — это редакционный текст;
     • прогнозов и рейтингов «купить/держать» — это инвестиционная
       рекомендация, а мы её не даём.

   Светофор — наше суждение о порогах, а не факт из отчёта. Пороги
   отраслевые условности: Долг/EBITDA 3× для девелопера и для нефтянки
   означают разное. Поэтому подписано прямо в блоке.
   ═══════════════════════════════════════════════════════════════════ */

/* Строки таблицы: [ключ, подпись, единица, знаков после запятой] */
const GROUPS = [
  {
    title: 'Финансовые результаты',
    rows: [
      ['revenue', 'Выручка', 'млрд ₽', 1],
      ['opProfit', 'Операционная прибыль', 'млрд ₽', 1],
      ['ebitda', 'EBITDA', 'млрд ₽', 1],
      ['netProfit', 'Чистая прибыль', 'млрд ₽', 1],
      /* «н/с» = нескорректированная: то, что компания показала в отчёте,
         без поправок на разовые статьи. У Газпрома за 2023 скорректированная
         726 млрд, а в отчёте — убыток 629 млрд. Рынок цитирует вторую,
         поэтому показываем обе и не делаем вид, что цифра одна. */
      ['netProfitNS', 'Чистая прибыль (как в отчёте)', 'млрд ₽', 1],
    ],
  },
  {
    title: 'Баланс и долг',
    rows: [
      ['assets', 'Активы', 'млрд ₽', 1],
      ['netAssets', 'Чистые активы', 'млрд ₽', 1],
      ['debt', 'Долг', 'млрд ₽', 1],
      ['cash', 'Наличность', 'млрд ₽', 1],
      ['netDebt', 'Чистый долг', 'млрд ₽', 1],
    ],
  },
  {
    title: 'Денежный поток',
    rows: [
      ['opFcf', 'Операционный поток', 'млрд ₽', 1],
      ['capex', 'CAPEX', 'млрд ₽', 1],
      ['fcf', 'Свободный поток (FCF)', 'млрд ₽', 1],
    ],
  },
  {
    title: 'Оценка рынка',
    rows: [
      ['cap', 'Капитализация', 'млрд ₽', 1],
      ['ev', 'EV (стоимость с долгом)', 'млрд ₽', 1],
      ['eps', 'Прибыль на акцию', '₽', 1],
      ['bv', 'Балансовая стоимость акции', '₽', 1],
    ],
  },
];

/* ── Светофор по коэффициентам ──────────────────────────────────────
   tone(v) → 'good' | 'warn' | 'bad' | 'na'
   Пороги подобраны как ориентир «дорого/нормально/дёшево» и
   «крепко/терпимо/рискованно». Это не рекомендация. */
const RATIOS = [
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
    hint: 'Сколько лет EBITDA нужно, чтобы расплатиться с долгом',
    tone: v => (v == null ? 'na' : v < 0 ? 'good' : v < 2 ? 'good' : v < 4 ? 'warn' : 'bad'),
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

const TONE_LABEL = { good: 'в норме', warn: 'внимание', bad: 'риск', na: 'нет данных' };

/** Значение метрики за самый свежий год, где оно есть. */
function latest(metric) {
  if (!metric?.values) return null;
  const years = Object.keys(metric.values).sort();
  const y = years[years.length - 1];
  return y ? { year: y, value: metric.values[y] } : null;
}

/** Формат значения для таблицы: млрд ₽ — одним знаком, проценты — как есть. */
function fmtVal(v, digits) {
  if (v == null) return '—';
  return nf(v, digits);
}

/* ── Пересказ цифр простыми словами ─────────────────────────────────
   Это НЕ редакционный разбор и не мнение о компании. Каждое предложение
   здесь — арифметика по той же таблице, что выше: сравнили первый и
   последний год, поделили одно на другое. Если данных для фразы нет,
   фраза не появляется вовсе — досочинять нечего.
   Никаких «стоит покупать», «недооценена», «перспективы» тут быть
   не может: это была бы инвестиционная рекомендация. */
function plainSummary(m, years) {
  if (!m || years.length < 2) return [];
  const first = years[0], last = years[years.length - 1];
  const at = (k, y) => m[k]?.values?.[y] ?? null;
  const mlrd = v => nf(v, 1) + ' млрд ₽';
  const pct = v => (v > 0 ? '+' : '') + nf(v, 1) + '%';
  const out = [];

  const rv1 = at('revenue', first), rv2 = at('revenue', last);
  if (rv1 > 0 && rv2 != null) {
    out.push(`Выручка за ${first}–${last}: ${mlrd(rv1)} → ${mlrd(rv2)} (${pct((rv2 - rv1) / rv1 * 100)}).`);
  }

  const eb1 = at('ebitda', first), eb2 = at('ebitda', last);
  const mg1 = at('ebitdaMargin', first), mg2 = at('ebitdaMargin', last);
  if (eb1 != null && eb2 != null) {
    let s = `EBITDA: ${mlrd(eb1)} → ${mlrd(eb2)}`;
    if (mg1 != null && mg2 != null) s += `, рентабельность ${nf(mg1, 1)}% → ${nf(mg2, 1)}%`;
    out.push(s + '.');
  }

  const nd = at('netDebt', last), de = at('debtEbitda', last);
  if (nd != null && eb2 != null && eb2 > 0) {
    if (nd < 0) {
      out.push(`Чистого долга нет: наличности больше долга на ${mlrd(Math.abs(nd))}.`);
    } else {
      let s = `Чистый долг ${mlrd(nd)}`;
      if (de != null) s += ` — ${nf(de, 2)} годовой EBITDA`;
      out.push(s + '.');
    }
  }

  const fcf = at('fcf', last);
  if (fcf != null) {
    out.push(fcf < 0
      ? `Свободный поток в ${last} отрицательный: ${mlrd(fcf)}.`
      : `Свободный поток в ${last}: ${mlrd(fcf)}.`);
  }

  const np = at('netProfit', last);
  if (np != null) out.push(`Чистая прибыль в ${last}: ${mlrd(np)}.`);

  return out;
}

export default function Fundamentals({ data, right }) {
  const fin = data?.fin;
  const div = data?.div;
  if (!fin && !div) return null;

  const years = fin?.years || [];
  const m = fin?.metrics || {};

  /* ── Таблица отчётности ── */
  const finTable = fin && years.length > 0 ? (
    <Panel
      title="Финансовая отчётность (МСФО)"
      style={{ marginBottom: 14 }}
      right={right}
    >
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th className="nosort" style={{ textAlign: 'left' }}>Показатель</th>
              {years.map((y, i) => (
                <th key={y} className="nosort" style={{ textAlign: 'right' }}>
                  {y}
                  {/* Дата публикации отчёта — чтобы было видно, за какой
                      период цифра и не приняли ли полугодие за год. */}
                  {fin.reportDates?.[i] && (
                    <div className="c-3" style={{ fontSize: 9, fontWeight: 400 }}>{fin.reportDates[i]}</div>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {GROUPS.map(g => {
              /* Показываем группу только если хоть одна метрика есть */
              const hasAny = g.rows.some(([k]) => m[k]);
              if (!hasAny) return null;
              return (
                <FragmentRows key={g.title} group={g} m={m} years={years} />
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="c-3" style={{ fontSize: 10.5, marginTop: 10, lineHeight: 1.6 }}>
        Источник: smart-lab.ru (МСФО). Прочерк — показателя нет в отчёте или он не публиковался.
        У банков и страховых выручки и EBITDA не бывает по природе их отчётности — там прочерк
        не пробел данных, а особенность учёта.
      </div>
    </Panel>
  ) : null;

  /* ── Пересказ цифр ── */
  const summary = plainSummary(m, years);
  const summaryPanel = summary.length > 0 ? (
    <Panel title="Что видно в цифрах" style={{ marginBottom: 14 }}
      right={<span className="c-3" style={{ fontSize: 10.5 }}>посчитано по таблице выше</span>}>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.85 }}>
        {summary.map((s, i) => <li key={i}>{s}</li>)}
      </ul>
      <div className="c-3" style={{ fontSize: 10.5, marginTop: 10, lineHeight: 1.6 }}>
        Это пересказ чисел из отчётности, а не мнение о компании и не совет.
        Никаких «дешево», «перспективно» или «стоит брать» здесь нет намеренно —
        таких выводов мы не делаем.
      </div>
    </Panel>
  ) : null;

  /* ── Светофор коэффициентов (последний год) ──
     Считаем список заранее, а не внутри разметки: у компании может не быть
     ни одного коэффициента (например, есть только дивиденды), и тогда
     панель с пустой сеткой выглядела бы как сломанная. */
  const ratioItems = fin
    ? RATIOS.map(r => {
      const l = latest(m[r.key]);
      return l ? { r, l, tone: r.tone(l.value) } : null;
    }).filter(Boolean)
    : [];

  const ratioCards = ratioItems.length > 0 ? (
    <Panel title="Коэффициенты — оценка" style={{ marginBottom: 14 }}
      right={<span className="c-3" style={{ fontSize: 10.5 }}>последний отчётный год</span>}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        gap: 10,
      }}>
        {ratioItems.map(({ r, l, tone }) => {
          const cls = tone === 'good' ? 'c-g' : tone === 'warn' ? 'c-a' : tone === 'bad' ? 'c-r' : 'c-3';
          return (
            <div key={r.key} className="kpi-card" title={r.hint} style={{ cursor: 'help' }}>
              <div className="kpi-l">{r.label}</div>
              <div className={'kpi-v ' + cls}>
                {nf(l.value, r.unit === '%' ? 1 : 2)}<span style={{ fontSize: 13 }}>{r.unit}</span>
              </div>
              <div className="kpi-s">
                <span className={cls}>●</span> {TONE_LABEL[tone]} · {l.year}
              </div>
            </div>
          );
        })}
      </div>

      {/* Легенда — как у оригинала. Смысл цветов без пояснения неочевиден. */}
      <div style={{ marginTop: 12, fontSize: 11, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <span><span className="c-g">●</span> в норме</span>
        <span><span className="c-a">●</span> внимание</span>
        <span><span className="c-r">●</span> риск</span>
        <span className="c-3">серые — данных нет</span>
      </div>
      <div className="c-3" style={{ fontSize: 10.5, marginTop: 10, lineHeight: 1.65 }}>
        <b>Это наша оценка порогов, а не факт из отчёта.</b> Границы «нормы» зависят от отрасли:
        долг 3× EBITDA для девелопера и для нефтяной компании значат разное, а высокая маржа
        у ритейла и у IT несопоставима. Смотрите на цвет как на подсказку, куда глянуть,
        а не как на вывод о бумаге. Не является инвестиционной рекомендацией.
      </div>
    </Panel>
  ) : null;

  /* ── Дивиденды ──
     Годы идут по убыванию (свежие сверху), а «изм. к пред.» считаем по
     хронологии — то есть сравниваем с годом РАНЬШЕ, а не со строкой ниже. */
  const divYears = Object.keys(div?.perShare || {}).sort();
  const divChange = {};
  for (let i = 1; i < divYears.length; i++) {
    const cur = div.perShare[divYears[i]];
    const prev = div.perShare[divYears[i - 1]];
    /* Ноль — это не «мало», а «не начисляли или ещё не объявили»:
       источник эти случаи не различает, поэтому процент не считаем. */
    divChange[divYears[i]] = (cur > 0 && prev > 0) ? (cur - prev) / prev * 100 : null;
  }

  const divTable = div && Object.keys(div.perShare || {}).length > 0 ? (
    <Panel title="Дивиденды по годам" style={{ marginBottom: 14 }}
      right={<span className="c-3" style={{ fontSize: 10.5 }}>source: smart-lab.ru</span>}>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th className="nosort" style={{ textAlign: 'left' }}>Год</th>
              <th className="nosort" style={{ textAlign: 'right' }}>Дивиденд, ₽/акцию</th>
              <th className="nosort" style={{ textAlign: 'right' }}>Изм. к пред. году</th>
              <th className="nosort" style={{ textAlign: 'right' }}>Див. доходность</th>
              <th className="nosort" style={{ textAlign: 'right' }}>Доля от прибыли</th>
              <th className="nosort" style={{ textAlign: 'right' }}>Всего начислено</th>
            </tr>
          </thead>
          <tbody>
            {[...divYears].reverse().map(y => {
              const ps = div.perShare[y];
              const ch = divChange[y];
              return (
                <tr key={y}>
                  <td>{y}</td>
                  <td style={{ textAlign: 'right' }} className="mono">{ps > 0 ? nf(ps, 2) : '—'}</td>
                  <td style={{ textAlign: 'right' }}
                    className={'mono ' + (ch == null ? 'c-3' : ch > 0 ? 'c-g' : 'c-r')}>
                    {ch == null ? '—' : (ch > 0 ? '+' : '') + nf(ch, 1) + '%'}
                  </td>
                  <td style={{ textAlign: 'right' }} className="mono">
                    {div.divYield?.[y] != null ? nf(div.divYield[y], 1) + '%' : '—'}
                  </td>
                  <td style={{ textAlign: 'right' }} className="mono">
                    {div.payoutRatio?.[y] != null ? nf(div.payoutRatio[y], 0) + '%' : '—'}
                  </td>
                  <td style={{ textAlign: 'right' }} className="mono">
                    {div.divPayment?.[y] != null ? nf(div.divPayment[y], 1) + ' млрд' : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="c-3" style={{ fontSize: 10.5, marginTop: 10, lineHeight: 1.6 }}>
        Суммы — за год, за который дивиденд <b>начислен</b>, а не за год выплаты.
        Поэтому наши цифры могут не совпадать с теми, где дивиденды сгруппированы
        по году выплаты: например, дивиденд за 2023 год, перечисленный в 2024-м,
        у нас стоит в 2023-м. Обе цифры верны — вопрос разный.
        «Див. доходность» — выплата к цене акции на тот момент, а не к сегодняшней.
        «Доля от прибыли» — сколько из прибыли ушло на дивиденды: больше 100 % значит
        платили из накопленного. <b>Прочерк</b> — за этот год выплата не начислена
        или ещё не объявлена; источник эти случаи не различает.
        Прошлые выплаты не гарантируют будущих.
      </div>
    </Panel>
  ) : null;

  return (
    <>
      {finTable}
      {summaryPanel}
      {ratioCards}
      {divTable}
    </>
  );
}

/** Строки одной группы: заголовок группы + её метрики. */
function FragmentRows({ group, m, years }) {
  return (
    <>
      <tr>
        <td colSpan={years.length + 1} className="c-3"
          style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', paddingTop: 12 }}>
          {group.title}
        </td>
      </tr>
      {group.rows.map(([key, label, unit, digits]) => {
        const metric = m[key];
        if (!metric) return null;
        return (
          <tr key={key}>
            <td style={{ textAlign: 'left' }}>
              {label} <span className="c-3" style={{ fontSize: 10 }}>{unit}</span>
            </td>
            {years.map(y => {
              const v = metric.values[y];
              /* Отрицательный чистый долг — это деньги, а не долг: помечаем знаком. */
              const neg = key === 'netDebt' && v != null && v < 0;
              return (
                <td key={y} style={{ textAlign: 'right' }} className={'mono ' + (neg ? 'c-g' : '')}>
                  {v == null ? '—' : fmtVal(v, digits)}
                </td>
              );
            })}
          </tr>
        );
      })}
    </>
  );
}