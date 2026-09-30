/* ═══════════════════════════════════════════════════════════════════
   MOEX ISS — слой данных
   Все эндпоинты проверены вживую (scripts/probe*.mjs).
   Данные грузятся прямо из браузера (CORS подтверждён).
   ═══════════════════════════════════════════════════════════════════ */

const ISS = 'https://iss.moex.com/iss';
// Облигации торгуются на двух основных площадках:
//   TQCB — корпоративные (3033 выпуска)
//   TQOB — государственные ОФЗ (62 выпуска)
// Пересечений между ними нет, поэтому списки объединяются.
const BOND_BOARDS = ['TQCB', 'TQOB'];
const SHARES_URL = `${ISS}/engines/stock/markets/shares/boards/TQBR/securities.json`;

/* ── низкоуровневый запрос ───────────────────────────────────────── */
/* extended=true → ответ вида [charsetinfo, {block:[...]}] и мы отдаём второй
   элемент. Но осторожно: у /iss/securities/{SECID}.json в extended-режиме
   блок description приходит ПУСТЫМ (0 строк) — проверено на живом ISS, там
   40 полей против нуля. Поэтому паспорт бумаги запрашиваем с extended:false
   и работаем с обычным объектом блоков. */
async function iss(path, params = {}, { retries = 3, extended = true } = {}) {
  const url = new URL(ISS + path);
  url.searchParams.set('iss.meta', 'off');
  if (extended) url.searchParams.set('iss.json', 'extended');
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, { credentials: 'omit' });
      if (!r.ok) throw new Error(`ISS ${r.status}`);
      const text = await r.text();
      if (text.trimStart().startsWith('<')) throw new Error('ISS вернул HTML');
      const arr = JSON.parse(text);
      // iss.json=extended → [charsetinfo, {block: [...], ...}]
      return extended && Array.isArray(arr) && arr.length > 1 ? arr[1] : arr;
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise(res => setTimeout(res, 400 * attempt));
    }
  }
}

/* ── классификация ───────────────────────────────────────────────── */

// Реальные значения BONDTYPE (проверены):
//  Облигация с фиксированным (известным) купоном · Облигация с плавающим купоном
//  Структурная облигация · Амортизируемая облигация · Облигация с фиксированным (неизвестным) купоном
//  Валютная облигация · Линкер/облигация с индексируемым номиналом · Конвертируемая · Дисконтная
// COUPON_DETAILS: Фиксированный с известными купонами · Ключевая ставка · Ставка RUONIA · ИПЦ · ...
export function couponKind(b) {
  const det = (b.COUPON_DETAILS || '').toLowerCase();
  const type = (b.BONDTYPE || '').toLowerCase();

  // Плавающий купон: либо формула (ключевая ставка, RUONIA, ИПЦ), либо прямо тип
  if (/ключевая|ruonia|ипц|cpi|срочная ставка/.test(det)) return 'float';
  if (type.includes('плавающим')) return 'float';
  if (type.includes('структурн')) return 'struct';
  if (type.includes('дисконт')) return 'discount';
  if (type.includes('конвертируем')) return 'convert';
  if (type.includes('фиксированн')) return 'fix';
  if (det.includes('фиксированн')) return 'fix';
  // «Амортизируемая облигация» в MOEX — это структура, а не тип купона.
  // COUPON_DETAILS у таких выпусков пустой, но купон в подавляющем большинстве фиксированный.
  if (type.includes('амортизируем')) return 'fix';
  return 'other';
}

export const COUPON_LABEL = {
  fix: 'Фикс',
  float: 'Флоатер',
  struct: 'Структурная',
  discount: 'Дисконт',
  convert: 'Конвертируемая',
  other: '—',
};

export const COUPON_TAG = {
  fix: 'b',
  float: 'p',
  struct: 'a',
  discount: 'g',
  convert: 'p',
  other: '',
};

// Код эмитента из REGNUMBER: 4B02-11-16493-A-001P → 16493-A
export function issuerKey(regnumber) {
  if (!regnumber) return null;
  const m = /(\d{4,6})-([A-ZА-Я]{1,3})(?:-\d|$)/.exec(regnumber);
  return m ? `${m[1]}-${m[2]}` : null;
}

const CURRENCY = { SUR: 'RUB', RUB: 'RUB', USD: 'USD', EUR: 'EUR', CNY: 'CNY', CHF: 'CHF', GBP: 'GBP', HKD: 'HKD' };

// Санити-порог доходности. p99 рынка ≈ 104%, «мусорные» выбросы (1776,28 %) отсекаем.
const YTM_MIN = -50;
const YTM_MAX = 300;

/* ── нормализация одной бумаги ───────────────────────────────────── */
function lastNum(...vals) {
  for (const v of vals) if (v != null && v !== '' && !Number.isNaN(+v)) return +v;
  return null;
}

function normalize(s, m, y, board = 'TQCB') {
  const price = lastNum(m?.LAST, m?.LCLOSEPRICE, m?.MARKETPRICE, s.PREVPRICE, s.PREVWAPRICE);
  const rawYtm = lastNum(s.YIELDATPREVWAPRICE, m?.YIELD);
  // доходность и «здоровье» значения
  const ytmOk = rawYtm != null && rawYtm >= YTM_MIN && rawYtm <= YTM_MAX;
  const ytm = ytmOk ? rawYtm : null;
  /* Отдельная проверка ИМЕННО биржевого поля YIELD. Z-спред биржа считает
     от него, а наша доходность выше берётся в первую очередь из
     YIELDATPREVWAPRICE. Поля расходятся, и сильно: у ДОМ.РФ25об
     YIELDATPREVWAPRICE = 21,12 %, а YIELD = 2 774,51 % — и биржа честно
     выдаёт Z-спред 2 759. Проверка одной лишь нашей доходности такой
     мусор пропускает. */
  const moexYtmOk = m?.YIELD != null && +m.YIELD >= YTM_MIN && +m.YIELD <= YTM_MAX;

  const faceUnit = s.FACEUNIT || 'SUR';
  const currency = CURRENCY[faceUnit] || faceUnit;

  const kind = couponKind(s);
  const isAmort = (s.BONDTYPE || '').includes('Амортизируем');
  const durationDays = m?.DURATION != null ? +m.DURATION : null;

  const matDate = s.MATDATE && s.MATDATE !== '0000-00-00' ? s.MATDATE : null;
  const offerDate = s.OFFERDATE && s.OFFERDATE !== '0000-00-00' ? s.OFFERDATE : null;
  const buybackDate = s.BUYBACKDATE && s.BUYBACKDATE !== '0000-00-00' ? s.BUYBACKDATE : null;

  return {
    secid: s.SECID,
    isin: s.ISIN,
    shortname: s.SHORTNAME,
    name: s.SECNAME || s.SHORTNAME,
    latname: s.LATNAME,
    regnumber: s.REGNUMBER,
    issuerKey: issuerKey(s.REGNUMBER),
    board,
    isOfz: board === 'TQOB' || /^ОФЗ|^SU\d/.test(s.SHORTNAME || '') || /федерального займа/i.test(s.BONDTYPE || ''),
    isSubfederal: isSubfederal(s.REGNUMBER),

    price,
    /* Изменение цены за день. Важно: LASTCHANGEPRCNT здесь НЕ подходит —
       это изменение последней сделки к предыдущей сделке, то есть шаг
       между двумя тиками. Проверка на живых данных: LASTCHANGEPRCNT
       совпадал с настоящим изменением за день лишь у 7% выпусков, а у
       остальных давал шум вплоть до противоположного знака.
       LASTTOPREVPRICE — изменение последней цены к закрытию прошлого
       дня; сверено с расчётом (LAST - PREVPRICE)/PREVPRICE у всех
       1727 торговавшихся выпусков, расхождений нет.
       Если сделок сегодня не было, LAST равен null, и изменения нет —
       показываем прочерк, а не ложный ноль. То же для новых выпусков,
       которые торгуются первый день: у них PREVPRICE пуст, сравнивать
       не с чем, поэтому биржа отдаёт 0 — показываем прочерк. */
    priceChange: (m?.LAST != null && m?.LASTTOPREVPRICE != null && s.PREVPRICE != null)
      ? +m.LASTTOPREVPRICE : null,
    prevPrice: s.PREVPRICE != null ? +s.PREVPRICE : null,

    ytm,
    ytmRaw: rawYtm,
    ytmOk,
    yieldDateType: y?.YIELDDATETYPE || null,   // MATDATE | OFFER | MBS

    couponPercent: s.COUPONPERCENT != null ? +s.COUPONPERCENT : null,
    couponValue: s.COUPONVALUE != null ? +s.COUPONVALUE : null,
    couponPeriod: s.COUPONPERIOD != null ? +s.COUPONPERIOD : null,
    nextCoupon: s.NEXTCOUPON && s.NEXTCOUPON !== '0000-00-00' ? s.NEXTCOUPON : null,

    nkd: s.ACCRUEDINT != null ? +s.ACCRUEDINT : null,
    faceValue: s.FACEVALUE != null ? +s.FACEVALUE : null,
    faceUnit,
    currency,
    isCurrency: faceUnit !== 'SUR' && faceUnit !== 'RUB',

    matDate,
    offerDate,
    buybackDate: buybackDate || offerDate,
    callOptionDate: s.CALLOPTIONDATE && s.CALLOPTIONDATE !== '0000-00-00' ? s.CALLOPTIONDATE : null,

    durationDays,
    durationMonths: durationDays != null ? Math.round(durationDays / 30.44 * 10) / 10 : null,

    listLevel: s.LISTLEVEL != null ? +s.LISTLEVEL : null,
    status: s.STATUS,

    bondType: s.BONDTYPE,
    bondSubtype: s.BONDSUBTYPE,
    couponDetails: s.COUPON_DETAILS,
    couponKind: kind,
    isAmort,
    hasOffer: !!offerDate && s.BONDSUBTYPE !== 'До погашения',
    isQualified: false,
    isCurrencyBond: (s.BONDTYPE || '').includes('Валютная'),

    turnover: m?.VALTODAY != null ? +m.VALTODAY : 0,
    /* Z-спред — премия к безрисковой кривой ОФЗ, в ПРОЦЕНТНЫХ ПУНКТАХ.
       Биржа отдаёт готовое значение: у ОФЗ оно около нуля (проверено:
       от −2,47 до +1,26), у корпоратов доходит до 215. Это самая честная
       метрика «сколько платят сверх государства за риск» — она не зависит
       от уровня ставки, в отличие от самой доходности.
       Заполнено примерно у половины выпусков: биржа считает его только
       там, где есть корректная дюрация и цена.

       Берём его ТОЛЬКО при достоверном биржевом YIELD. Проверено на живых
       данных: все значения с |Z| > 300 сидят на бумагах с битым YIELD
       (2 774 %, 36 095 %). Без привязки мусор попадал в фильтр и таблицу —
       на странице красовался Z-спред 2 759 % у ДОМ.РФ25об. После проверки
       разброс стал −49,2 … 239,3, и максимум принадлежит реально
       проблемному CTRLлиз1Р1 с доходностью 253 %. */
    zSpread: (moexYtmOk && m?.ZSPREAD != null) ? +m.ZSPREAD : null,
    /* Купонная доходность «сейчас» — купон к цене покупки. Показывает,
       сколько бумага платит относительно того, что вы за неё отдаёте.
       Та же формула, что в карточке выпуска. */
    currentYield: (s.COUPONPERCENT != null && price) ? (+s.COUPONPERCENT / price) * 100 : null,
    numTrades: m?.NUMTRADES != null ? +m.NUMTRADES : null,

    issuesize: s.ISSUESIZE != null ? +s.ISSUESIZE : null,
    issuesizePlaced: s.ISSUESIZEPLACED != null ? +s.ISSUESIZEPLACED : null,
    lotSize: s.LOTSIZE != null ? +s.LOTSIZE : null,

    updatedAt: m?.SYSTIME || null,
  };
}

/* ── кэш ─────────────────────────────────────────────────────────── */
let bondsCache = null;
let bondsPromise = null;

/** Все облигации TQCB + TQOB (~3095 шт). Запросы идут параллельно. */
export function fetchBonds({ force = false } = {}) {
  if (force) { bondsCache = null; bondsPromise = null; }
  if (bondsCache) return Promise.resolve(bondsCache);
  if (!bondsPromise) {
    bondsPromise = Promise.all(
      BOND_BOARDS.map(board =>
        iss(`/engines/stock/markets/bonds/boards/${board}/securities.json`)
          .then(d => {
            const S = d.securities || [];
            const M = new Map((d.marketdata || []).map(r => [r.SECID, r]));
            const Y = new Map((d.marketdata_yields || []).map(r => [r.SECID, r]));
            return S.map(s => normalize(s, M.get(s.SECID), Y.get(s.SECID), board));
          })
          .catch(e => { console.warn(`Не удалось загрузить ${board}:`, e.message); return []; })
      )
    )
      .then(lists => {
        const all = lists.flat();
        // на всякий случай убираем дубли по SECID (межбордовых пересечений нет, но подстрахуемся)
        const seen = new Set();
        bondsCache = all.filter(b => !seen.has(b.secid) && seen.add(b.secid));
        return bondsCache;
      })
      .catch(e => { bondsPromise = null; throw e; });
  }
  return bondsPromise;
}

/* ── карточка облигации ──────────────────────────────────────────── */
export async function fetchBondCard(secidOrIsin) {
  const id = (secidOrIsin || '').trim().toUpperCase();
  const [desc, bondization, boardData] = await Promise.all([
    iss(`/securities/${id}.json`),
    iss(`/securities/${id}/bondization.json`).catch(() => ({})),
    iss(`/securities/${id}.json`, { 'iss.only': 'boards' }).catch(() => ({})),
  ]);

  const description = {};
  (desc.description || []).forEach(x => { description[x.name] = x.value; });

  const bonds = boardData.boards || [];
  const mainBoard = bonds.find(b => b.is_primary === 1) || bonds[0];

  const coupons = (bondization.coupons || []).map(c => ({
    date: c.coupondate,
    value: c.value != null ? +c.value : null,
    valuePrc: c.valueprc != null ? +c.valueprc : null,
    faceValue: c.facevalue != null ? +c.facevalue : null,
  }));
  const amortizations = (bondization.amortizations || []).map(a => ({
    date: a.amortdate,
    value: a.value != null ? +a.value : null,
    valuePrc: a.valueprc != null ? +a.valueprc : null,
    source: a.data_source,
  }));
  // MOEX отдаёт «пустую» оферту с датой 0000-00-00 (техническая запись «Оферта/Погашение») — отбрасываем
  const validDate = d => !!d && d !== '0000-00-00';
  const offers = (bondization.offers || [])
    .filter(o => validDate(o.offerdate) || validDate(o.offerdatestart))
    .map(o => ({
      date: validDate(o.offerdate) ? o.offerdate : o.offerdatestart,
      start: o.offerdatestart,
      end: o.offerdateend,
      price: o.price != null ? +o.price : null,
      type: o.offertype,
    }));

  return {
    secid: id,
    description,
    issuerId: description.EMITTER_ID || null,
    coupons,
    amortizations,
    offers,
    boards: bonds,
    mainBoard,
    hasDefault: description.HASDEFAULT === 1 || description.HASDEFAULT === '1',
    hasTechDefault: description.HASTECHNICALDEFAULT === 1 || description.HASTECHNICALDEFAULT === '1',
    couponFrequency: description.COUPONFREQUENCY != null ? +description.COUPONFREQUENCY : null,
    daysToRedemption: description.DAYSTOREDEMPTION != null ? +description.DAYSTOREDEMPTION : null,
    isQualified: description.ISQUALIFIEDINVESTORS === 1 || description.ISQUALIFIEDINVESTORS === '1',
    typename: description.TYPENAME,
    issueName: description.NAME,
    issueDate: description.ISSUEDATE,
    shortname: description.SHORTNAME,
  };
}

/* ── эмитент ─────────────────────────────────────────────────────── */

/** Формальное имя/ИНН эмитента по ISIN (1 запрос). */
export async function fetchIssuerInfo(secidOrIsin) {
  try {
    const d = await iss('/securities.json', { q: secidOrIsin });
    const row = (d.securities || [])[0];
    if (!row) return null;
    return {
      id: row.emitent_id,
      title: row.emitent_title,
      inn: row.emitent_inn,
      name: row.name,
      shortname: row.shortname,
    };
  } catch { return null; }
}

/** Облигации эмитента из уже загруженного списка (без доп. запросов). */
export function bondsOfIssuer(all, key) {
  if (!key) return [];
  return all.filter(b => b.issuerKey === key);
}

/* ── реестр эмитентов MOEX ───────────────────────────────────────── *
 * /iss/emitters/{id} — официальный реестр: ОГРН, адреса, сайт,
 * капитализация. Рейтингов там НЕТ (14 полей, ни одного рейтингового) —
 * поэтому рейтинги на сайте честно помечены как отсутствующие.
 */

/** Поле URL в реестре приходит грязным («https://site.ru/ - ; - ;») — вычищаем. */
function firstUrl(s) {
  if (!s) return null;
  const m = String(s).match(/https?:\/\/[^\s;,]+/);
  return m ? m[0].replace(/[).,;]+$/, '') : null;
}

/** Полная карточка эмитента из реестра MOEX (1 запрос). */
export async function fetchEmitter(emitterId) {
  if (emitterId == null || emitterId === '') return null;
  try {
    const d = await iss(`/emitters/${emitterId}.json`);
    const e = (d.emitter || [])[0];
    if (!e) return null;
    const num = v => (v == null || v === '' ? null : +v);
    return {
      id: e.EMITTER_ID,
      title: e.TITLE,
      shortTitle: e.SHORT_TITLE,
      inn: e.INN,
      ogrn: e.OGRN,
      okpo: e.OKPO,
      country: e.OKSM,
      legalAddress: e.LEGAL_ADDRESS,
      postalAddress: e.POSTAL_ADDRESS,
      website: firstUrl(e.URL),
      // CAPITALIZATION — весь холдинг, EMITTER_CAPITALIZATION — само юрлицо
      capitalization: num(e.CAPITALIZATION),
      emitterCapitalization: num(e.EMITTER_CAPITALIZATION),
      capitalizationUpdatedAt: e.EMITTER_CAPITALIZATION_UPDATETIME,
    };
  } catch { return null; }
}

/** Официальная отчётность эмитента на сайте MOEX (без парсинга — просто ссылка). */
export function moexReportsUrl(emitterId) {
  return emitterId == null || emitterId === ''
    ? null
    : `https://www.moex.com/ru/listing/emidocs.aspx?id=${emitterId}`;
}

/* ── бухгалтерская отчётность из ГИР БО ФНС ──────────────────────── *
 * ГИР БО (bo.nalog.gov.ru) ведёт ФНС по ФЗ № 402-ФЗ «О бухгалтерском
 * учёте», ст. 18 — ресурс по закону публичный. Но из браузера к нему
 * обратиться нельзя: ФНС не отдаёт CORS-заголовок ни на одном своём
 * эндпоинте (проверено на поиске, карточке организации и выгрузке).
 *
 * Поэтому данные собирает робот (scripts/girbo.mjs) раз в неделю и
 * кладёт рядом с сайтом файл girbo.json. Браузер читает его с того же
 * домена — быстро и без внешних запросов.
 *
 * Организации, закрывшие доступ к своей отчётности, помечены closed.
 * Мы уважаем это ограничение и ничего не показываем по ним.
 */
let girboCache;
let girboPromise;

/** Весь файл отчётности. Загружается один раз за сессию. */
export async function fetchGirbo() {
  if (girboCache) return girboCache;
  if (!girboPromise) {
    const base = import.meta.env?.BASE_URL || '/';
    girboPromise = fetch(`${base}girbo.json`, { credentials: 'omit' })
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null)
      .then(d => { girboCache = d; return d; });
  }
  return girboPromise;
}

/** Отчётность конкретного эмитента по его ИНН. */
export async function fetchGirboByInn(inn) {
  const key = String(inn || '').trim();
  if (!key) return null;
  const all = await fetchGirbo();
  return all?.organizations?.[key] || null;
}

/** Публичная карточка организации в ГИР БО — для ссылки на первоисточник. */
export function girboUrl(girboId) {
  return girboId == null ? 'https://bo.nalog.gov.ru/' : `https://bo.nalog.gov.ru/nbo/organizations/${girboId}`;
}

/** Карточка выпуска на сайте MOEX. */
export function moexIssueUrl(secidOrIsin, board) {
  if (!secidOrIsin) return null;
  const b = board || 'TQCB';
  return `https://www.moex.com/ru/issue.aspx?board=${b}&code=${secidOrIsin}`;
}

/* ── анонсы первичных размещений ─────────────────────────────────── *
 * MOEX не публикует книгу заявок и ориентир купона в машиночитаемом
 * виде. Доступны только новостные анонсы «О порядке сбора заявок…».
 * Отдаём ровно их и честно называем анонсами, а не базой размещений.
 */
export async function fetchPlacementNews() {
  const d = await iss('/sitenews.json');
  const rows = d.sitenews || [];
  return rows
    .filter(n => /размещ|сбор заявок/i.test(n.title || ''))
    .map(n => ({
      id: n.id,
      title: (n.title || '').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim(),
      publishedAt: n.published_at,
      tag: n.tag,
      url: `https://www.moex.com/n${n.id}/?nt=101`,
    }));
}

/* ── субфедеральные и муниципальные облигации ─────────────────────── *
 * У региональных выпусков государственный регистрационный номер имеет
 * строгий формат: RU + 5 цифр + 3 буквы региона + 1 цифра.
 *   RU35002GSP0 — Санкт-Петербург, RU35067TMS0 — Томская область
 * У корпоратов он другой: 4B02-11-16493-A-001P.
 * Это позволяет отделять регионы от корпоратов прямо по списку бумаг,
 * без единого дополнительного запроса. Проверено: таких выпусков 65.
 */
export function isSubfederal(regnumber) {
  return /^RU\d{5}[A-ZА-Я]{3}\d$/.test(String(regnumber || '').trim());
}

/* ── рыночные ставки и индексы ───────────────────────────────────── *
 * MOEX отдаёт ключевую ставку как индекс KEYRATE («Индекс МосБиржи
 * Ключевой ставки»), а ставку репо — как RUSFAR. Обе доступны живым
 * запросом, поэтому робот-обновлятор для ставки не нужен.
 */
export const RATE_INDEXES = [
  { secid: 'KEYRATE', label: 'Ключевая ставка ЦБ', note: 'индекс МосБиржи ключевой ставки' },
  { secid: 'RUSFAR', label: 'RUSFAR', note: 'ставка репо с ЦК, овернайт' },
];

/**
 * Значения всех индексов MOEX одним запросом.
 * Возвращает { SECID: { value, change, date } }.
 */
export async function fetchIndexValues() {
  const d = await iss('/engines/stock/markets/index/securities.json', {
    'iss.only': 'securities,marketdata',
    'securities.columns': 'SECID,SHORTNAME,NAME,DECIMALS',
  });
  const meta = {};
  (d.securities || []).forEach(s => { meta[s.SECID] = s; });

  const out = {};
  (d.marketdata || []).forEach(m => {
    const v = m.CURRENTVALUE ?? m.LASTVALUE;
    if (v == null) return;
    const prev = m.LASTVALUE ?? null;
    out[m.SECID] = {
      secid: m.SECID,
      name: meta[m.SECID]?.NAME || m.SECID,
      shortname: meta[m.SECID]?.SHORTNAME || m.SECID,
      decimals: meta[m.SECID]?.DECIMALS ?? 2,
      value: +v,
      open: m.OPENVALUE != null ? +m.OPENVALUE : null,
      /* У индексов поле называется ИНАЧЕ, чем у акций и облигаций:
         LASTCHANGEPRC («изменение к предыдущему закрытию»), и оно
         верное. Сверено по RGBI: 111,22 против 111,69 вчера даёт
         −0,42%, ровно как в поле. Не заменяйте его на LASTCHANGEPRCNT
         по аналогии с бумагами — у индексов это разные величины. */
      changePct: m.LASTCHANGEPRC != null ? +m.LASTCHANGEPRC : null,
      monthChangePct: m.MONTHCHANGEPRC != null ? +m.MONTHCHANGEPRC : null,
      yearChangePct: m.YEARCHANGEPRC != null ? +m.YEARCHANGEPRC : null,
      high: m.HIGH != null ? +m.HIGH : null,
      low: m.LOW != null ? +m.LOW : null,
      date: m.TRADEDATE || null,
      time: m.UPDATETIME || null,
      prev,
    };
  });
  return out;
}

/** Медиана набора чисел (для «ВДО (медиана)» и «надёжные корпораты»). */
export function median(nums) {
  const a = nums.filter(v => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Доходность ОФЗ на заданный срок — линейная интерполяция кривой. */
export function curveAt(curve, years) {
  if (!curve?.length) return null;
  const pts = curve.filter(p => p.value != null).sort((a, b) => a.period - b.period);
  if (!pts.length) return null;
  if (years <= pts[0].period) return pts[0].value;
  if (years >= pts[pts.length - 1].period) return pts[pts.length - 1].value;
  for (let i = 1; i < pts.length; i++) {
    if (years <= pts[i].period) {
      const a = pts[i - 1], b = pts[i];
      const k = (years - a.period) / (b.period - a.period || 1);
      return a.value + (b.value - a.value) * k;
    }
  }
  return null;
}

/* ── кривая доходности ОФЗ ───────────────────────────────────────── */
export async function fetchYieldCurve() {
  const d = await iss('/engines/stock/zcyc.json');
  const years = (d.yearyields || []).map(r => ({
    period: +r.period,
    value: r.value != null ? +r.value : null,
    date: r.tradedate,
  })).filter(r => r.value != null).sort((a, b) => a.period - b.period);
  return years;
}

/* ── индексы ─────────────────────────────────────────────────────── */

/** История индекса (RGBI, MCFTR, IMOEX...). */
export async function fetchIndexHistory(secid, { from, till } = {}) {
  const d = await iss(`/history/engines/stock/markets/index/securities/${secid}.json`, {
    from: from || defaultFrom(120),
    till,
  });
  return (d.history || []).map(r => ({
    date: r.TRADEDATE,
    close: r.CLOSE != null ? +r.CLOSE : null,
    open: r.OPEN != null ? +r.OPEN : null,
    high: r.HIGH != null ? +r.HIGH : null,
    low: r.LOW != null ? +r.LOW : null,
    value: r.VALUE != null ? +r.VALUE : null,
    yield: r.YIELD != null ? +r.YIELD : null,
    duration: r.DURATION != null ? +r.DURATION : null,
    capitalization: r.CAPITALIZATION != null ? +r.CAPITALIZATION : null,
    name: r.SHORTNAME || r.NAME,
  }));
}

function defaultFrom(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

/* ── акции ───────────────────────────────────────────────────────── */
/**
 * Акции основного режима TQBR.
 * SECTYPE: '1' — обыкновенные, '2' — привилегированные.
 * Остальные значения на этой площадке — ETF/БПИФ ('J'), депозитарные
 * расписки ('9', 'B', 'A') и прочее; они в раздел «Акции» не попадают.
 */
const SHARE_TYPES = new Set(['1', '2']);

export async function fetchStocks({ includeFunds = false } = {}) {
  const d = await iss('/engines/stock/markets/shares/boards/TQBR/securities.json');
  const S = d.securities || [];
  const M = new Map((d.marketdata || []).map(r => [r.SECID, r]));
  return S
    .filter(s => includeFunds || SHARE_TYPES.has(s.SECTYPE))
    .map(s => {
      const m = M.get(s.SECID);
      const price = lastNum(m?.LAST, m?.LCLOSEPRICE, m?.MARKETPRICE, s.PREVPRICE);
      return {
        secid: s.SECID,
        isin: s.ISIN,
        shortname: s.SHORTNAME,
        name: s.SECNAME || s.SHORTNAME,
        latname: s.LATNAME,
        secType: s.SECTYPE,
        isPreferred: s.SECTYPE === '2',
        price,
        /* То же, что и у облигаций: LASTCHANGEPRCNT — это шаг между
           двумя последними сделками, а не изменение за день.
           Проверено: из 446 торговавшихся акций он совпадал с реальным
           изменением лишь у 33, тогда как LASTTOPREVPRICE — у всех 446.
           Пример вранья: Сбербанк показывал 0,00% вместо +1,06%,
           ГАЗПРОМ −0,01% вместо +1,70%, ЛУКОЙЛ −0,01% вместо +1,59%.
           Прочерк — когда сделок не было или бумага торгуется первый
           день и предыдущего закрытия для сравнения не существует. */
        change: (m?.LAST != null && m?.LASTTOPREVPRICE != null && s.PREVPRICE != null)
          ? +m.LASTTOPREVPRICE : null,
        lastChange: (m?.LAST != null && s.PREVPRICE != null) ? +m.LAST - +s.PREVPRICE : null,
        open: m?.OPEN != null ? +m.OPEN : null,
        low: m?.LOW != null ? +m.LOW : null,
        high: m?.HIGH != null ? +m.HIGH : null,
        turnover: m?.VALTODAY != null ? +m.VALTODAY : 0,
        numTrades: m?.NUMTRADES != null ? +m.NUMTRADES : null,
        issuesize: s.ISSUESIZE != null ? +s.ISSUESIZE : null,
        listLevel: s.LISTLEVEL != null ? +s.LISTLEVEL : null,
        // Оценка капитализации: число бумаг в выпуске × цена. Для бумаг,
        // где биржа не раскрывает полный ISSUESIZE, значение приблизительное.
        capitalization: (s.ISSUESIZE != null && price != null) ? +s.ISSUESIZE * price : null,
      };
    })
    .filter(s => s.price != null);
}

/* ── история цен по акции ────────────────────────────────────────── *
 * Нужна для графика в карточке акции. Отдельный запрос на бумагу —
 * поэтому вызывается только со страницы конкретной акции, а не в
 * списке: 262 запроса ради списка были бы издевательством над биржей.
 */
export async function fetchStockHistory(secid, { from, till } = {}) {
  if (!secid) return [];
  const d = await iss(`/history/engines/stock/markets/shares/boards/TQBR/securities/${secid}.json`, {
    from: from || defaultFrom(180),
    till,
  });
  return (d.history || []).map(r => ({
    date: r.TRADEDATE,
    close: r.CLOSE != null ? +r.CLOSE : null,
    open: r.OPEN != null ? +r.OPEN : null,
    high: r.HIGH != null ? +r.HIGH : null,
    low: r.LOW != null ? +r.LOW : null,
    value: r.VALUE != null ? +r.VALUE : null,
    volume: r.VOLUME != null ? +r.VOLUME : null,
    numTrades: r.NUMTRADES != null ? +r.NUMTRADES : null,
  })).filter(r => r.close != null);
}

/* ── паспорт бумаги: то, чего нет в списочных блоках ─────────────── *
 *
 * Разведано на живом ISS. Списочный блок TQCB отдаёт 47 полей, но в нём
 * НЕТ ни имени эмитента, ни признака «для квалифицированных
 * инвесторов». Эти сведения лежат только в описании КОНКРЕТНОЙ бумаги,
 * по адресу /iss/securities/{SECID}.json. Проверено отдельно: пачкой
 * этот блок не отдаётся — параметры securities= и iss.only=description
 * на /iss/securities.json игнорируются, приходит обычный список из 100
 * бумаг. Значит, обогащение стоит ровно один запрос на одну бумагу,
 * и злоупотреблять им нельзя: 3 095 выпусков — это 3 095 запросов.
 *
 * Поэтому функция вызывается только там, где пользователь смотрит на
 * один выпуск или на один эмитент, и никогда — ради списка целиком.
 */
export async function fetchSecurityDescription(secid) {
  if (!secid) return null;
  const d = await iss(`/securities/${secid}.json`, {}, { extended: false });
  const rows = (d.description || []).data || [];
  const get = name => {
    const r = rows.find(x => x[1] === name);
    return r && r[2] != null && r[2] !== '' ? r[2] : null;
  };
  const full = get('Полное наименование');
  return {
    secid,
    fullName: full,
    /* «Сбербанк ПАО 001Р-SBER51» → «Сбербанк ПАО» */
    issuerName: issuerFromFullName(full),
    issuerCode: get('Код эмитента'),
    issuersQualified: ['1', 'true', 'да'].includes(String(get('Бумаги для квалифицированных инвесторов') || '').toLowerCase()),
    listLevel: get('Уровень листинга') != null ? +get('Уровень листинга') : null,
    bondTypeText: get('Вид облигации'),
    subtypeText: get('Подвид облигации'),
    couponFreqYear: get('Периодичность выплаты купона в год') != null ? +get('Периодичность выплаты купона в год') : null,
    issueVolume: get('Объем выпуска') != null ? +get('Объем выпуска') : null,
    regNumber: get('Номер государственной регистрации'),
    maturity: get('Дата погашения'),
  };
}

/** Убирает из полного наименования хвост-серию: «… ПАО 001Р-SBER51» → «… ПАО». */
export function issuerFromFullName(full) {
  if (!full) return null;
  const parts = String(full).trim().split(/\s+/);
  // Срезаем с конца токены-серии: в них есть цифра и нет пробелов.
  while (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (/\d/.test(last) && last.length <= 24) parts.pop();
    else break;
  }
  const name = parts.join(' ').trim();
  return name || String(full).trim();
}

/**
 * Обогащает выпуски одного эмитента паспортами.
 * concurrency ограничена, чтобы не заваливать биржу; при превышении
 * лимита функция честно сообщает, что покрытие неполное.
 */
export async function fetchIssuerProfile(bonds, { limit = 40, concurrency = 4 } = {}) {
  const list = (bonds || []).filter(b => b.isin || b.secid);
  if (!list.length) return { issuerName: null, byIsin: {}, covered: 0, total: 0, partial: false };

  const total = list.length;
  const slice = list.slice(0, limit);
  const byIsin = {};
  let issuerName = null;

  let cursor = 0;
  const worker = async () => {
    while (cursor < slice.length) {
      const b = slice[cursor++];
      try {
        const p = await fetchSecurityDescription(b.secid);
        if (!p) continue;
        byIsin[b.isin || b.secid] = p;
        if (!issuerName && p.issuerName) issuerName = p.issuerName;
      } catch { /* одна бумага не ответила — остальные всё равно нужны */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, slice.length) }, worker));

  const covered = Object.keys(byIsin).length;
  return { issuerName, byIsin, covered, total, partial: covered < total };
}

/* ── ставка ЦБ (история известных решений) ───────────────────────── */
export const KEY_RATE_HISTORY = [
  ['2024-10-28', 21.0], ['2025-06-09', 20.0], ['2025-07-28', 18.0],
  ['2025-09-15', 17.0], ['2025-10-27', 16.5], ['2025-12-22', 16.0],
  ['2026-02-16', 15.5], ['2026-03-23', 15.0], ['2026-04-27', 14.5],
  ['2026-06-22', 14.25], ['2026-07-28', 14.0],
];
export const KEY_RATE = KEY_RATE_HISTORY[KEY_RATE_HISTORY.length - 1][1];

/* ── подборки ────────────────────────────────────────────────────── */
export const COLLECTIONS = [
  { slug: 'ofz', title: 'ОФЗ', desc: 'Государственные облигации (площадка TQOB)', test: b => b.isOfz },
  { slug: 'floatery', title: 'Флоатеры', desc: 'Плавающий купон: ключевая ставка, RUONIA, ИПЦ', test: b => b.couponKind === 'float' },
  { slug: 'valyutnye', title: 'Валютные', desc: 'Номинал в долларах, евро, юанях, франках', test: b => b.isCurrency },
  { slug: 'zameshchayushchie', title: 'Замещающие', desc: 'Выпуски с маркером «ЗО» в названии', test: b => /ЗО/.test(b.shortname || '') },
  { slug: 'vysokodohodnye', title: 'Высокодоходные (ВДО)', desc: 'Доходность от 20% и 3-й уровень листинга', test: b => b.ytm != null && b.ytm >= 20 && b.listLevel === 3 },
  { slug: 's-ofertoy', title: 'С офертой', desc: 'Досрочный выкуп (put)', test: b => b.hasOffer },
  { slug: 'ezhemesyachnyy-kupon', title: 'Ежемесячный купон', desc: 'Выплаты каждые 30 дней', test: b => b.couponPeriod != null && b.couponPeriod >= 25 && b.couponPeriod <= 40 },
  { slug: 's-amortizaciey', title: 'С амортизацией', desc: 'Возврат номинала частями', test: b => b.isAmort },
  { slug: 'subord', title: 'Субординированные', desc: 'Младший долг банков', test: b => /суборд|СУБ/i.test(b.shortname + ' ' + (b.bondType || '')) },
  { slug: 'korotkie', title: 'Короткие (до 1 года)', desc: 'Погашение в течение года', test: b => b.matDate && daysUntil(b.matDate) <= 365 && daysUntil(b.matDate) > 0 },
  { slug: 'dlinnye', title: 'Длинные (от 7 лет)', desc: 'Долгий срок до погашения', test: b => b.matDate && daysUntil(b.matDate) >= 2555 },
  { slug: 'struct', title: 'Структурные', desc: 'Структурные облигации', test: b => b.couponKind === 'struct' },
  { slug: 'list1', title: '1 уровень листинга', desc: 'Максимальные требования биржи', test: b => b.listLevel === 1 },
  { slug: 'fix', title: 'Фиксированный купон', desc: 'Постоянная известная ставка', test: b => b.couponKind === 'fix' },
  { slug: 'stoimost-do-90', title: 'Цена ниже 90%', desc: 'Глубокий дисконт к номиналу', test: b => b.price != null && b.price < 90 },
  { slug: 'bez-oferty', title: 'Без оферты', desc: 'Только до погашения', test: b => !b.hasOffer },
];

export function daysUntil(dateStr) {
  if (!dateStr) return Infinity;
  const d = new Date(dateStr + 'T00:00:00');
  return Math.round((d - new Date()) / 86400000);
}