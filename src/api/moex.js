/* ═══════════════════════════════════════════════════════════
   MOEX ISS API — Data Layer
   Direct fetch from iss.moex.com (CORS verified ✅)
   ═══════════════════════════════════════════════════════════ */

const ISS_BASE = 'https://iss.moex.com/iss';

// Helper: fetch with params, return parsed JSON
async function issFetch(path, params = {}) {
  const url = new URL(ISS_BASE + path);
  url.searchParams.set('iss.meta', 'off');
  url.searchParams.set('iss.json', 'extended');
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });
  const resp = await fetch(url, { credentials: 'omit' });
  if (!resp.ok) throw new Error(`ISS ${resp.status} for ${path}`);
  // iss.json=extended returns an array: [charsetinfo, {columns, data}] or [charsetinfo, {name: [...], ...}]
  const arr = await resp.json();
  // The actual data is in arr[1] - object with keys like 'securities', 'marketdata' etc.
  const data = Array.isArray(arr) && arr.length > 1 ? arr[1] : arr;
  return data || {};
}

// ═══════════════════════════════ Bonds (TQCB board) ═══════════════════════════════
export async function fetchAllBonds() {
  const data = await issFetch('/engines/stock/markets/bonds/boards/TQCB/securities.json', {
    limit: 100,
  });
  return data.securities || [];
}

// fetchAllBondsFull is just fetchAllBonds — MOEX returns all bonds in one request
export const fetchAllBondsFull = fetchAllBonds;

// ═══════════════════════════════ Bond detail ═══════════════════════════════
export async function fetchBondDetail(secid) {
  const data = await issFetch(`/securities/${secid}.json`);
  return data;
}

export async function fetchBondization(secid) {
  const data = await issFetch(`/securities/${secid}/bondization.json`);
  return data;
}

export async function fetchBondByIsin(isin) {
  const data = await issFetch(`/securities/${isin}.json`);
  return data;
}

// ═══════════════════════════════ Yield Curve ═══════════════════════════════
export async function fetchYieldCurve() {
  const data = await issFetch('/engines/stock/zcyc.json');
  return data;
}

export async function fetchYearYields() {
  const data = await issFetch('/engines/stock/zcyc/yearyields.json');
  return data;
}

// ═══════════════════════════════ Indices ═══════════════════════════════
export async function fetchIndex(engine = 'stock', market = 'index', board = 'SNDX', secid = 'RGBI') {
  const data = await issFetch(`/engines/${engine}/markets/${market}/boards/${board}/securities/${secid}.json`);
  return data;
}

// ═══════════════════════════════ Issuer bonds by INN ═══════════════════════════════
export async function fetchIssuerBonds(inn) {
  const data = await issFetch('/engines/stock/markets/bonds/boards/TQCB/securities.json', {
    q: inn, limit: 100,
    'securities.columns': 'secid,shortname,isin,is_traded,listlevel,matdate'
  });
  return data.securities || [];
}

export async function searchIssuer(name) {
  const data = await issFetch('/engines/stock/markets/bonds/boards/TQCB/securities.json', {
    q: name, limit: 20,
    'securities.columns': 'secid,emitent_inn,emitent_title,shortname'
  });
  return data.securities || [];
}

// ═══════════════════════════════ Stocks ═══════════════════════════════
export async function fetchStocks() {
  const data = await issFetch('/engines/stock/markets/shares/boards/TQBR/securities.json', { limit: 300 });
  return data.securities || [];
}

// ═══════════════════════════════ Market data (prices) ═══════════════════════════════
export async function fetchMarketData(secids) {
  if (!secids.length) return [];
  const data = await issFetch('/engines/stock/markets/bonds/boards/TQCB/securities.json', {
    securities: secids.join(','),
    'iss.only': 'marketdata',
    'marketdata.columns': 'SECID,LAST,LASTCHANGE,LASTCHANGEPRC, VOLTODAY,VALUE'
  });
  return data.marketdata || [];
}

// ═══════════════════════════════ Key rate (built-in history) ═══════════════════════════════
export const KS_HISTORY = [
  ['2025-01-03', 21.0], ['2025-06-09', 20.0], ['2025-07-28', 18.0],
  ['2025-09-15', 17.0], ['2025-10-27', 16.5], ['2025-12-22', 16.0],
  ['2026-02-16', 15.5], ['2026-03-23', 15.0], ['2026-04-27', 14.5],
  ['2026-06-22', 14.25], ['2026-07-28', 14.0],
];

export function keyRateAt(dateStr) {
  if (!dateStr) return 14.0;
  let v = 14.0;
  for (const [d, r] of KS_HISTORY) { if (d <= dateStr) v = r; else break; }
  return v;
}

export const KEY_RATE = 14.0;

// ═══════════════════════════════ Helper: parse ISS columns ═══════════════════════════════
export function parseIssRows(data) {
  if (!data || !Array.isArray(data)) return [];
  // ISS returns [{columns:[...]}, {data:[[...], ...]}]
  // or directly array of objects
  if (data.columns && data.data) {
    const cols = data.columns.map(c => c.name || c);
    return (data.data || []).map(row => {
      const obj = {};
      cols.forEach((col, i) => { obj[col] = row[i]; });
      return obj;
    });
  }
  return data;
}