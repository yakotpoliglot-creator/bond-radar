/**
 * Робот: собирает бухгалтерскую отчётность эмитентов из ГИР БО ФНС.
 *
 * ── Правовая основа ────────────────────────────────────────────────
 * ГИР БО (Государственный информационный ресурс бухгалтерской
 * отчётности) ведёт ФНС России по Федеральному закону № 402-ФЗ
 * «О бухгалтерском учёте», статья 18. Этот ресурс по закону является
 * публичным — государство само публикует эту отчётность.
 *
 * Мы сознательно соблюдаем четыре правила:
 *   1. Читаем только то, что ФНС публикует сама. Ничего не обходим,
 *      не авторизуемся, не подделываем заголовки.
 *   2. Если организация ограничила доступ к своим данным, ФНС отвечает
 *      «Organization closed for public use» — мы помечаем организацию
 *      как закрытую и идём дальше. Обходить этот запрет нельзя.
 *   3. Не собираем персональные данные. Запрашивается отчётность
 *      организаций по их ИНН, а ИНН эмитентов и так публичен в данных
 *      Московской биржи. ИНН пользователя не используется нигде.
 *   4. Соблюдаем вежливую нагрузку: пауза между запросами и честный
 *      User-Agent с ссылкой на проект.
 *
 * ── Что делает ─────────────────────────────────────────────────────
 *   1. Забирает у Московской биржи список эмитентов с ИНН
 *      (/iss/emitters.json — отдаёт EMITTER_ID, TITLE, INN пачками).
 *   2. Для каждого ИНН находит внутренний номер в ГИР БО.
 *   3. Забирает отчётность: выручку и активы по годам.
 *   4. Пишет public/girbo.json.
 *
 * Запускается по расписанию GitHub Actions раз в неделю. Отчётность
 * годовая, поэтому чаще не нужно.
 */

import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'public', 'girbo.json');

/* Честный User-Agent: сайт проекта указан, чтобы ФНС видела, кто ходит. */
const UA = 'BondRadar/1.0 (open-source bond screener; +https://github.com/yakotpoliglot-creator/bond-radar)';

/* Вежливая пауза между запросами к ФНС, чтобы не создавать нагрузку. */
const FNS_DELAY_MS = 250;
const MOEX_DELAY_MS = 120;

/* Сколько лет отчётности хранить. Годовая отчётность, 6 лет достаточно. */
const MAX_YEARS = 6;

/* Если собрали меньше этой доли эмитентов — считаем прогон неудачным
   и НЕ перезаписываем прошлый файл. Лучше старое, чем обрезанное. */
const MIN_COVERAGE = 0.35;

/* И дополнительно: новый прогон не должен быть заметно беднее прошлого.
   Так мы ловим не «мало эмитентов вообще», а «в этот раз отвалилось
   полсети» — именно этот случай портит файл. */
const MIN_GROWTH_VS_PREVIOUS = 0.8;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJson(url, { label = '', retries = 3, delay = FNS_DELAY_MS } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(30000),
      });

      /* 404 и 400 — это осмысленный ответ, повторять не нужно. */
      if (r.status === 400 || r.status === 404) {
        const text = await r.text();
        let msg = '';
        try { msg = JSON.parse(text).message || ''; } catch { /* не JSON */ }
        return { ok: false, status: r.status, message: msg, closed: /closed for public use/i.test(msg) };
      }

      if (!r.ok) throw new Error(`HTTP ${r.status}`);

      const data = await r.json();
      await sleep(delay);
      return { ok: true, data };
    } catch (e) {
      if (attempt === retries) {
        console.log(`      ! ${label || url}: ${e.message}`);
        return { ok: false, status: 0, message: e.message };
      }
      await sleep(500 * attempt);
    }
  }
  return { ok: false, status: 0, message: 'недостижимо' };
}

/* ── Шаг 1. Список эмитентов Московской биржи с ИНН ───────────────── */
async function moexEmitters() {
  const out = [];
  let start = 0;
  const limit = 100;

  for (let page = 0; page < 100; page++) {
    const url = `https://iss.moex.com/iss/emitters.json?iss.meta=off&iss.json=extended`
      + `&iss.only=emitters,emitters.cursor&limit=${limit}&start=${start}`;
    const r = await fetchJson(url, { label: 'список эмитентов MOEX', delay: MOEX_DELAY_MS });
    if (!r.ok) break;

    const rows = r.data?.[1]?.emitters || [];
    const cursor = r.data?.[1]?.['emitters.cursor']?.[0];
    const total = cursor?.TOTAL ?? 0;

    for (const row of rows) {
      const inn = String(row.INN || '').trim();
      if (/^\d{10}(\d{2})?$/.test(inn)) {
        out.push({ emitterId: row.EMITTER_ID, title: row.TITLE, inn });
      }
    }

    if (!rows.length || start + limit >= total) break;
    start += limit;
  }

  return out;
}

/* ── Шаг 2. ИНН → внутренний номер в ГИР БО ───────────────────────── *
 * Внимание: ФНС возвращает ИНН обёрнутым в HTML-подсветку поиска —
 *   "inn": "<strong>9731004688</strong>"
 * Поэтому перед сравнением обязательно снимаем теги, иначе точное
 * совпадение не сработает никогда и робот не найдёт ни одну компанию.
 */
const stripTags = s => String(s == null ? '' : s).replace(/<[^>]*>/g, '').trim();

async function girboIdByInn(inn) {
  const url = `https://bo.nalog.gov.ru/advanced-search/organizations/search`
    + `?query=${inn}&page=0&size=20`;
  const r = await fetchJson(url, { label: `поиск ИНН ${inn}` });
  if (!r.ok) return { closed: r.closed, message: r.message };

  /* Поиск у ФНС нечёткий: проверяем, что вернулась именно наша организация. */
  const items = r.data?.content || [];
  const exact = items.find(o => stripTags(o.inn) === inn);
  if (!exact) return { notFound: true };
  return { id: exact.id, name: stripTags(exact.shortName) };
}

/* ── Шаг 3. Отчётность организации ────────────────────────────────── */
async function girboReport(id) {
  const r = await fetchJson(`https://bo.nalog.gov.ru/nbo/organizations/${id}`, { label: `отчётность ${id}` });
  if (!r.ok) return { closed: r.closed, message: r.message };

  const bfo = Array.isArray(r.data?.bfo) ? r.data.bfo : [];

  /* gainSum и actives ФНС отдаёт в тысячах рублей — переводим в рубли. */
  const years = bfo
    .filter(p => p && p.period)
    .map(p => ({
      year: Number(p.period),
      revenue: p.gainSum != null ? Math.round(Number(p.gainSum) * 1000) : null,
      assets: p.actives != null ? Math.round(Number(p.actives) * 1000) : null,
      publishedAt: p.actualBfoDate || null,
    }))
    .filter(y => Number.isFinite(y.year))
    .sort((a, b) => b.year - a.year)
    .slice(0, MAX_YEARS);

  return {
    name: r.data?.shortName || null,
    ogrn: r.data?.ogrn || null,
    years,
  };
}

/* ── Основной прогон ──────────────────────────────────────────────── */
async function main() {
  console.log('Робот отчётности ГИР БО ФНС');
  console.log('Источник: ФЗ № 402-ФЗ «О бухгалтерском учёте», ст. 18 — ресурс публичный.');
  console.log('Закрытые организации помечаем и не обходим.\n');

  console.log('Шаг 1. Забираем эмитентов Московской биржи…');
  const emitters = await moexEmitters();
  console.log(`  получено эмитентов с корректным ИНН: ${emitters.length}\n`);
  if (!emitters.length) {
    console.error('Не удалось получить список эмитентов. Файл не трогаем.');
    process.exit(1);
  }

  /* Уникальные ИНН: у одного эмитента может быть несколько записей. */
  const byInn = new Map();
  for (const e of emitters) if (!byInn.has(e.inn)) byInn.set(e.inn, e);
  console.log(`  уникальных ИНН: ${byInn.size}\n`);

  console.log('Шаг 2 и 3. Ищем организации в ГИР БО и забираем отчётность…');
  const result = {};
  let found = 0, closed = 0, notFound = 0, failed = 0, withYears = 0;
  let i = 0;

  for (const [inn, meta] of byInn) {
    i++;
    if (i % 25 === 0 || i === 1) {
      console.log(`  ${i}/${byInn.size} · найдено ${found} · закрыто ${closed} · без отчётности ${notFound}`);
    }

    const idRes = await girboIdByInn(inn);
    if (idRes.closed) { closed++; result[inn] = { closed: true, title: meta.title }; continue; }
    if (idRes.notFound || !idRes.id) { notFound++; continue; }

    const rep = await girboReport(idRes.id);
    if (rep.closed) { closed++; result[inn] = { closed: true, title: meta.title }; continue; }
    if (!rep || !Array.isArray(rep.years)) { failed++; continue; }

    found++;
    if (rep.years.length) withYears++;

    result[inn] = {
      girboId: idRes.id,
      title: meta.title || rep.name || null,
      name: rep.name || idRes.name || null,
      ogrn: rep.ogrn || null,
      years: rep.years,
    };
  }

  console.log(`\nИтог: найдено ${found}, из них с отчётностью ${withYears}; `
    + `закрыто организацией ${closed}; не найдено ${notFound}; сбоев ${failed}`);

  /* Защита от обрезанного файла: не перезаписываем при плохом покрытии. */
  const coverage = found / byInn.size;
  if (coverage < MIN_COVERAGE) {
    console.error(`\nПокрытие ${(coverage * 100).toFixed(0)} % ниже порога `
      + `${(MIN_COVERAGE * 100).toFixed(0)} %. Файл НЕ перезаписываем — `
      + `лучше прошлые данные, чем обрезанные.`);
    process.exit(1);
  }

  /* Второй предохранитель: сравниваем с прошлым прогоном. Если данных
     стало заметно меньше, значит отвалилась сеть, а не эмитенты исчезли. */
  if (existsSync(OUT)) {
    try {
      const prevObj = JSON.parse(readFileSync(OUT, 'utf8'));
      const prevFound = prevObj?.stats?.found ?? 0;
      if (prevFound > 0 && found < prevFound * MIN_GROWTH_VS_PREVIOUS) {
        console.error(`\nПрошлый прогон дал ${prevFound} организаций, этот — ${found}. `
          + `Похоже на сбой сети, а не на изменение данных. Файл НЕ перезаписываем.`);
        process.exit(1);
      }
    } catch { /* прошлый файл битый — не мешаем перезаписи */ }
  }

  /* Сортируем ключи по ИНН. Это важно: порядок обхода эмитентов у биржи
     может меняться от прогона к прогону, и тогда весь файл выглядел бы
     изменённым, хотя данные те же — робот коммитил бы каждую неделю
     гигантский бесполезный diff. С сортировкой результат детерминирован. */
  const sorted = {};
  for (const inn of Object.keys(result).sort()) sorted[inn] = result[inn];

  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'ГИР БО ФНС России (bo.nalog.gov.ru), ФЗ № 402-ФЗ ст. 18',
    note: 'Отчётность организаций по их ИНН. Организации с закрытым доступом помечены closed.',
    standard: 'РСБУ — российские стандарты бухгалтерского учёта, отчётность самого '
      + 'юридического лица (эмитента), а не консолидированная отчётность группы по МСФО.',
    stats: { emitters: byInn.size, found, withYears, closed, notFound, failed },
    organizations: sorted,
  };

  /* Пишем компактно: файл читает браузер, лишние пробелы ни к чему. */
  const next = JSON.stringify(payload);
  if (existsSync(OUT)) {
    const prev = readFileSync(OUT, 'utf8');
    try {
      const prevObj = JSON.parse(prev);
      const a = JSON.stringify({ ...prevObj, generatedAt: null, stats: null });
      const b = JSON.stringify({ ...payload, generatedAt: null, stats: null });
      if (a === b) {
        console.log('\nДанные не изменились — коммит не нужен.');
        return;
      }
    } catch { /* старый файл битый — перезапишем */ }
  }

  writeFileSync(OUT, next, 'utf8');
  console.log(`\nЗаписано: public/girbo.json (${(next.length / 1024).toFixed(0)} КБ)`);
}

main().catch(e => {
  console.error('Робот упал:', e.message);
  process.exit(1);
});