/**
 * fundamentals.mjs — робот сбора МСФО и дивидендов со smart-lab.ru
 *
 * Берёт список акций с Мосбиржи (TQBR), для каждой проверяет наличие
 * финансовой отчётности на smart-lab и, если есть, разбирает таблицу
 * (МСФО + коэффициенты) и страницу дивидендов.
 *
 * Результат — public/fundamentals.json.
 *
 * Сделано по тому же образцу, что ratings.mjs: предохранители,
 * честный User-Agent, паузы между запросами.
 */

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ── конфиг ──────────────────────────────────────────────────────── */
const SMARTLAB_UA = 'BondRadar/1.0 (open-source bond screener; +https://github.com/yakotpoliglot-creator/bond-radar)';
const PAGE_DELAY_MS = 1400;          // между страницами smart-lab
const RETRIES = 3;
const MIN_TICKERS = 100;             // защита от пустого результата

const DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(DIR, '..', 'public');
const OUT = join(PUBLIC, 'fundamentals.json');

/* ── утилиты ─────────────────────────────────────────────────────── */
const sleep = ms => new Promise(s => setTimeout(s, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

async function fetch(url, tries = RETRIES) {
  for (let i = 1; i <= tries; i++) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 30000);
    try {
      const r = await globalThis.fetch(url, { headers: { 'User-Agent': SMARTLAB_UA }, signal: c.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      /* Чтение тела — внутри того же таймаута. Раньше clearTimeout стоял
         до r.text(), и если тело ответа подвисало, ждать приходилось
         бесконечно: таймаут уже был снят, а abort не срабатывал.
         Робот на этом вставал насмерть — видел сам, пришлось снимать. */
      return await r.text();
    } catch (e) {
      if (i === tries) {
        log(`ОШИБКА ${url.slice(0, 80)} → ${e.message?.slice(0, 60) || ''}`);
        return null;
      }
      await sleep(2500 * i);
    } finally {
      clearTimeout(t);
    }
  }
}

/* ── Парсинг HTML-таблицы smart-lab ─────────────────────────────────
   Таблица МСФО /q/<TICKER>/f/y/:
   row 0: заголовок «Лукойл (LKOH): годовая финансовая отчётность МСФО»
   row 1: подзаголовок со вкладками
   row 2: годы-заголовки в cell[2..6]: 2021 2022 2023 2024 2025
   row 3: «Дата отчета» в cell[3..7]
   row 4+: метрики: cell[0]=название, cell[1]=«?», cell[3..7]=значения, cell[9]=LTM

   ГЛАВНОЕ ПРО СТОЛБЦЫ: данные лежат ровно на один столбец ПРАВЕЕ
   своего года. То есть значению в cell[3] соответствует год из
   cell[2], значению в cell[9] (LTM) — подпись в cell[8].
   Поэтому правило простое: значение из cell[i] → год из cell[i-1].

   Почему не по «Дате отчета», как я пробовал сначала: у части
   компаний даты пустые (Сургутнефтегаз) или дублируются, и тогда
   два разных года схлопывались в один, а значение затиралось.
   Проверка по годам-заголовкам сошлась с реальными цифрами
   на LKOH (2025 = 3 768), GAZP (2022 = 11 674), SBER (2021 = 1 251,
   2022 = 270,5), ROSN (2021 = 8 761) — точно, до десятых. */

/* ── Общее для обоих парсеров таблиц ───────────────────────────────
   Годовая и квартальная таблицы устроены одинаково: первая таблица
   на странице, строка показателей, подпись периода на клетку ЛЕВЕЕ
   своего значения. Поэтому и разбор общий. */
function tableRows(html) {
  if (!html) return [];
  const tables = html.match(/<table[\s\S]*?<\/table>/g);
  if (!tables?.length) return [];
  const cellsOf = tr => [...tr.matchAll(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/g)]
    .map(c => c[0].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
  return [...tables[0].matchAll(/<tr[\s\S]*?<\/tr>/g)].map(r => cellsOf(r[0]));
}

const round2 = v => Math.round(v * 100) / 100;

/** Показатели, которые храним по промежуточным периодам (см. пояснение ниже). */
const PERIOD_METRICS = new Set([
  'revenue', 'opProfit', 'ebitda', 'ebitdaMargin', 'netProfit', 'netMargin',
  'fcf', 'opFcf', 'netDebt', 'debt', 'cash', 'capex',
]);

function parseFinTable(html) {
  const rows = tableRows(html);
  if (rows.length < 6) return null;

  /* ── Карта «индекс столбца данных → год» ──────────────────────────
     Берём строку, где стоит 4+ четырёхзначных года, и сдвигаем
     каждый год на один столбец вправо: данные живут там. */
  let yearAt = null;          // { [индексДанных]: '2021' }
  let yearList = [];          // годы по порядку — как их показывать
  for (const row of rows) {
    const found = [];
    for (let i = 1; i < row.length; i++) {
      const v = (row[i] || '').trim();
      if (/^20\d\d$/.test(v)) found.push({ idx: i, year: v });
    }
    if (found.length >= 4) {
      yearAt = {};
      yearList = [];
      for (const { idx, year } of found) {
        yearAt[idx + 1] = year;
        yearList.push(year);
      }
      break;
    }
  }
  if (!yearAt || yearList.length < 4) return null;

  /* Даты отчёта — для подписи под годом. Тот же сдвиг не нужен:
     строка «Дата отчета» уже выровнена со значениями. */
  const dateAt = {};
  for (const row of rows) {
    if (/дата отчета/i.test(row[0] || '')) {
      for (let i = 1; i < row.length; i++) {
        const v = (row[i] || '').trim();
        if (/^\d{2}\.\d{2}\.\d{4}$/.test(v)) dateAt[i] = v;
      }
      break;
    }
  }

  /* ── Столбец LTM, он же «последние 12 месяцев» ────────────────────
     Лежит в ЭТОЙ ЖЕ таблице, отдельно за ним ходить не нужно. У Лукойла
     выручка за 2025 год 3 768 млрд, а LTM — 3 919: это скользящие
     двенадцать месяцев, то есть «как дела сейчас», а не за прошлый год.
     Подпись «LTM ?» стоит на клетку левее значения — правило то же,
     что и у годов. Вопросительный знак у источника означает, что
     значение досчитано, а не взято из отчёта; так и подпишем. */
  let ltmAt = null;
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      if (/^ltm/i.test((row[i] || '').trim())) { ltmAt = i + 1; break; }
    }
    if (ltmAt != null) break;
  }

  /* ── Показатели ── */
  const metrics = {};
  const ltm = {};
  const collisions = [];
  for (const row of rows) {
    const label = row[0] || '';
    if (!label) continue;
    /* Служебные строки шапки пропускаем: это не показатели. */
    if (/^(Годовые|Квартальные|Валюта|Дата отчета|Финансовый отчет|Скачать|Лукойл|Сбербанк|Газпром|Роснефть|Сургутнефтегаз)/i.test(label)) continue;

    const values = {};
    for (let i = 1; i < row.length; i++) {
      const year = yearAt[i];
      if (!year) continue;
      const num = parseNum(row[i]);
      if (num != null) values[year] = Math.round(num * 100) / 100;
    }
    if (Object.keys(values).length === 0) continue;

    const key = metricKey(label);
    if (!key) continue;
    /* Ключ занят другой строкой — не затираем. Именно молчаливая
       подмена одной строки другой и стоила нам CAPEX: сумма уступала
       место проценту. Если это случится снова, в логе робота будет
       видно, какие две строки столкнулись. */
    if (metrics[key]) {
      if (metrics[key].label !== label) {
        collisions.push(`${key}: «${metrics[key].label}» ← «${label}»`);
      }
      continue;
    }
    metrics[key] = {
      label: label.replace(/\s*\([^)]*\)\s*/g, '').trim(),
      values,
    };
    if (ltmAt != null) {
      const lv = parseNum(row[ltmAt]);
      if (lv != null) ltm[key] = round2(lv);
    }
  }

  if (Object.keys(metrics).length < 5) return null;

  /* ── Ноли, которые не ноли ──
     За год, по которому у компании нет отчётности, источник подставляет
     ноль. У Лукойла за 2022 год балансовая стоимость 0.00, чистый долг
     0.00 и производительность труда 0.00 — при том, что строки «Долг» и
     «Наличность» за этот год ПУСТЫЕ, то есть ноль посчитан из пустоты.
     Показать «0,0 млрд ₽» вместо прочерка — значит соврать, а в 2022 году
     у Лукойла был не ноль, а чистый долг около нуля со знаком минус.

     Поэтому для «пустого» года ноли считаем отсутствием данных. Пустым
     считаем год, в котором нет почти ни одной основной строки: выручки,
     EBITDA, активов, чистых активов, операционной и чистой прибыли.
     Настоящие нули при этом не теряются: год без отчётности не бывает
     годом с нулевой выручкой у работающей компании, а рыночные данные
     (капитализация, число акций) в такой год всё равно не ноли. */
  const CORE = ['revenue', 'ebitda', 'assets', 'netAssets', 'opProfit', 'netProfit'];
  let zerosDropped = 0;
  for (const y of yearList) {
    const present = CORE.filter(k => metrics[k]?.values[y] != null).length;
    if (present >= 2) continue;
    for (const metric of Object.values(metrics)) {
      if (metric.values[y] === 0) { delete metric.values[y]; zerosDropped++; }
    }
  }

  /* ── Коэффициенты, которые считаем сами ────────────────────────────
     Источник подписывает строку «Долг/EBITDA», а внутри лежит ЧИСТЫЙ
     долг к EBITDA (см. выше). Поэтому оба коэффициента считаем из строк
     «Долг», «Чистый долг» и «EBITDA», а готовое значение используем
     только там, где своих строк не хватает.

     Сверено с независимым сервисом по пяти годам X5: общий долг к EBITDA
     у нас 1,83 / 1,26 / 1,05 / 1,13 / 1,43 — у него 1,8 / 1,3 / 1,1 /
     1,1 / 1,4. Покрытие процентов источник не даёт вовсе, а без него не
     видно, выдерживает ли компания свою долговую ставку: у X5 оно упало
     с 9,7 раза до 4,7 за пять лет, и это важнее самой величины долга. */
  const at = (k, y) => metrics[k]?.values?.[y];
  const derive = (key, fn) => {
    const values = {};
    for (const y of yearList) {
      const v = fn(y);
      if (v != null && Number.isFinite(v)) values[y] = round2(v);
    }
    /* Пустая строка не нужна: интерфейс сам покажет прочерк там, где
       показателя нет, и лишняя строка из одних прочерков только мешает. */
    if (Object.keys(values).length) metrics[key] = { values };
  };

  derive('debtEbitda', y => {
    const d = at('debt', y), e = at('ebitda', y);
    return d != null && e > 0 ? d / e : null;
  });
  /* Свой расчёт надёжнее готового: он есть и там, где источника строка
     пустая, и он же подтверждает, что подмена в источнике именно такая. */
  derive('netDebtEbitda', y => {
    const nd = at('netDebt', y), e = at('ebitda', y);
    return nd != null && e > 0 ? nd / e : null;
  });
  derive('interestCoverage', y => {
    const e = at('ebitda', y), i = at('interest', y);
    return e != null && i > 0 ? e / i : null;
  });

  /* Те же три коэффициента за скользящие двенадцать месяцев: по ним видно
     нагрузку на сегодня, а не на конец прошлого года. */
  const deriveLtm = (key, v) => {
    if (v != null && Number.isFinite(v)) ltm[key] = round2(v);
  };
  deriveLtm('debtEbitda', ltm.debt != null && ltm.ebitda > 0 ? ltm.debt / ltm.ebitda : null);
  deriveLtm('netDebtEbitda', ltm.netDebt != null && ltm.ebitda > 0 ? ltm.netDebt / ltm.ebitda : null);
  deriveLtm('interestCoverage', ltm.ebitda != null && ltm.interest > 0 ? ltm.ebitda / ltm.interest : null);

  /* Даты отчёта по годам — для подписи в интерфейсе. */
  const reportDates = yearList.map(y => {
    const idx = Object.keys(yearAt).find(k => yearAt[k] === y);
    return dateAt[idx] || null;
  });

  return { years: yearList, reportDates, metrics, ltm, collisions, zerosDropped };
}

/**
 * Квартальная (промежуточная) таблица — те же показатели, но по периодам.
 *
 * Устроена как годовая: подпись периода на клетку ЛЕВЕЕ значения.
 * Проверено по датам отчётов: у Лукойла значение 1 908 стоит под подписью
 * «2025Q2», а рядом дата 29.08.2025 — это отчёт за первое полугодие 2025.
 * Следующее значение 1 860 под подписью «2025Q4» и дата 20.03.2026 — отчёт
 * за весь 2025 год. Сходятся все три, поэтому правило верное.
 *
 * ВАЖНО про подпись: «2025Q2» — это ПОСЛЕДНИЙ квартал периода, а не всегда
 * квартал. Лукойл отчитывается раз в полугодие, и у него «2025Q2» значит
 * полгода. Поэтому подпись показываем как есть и рядом дату публикации,
 * а не додумываем «за квартал»: иначе получилось бы, что полугодовая
 * выручка — это квартальная.
 */
function parseQuarterTable(html) {
  const rows = tableRows(html);
  if (rows.length < 6) return null;

  /* ── Карта «индекс столбца данных → подпись периода» ── */
  let labelAt = null;         // { [индексДанных]: '2025Q2' }
  let periodList = [];
  for (const row of rows) {
    const found = [];
    for (let i = 1; i < row.length; i++) {
      const v = (row[i] || '').trim();
      if (/^20\d\dQ[1-4]$/.test(v)) found.push({ idx: i, label: v });
    }
    if (found.length >= 2) {
      labelAt = {};
      periodList = [];
      for (const { idx, label } of found) {
        labelAt[idx + 1] = label;
        periodList.push(label);
      }
      break;
    }
  }
  if (!labelAt || periodList.length < 2) return null;

  /* Дата публикации отчёта — она выровнена со значениями напрямую. */
  const dateAt = {};
  for (const row of rows) {
    if (/дата отчета/i.test(row[0] || '')) {
      for (let i = 1; i < row.length; i++) {
        const v = (row[i] || '').trim();
        if (/^\d{2}\.\d{2}\.\d{4}$/.test(v)) dateAt[i] = v;
      }
      break;
    }
  }

  const metrics = {};
  for (const row of rows) {
    const label = row[0] || '';
    if (!label) continue;
    if (/^(Годовые|Квартальные|Валюта|Дата отчета|Финансовый отчет|Скачать)/i.test(label)) continue;

    const values = {};
    for (let i = 1; i < row.length; i++) {
      const period = labelAt[i];
      if (!period) continue;
      const num = parseNum(row[i]);
      if (num != null) values[period] = round2(num);
    }
    if (Object.keys(values).length === 0) continue;

    const key = metricKey(label);
    /* Периоды держим узким набором. Годовая таблица — это история, и там
       широта полезна; а здесь важно «что сейчас», и сорок пять показателей
       по пяти периодам на 213 компаний раздували файл почти вдвое ради
       строк, которых в карточке всё равно нет. Подписи строк тоже не
       храним: их даёт интерфейс, а в данных они дублировались 213 раз. */
    if (!key || metrics[key] || !PERIOD_METRICS.has(key)) continue;
    metrics[key] = { values };
  }
  if (Object.keys(metrics).length < 2) return null;

  const periods = periodList.map(p => {
    const idx = Object.keys(labelAt).find(k => labelAt[k] === p);
    return { label: p, date: dateAt[idx] || null };
  });

  return { periods, metrics };
}

/** Приводит название метрики к каноническому ключу для UI.
 *
 *  Порядок проверок важен, а незнакомое название возвращает null:
 *  лучше не показать показатель, чем сложить две разные строки в
 *  один ключ. Именно так и случилось с «Чистая прибыль» и «Чистая
 *  прибыль н/с» у Роснефти — вторая затирала первую по тем годам,
 *  где были обе, и получалась мешанина. */
function metricKey(label) {
  const l = label.toLowerCase().trim();
  const млрд = /млрд/.test(l);
  const процент = /%/.test(l);

  /* «н/с» = «нескорректированная» — это видно по ссылке в самой таблице:
     она ведёт на smart-lab.ru/finansoviy-slovar/Чистая прибыль
     нескорректированная. То есть «Чистая прибыль» — скорректированная
     (без разовых статей), а «н/с» — как в отчёте. У Газпрома за 2023
     это 726 против −629 млрд: рынок цитирует вторую. */
  if (/^чистая прибыль\s*н\/с/i.test(l)) return 'netProfitNS';
  if (/^чистая прибыль/i.test(l)) return 'netProfit';
  if (/^ebitda/i.test(l) && млрд) return 'ebitda';
  if (/^выручка/i.test(l) && млрд) return 'revenue';
  if (/операционная прибыль/i.test(l)) return 'opProfit';
  if (/амортизация/i.test(l)) return 'amort';
  if (/процентные расходы/i.test(l)) return 'interest';
  if (/^чистые активы/i.test(l)) return 'netAssets';
  if (/^активы/i.test(l)) return 'assets';
  if (/^чистый долг/i.test(l)) return 'netDebt';
  /* «Долг/EBITDA» — это коэффициент, и проверять его надо РАНЬШЕ общего
     долга, иначе он попадает под правило «Долг» и коэффициент теряется.
     Ровно это и случилось, когда правило долга починили: строка «Долг»
     начала находиться, а «Долг/EBITDA» — пропадать. Ловушка видна в
     отчёте робота как столкновение строк.

     Но и подпись источника врёт: под «Долг/EBITDA» лежит ЧИСТЫЙ долг к
     EBITDA. Проверено на шести компаниях — у X5 за 2024 год там 0,11
     (это 28,1 / 256,2), тогда как общий долг к EBITDA даёт 1,13; у МТС
     расхождение ещё резче, 1,55 против 4,17. Поэтому готовое значение
     кладём в netDebtEbitda, а общий долг к EBITDA считаем сами ниже,
     из строк «Долг» и «EBITDA». */
  if (/долг\s*\/\s*ebitda/i.test(l)) return 'netDebtEbitda';
  /* Здесь было /^долг\b/ — и не срабатывало НИКОГДА. В JavaScript
     \b определяется через \w, а \w — это только латиница и цифры,
     поэтому границы слова вокруг кириллицы не существует. Из-за
     этого строка «Долг» (общий долг, 318 млрд ₽ у Лукойла) целиком
     выпадала из данных, а в карточке стоял прочерк. Проверяем
     следующим символом, а не границей слова. Наклонную черту тоже
     исключаем: «Долг/EBITDA» обрабатывается строкой выше. */
  if (/^долг(?![а-яёa-z/])/i.test(l)) return 'debt';
  if (/наличность/i.test(l)) return 'cash';
  if (/опер\.?\s*денежный/i.test(l)) return 'opFcf';
  if (/^опер\.?\s*расходы/i.test(l)) return 'opEx';

  /* ── Почему проценты проверяем РАНЬШЕ абсолютных значений ──
     «CAPEX , млрд руб» и «CAPEX/Выручка , %» начинаются одинаково.
     Раньше обе уходили в один ключ capex, и вторая затирала первую:
     в карточке Лукойла CAPEX показывался как 9 «млрд ₽», хотя это
     9 % выручки, а сам CAPEX 782 млрд ₽ пропадал совсем. Правило
     простое: если у строки есть «%», это коэффициент, а не сумма. */
  if (/^capex/i.test(l) && процент) return 'capexRevenue';
  if (/^capex/i.test(l) && млрд) return 'capex';
  if (/^fcf\b/i.test(l) && процент) return 'fcfToEbitda';
  if (/^fcf\b/i.test(l) && млрд) return 'fcf';
  if (/^fcf.*акци/i.test(l)) return 'fcfPerShare';
  if (/доходность\s*fcf/i.test(l)) return 'fcfYield';
  if (/fcf.*ebitda/i.test(l)) return 'fcfToEbitda';

  /* Дивиденды: «Див доход, ао, %» — доходность к цене акции, а
     «Дивиденды/прибыль, %» — какая доля прибыли ушла на выплаты.
     Обе строки содержат и «дивиденд», и «%», поэтому раньше обе
     уходили в divYield: вторая затирала первую, и доходность к цене
     из отчётности исчезала. */
  if (/дивиденд.*руб/i.test(l)) return 'divPerShare';
  if (/див\.?\s*выплата/i.test(l)) return 'divPayment';
  if (/див\s*доход/i.test(l)) return 'divYield';
  if (/^дивиденды?\s*\/\s*прибыль/i.test(l) && процент) return 'payoutRatio';

  if (/капитализация/i.test(l)) return 'cap';
  if (/^ev\s*\/\s*ebitda/i.test(l)) return 'evEbitda';
  /* Строку «Долг/EBITDA» ловит правило выше — она тоже подходит под этот
     образец, но там она обрабатывается раньше и уходит в netDebtEbitda. */
  if (/^ev\b/i.test(l)) return 'ev';
  if (/^eps/i.test(l)) return 'eps';
  if (/bv\/акцию/i.test(l)) return 'bv';
  if (/рентаб\s*ebitda/i.test(l) || /ebitda.*маржа/i.test(l)) return 'ebitdaMargin';
  if (/чистая\s*рентаб/i.test(l)) return 'netMargin';
  if (/^roe/i.test(l)) return 'roe';
  if (/^roa/i.test(l)) return 'roa';
  if (/^p\/e/i.test(l)) return 'pe';
  if (/^p\/fcf/i.test(l)) return 'pfcf';
  if (/^p\/s/i.test(l)) return 'ps';
  if (/^p\/bv/i.test(l)) return 'pbv';

  /* ── Остальное, что есть в таблице и раньше пропадало ── */
  if (/^баланс\s*стоимость/i.test(l)) return 'bookValue';
  if (/^число\s*акций/i.test(l)) return 'shares';
  if (/^free\s*float/i.test(l)) return 'freeFloat';
  if (/^расх.*персонал/i.test(l)) return 'staffCost';
  if (/^персонал/i.test(l)) return 'employees';
  if (/произв\.?\s*труда/i.test(l)) return 'productivity';
  if (/расходы\s*\/\s*чел/i.test(l)) return 'costPerEmployee';
  if (/^r\s*&\s*d/i.test(l)) return 'rdCapex';
  if (/^добыча нефти/i.test(l)) return 'oilProduction';
  if (/^переработка нефти/i.test(l)) return 'oilRefining';
  if (/^добыча газа/i.test(l)) return 'gasProduction';
  return null;   // незнакомое — не выдумываем ключ
}

function parseNum(s) {
  if (!s || s === '—' || s === '-' || s === '?') return null;
  // «3 767.8» → 3767.8, «1 234» → 1234, «-0.3×» → -0.3
  const cleaned = s.replace(/\s/g, '').replace(/,/g, '.').replace(/[^\d.\-×]/g, '');
  const m = cleaned.match(/^(-?\d+(?:\.\d+)?)/);
  return m ? +m[1] : null;
}

/* ── парсинг дивидендов ────────────────────────────────────────────
   Вторая таблица — годовые сводки. Реальные подписи строк (проверено):
     row1: ["", "%", "", "2017", "2018", … "2025", "", "LTM"]   ← шапка
     row2: «Дивиденд, руб/акцию»      → perShare
     row3: «Див доход, ао, %»         → divYield
     row4: «Дивиденды/прибыль, %»     → payoutRatio
     row5: «Див.выплата, млрд руб»    → divPayment

   Годы берём ИЗ ШАПКИ, а не «первый столбец всегда 2017». У молодых
   компаний история короче: у БАЗИС шапка начинается с 2022, и жёсткая
   пятёрка с 2017 приписала бы его выплатам чужие годы.
   Годы в этой таблице стоят ровно над своими значениями, без сдвига
   (у МСФО сдвиг есть, здесь нет — проверено на Лукойле: 2017 → 215 ₽).

   ВАЖНО про порядок проверок. Правило для доходности раньше звучало как
   «в подписи есть „дивиденд“ и есть „%“» — и под него попадала ещё и
   строка «Дивиденды/прибыль, %». Строки идут по порядку, поэтому вторая
   затирала первую, и в колонке «Див. доходность» оказывался процент
   выплаты от прибыли. Это разные вещи: 46 % от прибыли и 6,4 % к цене.
   Поэтому проверяем от узкого к общему. */

function parseDividends(html) {
  if (!html) return null;
  const tables = html.match(/<table[\s\S]*?<\/table>/g);
  if (!tables?.length) return null;

  // Вторая таблица — годовые сводки
  const tab = tables.length >= 2 ? tables[1] : tables[0];
  const cellsOf = tr => [...tr.matchAll(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/g)]
    .map(c => c[0].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
  const trs = [...tab.matchAll(/<tr[\s\S]*?<\/tr>/g)];
  const rows = trs.map(r => cellsOf(r[0]));

  if (rows.length < 3) return null;

  /* Шапка: строка, где стоит хотя бы два четырёхзначных года. */
  let yearAt = null;
  for (const r of rows) {
    const map = {};
    let count = 0;
    for (let i = 0; i < r.length; i++) {
      if (/^20\d\d$/.test(r[i])) { map[i] = r[i]; count++; }
    }
    if (count >= 2) { yearAt = map; break; }
  }
  if (!yearAt) return null;

  const perShare = {}, divYield = {}, payoutRatio = {}, divPayment = {};

  for (const r of rows) {
    /* Подпись таблицы — одна ячейка, и в ней тоже есть слово «выплаты».
       Отсекаем такие строки, а не по числу столбцов: у короткой истории
       столбцов мало, и порог «не меньше 10» выкидывал её целиком. */
    if (r.length < 3) continue;

    const label = (r[0] || '').toLowerCase();
    if (!label) continue;
    const target =
      /^див\.?\s*доход/.test(label) ? divYield
      : /прибыл/.test(label) && label.includes('%') ? payoutRatio
      : /выплат/.test(label) ? divPayment
      : /дивиденд/.test(label) && label.includes('руб') && !label.includes('%') ? perShare
      : null;
    if (!target) continue;

    for (const [i, year] of Object.entries(yearAt)) {
      const num = parseNum(r[i]);
      if (num != null) target[year] = num;
    }
  }

  const nonEmpty = o => (Object.keys(o).length > 0 ? o : null);
  return Object.keys(perShare).length > 0
    ? {
      perShare,
      divYield: nonEmpty(divYield),
      payoutRatio: nonEmpty(payoutRatio),
      divPayment: nonEmpty(divPayment),
    }
    : null;
}

/* ── основной цикл ───────────────────────────────────────────────── */
async function main() {
  log('Загружаем список акций Мосбиржи (TQBR)…');

  const sharesData = await (async () => {
    const url = 'https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities.json?iss.meta=off&iss.only=securities';
    const text = await fetch(url);
    if (!text) { log('Не удалось загрузить список акций'); process.exit(1); }
    return JSON.parse(text);
  })();

  const cols = sharesData.securities.columns;
  const iSec = cols.indexOf('SECID');
  const iShort = cols.indexOf('SHORTNAME');
  const iSize = cols.indexOf('ISSUESIZE');
  const iType = cols.indexOf('SECTYPE');

  // Только обыкновенные акции (SECTYPE 1=обыкн, 2=привилегированные)
  const tickers = sharesData.securities.data
    .filter(r => /^[12]$/.test(String(r[iType] ?? '')))
    .map(r => ({ secid: r[iSec], shortname: r[iShort], issuesize: r[iSize] }));

  log(`Найдено ${tickers.length} акций на TQBR`);
  if (tickers.length < MIN_TICKERS) { log(`Слишком мало: ${tickers.length}`); process.exit(1); }

  const result = { generatedAt: new Date().toISOString(), source: 'smart-lab.ru', tickers: {} };
  let done = 0, err = 0, withFin = 0, withDiv = 0, withQ = 0;
  const allCollisions = [];

  for (const t of tickers) {
    // 1. МСФО-страница
    const finHtml = await fetch('https://smart-lab.ru/q/' + t.secid + '/f/y/');
    const fin = finHtml ? parseFinTable(finHtml) : null;
    await sleep(PAGE_DELAY_MS);

    // 2. Дивиденды
    const divHtml = await fetch('https://smart-lab.ru/q/' + t.secid + '/dividend/');
    const div = divHtml ? parseDividends(divHtml) : null;
    await sleep(PAGE_DELAY_MS);

    // 3. Промежуточная отчётность: последние периоды, а не только годы
    const qHtml = await fetch('https://smart-lab.ru/q/' + t.secid + '/f/q/');
    const q = qHtml ? parseQuarterTable(qHtml) : null;
    await sleep(PAGE_DELAY_MS);

    if (fin || div || q) {
      result.tickers[t.secid] = { n: t.shortname, fin, q, div };
      if (fin) withFin++;
      if (div) withDiv++;
      if (q) withQ++;
      /* Столкновение строк — это сигнал, что правило разбора надо
         уточнить: две разные строки таблицы претендуют на один ключ. */
      if (fin?.collisions?.length) {
        allCollisions.push(`${t.secid} · ${fin.collisions.join(' | ')}`);
      }
    }
    done++;
    /* Логируем каждый тикер, а не каждый десятый. Робот идёт ~25 минут,
       и когда он замолкал, понять «работает или встал» было нельзя.
       Строк всего 262 — это дешевле, чем гадать по молчанию. */
    log(`${String(done).padStart(3)}/${tickers.length} · ${t.secid.padEnd(7)} · `
      + `${fin ? 'МСФО' : '—'} · ${q ? 'периоды' : '—'} · ${div ? 'дивы' : '—'} · `
      + `всего МСФО ${withFin}, периодов ${withQ}, див ${withDiv}`);
  }

  result.stats = {
    total: tickers.length,
    processed: done,
    withFinance: withFin,
    withPeriods: withQ,
    withDividends: withDiv,
    errors: err,
    collisions: allCollisions.length,
  };
  if (allCollisions.length) {
    log(`Столкновений строк: ${allCollisions.length}. Первые 15:`);
    allCollisions.slice(0, 15).forEach(c => log('  ' + c));
  }

  writeFileSync(OUT, JSON.stringify(result, null, 1));
  log(`Готово: ${withFin} с МСФО, ${withDiv} с дивидендами · ${OUT}`);
}

/* Запуск только при прямом вызове файла. Так парсеры можно
   импортировать в проверочный скрипт и гонять на нескольких
   компаниях, не поднимая обход всех 262 бумаг. */
const invokedDirectly = process.argv[1]
  && process.argv[1].replace(/\\/g, '/').endsWith('scripts/fundamentals.mjs');

if (invokedDirectly) {
  main().catch(e => { log('КРИТИЧЕСКАЯ ОШИБКА:', e.message); process.exit(1); });
}

export { parseFinTable, parseQuarterTable, parseDividends, parseNum, metricKey };