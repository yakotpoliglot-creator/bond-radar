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

function parseFinTable(html) {
  if (!html) return null;
  const tables = html.match(/<table[\s\S]*?<\/table>/g);
  if (!tables?.length) return null;

  const cellsOf = tr => [...tr.matchAll(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/g)]
    .map(c => c[0].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());

  const trs = [...tables[0].matchAll(/<tr[\s\S]*?<\/tr>/g)];
  const rows = trs.map(r => cellsOf(r[0]));
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

  /* ── Показатели ── */
  const metrics = {};
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
    metrics[key] = {
      label: label.replace(/\s*\([^)]*\)\s*/g, '').trim(),
      values,
    };
  }

  if (Object.keys(metrics).length < 5) return null;

  /* Даты отчёта по годам — для подписи в интерфейсе. */
  const reportDates = yearList.map(y => {
    const idx = Object.keys(yearAt).find(k => yearAt[k] === y);
    return dateAt[idx] || null;
  });

  return { years: yearList, reportDates, metrics };
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
  if (/^долг\b/i.test(l)) return 'debt';
  if (/наличность/i.test(l)) return 'cash';
  if (/опер\.?\s*денежный/i.test(l)) return 'opFcf';
  if (/^capex/i.test(l)) return 'capex';
  if (/^fcf\b/i.test(l) && млрд) return 'fcf';
  if (/^дивиденд.*руб/i.test(l)) return 'divPerShare';
  if (/див\.?\s*выплата/i.test(l)) return 'divPayment';
  if (/див\s*доход/i.test(l) || (/дивиденд/i.test(l) && /%/.test(l))) return 'divYield';
  if (/капитализация/i.test(l)) return 'cap';
  if (/^ev\/ebitda/i.test(l)) return 'evEbitda';
  if (/долг[/]ebitda/i.test(l)) return 'debtEbitda';
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
  let done = 0, err = 0, withFin = 0, withDiv = 0;

  for (const t of tickers) {
    // 1. МСФО-страница
    const finHtml = await fetch('https://smart-lab.ru/q/' + t.secid + '/f/y/');
    const fin = finHtml ? parseFinTable(finHtml) : null;
    await sleep(PAGE_DELAY_MS);

    // 2. Дивиденды
    const divHtml = await fetch('https://smart-lab.ru/q/' + t.secid + '/dividend/');
    const div = divHtml ? parseDividends(divHtml) : null;
    await sleep(PAGE_DELAY_MS);

    if (fin || div) {
      result.tickers[t.secid] = { n: t.shortname, fin, div };
      if (fin) withFin++;
      if (div) withDiv++;
    }
    done++;
    /* Логируем каждый тикер, а не каждый десятый. Робот идёт ~25 минут,
       и когда он замолкал, понять «работает или встал» было нельзя.
       Строк всего 262 — это дешевле, чем гадать по молчанию. */
    log(`${String(done).padStart(3)}/${tickers.length} · ${t.secid.padEnd(7)} · `
      + `${fin ? 'МСФО' : '—'} · ${div ? 'дивы' : '—'} · всего МСФО ${withFin}, див ${withDiv}`);
  }

  result.stats = {
    total: tickers.length,
    processed: done,
    withFinance: withFin,
    withDividends: withDiv,
    errors: err,
  };

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

export { parseFinTable, parseDividends, parseNum, metricKey };