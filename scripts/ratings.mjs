/* Робот кредитных рейтингов.
 *
 * Откуда берём. Таблица котировок облигаций на smart-lab.ru: у каждой
 * строки есть значок рейтинга (ячейка class="bond-rating bond-rating--NN")
 * и ссылка на выпуск с ISIN. Список листается страницами по 100 выпусков,
 * всего 16 страниц. ISIN — тот самый ключ, по которому наши данные биржи
 * связываются с рейтингом, ничего сопоставлять по названиям не нужно.
 *
 * Почему робот, а не браузер. Страница отдаётся без CORS, из браузера её
 * прочитать нельзя (проверено: заголовка access-control-allow-origin нет).
 *
 * Правая сторона вопроса. robots.txt smart-lab.ru для обычных роботов
 * /q/bonds/ НЕ запрещает — запрещены /r.php, /print/ и служебные разделы.
 * Ходим с честным User-Agent и контактом, с паузой между запросами, всего
 * шестнадцать обращений в сутки. Ничего не обходим, не авторизуемся и не
 * подделываем заголовки; на сайте у каждой бумаги стоит ссылка на
 * первоисточник.
 *
 * ЧЕГО В ИСТОЧНИКЕ НЕТ (и мы не выдумываем):
 *   · агентства — значок рейтинга показан без указания, АКРА это, Эксперт
 *     РА или НРА, и без даты присвоения;
 *   · рейтинга выпуска против рейтинга эмитента — в таблице одно значение
 *     на строку, и оно относится к эмитенту;
 *   · рейтинга для бумаг, которых в списке smart-lab нет вовсе.
 * Поэтому на сайте это подписано как ориентир с указанием источника, а не
 * как рейтинг из отчёта агентства.
 *
 * Запуск: node scripts/ratings.mjs
 */
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'public', 'ratings.json');

const BASE = 'https://smart-lab.ru';
const LIST_PATH = '/q/bonds/';
/* Порядок сортировки берём из ссылок самой пагинации: сайт листает
   именно этот порядок, и подменять его своим нельзя — иначе страницы
   будут пересекаться и выпуски потеряются. */
const PAGE_PATH = n => `/q/bonds/order_by_val_to_day/desc/page${n}/`;

const UA = 'BondRadar/1.0 (open-source bond screener; +https://github.com/yakotpoliglot-creator/bond-radar)';
const PAGE_DELAY_MS = 1500;   // пауза между страницами: сайт не должен нас замечать
const MAX_PAGES = 40;         // предохранитель: сейчас страниц 16
const MIN_RATED = 700;        // меньше — значит сайт поменял разметку или отдал огрызок
const RETRIES = 3;

const sleep = ms => new Promise(s => setTimeout(s, ms));

/** Запрос страницы с повторами: сеть рвётся и на домашней машине, и в раннере. */
async function fetchPage(url, attempts = RETRIES) {
  let lastError = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'ru-RU,ru;q=0.9',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      if (body.length < 20000) throw new Error(`страница подозрительно мала: ${body.length} байт`);
      return body;
    } catch (e) {
      lastError = e;
      if (i < attempts) await sleep(2000 * i);
    }
  }
  throw lastError;
}

/**
 * Строки таблицы: ISIN, значок рейтинга и код шкалы.
 *
 * Разбираем по строке целиком, а не по номеру ячейки: столбцы у сайта
 * меняются (в августе 2026 между «Имя» и «Лет до погаш.» добавился
 * столбец с графиком), и привязка к номеру однажды тихо сломалась бы.
 * Ячейка рейтинга помечена классом bond-rating, ссылка на выпуск — в той
 * же строке, так что пара «ISIN → рейтинг» собирается без догадок.
 */
function rowsFrom(html) {
  const out = [];
  for (const tr of html.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const isin = (tr.match(/\/q\/bonds\/(RU[0-9A-Z]{10})\//) || [])[1];
    if (!isin) continue;
    const symbol = (tr.match(/class="bond-rating[^"]*"[^>]*>([^<]*)</) || [])[1];
    const code = (tr.match(/bond-rating--(\d+)/) || [])[1];
    out.push({
      isin,
      rating: symbol ? symbol.replace(/&nbsp;/g, ' ').trim() : null,
      code: code ? Number(code) : null,
    });
  }
  return out;
}

/** Номера страниц из пагинации — чтобы не угадывать их количество. */
function pagesFrom(html) {
  const nums = [...html.matchAll(/href="\/q\/bonds\/[^"]*page(\d+)\/?"/gi)].map(m => Number(m[1]));
  return nums.length ? Math.max(...nums) : 1;
}

async function main() {
  /* Прошлый файл: рейтинги меняются редко, и если данные те же, коммит
     робота был бы пустым шумом. Сравниваем без служебных полей. */
  const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;

  const first = await fetchPage(BASE + LIST_PATH);
  const totalPages = Math.min(pagesFrom(first), MAX_PAGES);
  console.log(`Список: страниц ${totalPages} (по 100 выпусков)`);

  const ratings = {};
  const scale = {};
  const byRating = {};
  let scannedRows = 0;
  let failedPages = 0;

  for (let n = 1; n <= totalPages; n++) {
    let html = null;
    try {
      html = n === 1 ? first : await fetchPage(BASE + PAGE_PATH(n));
    } catch (e) {
      failedPages++;
      console.log(`  страница ${n}: сбой — ${e.message}`);
      continue;
    }
    const rows = rowsFrom(html);
    scannedRows += rows.length;
    for (const r of rows) {
      if (!r.rating) continue;
      ratings[r.isin] = { r: r.rating, c: r.code };
      if (r.code != null) scale[r.code] = r.rating;
      byRating[r.rating] = (byRating[r.rating] || 0) + 1;
    }
    if (n < totalPages) await sleep(PAGE_DELAY_MS);
  }

  const rated = Object.keys(ratings).length;
  console.log(`Строк просмотрено: ${scannedRows}, с рейтингом: ${rated}, сбоев страниц: ${failedPages}`);

  /* Предохранитель: если разметка поменялась, рейтингов окажется мало или
     не будет вовсе. Тогда файл НЕ трогаем — лучше старые данные, чем
     пустая колонка на сайте. */
  if (rated < MIN_RATED) {
    console.error(`Рейтингов всего ${rated} (меньше ${MIN_RATED}) — похоже, сайт поменял разметку. Файл не тронут.`);
    process.exit(1);
  }
  /* Второй предохранитель: почти все страницы упали — тоже не пишем. */
  if (failedPages > totalPages / 3) {
    console.error(`Не прочитано страниц: ${failedPages} из ${totalPages}. Файл не тронут.`);
    process.exit(1);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    source: `${BASE}${LIST_PATH}`,
    note: 'Кредитные рейтинги по данным таблицы котировок smart-lab.ru. '
      + 'Агентство и дата присвоения в источнике не указаны, поэтому это ориентир, '
      + 'а не выписка из отчёта рейтингового агентства. Рейтинг относится к эмитенту. '
      + 'По бумагам, которых в списке источника нет, рейтинга не будет.',
    stats: {
      pages: totalPages,
      failedPages,
      rowsScanned: scannedRows,
      withRating: rated,
      coveragePercent: scannedRows ? Math.round(rated / scannedRows * 1000) / 10 : 0,
      byRating,
    },
    scale,
    ratings,
  };

  /* Пишем только при изменении: иначе робот коммитил бы одно и то же. */
  if (prev) {
    const a = JSON.stringify({ ...prev, generatedAt: null, stats: null });
    const b = JSON.stringify({ ...payload, generatedAt: null, stats: null });
    if (a === b) {
      console.log('Данные не изменились — файл не перезаписываем.');
      return;
    }
  }

  writeFileSync(OUT, JSON.stringify(payload));
  const kb = Math.round(JSON.stringify(payload).length / 1024);
  console.log(`Записано: public/ratings.json (${kb} КБ, ${rated} рейтингов, покрытие ${payload.stats.coveragePercent}%)`);
}

/* Разбор вынесен в экспорт для точечной проверки. */
export { rowsFrom, pagesFrom };

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch(e => {
    console.error('Робот упал:', e.message);
    process.exit(1);
  });
}
