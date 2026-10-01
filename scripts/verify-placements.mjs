/* Проверка разбора на живых страницах биржи — без полного сбора.
   Запуск: node scripts/verify-placements.mjs [id ...] */
import { htmlToLines, bodyOf, kindOf, matchLabel, fieldsOf, splitIssueBlocks, recordFromFields } from './placements.mjs';

const UA = 'BondRadar/1.0 (open-source bond screener; +https://github.com/yakotpoliglot-creator/bond-radar)';
const ISS = 'https://iss.moex.com/iss';

/* Берём подписи из ленты, чтобы у страницы и разбора был один заголовок. */
async function feedTitles() {
  const map = new Map();
  for (let start = 0; start < 1200; start += 50) {
    const r = await fetch(`${ISS}/sitenews.json?iss.meta=off&iss.json=extended&start=${start}`, { headers: { 'User-Agent': UA } });
    const j = await r.json();
    for (const n of j[1].sitenews || []) map.set(String(n.id), n);
  }
  return map;
}

const feed = await feedTitles();
const ids = process.argv.slice(2).length ? process.argv.slice(2)
  : [...feed.keys()].slice(0, 200);

const stat = { checked: 0, byKind: {}, noFields: [], records: 0 };
for (const id of ids) {
  const item = feed.get(String(id));
  if (!item) continue;
  const kind = kindOf(item.title);
  if (!kind) continue;
  const html = await (await fetch(`https://www.moex.com/n${id}/?nt=101`, { headers: { 'User-Agent': UA } })).text();
  const lines = bodyOf(htmlToLines(html), item.title);
  const parsed = lines.filter(s => matchLabel(s)).length;
  stat.checked++;
  stat.byKind[kind] = (stat.byKind[kind] || 0) + 1;
  if (!parsed) stat.noFields.push(id);

  if (kind === 'results') {
    const blocks = splitIssueBlocks(lines);
    const regs = lines.filter(s => /^(Регистрационный|Идентификационный|Государственный регистрационный)\s*(номер|.*номер выпуска)/i.test(s)).length;
    if (blocks.length !== regs) {
      console.log(`  ${id}: блоков ${blocks.length}, строк с регномером ${regs} — РАСХОЖДЕНИЕ`);
      lines.filter(s => /номер выпуска/i.test(s)).forEach(s => console.log('     ', JSON.stringify(s).slice(0, 130), matchLabel(s) ? 'распознана' : 'НЕ распознана'));
    }
    stat.records += blocks.length;
  } else {
    const { val } = fieldsOf(lines);
    const rec = recordFromFields({ kind, id, title: item.title, publishedAt: item.published_at, url: '', issuer: null, val });
    const filled = ['isin', 'placementStart', 'regNumber', 'book', 'priceRub', 'mode'].filter(k => rec[k]).length;
    if (filled < 2) console.log(`  ${id} [${kind}]: мало полей (${filled}) — ${String(item.title).slice(0, 70)}`);
    stat.records += 1;
  }
  await new Promise(s => setTimeout(s, 150));
}

console.log(`\nПроверено страниц: ${stat.checked} — ${JSON.stringify(stat.byKind)}`);
console.log(`Записей получилось бы: ${stat.records}`);
console.log(`Страниц без распознанных полей: ${stat.noFields.length} ${stat.noFields.slice(0, 10).join(', ')}`);
