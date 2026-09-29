/* ═══════════════════════════════════════════════════════════
   BondRadar Weekly Data Collector
   Runs via GitHub Actions every Sunday
   Collects: credit ratings, issuer financials, primary placements
   ═══════════════════════════════════════════════════════════ */

import { writeFileSync, mkdirSync, existsSync } from 'fs';

const DATA_DIR = './src/data';

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

/* ── Helpers ─────────────────────────────────────────── */
async function fetchText(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'BondRadar-bot/1.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.text();
}

async function fetchJson(url) {
  const text = await fetchText(url);
  return JSON.parse(text);
}

/* ── 1. Credit ratings from agencies ──────────────── */
async function collectRatings() {
  console.log('Collecting credit ratings...');
  const ratings = [];

  // AKRA — their list is at https://www.acra-ratings.ru/...
  // Expert RA — https://raexpert.ru/ratings/
  // NKR — https://nkr-rating.ru/
  // NRA — https://www.nra-rating.ru/

  // For now, return a placeholder structure
  // Real scraping will be implemented per-agency
  return ratings;
}

/* ── 2. MOEX ISS data snapshot ───────────────────── */
async function collectMoexSnapshot() {
  console.log('Collecting MOEX snapshot...');

  // Fetch all bonds from MOEX
  const baseUrl = 'https://iss.moex.com/iss/engines/stock/markets/bonds/boards/TQCB/securities.json';

  let all = [];
  let start = 0;
  const LIMIT = 100;

  while (true) {
    const url = `${baseUrl}?iss.meta=off&iss.json=extended&limit=${LIMIT}&start=${start}`;
    const data = await fetchJson(url);
    const batch = data.securities || [];
    all.push(...batch);
    if (batch.length < LIMIT) break;
    start += LIMIT;
  }

  console.log(`  Fetched ${all.length} bonds`);

  // Save raw snapshot
  writeFileSync(`${DATA_DIR}/bonds-snapshot.json`, JSON.stringify(all, null, 2));
  return all;
}

/* ── 3. Find new listings / primary placements ────── */
async function collectPlacements() {
  console.log('Collecting primary placements...');
  // Detect bonds with recent listing dates
  // This uses the snapshot saved above
  const snapshot = JSON.parse(
    readFileSync(`${DATA_DIR}/bonds-snapshot.json`, 'utf-8')
  );

  const today = new Date();
  const monthAgo = new Date(today);
  monthAgo.setDate(monthAgo.getDate() - 30);

  const newBonds = snapshot.filter(b => {
    // Check listing date or first appearance
    return false; // TODO: implement listing date detection
  });

  return newBonds;
}

/* ── 4. Compile issuer financials ─────────────────── */
function compileIssuerFinancials() {
  console.log('Compiling issuer financials...');
  // TODO: parse from e-disclosure.ru or other sources
  return {};
}

/* ── Main ──────────────────────────────────────────── */
async function main() {
  console.log('=== BondRadar Weekly Data Collection ===\n');

  const ratings = await collectRatings();
  const bonds = await collectMoexSnapshot();
  const placements = await collectPlacements();
  const financials = compileIssuerFinancials();

  // Write compiled data
  writeFileSync(`${DATA_DIR}/ratings.json`, JSON.stringify(ratings, null, 2));
  writeFileSync(`${DATA_DIR}/placements.json`, JSON.stringify(placements, null, 2));
  writeFileSync(`${DATA_DIR}/financials.json`, JSON.stringify(financials, null, 2));

  // Write meta
  const meta = {
    collectedAt: new Date().toISOString(),
    bondsCount: bonds.length,
    ratingsCount: ratings.length,
    placementsCount: placements.length,
  };
  writeFileSync(`${DATA_DIR}/meta.json`, JSON.stringify(meta, null, 2));

  console.log(`\nDone. Collected:
    Bonds:    ${meta.bondsCount}
    Ratings:  ${meta.ratingsCount}
    Placements: ${meta.placementsCount}`);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});