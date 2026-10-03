/* ═══════════════════════════════════════════════════════════════════
   Мой портфель — позиции в localStorage (usePortfolio).
   Позиция: { id, isin, secid, shortname, qty, buyPrice, buyDate }

   Важно про цены: облигации на Мосбирже котируются в ПРОЦЕНТАХ от
   номинала (98,5 = 98,5% номинала), акции — в рублях. Приводим всё
   к рублям за одну бумагу, поэтому цена покупки вводится в рублях
   за бумагу (для облигации — «грязная» цена, включая НКД).
   НКД входит и в цену покупки, и в текущую стоимость, поэтому
   на прибыль он не влияет — показываем его отдельной колонкой.
   ═══════════════════════════════════════════════════════════════════ */
import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { fetchBonds, fetchStocks } from '../api/moex';
import { Panel, Kpi, Loading, ErrorBox } from '../components/ui';
import { usePortfolio } from '../lib/store';
import { nf, money, chgClass, dateShort, timeLeft } from '../lib/format';

/** Сегодняшняя дата в виде YYYY-MM-DD — для отбора того, что ещё впереди.
    Через локальные поля, а не toISOString(): в Москве ночью UTC-дата
    отстала бы на день, и сегодняшнее погашение уехало бы в прошедшие. */
function todayStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ── CSV портфеля ─────────────────────────────────────────────────────

   Это третье из пяти требований папы и последнее незакрытое: «портфель
   CSV импорт/экспорт». Формат выгрузки — как в скринере: разделитель «;»
   и BOM, чтобы Excel в русской локали открыл файл сразу, без танцев с
   кодировкой. Числа отдаём с точкой: Excel поймёт.

   Импорт намеренно терпимый: файл человек может получить откуда угодно —
   из банка, из другого сервиса, из своей таблицы. Поэтому принимаем и «;»,
   и «,», и кавычки, и отсутствие заголовка, и запятую в числах. */

/** Разбор CSV: кавычки, любой из двух разделителей, BOM, CRLF. */
function parseCsv(text) {
  const clean = String(text || '').replace(/^\uFEFF/, '');
  const first = clean.split(/\r?\n/)[0] || '';
  /* Разделитель — по первой строке: где больше, тот и он. */
  const sep = first.split(';').length >= first.split(',').length ? ';' : ',';
  const out = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"') {
        if (clean[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); out.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); out.push(row); }
  return out.filter(r => r.some(c => String(c).trim() !== ''));
}

/** Число из CSV: «1 234,56», «1234.56», «1234 ₽» — всё понимаем. */
function csvNum(v) {
  const s = String(v ?? '').replace(/[\s\u00A0₽]/g, '').replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/* Облигация или акция: у облигаций из normalize() всегда есть поле faceValue */
const isBond = item => !!item && 'faceValue' in item;

/* Цена одной бумаги в рублях.
   Для облигаций — «грязная» цена: процент от номинала плюс накопленный
   купонный доход. Брокер в отчёте показывает именно её, поэтому цена
   покупки и текущая стоимость оказываются сравнимыми: иначе НКД давал бы
   фиктивный убыток на ровном месте. */
function unitPrice(item) {
  if (!item) return null;
  if (isBond(item)) {
    if (item.price == null) return null;
    const face = item.faceValue ?? 1000;   // если номинал неизвестен — считаем 1000 ₽
    return item.price / 100 * face + (item.nkd ?? 0);
  }
  return item.price ?? null;
}

/* Поиск бумаги в списке по ISIN или тикеру */
function findIn(list, p) {
  const isin = (p.isin || '').toUpperCase();
  const secid = (p.secid || '').toUpperCase();
  return list.find(x =>
    (isin && (x.isin || '').toUpperCase() === isin) ||
    (secid && (x.secid || '').toUpperCase() === secid)
  ) || null;
}

export default function PortfolioPage() {
  const { positions, add, remove } = usePortfolio();
  const [bonds, setBonds] = useState([]);
  const [stocks, setStocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ code: '', qty: '', buyPrice: '' });
  const [formErr, setFormErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [csvMsg, setCsvMsg] = useState(null);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true); setError(null);
    try { setBonds(await fetchBonds()); }
    catch (e) { setError(e); }
    finally { setLoading(false); }
  }

  /* Если среди позиций есть бумаги, которых нет среди облигаций,
     один раз догружаем список акций (нужен для текущей цены). */
  useEffect(() => {
    if (!bonds.length || stocks.length) return;
    if (!positions.some(p => !findIn(bonds, p))) return;
    let alive = true;
    fetchStocks().then(s => { if (alive) setStocks(s); }).catch(() => {});
    return () => { alive = false; };
  }, [bonds, positions, stocks.length]);

  /* Расчёт по каждой позиции */
  const rows = useMemo(() => positions.map(p => {
    const bond = findIn(bonds, p);
    const stock = bond ? null : findIn(stocks, p);
    const item = bond || stock;
    const cur = unitPrice(item);

    const invested = p.qty * p.buyPrice;                 // вложено, ₽
    const value = cur == null ? null : p.qty * cur;      // текущая стоимость, ₽
    const pl = value == null ? null : value - invested;
    const plPct = (value == null || !invested) ? null : pl / invested * 100;

    return {
      p, bond, item, cur, invested, value, pl, plPct,
      nkd: bond?.nkd ?? null,
      priced: value != null,
    };
  }), [positions, bonds, stocks]);

  const totalInvested = rows.reduce((a, r) => a + r.invested, 0);
  /* Позиции без найденной цены учитываем по цене покупки, чтобы итог не «прыгал» */
  const totalValue = rows.reduce((a, r) => a + (r.value ?? r.invested), 0);
  const totalPl = totalValue - totalInvested;
  const totalPct = totalInvested ? totalPl / totalInvested * 100 : null;
  const totalNkd = rows.reduce((a, r) => a + (r.nkd != null ? r.nkd * r.p.qty : 0), 0);
  const unpriced = rows.filter(r => !r.priced).length;
  const showNkd = rows.some(r => r.nkd != null);

  /* ── Что из вашего портфеля закрывается в 2026 году ────────────────
     Папа спрашивал «столько погашений — стоит ли избавляться?». Чтобы
     отвечать на такой вопрос, нужны не рыночные объёмы, а суммы по его
     собственным позициям — их и считаем: бумаг × номинал.
     Цена оферты и последний купон могут быть другими, поэтому пишем
     прямо, что это номинал, и что оферту ещё нужно предъявить. */
  const in2026 = useMemo(() => {
    const today = todayStr();
    const out = [];
    for (const r of rows) {
      const b = r.bond;
      if (!b) continue;
      const face = Number(b.faceValue);
      const amount = Number.isFinite(face) && face > 0 ? face * r.p.qty : null;
      const pairs = [['mat', b.matDate], ['offer', b.offerDate]];
      for (const [kind, iso] of pairs) {
        if (!iso || !String(iso).startsWith('2026') || String(iso) < today) continue;
        out.push({
          key: r.p.id + '|' + kind, date: iso, kind, row: r, bond: b, amount,
          /* Последний купон приходит вместе с номиналом, если ближайшая
             выплата совпадает с датой погашения. */
          lastCoupon: kind === 'mat' && b.nextCoupon === iso && b.couponValue != null
            ? b.couponValue * r.p.qty : null,
        });
      }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }, [rows]);
  const in2026Mat = in2026.filter(e => e.kind === 'mat');
  const in2026Offer = in2026.filter(e => e.kind === 'offer');
  const in2026Sum = in2026Mat.reduce((a, e) => a + (e.amount || 0) + (e.lastCoupon || 0), 0);
  const in2026OfferSum = in2026Offer.reduce((a, e) => a + (e.amount || 0), 0);
  const in2026Unknown = in2026Mat.some(e => e.amount == null);

  /* Добавление позиции: название подтягиваем из списка биржи */
  async function submit(e) {
    e.preventDefault();
    const code = form.code.trim().toUpperCase();
    const qty = Number(form.qty);
    const buyPrice = Number(form.buyPrice);

    if (!code) { setFormErr('Укажите ISIN или тикер бумаги'); return; }
    if (!(qty > 0)) { setFormErr('Количество должно быть больше нуля'); return; }
    if (!(buyPrice >= 0) || Number.isNaN(buyPrice)) { setFormErr('Проверьте цену покупки'); return; }

    setFormErr(null); setBusy(true);

    let item = null;
    try {
      const bs = bonds.length ? bonds : await fetchBonds();
      if (!bonds.length) setBonds(bs);
      item = bs.find(b =>
        (b.isin || '').toUpperCase() === code || (b.secid || '').toUpperCase() === code
      ) || null;

      if (!item) {
        const ss = stocks.length ? stocks : await fetchStocks();
        if (!stocks.length) setStocks(ss);
        item = ss.find(s =>
          (s.isin || '').toUpperCase() === code || (s.secid || '').toUpperCase() === code
        ) || null;
      }
    } catch {
      /* сеть отвалилась — добавляем как есть, с введённым кодом вместо названия */
    }

    add({
      isin: item?.isin || code,
      secid: item?.secid || code,
      shortname: item?.shortname || code,
      qty,
      buyPrice,
      buyDate: new Date().toISOString().slice(0, 10),
    });

    setForm({ code: '', qty: '', buyPrice: '' });
    setBusy(false);
  }

  /* ── Выгрузка портфеля в CSV ─────────────────────────────────────── */
  const exportCsv = () => {
    const cols = [
      ['ISIN', r => r.p.isin],
      ['Тикер', r => r.p.secid],
      ['Название', r => r.bond?.shortname || r.item?.shortname || r.p.shortname],
      ['Количество', r => r.p.qty],
      ['Цена покупки', r => r.p.buyPrice],
      ['Дата покупки', r => r.p.buyDate],
      ['Вложено, ₽', r => r.invested.toFixed(2)],
      ['Стоимость, ₽', r => (r.value == null ? '' : r.value.toFixed(2))],
      ['П/У, ₽', r => (r.pl == null ? '' : r.pl.toFixed(2))],
      ['П/У, %', r => (r.plPct == null ? '' : r.plPct.toFixed(2))],
    ];
    const esc = v => {
      if (v == null) return '';
      const s = String(v);
      return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [cols.map(c => esc(c[0])).join(';')];
    for (const r of rows) lines.push(cols.map(c => esc(c[1](r))).join(';'));
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bond-radar-portfel-' + todayStr() + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setCsvMsg({ cls: 'c-2', text: `Выгружено ${rows.length} позиций. Файл открывается в Excel как есть.` });
  };

  /* ── Загрузка портфеля из CSV ────────────────────────────────────── */
  async function importCsv(file) {
    if (!file) return;
    setCsvMsg({ cls: 'c-2', text: 'Читаем файл…' });
    let table;
    try {
      table = parseCsv(await file.text());
    } catch (e) {
      setCsvMsg({ cls: 'c-r', text: 'Не удалось прочитать файл: ' + e.message });
      return;
    }
    if (!table.length) { setCsvMsg({ cls: 'c-r', text: 'Файл пустой — ни одной строки.' }); return; }

    /* Заголовок ищем по словам, а не по позиции: файлы приходят разные.
       Если заголовка нет, берём колонки по порядку — ISIN, тикер,
       название, количество, цена, дата (это наш же формат выгрузки). */
    const head = table[0].map(s => String(s).trim().toLowerCase());
    const looksHeader = head.some(s => /isin|тикер|ticker|назван|бумаг|колич|кол-во|цена/.test(s));
    const body = looksHeader ? table.slice(1) : table;
    const at = (names, fallback) => {
      const i = head.findIndex(s => names.some(n => s.includes(n)));
      return i >= 0 ? i : fallback;
    };
    const cIsin = at(['isin'], 0);
    const cTicker = at(['тикер', 'ticker', 'secid'], 1);
    const cName = at(['назван', 'бумага', 'name'], 2);
    const cQty = at(['колич', 'кол-во', 'qty', 'шт'], 3);
    const cPrice = at(['цена', 'price'], 4);
    const cDate = at(['дата', 'date'], 5);

    /* Ищем бумагу по ISIN, тикеру или названию — в облигациях и акциях. */
    const all = [...bonds, ...stocks];
    const find = (raw) => {
      const key = String(raw || '').trim().toLowerCase();
      if (!key) return null;
      return all.find(x =>
        String(x.isin || '').toLowerCase() === key ||
        String(x.secid || '').toLowerCase() === key ||
        String(x.shortname || '').toLowerCase() === key) || null;
    };

    let added = 0;
    const problems = [];
    body.forEach((r, n) => {
      const lineNo = n + (looksHeader ? 2 : 1);
      const qty = csvNum(r[cQty]);
      const price = csvNum(r[cPrice]);
      const hit = find(r[cIsin]) || find(r[cTicker]) || find(r[cName]);
      if (!hit) {
        problems.push(`строка ${lineNo}: не нашли бумагу «${String(r[cIsin] || r[cTicker] || r[cName] || '').trim()}» в списках биржи`);
        return;
      }
      if (!(qty > 0)) { problems.push(`строка ${lineNo}: количество не число («${r[cQty]}»)`); return; }
      if (price == null || price < 0) { problems.push(`строка ${lineNo}: цена не число («${r[cPrice]}»)`); return; }
      const dateRaw = String(r[cDate] || '').trim();
      const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw);
      add({
        isin: hit.isin || null,
        secid: hit.secid || null,
        shortname: hit.shortname || null,
        qty,
        buyPrice: price,
        buyDate: dateOk ? dateRaw : todayStr(),
      });
      added++;
    });

    /* Отчитываемся честно: что взяли и что не поняли. Молча пропустить
       половину строк — худшее, что можно сделать с чужим файлом. */
    const parts = [`Добавлено позиций: ${added}.`];
    if (problems.length) {
      parts.push(`Не разобрано строк: ${problems.length} — ${problems.slice(0, 3).join('; ')}`
        + (problems.length > 3 ? ` и ещё ${problems.length - 3}.` : ''));
    } else {
      parts.push('Все строки разобраны.');
    }
    setCsvMsg({ cls: added ? 'c-2' : 'c-r', text: parts.join(' ') });
  }

  if (loading) return <Loading text="Загрузка портфеля…" />;
  if (error) return <ErrorBox error={error} onRetry={load} />;

  return (
    <div>
      <div className="page-h">
        <div className="page-t">▥ Мой портфель</div>
        <div className="page-s">
          Позиции хранятся только в вашем браузере (localStorage) · цены — ISS MOEX в реальном времени
        </div>
      </div>

      {/* ── Форма добавления ─────────────────────────────────────── */}
      <Panel title="Добавить позицию">
        <form className="filters" onSubmit={submit}>
          <div className="fg">
            <label>ISIN или тикер</label>
            <input
              className="inp"
              style={{ width: 220 }}
              placeholder="RU000A10… / SU26238RMFS4 / SBER"
              value={form.code}
              onChange={e => setForm(f => ({ ...f, code: e.target.value }))}
            />
          </div>
          <div className="fg">
            <label>Количество</label>
            <input
              className="inp"
              style={{ width: 110 }}
              type="number"
              min="1"
              step="1"
              placeholder="10"
              value={form.qty}
              onChange={e => setForm(f => ({ ...f, qty: e.target.value }))}
            />
          </div>
          <div className="fg">
            <label>Цена покупки, ₽ за бумагу</label>
            <input
              className="inp"
              style={{ width: 160 }}
              type="number"
              min="0"
              step="0.01"
              placeholder="985.50"
              value={form.buyPrice}
              onChange={e => setForm(f => ({ ...f, buyPrice: e.target.value }))}
            />
          </div>
          <button className="btn btn-green" type="submit" disabled={busy}>
            {busy ? 'Ищем бумагу…' : 'Добавить'}
          </button>
        </form>
        <div className="c-3" style={{ fontSize: 11, marginTop: 10, lineHeight: 1.6 }}>
          Название бумаги подтягивается автоматически: сначала ищет среди облигаций,
          затем среди акций. Цена покупки — в рублях за одну бумагу; для облигаций
          это «грязная» цена (с НКД), как в отчёте брокера.
        </div>
        {formErr && <div className="err" style={{ textAlign: 'left', paddingTop: 8 }}>{formErr}</div>}

        {/* ── CSV: выгрузка и загрузка ────────────────────────────────
            Это третье требование папы и последнее незакрытое. Выгрузка
            идёт тем же форматом, что и в скринере («;» и BOM), — Excel
            в русской локали откроет файл сразу. Загрузка терпимая:
            принимает файл из банка, из другого сервиса и из своей
            таблицы, а про непонятные строки говорит честно, а не молчит. */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', paddingTop: 14 }}>
          <button className="btn btn-sm" type="button" onClick={exportCsv} disabled={!rows.length}>
            ⤓ Выгрузить портфель в CSV
          </button>
          <label className="btn btn-sm" style={{ cursor: 'pointer' }}>
            ⤒ Загрузить из CSV
            <input
              type="file"
              accept=".csv,text/csv"
              style={{ display: 'none' }}
              onChange={e => { importCsv(e.target.files?.[0]); e.target.value = ''; }}
            />
          </label>
          <span className="c-3" style={{ fontSize: 11 }}>
            формат: ISIN; Тикер; Название; Количество; Цена покупки; Дата покупки — как в выгрузке.
            Позиции хранятся в браузере, загрузка добавляет их к уже введённым
          </span>
        </div>
        {csvMsg && (
          <div className={csvMsg.cls} style={{ fontSize: 11.5, paddingTop: 8, lineHeight: 1.6 }}>
            {csvMsg.text}
          </div>
        )}
      </Panel>

      <div style={{ height: 14 }} />

      {!positions.length ? (
        <Panel>
          <div className="empty" style={{ padding: '42px 20px' }}>
            <div style={{ fontSize: 15, marginBottom: 8 }}>Портфель пуст</div>
            <div style={{ marginBottom: 14 }}>
              Добавьте первую позицию через форму выше — укажите ISIN или тикер,
              количество и цену покупки.
            </div>
            <Link className="btn" to="/screener">Выбрать бумагу в скринере</Link>
          </div>
        </Panel>
      ) : (
        <>
          {/* ── Сводка ────────────────────────────────────────────── */}
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', marginBottom: 14 }}>
            <Kpi label="Вложено" value={money(totalInvested)} sub={`${positions.length} позиций`} />
            <Kpi
              label="Текущая стоимость"
              value={money(totalValue)}
              sub={unpriced ? `без цены: ${unpriced} поз. — учтены по цене покупки` : 'по текущим ценам'}
            />
            <Kpi
              label="Прибыль / убыток"
              value={(totalPl > 0 ? '+' : '') + money(totalPl)}
              cls={chgClass(totalPl)}
              sub={totalPct == null ? '—' : (totalPct > 0 ? '+' : '') + nf(totalPct, 2) + '%'}
            />
            <Kpi
              label="Доходность портфеля"
              value={totalPct == null ? '—' : (totalPct > 0 ? '+' : '') + nf(totalPct, 2) + '%'}
              cls={chgClass(totalPct)}
              sub="к вложенным средствам"
            />
            <Kpi
              label="НКД в цене"
              value={money(totalNkd)}
              sub="уже учтён в стоимости"
            />
          </div>

          {/* ── Что закрывается до конца 2026 года ────────────────── */}
          {in2026.length > 0 && (
            <Panel
              title="Ваши погашения и оферты до конца 2026 года"
              pad={false}
              style={{ marginBottom: 14 }}
            >
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Дата</th>
                      <th>Бумага</th>
                      <th>Что</th>
                      <th>Бумаг</th>
                      <th>Вернётся</th>
                    </tr>
                  </thead>
                  <tbody>
                    {in2026.map(e => (
                      <tr key={e.key} style={{ cursor: 'default' }}>
                        <td>
                          <div className="mono">{dateShort(e.date)}</div>
                          <div className="c-3" style={{ fontSize: 10 }}>{timeLeft(e.date)}</div>
                        </td>
                        <td>
                          <Link to={'/bond/' + (e.bond.isin || e.bond.secid)} style={{ fontWeight: 600 }}>
                            {e.bond.shortname}
                          </Link>
                        </td>
                        <td>
                          <span className={'tag ' + (e.kind === 'mat' ? 'g' : 'a')}>
                            {e.kind === 'mat' ? 'Погашение' : 'Оферта'}
                          </span>
                        </td>
                        <td className="mono">{nf(e.row.p.qty, 0)}</td>
                        <td className="mono">
                          {e.amount == null
                            ? <span className="c-3">номинал н/д</span>
                            : money(e.amount)}
                          {e.lastCoupon != null && (
                            <span className="c-3" style={{ fontSize: 10, marginLeft: 5 }}>
                              + купон {money(e.lastCoupon)}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="c-2" style={{ fontSize: 11.5, padding: '10px 12px', lineHeight: 1.7 }}>
                <b>Погашения:</b> вернётся {money(in2026Sum)} по {nf(in2026Mat.length, 0)}{' '}
                {in2026Mat.length === 1 ? 'выпуску' : 'выпускам'} — это номинал плюс последний купон,
                где он совпадает с датой, и <b>до налога</b>: НДФЛ с дисконта брокер удержит сам.
                {in2026Unknown && ' По части выпусков биржа номинала не дала — там прочерк.'}
                <br />
                <b>Оферты:</b> {nf(in2026Offer.length, 0)} на {money(in2026OfferSum)} номинала — но это
                право, а не обязанность. Чтобы деньги вернулись, бумагу нужно предъявить к выкупу в срок,
                который назначает эмитент, и цена выкупа может отличаться от номинала. Купон, если он не
                попадает на дату выкупа, придёт отдельно.
                <br />
                <span className="c-3">
                  Это календарь возврата денег, а не совет. Держать до даты или продать раньше — решать вам;
                  мы только показываем, что и когда произойдёт. Бумага, которая уже не торгуется на бирже,
                  сюда не попадёт: цену и номинал для неё взять неоткуда.
                </span>
              </div>
            </Panel>
          )}

          {/* ── Таблица позиций ───────────────────────────────────── */}
          <Panel title="Позиции" pad={false}>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Бумага</th>
                    <th>Кол-во</th>
                    <th>Цена покупки</th>
                    <th>Текущая цена</th>
                    <th>Вложено</th>
                    <th>Стоимость</th>
                    <th>П/У, ₽</th>
                    <th>П/У, %</th>
                    <th>Вес</th>
                    {showNkd && <th>НКД на бумагу</th>}
                    <th className="nosort">Дата покупки</th>
                    <th className="nosort"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => {
                    const p = r.p;
                    const weight = totalValue ? (r.value ?? r.invested) / totalValue * 100 : null;
                    return (
                      <tr key={p.id}>
                        <td>
                          {r.bond
                            ? <Link to={'/bond/' + r.bond.isin} style={{ fontWeight: 600 }}>{r.bond.shortname}</Link>
                            : <span style={{ fontWeight: 600 }}>{p.shortname}</span>}
                          <div className="mono c-3" style={{ fontSize: 10 }}>
                            {p.isin}{p.secid && p.secid !== p.isin ? ' · ' + p.secid : ''}
                            {r.bond ? '' : (r.item ? ' · акция' : ' · нет в списке биржи')}
                          </div>
                        </td>
                        <td className="mono">{nf(p.qty, 0)}</td>
                        <td className="mono">{nf(p.buyPrice, 2)}</td>
                        <td className="mono">{r.cur == null ? <span className="c-3">н/д</span> : nf(r.cur, 2)}</td>
                        <td className="mono c-2">{money(r.invested)}</td>
                        <td className="mono">{r.value == null ? '—' : money(r.value)}</td>
                        <td className={'mono ' + chgClass(r.pl)}>
                          {r.pl == null ? '—' : (r.pl > 0 ? '+' : '') + money(r.pl)}
                        </td>
                        <td className={chgClass(r.plPct)}>
                          {r.plPct == null ? '—' : (r.plPct > 0 ? '+' : '') + nf(r.plPct, 2) + '%'}
                        </td>
                        <td className="mono c-2">{weight == null ? '—' : nf(weight, 1) + '%'}</td>
                        {showNkd && (
                          <td className="mono c-2">{r.nkd == null ? '—' : nf(r.nkd, 2)}</td>
                        )}
                        <td className="mono c-3" style={{ fontSize: 11 }}>{p.buyDate || '—'}</td>
                        <td>
                          <button className="btn btn-sm" onClick={() => remove(p.id)}>Удалить</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>

          <div className="c-3" style={{ fontSize: 11, marginTop: 10, lineHeight: 1.6 }}>
            Как считаем: для облигаций берётся «грязная» цена — процент от номинала
            переводится в рубли (для бумаг с неизвестным номиналом берём 1000 ₽) и
            прибавляется НКД; акции — по последней цене сделки. Так цена покупки и
            текущая стоимость сравнимы: брокер в отчёте тоже показывает цену с НКД.
            Валютные выпуски пересчитываются по номиналу в валюте, без курса ЦБ.
          </div>
        </>
      )}
    </div>
  );
}