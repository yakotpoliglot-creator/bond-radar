/* Проверка data-слоя на реальных данных MOEX (Node 18+ имеет fetch) */
import {
  fetchBonds, couponKind, issuerKey, COLLECTIONS, daysUntil,
  fetchYieldCurve, fetchBondCard, fetchIssuerInfo, bondsOfIssuer,
} from '../src/api/moex.js';

const bonds = await fetchBonds();
console.log('=== fetchBonds() ===');
console.log('всего:', bonds.length);

// 1. Санити доходности
const bad = bonds.filter(b => !b.ytmOk && b.ytmRaw != null);
const shown = bonds.filter(b => b.ytm != null);
console.log('с доходностью:', shown.length, '| помечено аномальными:', bad.length);
console.log('макс показанная YTM:', Math.max(...shown.map(b => b.ytm)).toFixed(2));
console.log('макс сырая YTM:', Math.max(...bonds.filter(b=>b.ytmRaw!=null).map(b => b.ytmRaw)).toFixed(2));
const avtoa = bonds.find(b => b.shortname === 'АВТОА1P01');
console.log('АВТОА1P01: ytm =', avtoa.ytm, '| ytmRaw =', avtoa.ytmRaw, '| ytmOk =', avtoa.ytmOk);

// 2. Типы купонов
const kinds = {};
bonds.forEach(b => { kinds[b.couponKind] = (kinds[b.couponKind] || 0) + 1; });
console.log('\n=== couponKind ===');
Object.entries(kinds).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log(`  ${String(v).padStart(5)}  ${k}`));

// 3. Эмитенты
const withKey = bonds.filter(b => b.issuerKey);
const groups = new Map();
withKey.forEach(b => { if (!groups.has(b.issuerKey)) groups.set(b.issuerKey, []); groups.get(b.issuerKey).push(b); });
console.log('\n=== эмитенты ===');
console.log('бумаг с ключом:', withKey.length, '| эмитентов:', groups.size);
const sam = groups.get('16493-A');
console.log('Самолет (16493-A):', sam?.length, 'выпусков |', sam?.slice(0,4).map(b=>b.shortname).join(', '));

// 4. Подборки
console.log('\n=== подборки ===');
COLLECTIONS.forEach(c => {
  const n = bonds.filter(c.test).length;
  console.log(`  ${String(n).padStart(5)}  ${c.slug.padEnd(24)} ${c.title}`);
});

// 5. Поля бумаги (наличие)
console.log('\n=== заполненность полей ===');
const fields = ['price','ytm','couponPercent','nkd','matDate','offerDate','durationDays','listLevel','turnover','zSpread','issuerKey'];
fields.forEach(f => {
  const n = bonds.filter(b => b[f] != null).length;
  console.log(`  ${String(n).padStart(5)}/${bonds.length}  ${f}`);
});

// 6. Карточка облигации
console.log('\n=== fetchBondCard(RU000A104JQ3) ===');
const card = await fetchBondCard('RU000A104JQ3');
console.log('название:', card.shortname, '| эмитент ID:', card.issuerId, '| дефолт:', card.hasDefault, '| тех.дефолт:', card.hasTechDefault);
console.log('купонов:', card.coupons.length, '| амортизаций:', card.amortizations.length, '| оферт:', card.offers.length);
console.log('первый купон:', JSON.stringify(card.coupons[0]));
console.log('последний купон:', JSON.stringify(card.coupons[card.coupons.length-1]));

// 7. Кривая доходности
console.log('\n=== fetchYieldCurve() ===');
const yc = await fetchYieldCurve();
console.log('точек:', yc.length);
console.log(yc.map(p => `${p.period}г:${p.value}%`).join('  '));

// 8. Инфо об эмитенте
console.log('\n=== fetchIssuerInfo(RU000A104JQ3) ===');
const info = await fetchIssuerInfo('RU000A104JQ3');
console.log(JSON.stringify(info));

// 9. Дубликаты SECID
const dup = bonds.length - new Set(bonds.map(b => b.secid)).size;
console.log('\nдубликатов SECID:', dup);
console.log('\n✅ проверка завершена');