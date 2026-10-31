/* Пробник источников новостей.
 *
 * Цель — проверить то, что в прошлый раз осталось неизвестным: отвечают ли
 * новостные ленты с американских адресов GitHub Actions. Мои прошлые запросы
 * шли с домашней машины в России, и по ним нельзя было обещать, что робот
 * в CI получит те же ответы.
 *
 * Ничего не пишем и никуда не коммитим: только стучимся и печатаем, что
 * пришло. Запуск: node scripts/news-probe.mjs
 */

const UA = 'BondRadar/1.0 (open-source bond screener; +https://github.com/yakotpoliglot-creator/bond-radar)';

const SOURCES = [
  ['MOEX sitenews', 'https://iss.moex.com/iss/sitenews.json?iss.meta=off'],
  ['MOEX РБК-лента', 'https://iss.moex.com/iss/sitenews.json?iss.meta=off&limit=50'],
  ['Interfax RSS', 'https://www.interfax.ru/rss.asp'],
  ['RBC RSS', 'https://rssexport.rbc.ru/rbcnews/news/30/full.rss'],
  ['TASS RSS', 'https://tass.ru/rss/v2.xml'],
  ['Finam RSS', 'https://www.finam.ru/analysis/conews/rsspoint/'],
  ['Vedomosti RSS', 'https://www.vedomosti.ru/rss/news'],
  ['smart-lab RSS', 'https://smart-lab.ru/rss/'],
  ['Google News (рынок)', 'https://news.google.com/rss/search?q=%D0%BE%D0%B1%D0%BB%D0%B8%D0%B3%D0%B0%D1%86%D0%B8%D0%B8&hl=ru&gl=RU&ceid=RU:ru'],
  ['Прайм RSS', 'https://1prime.ru/export/rss.xml'],
  ['БКС Экспресс RSS', 'https://bcs-express.ru/rss'],
];

const TIMEOUT = 25000;

async function probe(name, url) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, accept: 'application/rss+xml,application/xml,application/json,text/xml,*/*' },
      signal: AbortSignal.timeout(TIMEOUT),
      redirect: 'follow',
    });
    const body = await res.text();
    const ms = Date.now() - started;
    const items = (body.match(/<item[\s>]/gi) || []).length || (body.match(/<entry[\s>]/gi) || []).length;
    const looksXml = /<\?xml|<rss|<feed/i.test(body);
    return { name, ok: res.ok, status: res.status, ms, kb: Math.round(body.length / 1024), items, looksXml, body };
  } catch (e) {
    return { name, ok: false, status: '—', ms: Date.now() - started, error: e.name + ': ' + e.message };
  }
}

console.log('Проверка источников новостей — так, как их видит GitHub Actions\n');
console.log('источник              HTTP   мс     КБ    записей  формат');
console.log('─'.repeat(66));

const results = [];
for (const [name, url] of SOURCES) {
  const r = await probe(name, url);
  results.push(r);
  const fmt = r.error ? r.error.slice(0, 30) : (r.looksXml ? 'XML/RSS' : 'не XML');
  console.log(
    name.padEnd(20) +
    String(r.status).padEnd(7) +
    String(r.ms).padEnd(7) +
    String(r.kb ?? '').padEnd(6) +
    String(r.items || '').padEnd(9) +
    fmt
  );
  await new Promise(s => setTimeout(s, 400));
}

const alive = results.filter(r => r.ok);
console.log(`\nОтветили: ${alive.length} из ${results.length}`);
console.log('Живые: ' + (alive.map(r => r.name).join(', ') || '—'));
console.log('Молчат: ' + (results.filter(r => !r.ok).map(r => r.name).join(', ') || '—'));

/* Что важно для связки «новость → эмитент»: называет ли источник бумагу
   в заголовке. Смотрим на живых лентах, а не на своих догадках. */
const moex = results.find(r => r.name === 'MOEX sitenews');
if (moex?.body) {
  try {
    const j = JSON.parse(moex.body);
    const cols = j.sitenews.columns, data = j.sitenews.data;
    const iT = cols.indexOf('title'), iD = cols.indexOf('published_at');
    console.log('\nЛента биржи — есть ли в заголовках названия бумаг:');
    const withIsin = data.filter(row => /[A-Z]{2}[A-Z0-9]{10}/.test(String(row[iT])));
    const withSec = data.filter(row => /ценной бумаги|ценных бумаг|облигац/i.test(String(row[iT])));
    console.log(`  записей всего: ${data.length}`);
    console.log(`  с ISIN в заголовке: ${withIsin.length}`);
    console.log(`  со словами про бумагу: ${withSec.length}`);
    console.log('  примеры:');
    for (const row of data.slice(0, 5)) {
      console.log(`    ${String(row[iD]).slice(0, 16)}  ${String(row[iT]).slice(0, 92)}`);
    }
  } catch (e) {
    console.log('\nленту биржи не разобрать: ' + e.message);
  }
}
