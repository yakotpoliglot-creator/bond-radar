import { nf, chgClass, chgArrow } from '../lib/format';
import { Panel } from './ui';
import { RATIOS, TONE_CLS, TONE_LABEL, latest, ratioText, ratioValue } from '../lib/ratios';

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

/* Строки таблицы: [ключ, подпись, единица, знаков после запятой, делитель]
   Делитель нужен там, где в отчёте число в одних единицах, а читать его
   удобнее в других: сотрудников показываем в тысячах, а не «104 323 чел.».
   Незнакомый показатель не выдумываем — строки просто не будет. */
const GROUPS = [
  {
    title: 'Финансовые результаты',
    rows: [
      ['revenue', 'Выручка', 'млрд ₽', 1],
      ['opProfit', 'Операционная прибыль', 'млрд ₽', 1],
      ['ebitda', 'EBITDA', 'млрд ₽', 1],
      /* Маржа EBITDA идёт сразу за самой EBITDA: в отчёте это соседние
         строки, и рядом они читаются как одно предложение. */
      ['ebitdaMargin', 'Рентабельность по EBITDA', '%', 1],
      ['netProfit', 'Чистая прибыль', 'млрд ₽', 1],
      /* «н/с» = нескорректированная: то, что компания показала в отчёте,
         без поправок на разовые статьи. У Газпрома за 2023 скорректированная
         726 млрд, а в отчёте — убыток 629 млрд. Рынок цитирует вторую,
         поэтому показываем обе и не делаем вид, что цифра одна. */
      ['netProfitNS', 'Чистая прибыль (как в отчёте)', 'млрд ₽', 1],
      ['netMargin', 'Чистота прибыли (маржа)', '%', 1],
      ['opEx', 'Операционные расходы', 'млрд ₽', 1],
      ['amort', 'Амортизация', 'млрд ₽', 1],
      ['interest', 'Процентные расходы', 'млрд ₽', 1],
    ],
  },
  {
    title: 'Баланс и долг',
    rows: [
      ['assets', 'Активы', 'млрд ₽', 1],
      ['netAssets', 'Чистые активы', 'млрд ₽', 1],
      ['bookValue', 'Балансовая стоимость', 'млрд ₽', 1],
      ['debt', 'Долг (общий)', 'млрд ₽', 1],
      ['cash', 'Наличность', 'млрд ₽', 1],
      ['netDebt', 'Чистый долг', 'млрд ₽', 1],
      ['debtEbitda', 'Долг/EBITDA', '×', 2],
      ['netDebtEbitda', 'Чистый долг/EBITDA', '×', 2],
      ['interestCoverage', 'Покрытие процентов', '×', 2],
    ],
  },
  {
    title: 'Денежный поток',
    rows: [
      ['opFcf', 'Операционный поток', 'млрд ₽', 1],
      ['capex', 'CAPEX (вложения)', 'млрд ₽', 1],
      ['capexRevenue', 'CAPEX к выручке', '%', 1],
      ['fcf', 'Свободный поток (FCF)', 'млрд ₽', 1],
      ['fcfPerShare', 'FCF на акцию', '₽', 1],
      ['fcfToEbitda', 'FCF к EBITDA', '%', 1],
    ],
  },
  {
    title: 'Оценка рынка',
    rows: [
      ['cap', 'Капитализация', 'млрд ₽', 1],
      ['ev', 'EV (стоимость с долгом)', 'млрд ₽', 1],
      ['eps', 'Прибыль на акцию', '₽', 1],
      ['bv', 'Балансовая стоимость акции', '₽', 1],
      ['fcfYield', 'Доходность FCF', '%', 1],
      ['shares', 'Акций', 'млн шт.', 1],
      ['freeFloat', 'В свободном обращении', '%', 1],
    ],
  },
  {
    title: 'Компания и персонал',
    rows: [
      ['employees', 'Сотрудников', 'тыс. чел.', 1, 1000],
      ['productivity', 'Выручка на сотрудника', 'млн ₽', 1],
      ['staffCost', 'Расходы на персонал', 'млрд ₽', 1],
      ['costPerEmployee', 'Расходы на сотрудника', 'тыс. ₽', 1],
    ],
  },
  {
    /* Есть только у нефтегазовых: у Северстали или Сбера этих строк
       в отчёте нет, и группа просто не показывается. */
    title: 'Добыча и переработка',
    rows: [
      ['oilProduction', 'Добыча нефти', 'млн т', 1],
      ['oilRefining', 'Переработка нефти', 'млн т', 1],
      ['gasProduction', 'Добыча газа', 'млрд м³', 1],
    ],
  },
];




/** Формат значения для таблицы: млрд ₽ — одним знаком, проценты — как есть. */
function fmtVal(v, digits) {
  if (v == null) return '—';
  return nf(v, digits);
}


/**
 * Изменение к прошлому году в процентах — та самая «маленькая арифметика»,
 * которой в карточке не хватало: под выручкой видно +18,8 %, под капиталом
 * −64,3 %, и не надо считать в голове.
 *
 * Делим на МОДУЛЬ прошлого значения: убыток, сменившийся прибылью
 * (−100 → +50), — это рост, и минус в знаменателе дал бы минус в ответе.
 *
 * Ноль в знаменателе — это не «бесконечный рост», а отсутствие базы:
 * процент от нуля не считается, поэтому возвращаем null, а не число.
 */
function chgPct(v, prev) {
  if (v == null || prev == null || prev === 0) return null;
  return (v - prev) / Math.abs(prev) * 100;
}

/** Показываем изменение только у сумм. У процентов и коэффициентов
 *  «изменение в процентах» читалось бы как процент от процента. */
const chgShown = unit => unit.includes('₽') || unit.includes('чел');

/* ── Пересказ цифр простыми словами ─────────────────────────────────
   Это НЕ редакционный разбор и не мнение о компании. Каждое предложение
   здесь — арифметика по той же таблице, что выше: сравнили первый и
   последний год, поделили одно на другое. Если данных для фразы нет,
   фраза не появляется вовсе — досочинять нечего.
   Никаких «стоит покупать», «недооценена», «перспективы» тут быть
   не может: это была бы инвестиционная рекомендация. */
function plainSummary(m, years, ltm) {
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

  const nd = at('netDebt', last), de = at('netDebtEbitda', last);
  if (nd != null && eb2 != null && eb2 > 0) {
    if (nd < 0) {
      out.push(`Чистого долга нет: наличности больше долга на ${mlrd(Math.abs(nd))}.`);
    } else {
      let s = `Чистый долг ${mlrd(nd)}`;
      /* Здесь именно ЧИСТЫЙ долг к EBITDA: строка про чистый долг, и
         подставлять сюда общий долг к EBITDA было бы неверно — это
         разные числа, у Х5 они расходятся в тринадцать раз. */
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

  /* Скользящие двенадцать месяцев — самая свежая точка, поэтому в конце
     и отдельной строкой: она отвечает на «а что сейчас», тогда как всё
     выше — про то, как менялось по годам. Источник считает её сам. */
  if (ltm && (ltm.revenue != null || ltm.ebitda != null)) {
    const parts = [];
    if (ltm.revenue != null) parts.push(`выручка ${mlrd(ltm.revenue)}`);
    if (ltm.ebitda != null) parts.push(`EBITDA ${mlrd(ltm.ebitda)}`);
    if (ltm.netProfit != null) parts.push(`чистая прибыль ${mlrd(ltm.netProfit)}`);
    out.push(`За последние 12 месяцев (на дату последнего отчёта): ${parts.join(', ')}.`);
  }

  return out;
}

export default function Fundamentals({ data, right }) {
  const fin = data?.fin;
  const div = data?.div;
  const q = data?.q;
  if (!fin && !div && !q) return null;

  const years = fin?.years || [];
  const m = fin?.metrics || {};

  /* Столбец «за 12 мес.» показываем только если он заполнен: столбец
     из одних прочерков только занимает место и путает. */
  const hasLtm = !!fin?.ltm && Object.keys(fin.ltm).length >= 5;

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
              {hasLtm && (
                /* Столбец «за 12 месяцев» — скользящий: не год отчёта,
                   а последние двенадцать месяцев на дату публикации.
                   Источник помечает его «LTM ?»: цифра досчитана, а не
                   взята из отчёта. Так и подписываем. */
                <th className="nosort" style={{ textAlign: 'right', borderLeft: '1px solid var(--line, #2a2a2a)' }}>
                  за 12 мес.
                  <div className="c-3" style={{ fontSize: 9, fontWeight: 400 }}>скользящие</div>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {GROUPS.map(g => {
              /* Показываем группу только если хоть одна метрика есть */
              const hasAny = g.rows.some(([k]) => m[k]);
              if (!hasAny) return null;
              return (
                <FragmentRows key={g.title} group={g} m={m} years={years} ltm={hasLtm ? fin.ltm : null} />
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="c-3" style={{ fontSize: 10.5, marginTop: 10, lineHeight: 1.6 }}>
        Источник: smart-lab.ru (МСФО). Прочерк — показателя нет в отчёте или он не публиковался.
        За годы без отчётности источник подставляет ноль, и такой ноль мы показываем прочерком,
        а не нулём рублей: ноль, посчитанный из пустоты, — это не ноль, а отсутствие данных.
        Столбец <b>«за 12 мес.»</b> — скользящие двенадцать месяцев на дату последнего отчёта:
        он показывает, как дела сейчас, а не за прошлый год, и источник считает его сам.
        У банков и страховых выручки и EBITDA не бывает по природе их отчётности — там прочерк
        не пробел данных, а особенность учёта.
      </div>
    </Panel>
  ) : null;

  /* ── Пересказ цифр ── */
  const summary = plainSummary(m, years, hasLtm ? fin.ltm : null);
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
      if (!l) return null;
      /* Значение проходит общую отсечку: при знаменателе около нуля
         коэффициент неинформативен, и вместо «166×» показываем «н/д». */
      const v = ratioValue(r, l.value);
      const tone = v.na ? 'na' : v.tone;
      return {
        r, l, tone,
        text: v.na ? 'н/д' : ratioText(r, l.value),
        toneLabel: v.na ? (v.sanitized ? 'неинформативно' : TONE_LABEL.na) : TONE_LABEL[tone],
        hint: v.na ? v.why : r.hint,
        na: !!v.na,
      };
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
        {ratioItems.map(({ r, l, tone, text, toneLabel, hint, na }) => {
          const cls = TONE_CLS[tone];
          return (
            <div key={r.key} className="kpi-card" title={hint} style={{ cursor: 'help' }}>
              <div className="kpi-l">{r.label}</div>
              <div className={'kpi-v ' + cls}>
                {text}{!na && <span style={{ fontSize: 13 }}>{r.unit}</span>}
              </div>
              <div className="kpi-s">
                <span className={cls}>●</span> {toneLabel} · {l.year}
              </div>
            </div>
          );
        })}
      </div>

      {/* Легенда — как у оригинала. Смысл цветов без пояснения неочевиден:
          светофор стоит только у кредитных коэффициентов, а маржа и
          рентабельность серые, потому что без отрасли не оцениваются. */}
      <div style={{ marginTop: 12, fontSize: 11, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <span><span className="c-g">●</span> в норме</span>
        <span><span className="c-a">●</span> внимание</span>
        <span><span className="c-r">●</span> риск</span>
        <span className="c-3">серые — справочно, зависят от отрасли</span>
      </div>
      <div className="c-3" style={{ fontSize: 10.5, marginTop: 10, lineHeight: 1.65 }}>
        <b>Это наша оценка порогов, а не факт из отчёта.</b> Границы «нормы» зависят от отрасли:
        долг 3× EBITDA для девелопера и для нефтяной компании значат разное, а высокая маржа
        у ритейла и у IT несопоставима. Смотрите на цвет как на подсказку, куда глянуть,
        а не как на вывод о бумаге. Где знаменатель около нуля, вместо абсурдного коэффициента
        стоит «н/д» — это не «очень плохо», а «считать не из чего».
        Не является инвестиционной рекомендацией.
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

  /* ── Последние отчётные периоды ────────────────────────────────────
     Годовая таблица отвечает на вопрос «как менялось по годам», а эта
     панель — «что происходит сейчас»: свежие кварталы или полугодия
     с датами публикации. Именно это смотрят первым делом, и именно
     этого не хватало: по годам последняя точка — прошлый декабрь. */
  const periodsPanel = q?.periods?.length
    ? (() => {
      const last = q.periods.slice(-5);
      const ROWS = [
        ['revenue', 'Выручка', 'млрд ₽', 1],
        ['ebitda', 'EBITDA', 'млрд ₽', 1],
        ['opProfit', 'Операционная прибыль', 'млрд ₽', 1],
        ['netProfit', 'Чистая прибыль', 'млрд ₽', 1],
      ];
      const rows = ROWS.filter(([k]) => q.metrics?.[k]);
      if (!rows.length) return null;
      return (
        <Panel title="Последние отчётные периоды" style={{ marginBottom: 14 }}
          right={<span className="c-3" style={{ fontSize: 10.5 }}>МСФО, промежуточная отчётность</span>}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="nosort" style={{ textAlign: 'left' }}>Показатель</th>
                  {last.map(p => (
                    <th key={p.label} className="nosort" style={{ textAlign: 'right' }}>
                      {p.label}
                      {p.date && (
                        <div className="c-3" style={{ fontSize: 9, fontWeight: 400 }}>{p.date}</div>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(([key, label, unit, digits]) => (
                  <tr key={key}>
                    <td style={{ textAlign: 'left' }}>
                      {label} <span className="c-3" style={{ fontSize: 10 }}>{unit}</span>
                    </td>
                    {last.map(p => {
                      const v = q.metrics[key].values[p.label];
                      return (
                        <td key={p.label} style={{ textAlign: 'right' }} className="mono">
                          {v == null ? '—' : nf(v, digits)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="c-3" style={{ fontSize: 10.5, marginTop: 10, lineHeight: 1.6 }}>
            Подпись периода — <b>как её даёт источник</b>: это последний квартал периода,
            а не всегда сам квартал. Компания может отчитываться и за квартал, и за полугодие,
            поэтому «2026Q2» у одной значит три месяца, а у другой — шесть. Мы подпись
            не переписываем, чтобы не выдать полугодовую выручку за квартальную.
            Дата под подписью — когда отчёт опубликован. Сравнивать периоды одной компании
            между собой можно; между разными компаниями — только с этой оговоркой.
          </div>
        </Panel>
      );
    })()
    : null;

  return (
    <>
      {periodsPanel}
      {/* Коэффициенты — до отчётности. Сначала «что сейчас» и «сколько
          стоит», и только потом длинная таблица по годам: до неё эти
          четыре плитки приходилось искать прокруткой. */}
      {ratioCards}
      {finTable}
      {summaryPanel}
      {divTable}
    </>
  );
}

/** Строки одной группы: заголовок группы + её метрики. */
function FragmentRows({ group, m, years, ltm }) {
  return (
    <>
      <tr>
        <td colSpan={years.length + 1 + (ltm ? 1 : 0)} className="c-3"
          style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', paddingTop: 12 }}>
          {group.title}
        </td>
      </tr>
      {group.rows.map(([key, label, unit, digits, scale]) => {
        const metric = m[key];
        if (!metric) return null;
        return (
          <tr key={key}>
            <td style={{ textAlign: 'left' }}>
              {label} <span className="c-3" style={{ fontSize: 10 }}>{unit}</span>
            </td>
            {years.map((y, i) => {
              const v = metric.values[y];
              /* Отрицательный чистый долг — это деньги, а не долг: помечаем знаком. */
              const neg = key === 'netDebt' && v != null && v < 0;
              /* Изменение к прошлому году — под числом, как в карточке-образце.
                 У самого левого года прошлого нет, и выдумывать его нельзя:
                 получается пусто, а не «+0,0 %». */
              const chg = chgShown(unit) && i > 0 ? chgPct(v, metric.values[years[i - 1]]) : null;
              return (
                <td key={y} style={{ textAlign: 'right' }} className={'mono ' + (neg ? 'c-g' : '')}>
                  {v == null ? '—' : fmtVal(scale ? v / scale : v, digits)}
                  {chg != null && (
                    <div className={chgClass(chg)} style={{ fontSize: 9.5, fontWeight: 400 }}>
                      {chgArrow(chg)} {chg > 0 ? '+' : ''}{nf(chg, 1)}%
                    </div>
                  )}
                </td>
              );
            })}
            {ltm && (
              <td style={{ textAlign: 'right', borderLeft: '1px solid var(--line, #2a2a2a)' }} className="mono">
                {ltm[key] == null ? '—' : fmtVal(scale ? ltm[key] / scale : ltm[key], digits)}
              </td>
            )}
          </tr>
        );
      })}
    </>
  );
}