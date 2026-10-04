/* Робот допуска выпусков.
 *
 * ЧТО СОБИРАЕМ. Биржевой признак «Бумаги для квалифицированных инвесторов»
 * (в описании бумаги — ISQUALIFIEDINVESTORS): 1 — выпуск предназначен только
 * для квалифицированных инвесторов, 0 — доступен всем. На сайте по нему
 * работает фильтр «Допуск» и пометка «квал» в списке выпусков.
 *
 * ПОЧЕМУ РОБОТ, А НЕ БРАУЗЕР. Пачкой этот признак не отдаётся: проверено и на
 * списочном блоке площадок TQCB/TQOB (47 полей — признака нет), и на
 * агрегатном /iss/securities.json (14 полей — нет), и на параметрах
 * securities=/iss.only=description (игнорируются, приходит обычный список из
 * 100 бумаг). Признак лежит только в описании КОНКРЕТНОЙ бумаги:
 * /iss/securities/{SECID}.json. Значит, цена вопроса — один запрос на выпуск,
 * около 3 100 запросов за прогон. Из браузера так делать нельзя: три тысячи
 * запросов из каждого браузера — это и грубо, и медленно. Поэтому обходим
 * выпуски раз в сутки и кладём рядом с сайтом файл public/qual.json — тем же
 * приёмом, что рейтинги (scripts/ratings.mjs), ГИР БО и первичку.
 *
 * ПРАВАЯ СТОРОНА ВОПРОСА. ISS MOEX — открытый интерфейс биржи, авторизации не
 * требует, robots.txt обращений к /iss/ не запрещает. Ходим честным
 * User-Agent, не больше пяти запросов одновременно, с паузой и повторами;
 * всего один прогон в сутки.
 *
 * ЧЕГО В ДАННЫХ НЕТ (и мы не выдумываем):
 *   · решения о допуске конкретного человека — его принимает брокер, а не
 *     сайт: биржевой признак говорит лишь, для кого выпуск предназначен;
 *   · правил ЦБ про флоатеры и структурные выпуски — у нас их нет, поэтому
 *     фильтр опирается ТОЛЬКО на биржевой признак;
 *   · бумаг, по которым биржа ответа не дала: они в файл не попадают, и сайт
 *     честно говорит, сколько выпусков проверено, а не додумывает за биржу.
 *
 * Запуск: node scripts/qual.mjs            — полный обход (2–5 минут)
 *         node scripts/qual.mjs --limit 40 — проверка на выборке
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'public', 'qual.json');

const ISS = 'https://iss.moex.com/iss';
/* Площадки, из которых собран список выпусков на сайте (см. BOND_BOARDS в
   src/api/moex.js). Если там появятся новые, их надо добавить и здесь. */
const BOARDS = ['TQCB', 'TQOB'];

const UA = 'BondRadar/1.0 (open-source bond screener; +https://github.com/yakotpoliglot-creator/bond-radar)';
const CONCURRENCY = 5;      // одновременно не больше пяти обращений
const PAUSE_MS = 150;       // пауза после каждого запроса: биржа не должна нас замечать
const RETRIES = 3;
const TIMEOUT_MS = 20000;
const MIN_COVERAGE = 0.95;  // меньше — значит биржа поменяла поля или режет нас

const sleep = ms => new Promise(s => setTimeout(s, ms));

const limitArg = (() => {
  const i = process.argv.indexOf('--limit');
  if (i < 0) return null;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : null;
})();

/** Запрос JSON с повторами: сеть рвётся и дома, и в раннере. */
async function getJson(url, attempts = RETRIES) {
  let lastError = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastError = e;
      await sleep(400 * i * i);
    }
  }
  throw lastError || new Error('не удалось');
}

/** Список выпусков площадки. Биржа отдаёт его целиком, страницами не режет. */
async function boardSecids(board) {
  const j = await getJson(`${ISS}/engines/stock/markets/bonds/boards/${board}/securities.json?iss.meta=off&iss.only=securities`);
  const cols = j.securities?.columns || [];
  const i = cols.indexOf('SECID');
  if (i < 0) throw new Error(`${board}: в ответе нет колонки SECID`);
  return (j.securities.data || []).map(r => r[i]).filter(Boolean);
}

/** Допуск одной бумаги: 1, 0 или null (биржа признак не отдала). */
async function qualFlag(secid) {
  const j = await getJson(`${ISS}/securities/${encodeURIComponent(secid)}.json?iss.meta=off`);
  const row = (j.description?.data || []).find(x => x[0] === 'ISQUALIFIEDINVESTORS');
  if (!row) return null;
  const v = String(row[2]);
  return v === '1' ? 1 : v === '0' ? 0 : null;
}

const boards = await Promise.all(BOARDS.map(async board => {
  const ids = await boardSecids(board);
  console.log(`${board}: ${ids.length} выпусков`);
  return ids;
}));
let secids = [...new Set(boards.flat())];
if (limitArg) secids = secids.slice(0, limitArg);
console.log(`Всего выпусков к обходу: ${secids.length}${limitArg ? ` (проверка на выборке --limit ${limitArg})` : ''}`);

const bySecid = {};
const unknown = [];
let done = 0;
const queue = [...secids];
const started = Date.now();

await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length) {
    const secid = queue.shift();
    const v = await qualFlag(secid).catch(() => null);
    if (v === null) unknown.push(secid); else bySecid[secid] = v;
    done++;
    if (done % 250 === 0) {
      const left = Math.round((Date.now() - started) / done * (secids.length - done) / 1000);
      console.log(`  проверено ${done} из ${secids.length}, осталось ~${left} с`);
    }
    await sleep(PAUSE_MS);
  }
}));

const qualOnly = Object.values(bySecid).filter(v => v === 1).length;
const forAll = Object.values(bySecid).filter(v => v === 0).length;
const coverage = secids.length ? (secids.length - unknown.length) / secids.length : 0;

const out = {
  generatedAt: new Date().toISOString(),
  source: 'Московская Биржа: ISS, описание каждого выпуска (/iss/securities/{SECID}.json), поле ISQUALIFIEDINVESTORS',
  note: 'Биржа отдаёт признак «бумаги для квалифицированных инвесторов» только по одной бумаге — пачкой его нет ни в списочных блоках площадок, ни в агрегатном списке ISS. 1 — выпуск предназначен только для квалифицированных инвесторов, 0 — доступен всем. Бумаги, по которым ответа нет, в файл не попадают: сайт честно показывает, сколько выпусков проверено.',
  boards: BOARDS,
  counts: { total: secids.length, forAll, qualOnly, unknown: unknown.length },
  coverage: Number(coverage.toFixed(4)),
  partial: unknown.length > 0,
  bySecid,
};

writeFileSync(OUT, JSON.stringify(out) + '\n');
console.log(`\nТолько для квалов: ${qualOnly} | для всех: ${forAll} | без ответа: ${unknown.length}`);
console.log(`Покрытие: ${(coverage * 100).toFixed(1)} % → ${OUT}`);

if (coverage < MIN_COVERAGE) {
  console.error(`\nПокрытие ниже ${(MIN_COVERAGE * 100).toFixed(0)} % — похоже, биржа поменяла поля или режет нас.`);
  console.error('Файл записан, но он неполный: на сайте это будет видно («проверено N из M»).');
  process.exit(1);
}
