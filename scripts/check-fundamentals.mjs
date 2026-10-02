/**
 * check-fundamentals.mjs — проверка парсера МСФО на компаниях с известными цифрами.
 *
 * Запуск: node scripts/check-fundamentals.mjs
 *
 * Зачем это отдельным файлом. Когда я переписывал разбор таблицы smart-lab,
 * ошибка в столбцах выглядела правдоподобно: цифры были, годы были, но
 * сдвинуты на год, и у Сбера терялась прибыль 270,5 млрд за 2022 год.
 * Глазами такое не поймать — нужны значения, которые я знаю заранее
 * из отчётности, а не те, что вернул парсер.
 *
 * Ожидания здесь — реальная отчётность:
 *   LKOH 2021 выручка 9 431, 2025 EBITDA 892,1
 *   GAZP 2022 выручка 11 674, 2023 прибыль как в отчёте −629
 *   SBER 2021 прибыль 1 251, 2022 прибыль 270,5
 *   ROSN 2021 выручка 8 761
 * Скрипт заодно проверяет, что годы не дублируются и идут по возрастанию:
 * именно дубли выдавали сбой столбцов.
 */
import { parseFinTable, parseQuarterTable, parseDividends } from './fundamentals.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const UA = 'BondRadar/1.0';
const sleep = ms => new Promise(s => setTimeout(s, ms));
const get = async u => {
  for (let a = 0; a < 3; a++) {
    try {
      const c = new AbortController(); setTimeout(() => c.abort(), 45000);
      const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: c.signal });
      if (r.ok) return await r.text();
      console.log('  HTTP ' + r.status + ' — повтор');
    } catch (e) { console.log('  ' + e.name + ' — повтор'); }
    await sleep(2500);
  }
  return null;
};

const CHECKS = {
  LKOH: {
    revenue: { 2021: 9431 },
    ebitda: { 2025: 892.1 },
    netProfit: { 2021: 773.4, 2023: 1155 },
    /* ── Проверки на конкретные найденные ошибки ──
       Под ключом capex раньше лежал ПРОЦЕНТ от выручки (5, 9, 18, 21),
       а сам CAPEX пропадал: обе строки начинались с «CAPEX» и уходили
       в один ключ, вторая затирала первую. Теперь это разные ключи,
       и оба значения — настоящие: Лукойл в 2023 вложил 720 млрд ₽,
       а это 9 % выручки. Если однажды capex снова станет маленьким
       числом, проверка это поймает. */
    capex: { 2023: 720, 2025: 774.6 },
    capexRevenue: { 2023: 9, 2025: 21 },
    /* Строка «Долг» не находилась вообще: правило было записано через \b,
       а \b не работает с кириллицей. Общий долг Лукойла: 758 → 318 млрд. */
    debt: { 2021: 758, 2023: 396, 2025: 318 },
    /* Доходность к цене и доля от прибыли — разные вещи; раньше обе
       уходили в divYield, и вторая затирала первую. */
    divYield: { 2023: 14 },
    payoutRatio: { 2023: 55 },
    shares: { 2021: 650.3 },
    employees: { 2023: 104172 },
  },
  GAZP: {
    revenue: { 2021: 10241, 2022: 11674, 2023: 8542 },
    /* Основная строка — скорректированная прибыль; «н/с» — как в отчёте. */
    netProfit: { 2023: 726, 2024: 1461 },
    netProfitNS: { 2023: -629, 2024: 1219 },
  },
  SBER: { netProfit: { 2021: 1251, 2022: 270.5, 2023: 1509, 2024: 1582, 2025: 1707 } },
  ROSN: { revenue: { 2021: 8761, 2022: 9049, 2023: 9163, 2024: 10139 } },
  SNGS: {},
};

/* Скользящие двенадцать месяцев лежат в той же таблице, поэтому за ними
   отдельно ходить не нужно. Проверяем, что столбец найден и что в нём
   настоящие цифры, а не значение последнего года. */
const LTM_CHECKS = {
  LKOH: { revenue: 3919, ebitda: 1286 },
  GAZP: { revenue: 10083 },
};

let bad = 0;
for (const [tk, expect] of Object.entries(CHECKS)) {
  await sleep(1500);
  const html = await get(`https://smart-lab.ru/q/${tk}/f/y/`);
  const p = parseFinTable(html);
  if (!p) { console.log(`${tk}: ПАРСЕР ВЕРНУЛ NULL`); bad++; continue; }

  const dup = p.years.length !== new Set(p.years).size;
  const asc = p.years.every((y, i) => i === 0 || +y > +p.years[i - 1]);
  console.log(`\n${tk}: годы ${p.years.join(',')} ${dup ? '✗ ДУБЛИ' : dup === false ? '' : ''}${asc ? '' : ' ✗ НЕ ПО ВОЗРАСТАНИЮ'} · метрик ${Object.keys(p.metrics).length}`);

  for (const [key, years] of Object.entries(expect)) {
    const got = p.metrics[key]?.values || {};
    for (const [y, want] of Object.entries(years)) {
      const have = got[y];
      const ok = have != null && Math.abs(have - want) < 0.51;
      if (!ok) bad++;
      console.log(`  ${ok ? '✓' : '✗'} ${key} ${y}: ожидали ${want}, получили ${have ?? '—'}`);
    }
  }
  console.log(`  все ключи: ${Object.keys(p.metrics).join(', ')}`);

  const wantLtm = LTM_CHECKS[tk];
  if (wantLtm) {
    for (const [key, want] of Object.entries(wantLtm)) {
      const have = p.ltm?.[key];
      const ok = have != null && Math.abs(have - want) < 1.1;
      if (!ok) bad++;
      console.log(`  ${ok ? '✓' : '✗'} за 12 мес. ${key}: ожидали ${want}, получили ${have ?? '—'}`);
    }
  }
}

/* ── Промежуточная отчётность ────────────────────────────────────────
   Конкретные цифры здесь проверять нельзя — они меняются каждый квартал.
   Проверяем устройство: периоды разобрались, у части есть даты, и
   выручка есть больше чем за пару периодов. Если правило столбцов
   однажды собьётся, периоды либо исчезнут, либо станут пустыми. */
console.log('\n── промежуточная отчётность ──');
for (const tk of ['CHMF', 'LKOH']) {
  await sleep(1500);
  const q = parseQuarterTable(await get(`https://smart-lab.ru/q/${tk}/f/q/`));
  if (!q) { console.log(`  ✗ ${tk}: периоды не разобраны`); bad++; continue; }
  const dated = q.periods.filter(p => p.date).length;
  const rev = q.metrics.revenue ? Object.keys(q.metrics.revenue.values).length : 0;
  const ok = q.periods.length >= 3 && dated >= 2 && rev >= 3;
  if (!ok) bad++;
  const lastP = q.periods[q.periods.length - 1];
  console.log(`  ${ok ? '✓' : '✗'} ${tk}: периодов ${q.periods.length}, с датами ${dated}, `
    + `выручка за ${rev} периодов, последний ${lastP.label} ${lastP.date || '(дата не указана)'}`);
}

/* ── Дивиденды ────────────────────────────────────────────────────────
   Отдельная проверка, потому что здесь была своя ошибка: правило для
   «Див доход, ао, %» перехватывало и строку «Дивиденды/прибыль, %»,
   и в колонке доходности оказывался процент от прибыли. У Лукойла
   за 2019 год это 46 % против 8,8 % — разница в пять раз, и заметить
   её можно только зная настоящие цифры. */
const DIV_CHECKS = {
  LKOH: {
    perShare: { 2017: 215, 2019: 542, 2023: 945 },
    divYield: { 2019: 8.8 },
    payoutRatio: { 2019: 59 },
    divPayment: { 2019: 380.0 },
  },
};

console.log('\n── дивиденды ──');
for (const [tk, expect] of Object.entries(DIV_CHECKS)) {
  await sleep(1500);
  const d = parseDividends(await get(`https://smart-lab.ru/q/${tk}/dividend/`));
  if (!d) { console.log(`${tk}: ДИВИДЕНДЫ НЕ РАЗОБРАНЫ`); bad++; continue; }

  console.log(`${tk}: ключи ${Object.keys(d).join(', ')}`);
  for (const [key, years] of Object.entries(expect)) {
    const got = d[key] || {};
    for (const [y, want] of Object.entries(years)) {
      const have = got[y];
      const ok = have != null && Math.abs(have - want) < 0.6;
      if (!ok) bad++;
      console.log(`  ${ok ? '✓' : '✗'} ${key} ${y}: ожидали ${want}, получили ${have ?? '—'}`);
    }
  }
  /* Доходность и доля от прибыли — разные величины; если они совпали
     по всем годам, значит строки снова схлопнулись в одну. */
  const yy = d.divYield || {}, pp = d.payoutRatio || {};
  const same = Object.keys(yy).filter(y => pp[y] != null && yy[y] === pp[y]);
  if (same.length > 0) { console.log(`  ✗ доходность и доля от прибыли совпали в годах: ${same.join(',')}`); bad++; }
}

console.log(bad === 0 ? '\n=== ПАРСЕР: ВСЁ СОШЛОСЬ ===' : `\n=== ПАРСЕР: РАСХОЖДЕНИЙ ${bad} ===`);

/* ── Проверка самого файла данных ─────────────────────────────────────
   Парсер может работать, а собранный файл — быть испорченным: например,
   если робот упал на середине или в нём остались дубли годов.
   Здесь смотрим на результат, а не на разбор. */
const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'fundamentals.json');
console.log('\n── файл данных ──');
if (!existsSync(FILE)) {
  console.log('  файла нет — проверка пропущена (сначала запустите робота)');
} else {
  const d = JSON.parse(readFileSync(FILE, 'utf8'));
  const ticks = Object.keys(d.tickers || {});
  console.log(`  собран: ${d.generatedAt} · тикеров ${ticks.length} · ` + JSON.stringify(d.stats));

  let dupYears = [], emptyFin = [], badDiv = [];
  for (const [tk, t] of Object.entries(d.tickers)) {
    const ys = t.fin?.years;
    if (ys && ys.length !== new Set(ys).size) dupYears.push(tk);
    if (!ys && !t.div) emptyFin.push(tk);
    /* В дивидендах не должно остаться старого ключа divPayout:
       он означал «всего выплачено», а не долю от прибыли. */
    if (t.div && (t.div.divPayout !== undefined || (t.div.divYield && !t.div.payoutRatio))) badDiv.push(tk);
  }

  const report = (name, list, limit = 8) => {
    if (list.length === 0) { console.log(`  ✓ ${name}: нет`); return 0; }
    console.log(`  ✗ ${name}: ${list.length} — ${list.slice(0, limit).join(', ')}${list.length > limit ? ' …' : ''}`);
    return list.length;
  };

  bad += report('тикеры с дублями годов', dupYears);
  bad += report('тикеры без данных вообще', emptyFin);
  bad += report('старая структура дивидендов', badDiv);

  /* Новые пласты: скользящие 12 месяцев и промежуточные периоды.
     Если они вдруг исчезнут у большинства компаний, значит сломался
     сбор, а не источник — источник отдаёт их почти всем. */
  const withLtm = ticks.filter(tk => {
    const l = d.tickers[tk].fin?.ltm;
    return l && Object.keys(l).length >= 5;
  }).length;
  const withQ = ticks.filter(tk => d.tickers[tk].q?.periods?.length).length;
  console.log(`  ${withLtm >= ticks.length * 0.7 ? '✓' : '✗'} с показателями за 12 мес.: ${withLtm} из ${ticks.length}`);
  console.log(`  ${withQ >= ticks.length * 0.7 ? '✓' : '✗'} с промежуточными периодами: ${withQ} из ${ticks.length}`);
  if (withLtm < ticks.length * 0.7 || withQ < ticks.length * 0.7) bad++;

  /* Лукойл как ориентир: годы по возрастанию, дивиденды на месте. */
  const l = d.tickers?.LKOH;
  if (l?.fin) {
    const ok = l.fin.years.join(',') === '2021,2022,2023,2024,2025';
    if (!ok) bad++;
    console.log(`  ${ok ? '✓' : '✗'} LKOH годы: ${l.fin.years.join(',')}`);
    const hasDiv = l.div?.perShare && Object.keys(l.div.perShare).length >= 8;
    if (!hasDiv) bad++;
    console.log(`  ${hasDiv ? '✓' : '✗'} LKOH дивидендов по годам: ${l.div?.perShare ? Object.keys(l.div.perShare).length : 0}`);
  }
}

console.log(bad === 0 ? '\n=== ВСЁ ХОРОШО ===' : `\n=== ПРОБЛЕМ: ${bad} ===`);
process.exit(bad === 0 ? 0 : 1);