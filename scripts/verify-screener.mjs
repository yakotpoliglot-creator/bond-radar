/* Проверка новых фильтров скринера на живых данных Мосбиржи. */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0 Safari/537.36';
const boards = ['TQCB', 'TQOB'];
const all = [];
for (const b of boards) {
  const r = await fetch(`https://iss.moex.com/iss/engines/stock/markets/bonds/boards/${b}/securities.json?iss.meta=off&iss.json=extended`, { headers: { 'User-Agent': UA } });
  const d = await r.json();
  const S = d[1].securities || [], M = new Map((d[1].marketdata || []).map(x => [x.SECID, x]));
  for (const s of S) {
    const m = M.get(s.SECID) || {};
    const price = m.LAST != null ? +m.LAST : (m.MARKETPRICE != null ? +m.MARKETPRICE : null);
    /* Та же проверка достоверности доходности, что в src/api/moex.js:
       YTM_MIN..YTM_MAX = −50..300. Z-спред берём только при валидном YTM —
       иначе в данные попадают значения вроде 36 080. */
    const rawYtm = m.YIELD != null ? +m.YIELD : null;
    const ytmOk = rawYtm != null && rawYtm >= -50 && rawYtm <= 300;
    all.push({
      board: b, secid: s.SECID, name: s.SHORTNAME, reg: s.REGNUMBER,
      price, ytm: ytmOk ? rawYtm : null,
      z: (ytmOk && m.ZSPREAD != null) ? +m.ZSPREAD : null,
      durDays: m.DURATION != null ? +m.DURATION : null,
      period: s.COUPONPERIOD != null ? +s.COUPONPERIOD : null,
      face: s.FACEUNIT, amort: (s.BONDTYPE || '').includes('Амортизируем'),
      turnover: m.VALTODAY != null ? +m.VALTODAY : 0,
      cur: (s.COUPONPERCENT != null && price) ? (+s.COUPONPERCENT / price) * 100 : null,
    });
  }
}
console.log(`всего выпусков: ${all.length} (TQCB ${all.filter(x => x.board === 'TQCB').length}, TQOB ${all.filter(x => x.board === 'TQOB').length})`);

console.log('\n=== заполненность новых полей ===');
const pct = n => ((n / all.length) * 100).toFixed(0) + '%';
console.log(`  Z-спред:              ${all.filter(x => x.z != null).length}  (${pct(all.filter(x => x.z != null).length)})`);
console.log(`  купонная доходность:  ${all.filter(x => x.cur != null).length}  (${pct(all.filter(x => x.cur != null).length)})`);
console.log(`  дюрация:              ${all.filter(x => x.durDays != null).length}  (${pct(all.filter(x => x.durDays != null).length)})`);
console.log(`  частота купона:       ${all.filter(x => x.period != null).length}  (${pct(all.filter(x => x.period != null).length)})`);

console.log('\n=== Z-спред: как распределён ===');
const zs = all.filter(x => x.z != null).map(x => x.z).sort((a, b) => a - b);
const q = p => zs[Math.floor(zs.length * p)].toFixed(1);
console.log(`  мин ${zs[0].toFixed(1)} · 25% ${q(0.25)} · медиана ${q(0.5)} · 75% ${q(0.75)} · 90% ${q(0.9)} · макс ${zs[zs.length - 1].toFixed(1)}`);
console.log('  (у ОФЗ должно быть около нуля)');
const ofz = all.filter(x => x.board === 'TQOB' && x.z != null).map(x => x.z);
console.log(`  ОФЗ: ${ofz.length} шт., медиана ${ofz.sort((a, b) => a - b)[Math.floor(ofz.length / 2)].toFixed(2)}`);
const corp = all.filter(x => x.board === 'TQCB' && x.z != null).map(x => x.z).sort((a, b) => a - b);
console.log(`  корпораты: ${corp.length} шт., медиана ${corp[Math.floor(corp.length / 2)].toFixed(2)}`);

console.log('\n=== частота купона: раскладка по нашим диапазонам ===');
const F = { 'ежемес 25-45': [25, 45], 'квартал 80-100': [80, 100], 'полугод 170-195': [170, 195], 'год 350-380': [350, 380] };
for (const [k, [a, b]] of Object.entries(F)) {
  const n = all.filter(x => x.period != null && x.period >= a && x.period <= b).length;
  console.log(`  ${k.padEnd(16)} ${n}`);
}
const un = all.filter(x => x.period != null && !Object.values(F).some(([a, b]) => x.period >= a && x.period <= b)).length;
console.log(`  не попали никуда: ${un}`);
const uniq = [...new Set(all.filter(x => x.period != null).map(x => x.period))].sort((a, b) => a - b);
console.log(`  все значения периода: ${uniq.join(', ')}`);

console.log('\n=== дедупликация «один выпуск на эмитента» ===');
const key = r => { const m = /(\d{4,6})-([A-ZА-Я]{1,3})(?:-\d|$)/.exec(r || ''); return m ? m[1] + '-' + m[2] : null; };
const withKey = all.filter(x => key(x.reg));
const best = new Map();
for (const x of withKey) { const k = key(x.reg); const c = best.get(k); if (!c || x.turnover > c.turnover) best.set(k, x); }
console.log(`  было ${all.length} → стало ${best.size} (эмитентов ${best.size})`);

console.log('\n=== пример: доходные корпораты с Z-спредом, 1 выпуск на эмитента ===');
const sample = [...best.values()].filter(x => x.board === 'TQCB' && x.z != null && x.ytm != null && x.ytm < 40)
  .sort((a, b) => b.z - a.z).slice(0, 12);
console.log('  ВЫПУСК'.padEnd(20) + 'ЦЕНА'.padStart(8) + 'YTM'.padStart(8) + 'Z-СПРЕД'.padStart(9) + 'ДЮР,лет'.padStart(9));
for (const x of sample) {
  console.log('  ' + String(x.name).slice(0, 18).padEnd(18) + x.price.toFixed(1).padStart(8) + x.ytm.toFixed(2).padStart(8) + x.z.toFixed(2).padStart(9) + (x.durDays / 365).toFixed(2).padStart(9));
}

console.log('\n=== проверка: Z-спред ≈ YTM минус кривая ОФЗ ===');
/* строим грубую кривую по ОФЗ (дюрация -> доходность) */
const curve = all.filter(x => x.board === 'TQOB' && x.durDays > 0 && x.ytm > 0)
  .map(x => ({ d: x.durDays / 365, y: x.ytm })).sort((a, b) => a.d - b.d);
function at(x) {
  if (!curve.length) return null;
  if (x <= curve[0].d) return curve[0].y;
  if (x >= curve[curve.length - 1].d) return curve[curve.length - 1].y;
  for (let i = 0; i < curve.length - 1; i++) {
    const a = curve[i], b = curve[i + 1];
    if (x >= a.d && x <= b.d) return a.y + (b.y - a.y) * ((x - a.d) / (b.d - a.d));
  }
  return null;
}
let ok = 0, off = [];
for (const x of all) {
  if (x.z == null || x.ytm == null || !(x.durDays > 0) || x.ytm > 60) continue;
  const base = at(x.durDays / 365);
  if (base == null) continue;
  const g = x.ytm - base;
  if (Math.abs(g - x.z) < 1.5) ok++; else if (off.length < 5) off.push(`${x.name}: Z=${x.z.toFixed(1)} наш=${g.toFixed(1)}`);
}
console.log(`  сошлось: ${ok}, расхождений >1,5 п.п.: ${off.length ? 'есть' : 'нет'}`);
off.forEach(o => console.log('     ' + o));