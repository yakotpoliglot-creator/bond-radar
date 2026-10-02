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
  /* ЦЕНА И ДОХОДНОСТЬ БЕРУТСЯ ПАРОЙ ИЗ ОДНОГО ИСТОЧНИКА.
     Это не педантизм, а исправление настоящей ошибки. Раньше цена
     выбиралась по списку LAST → LCLOSEPRICE → MARKETPRICE → PREVPRICE
     → PREVWAPRICE, а доходность отдельным списком YIELDATPREVWAPRICE →
     YIELD. Два числа при этом описывали РАЗНЫЕ цены.

     Живой пример: Ситимат01. PREVWAPRICE = 19,91, от неё биржа считает
     YIELDATPREVWAPRICE = 59,58%. А цена в карточке показывалась 98,9
     (из MARKETPRICE). Инвестор видел бумагу у номинала с доходностью
     59,58% — числа, которые друг к другу не относятся.

     Поэтому теперь цена и доходность идут одной парой: цена последней
     сделки с доходностью последней сделки, а если торгов сегодня не
     было — цена предыдущего дня с доходностью предыдущего дня. */
  let price = null, rawYtm = null, priceSrc = null;
  if (m?.LAST != null && +m.LAST > 0) {
    price = +m.LAST; rawYtm = lastNum(m?.YIELD); priceSrc = 'today';
  } else if (m?.MARKETPRICE != null && +m.MARKETPRICE > 0) {
    price = +m.MARKETPRICE; rawYtm = lastNum(m?.YIELD); priceSrc = 'today';
  } else if (s.PREVPRICE != null && +s.PREVPRICE > 0) {
    price = +s.PREVPRICE; rawYtm = lastNum(m?.YIELD); priceSrc = 'prev';
  } else if (s.PREVWAPRICE != null && +s.PREVWAPRICE > 0) {
    price = +s.PREVWAPRICE; rawYtm = lastNum(s.YIELDATPREVWAPRICE); priceSrc = 'prev';
  }
  if (price == null) price = lastNum(m?.LCLOSEPRICE, s.PREVPRICE, s.PREVWAPRICE);
  if (!(price > 0)) price = null;
  if (rawYtm == null) rawYtm = lastNum(m?.YIELD, s.YIELDATPREVWAPRICE);
  // доходность и «здоровье» значения
  /* НОЛЬ У БИРЖИ ЗНАЧИТ «ДАННЫХ НЕТ», А НЕ НОЛЬ.
     По выпуску, где сегодня не было сделок, YIELD приходит ровно 0.
     Мы печатали это как «доходность 0,00%» — инвестор читает как
     настоящую нулевую доходность. В скринере так показывались
     ОФЗ 29024, Сегежа3P5R, ПСБ 15 — то есть бумаги выглядели
     заведомо убыточными. То же с DURATION = 0: ноль дюрации у бумаги
     с погашением через десять лет — не факт, а отсутствие расчёта,
     и таких выпусков 1388, они же сбивали подборку «близкая дюрация». */
  if (rawYtm === 0) rawYtm = null;
  /* ФИЗИЧЕСКИЙ ПОТОЛОК ДОХОДНОСТИ.
     Биржа отдаёт по неликвидным выпускам математически невозможные
     значения. Топ корпоратов по её полю выглядел так:
     СэтлГрБ2P4 — цена 97,54, «доходность» 17 626% (оферта через 2 дня);
     ЭффТех1P2 — цена 5,10, «доходность» 3 434%; СИМПЛСК1Р1 — 2 604%.
     Всего 103 корпората имели доходность выше 50% и 39 — выше 100%.

     Считаем предел, выше которого доходность невозможна физически:
     купив по цене P и получив обратно номинал плюс все оставшиеся
     купоны, больше этой величины заработать нельзя. Слагаемое в 1,35
     и 20 пунктов — запас на неточность оценки купонов (амортизация,
     переменный купон) и на то, что точная формула сложного процента
     даёт чуть больше грубой оценки. */
  const ytmCeiling = (() => {
    if (!(price > 0)) return null;
    const dMat = daysUntil(s.MATDATE);
    // Если доходность считается к оферте — срок до неё, иначе до погашения
    const dOff = daysUntil(s.OFFERDATE);
    const d = (dOff != null && dOff > 0 && (dMat == null || dOff < dMat)) ? dOff : dMat;
    if (d == null || d <= 0) return null;
    const years = d / 365;
    const cpn = lastNum(s.COUPONPERCENT) || 0;
    // Грубая сумма оставшихся купонов + возврат номинала
    const back = 100 + cpn * years;
    if (!(back > price)) return null;
    const bound = (Math.pow(back / price, 1 / years) - 1) * 100;
    return bound * 1.35 + 20;
  })();
  /* Значение, срезанное потолком, сохраняем отдельным полем. На главной
     такие числа показывать нельзя, а «Радару риска» они и нужны: там
     собрано самое плохое, и вырезать из него худшее — значит сломать
     саму страницу. У оригинала на радаре так и стоит «>200%». */
  const ytmAboveCeiling = (rawYtm != null && ytmCeiling != null && rawYtm > ytmCeiling) ? rawYtm : null;
  if (ytmAboveCeiling != null) rawYtm = null;
  const ytmOk = rawYtm != null && rawYtm >= YTM_MIN && rawYtm <= YTM_MAX;
  /* Два поля доходности у биржи могут противоречить друг другу в разы:
     ВЭБ.РФ 19 — 0,50% против 170,43%, СистемБ1P4 — −7,23% против 6,70%.
     Это не наш расчёт, это два числа самой биржи, и по неликвидным
     выпускам верного среди них может не быть вовсе. Молча показать одно
     из них — значит выдать случайное число за факт. Поэтому помечаем
     расхождение и говорим об этом в интерфейсе. */
  const ytmAlt = lastNum(m?.YIELD, s.YIELDATPREVWAPRICE);
  const ytmSuspect = rawYtm != null && ytmAlt != null && Math.abs(rawYtm - ytmAlt) > 10;
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
  /* DURATION = 0 — тоже «не посчитано» (см. комментарий у ytm выше). */
  const durRaw = m?.DURATION != null ? +m.DURATION : null;
  const durationDays = durRaw && durRaw > 0 ? durRaw : null;

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
    /* Откуда цена: 'today' — сделка текущей сессии, 'prev' — предыдущий
       торговый день. Нужно, чтобы интерфейс не выдавал вчерашнюю цену
       за сегодняшнюю: 548 выпусков из 3095 сегодня не торговались. */
    priceSrc,
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
    ytmAboveCeiling,
    ytmOk,
    ytmSuspect,
    ytmAlt,
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
/* ── кредитные рейтинги ──────────────────────────────────────────── *
 *
 * Рейтинги берём из таблицы котировок smart-lab.ru: у каждой строки есть
 * значок рейтинга и ссылка на выпуск с ISIN — по нему рейтинг и
 * связывается с нашими данными биржи.
 *
 * Страница отдаётся без CORS, из браузера её не прочитать, поэтому её
 * разбирает робот (scripts/ratings.mjs) и кладёт рядом с сайтом файл
 * ratings.json — тот же приём, что с отчётностью ГИР БО и первичкой.
 *
 * Чего в источнике НЕТ и мы не додумываем: агентства (значок показан без
 * указания, АКРА это или Эксперт РА) и даты присвоения. Поэтому в
 * подсказке к колонке прямо сказано, что это ориентир по данным
 * smart-lab, а не выписка из отчёта рейтингового агентства.
 */
let ratingsCache;
let ratingsPromise;

/** Рейтинги по ISIN: { ratings: { ISIN: { r, c } }, scale, stats }. */
export function fetchRatings() {
  if (ratingsCache) return Promise.resolve(ratingsCache);
  if (!ratingsPromise) {
    const base = import.meta.env?.BASE_URL || '/';
    ratingsPromise = fetch(`${base}ratings.json`, { credentials: 'omit' })
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null)
      .then(d => { ratingsCache = d; return d; });
  }
  return ratingsPromise;
}

/** Проставляет бумагам рейтинг и место на шкале (нужно для сортировки). */
async function withRatings(list) {
  const data = await fetchRatings();
  const map = data?.ratings;
  if (!map) return list;

  /* Рейтинг у источника — рейтинг ЭМИТЕНТА, а не выпуска. Проверено на всех
     данных: у 332 эмитентов, чьи выпуски есть в таблице smart-lab, значок
     одинаков у всех выпусков без единого расхождения.
     Отсюда честный добор: у бумаги, которой в таблице нет вовсе, показываем
     рейтинг её эмитента по другим его выпускам — это ровно тот же рейтинг,
     который источник и показывает, а не наша догадка. Покрытие наших
     выпусков из-за этого растёт с 47 % до 70 %; у остальных прочерк, потому
     что эмитента в источнике нет. */
  const issuerRating = new Map();
  for (const b of list) {
    const hit = b.isin ? map[b.isin] : null;
    if (hit && b.issuerKey && !issuerRating.has(b.issuerKey)) issuerRating.set(b.issuerKey, hit);
  }

  for (const b of list) {
    const own = b.isin ? map[b.isin] : null;
    const via = own || (b.issuerKey ? issuerRating.get(b.issuerKey) : null);
    b.rating = via?.r || null;
    /* Код шкалы: 1 — D, 20 — AAA. Сортировать по значку нельзя:
       строками «AAA» оказалось бы меньше, чем «A-». */
    b.ratingCode = via?.c ?? null;
    /* own — значок стоит у самой этой бумаги; иначе рейтинг взят по
       эмитенту, и в подсказке это сказано прямо. */
    b.ratingOwn = !!own;
  }
  return list;
}

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
      /* Рейтинги подмешиваем к списку бумаг, а не к каждой странице
         отдельно: так колонка появляется сразу везде, где таблица
         строится из этого списка (скринер, подборки, ОФЗ, ВДО). Если
         файла нет — просто не будет рейтингов, страницы работать
         не перестанут. */
      .then(list => withRatings(list))
      .catch(e => { bondsPromise = null; throw e; });
  }
  return bondsPromise;
}

/* ── карточка облигации ──────────────────────────────────────────── *
 *
 * Тонкость, на которой мы уже попадались: график купонов и площадки
 * биржа отдаёт только по коду ПЛОЩАДКИ. У корпоратов он совпадает
 * с ISIN, а у ОФЗ — нет: ISIN RU000A10D533, а код на TQOB —
 * SU26254RMFS1. Запрос по ISIN возвращает НОЛЬ площадок и НОЛЬ
 * купонов, и карточка писала «MOEX не отдал график, возможно
 * дисконтная бумага» про ОФЗ с купоном 13% и 20 выплатами.
 * Проверено на живом ISS: по SU26254RMFS1 приходит 48 площадок
 * и 20 купонов, по RU000A10D533 — пусто.
 *
 * Поэтому сначала спрашиваем по тому, что пришло в адресе, и только
 * если площадок нет — ищем код площадки в уже загруженном списке
 * бумаг (он кэширован общим промисом, лишнего запроса не будет).
 */
async function boardSecidFor(isin) {
  const all = await fetchBonds().catch(() => []);
  const hit = all.find(b => b.isin === isin || b.secid === isin);
  return hit && hit.secid && hit.secid !== isin ? hit.secid : null;
}

export async function fetchBondCard(secidOrIsin) {
  const id = (secidOrIsin || '').trim().toUpperCase();
  const [desc, boardData] = await Promise.all([
    iss(`/securities/${id}.json`),
    iss(`/securities/${id}.json`, { 'iss.only': 'boards' }).catch(() => ({})),
  ]);

  const boards = boardData.boards || [];
  const couponId = boards.length ? id : (await boardSecidFor(id)) || id;
  const bondization = couponId === id
    ? await iss(`/securities/${id}/bondization.json`).catch(() => ({}))
    : await iss(`/securities/${couponId}/bondization.json`).catch(() => ({}));

  const description = {};
  (desc.description || []).forEach(x => { description[x.name] = x.value; });

  const mainBoard = boards.find(b => b.is_primary === 1) || boards[0];
  const bonds = boards;

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

  /* Рейтинг у карточки. Сначала ищем значок у самой бумаги, а если его нет —
     рейтинг её эмитента по другим его выпускам (рейтинг у источника
     эмитентский, см. withRatings). Если файла рейтингов нет вовсе, поля
     останутся пустыми — карточка работает как прежде. */
  const ratings = await fetchRatings();
  const own = ratings?.ratings?.[description.ISIN] || null;
  let rHit = own;
  if (!own) {
    const list = await fetchBonds().catch(() => []);
    const self = list.find(x => x.isin === description.ISIN && x.issuerKey);
    const peer = self ? list.find(x => x !== self && x.issuerKey === self.issuerKey && x.rating) : null;
    if (peer) rHit = { r: peer.rating, c: peer.ratingCode };
  }

  return {
    secid: id,
    description,
    rating: rHit?.r || null,
    ratingOwn: !!own,
    /* Дата сбора файла: показываем её рядом с рейтингом, чтобы было видно,
       если робот однажды перестанет обновлять данные. */
    ratingAt: ratings?.generatedAt || null,
    ratingCode: rHit?.c ?? null,
    ratingSource: ratings?.source || null,
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

/** Дата сбора файла отчётности — чтобы на сайте было видно, не устарел ли он. */
export function fetchFundamentals() {
  if (fundamentalsCache) return Promise.resolve(fundamentalsCache);
  if (!fundamentalsPromise) {
    const base = import.meta.env?.BASE_URL || '/';
    fundamentalsPromise = fetch(`${base}fundamentals.json`, { credentials: 'omit' })
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null)
      .then(d => { fundamentalsCache = d; return d; });
  }
  return fundamentalsPromise;
}
let fundamentalsCache = null, fundamentalsPromise = null;

export async function fetchFundamentalsDate() {
  const d = await fetchFundamentals();
  return d?.generatedAt || null;
}

/* ── Сопоставление эмитента облигаций с акцией ─────────────────────
   Отчётность у источника лежит по тикеру АКЦИИ. У эмитента облигаций
   тикера нет, поэтому ищем его по названию компании.

   Здесь СОЗНАТЕЛЬНО только точное совпадение после нормализации.
   Сопоставление «по вхождению подстроки» опасно: «Банк ДОМ.РФ» и
   «ДОМ.РФ» — разные организации, и показать отчётность одной на
   странице другой значит выдать чужое за своё. Лучше не показать
   ничего, чем показать не то. */

/** Убирает организационную форму, кавычки и лишние пробелы. */
function normCompanyName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[«»"'`(),.]/g, ' ')
    .replace(/\b(пао|оао|зао|ооо|ао|ап|публичное|акционерное|общество|компания|группа)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Название эмитента без хвостового номера выпуска: «ЛУКОЙЛ 26» → «ЛУКОЙЛ». */
function stripIssueTail(s) {
  return String(s || '').replace(/\s+\d+[-\dA-Za-z]*$/, '').trim();
}

/**
 * Ищет отчётность эмитента среди собранных тикеров.
 * @param {object} fdata — данные public/fundamentals.json
 * @param {string[]} candidates — возможные названия эмитента
 * @returns {{ticker:string, data:object}|null}
 */
export function findIssuerFundamentals(fdata, candidates) {
  const map = fdata?.tickers;
  if (!map) return null;

  const wanted = new Set(
    (candidates || [])
      .flatMap(c => [c, stripIssueTail(c)])
      .map(normCompanyName)
      .filter(s => s.length >= 3)
  );
  if (!wanted.size) return null;

  for (const [ticker, d] of Object.entries(map)) {
    const n = normCompanyName(d?.n);
    if (n && wanted.has(n)) return { ticker, data: d };
  }
  return null;
}

export async function fetchGirboDate() {
  const all = await fetchGirbo();
  return all?.generatedAt || null;
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

/* ── первичные размещения ────────────────────────────────────────── *
 *
 * Биржа публикует по каждому размещению отдельное сообщение, в котором
 * перечислены эмитент, серия, регистрационный номер, торговый код
 * (ISIN), дата начала размещения, период сбора заявок с точным временем,
 * режим и цена размещения. В сообщениях «Итоги выпуска» — фактический
 * объём размещённого, количество бумаг, фактическая цена и доля
 * размещённых.
 *
 * Список новостей (iss.moex.com/iss/sitenews.json) читается из браузера
 * напрямую: там есть CORS. А тексты сообщений лежат обычными страницами
 * на www.moex.com и CORS-заголовка не отдают — из браузера их взять
 * нельзя. Поэтому тексты разбирает робот (scripts/placements.mjs) и
 * кладёт рядом с сайтом файл placements.json — как и отчётность ГИР БО.
 *
 * Чего в этих данных нет и не будет: рейтингов (у источника нет ни
 * агентства, ни даты присвоения) и ориентира купона до размещения
 * (ставку раскрывает эмитент, а не биржа).
 */
let placementsCache;
let placementsPromise;

/** Все разобранные анонсы размещений. Файл читается один раз за сессию. */
export async function fetchPlacements() {
  if (placementsCache) return placementsCache;
  if (!placementsPromise) {
    const base = import.meta.env?.BASE_URL || '/';
    placementsPromise = fetch(`${base}placements.json`, { credentials: 'omit' })
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null)
      .then(d => { placementsCache = d; return d; });
  }
  return placementsPromise;
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

/* ── валюты бегущей строки: КУРС ЦБ РФ ───────────────────────────── *
 *
 * Разведано на живых источниках и на самом оригинале (scripts/probe*.mjs,
 * см. журнал, раздел «Тикер»). Главное, что выяснилось: в полосе валют
 * у bondradar.pro стоит НЕ биржевая цена, а КУРС ЦБ. Это видно прямо в
 * их коде — ensureFX() тянет cbr-xml-daily.ru/daily_json.js, и их числа
 * (84,43 +0,02 % · 96,06 −0,19 % · 12,58 +0,11 %) — это ровно курс ЦБ.
 *
 * Поэтому и мы показываем курс ЦБ, но без сторонних зеркал — из
 * официального источника Мосбиржи:
 *
 *   · доллар и евро — блок cbrf эндпоинта
 *     /iss/statistics/engines/currency/markets/selt/rates.json.
 *     Там курс ЦБ лежит вместе со СВОИМ процентом к предыдущему курсу
 *     (CBRF_USD_LAST / CBRF_USD_LASTCHANGEPRCNT), поэтому пара
 *     «значение + процент» взята из одного места, а не собрана из двух
 *     (см. «Грабли», п.2 — цена и доходность обязаны быть из одного
 *     источника). Сверено с полосой оригинала в один момент времени:
 *     84,4283 (+0,0208 %) и 96,0625 (−0,1874 %) — совпало до сотых.
 *
 *   · юань — курса ЦБ в блоке cbrf НЕТ вовсе: там публикуются только
 *     USD и EUR (проверено; параметр date блок не расширяет). Ближайшее
 *     официальное — фиксинг Мосбиржи CNYFIXME. Берём его вместе с
 *     предыдущим фиксингом из истории и считаем процент сами:
 *     12,5720 против 12,5591 = +0,10 %. У ЦБ на ту же дату 12,5764
 *     (+0,11 %) — расхождение в одну копейку, и оно не выдумано: это
 *     разные величины, и в интерфейсе юань подписан «фиксинг MOEX»,
 *     а не «курс ЦБ».
 *
 * Почему не живая биржевая цена (CETS), как предполагал журнал: у евро
 * в тот момент вообще не было сделок (NUMTRADES = 0, LAST = null), и
 * любая пара «фиксинг сегодня / последняя сделка вчера» давала бы
 * +0,46 % вместо настоящих −0,19 % — то есть противоположный знак.
 * Курс ЦБ и меняется раз в сутки, и одинаков у всех, кто его показывает.
 *
 * Живой биржевой курс остаётся доступен отдельно (fetchCurrencyMarket)
 * и используется как запасной вариант, если блок курса ЦБ не ответил.
 */
export const TICKER_FX = [
  { code: 'USD', symbol: '$' },
  { code: 'EUR', symbol: '€' },
  { code: 'CNY', symbol: '¥' },
];

const FX_MIN = 1;      // курс не может быть меньше рубля — защита от мусора
const FX_MAX = 10000;  // и больше 10 000 ₽ за единицу — тоже

function fxOk(v) {
  return v != null && Number.isFinite(+v) && +v >= FX_MIN && +v <= FX_MAX;
}

/** Курс ЦБ (USD, EUR) + фиксинг юаня. Ключ — код валюты. */
export async function fetchCurrencyRates() {
  const [cbr, cnyHist] = await Promise.all([
    iss('/statistics/engines/currency/markets/selt/rates.json').catch(() => null),
    /* Две последние строки истории дают согласованную пару «сегодня/вчера»
       для юаня. Двух недель с запасом хватает даже после долгих праздников. */
    iss('/history/engines/currency/markets/index/securities/CNYFIXME.json', {
      from: defaultFrom(14),
    }).catch(() => null),
  ]);

  const out = {};
  const row = cbr?.cbrf?.[0];
  if (row) {
    if (fxOk(row.CBRF_USD_LAST)) {
      out.USD = {
        code: 'USD', symbol: '$', source: 'cbr', sourceLabel: 'курс ЦБ',
        value: +row.CBRF_USD_LAST,
        changePct: row.CBRF_USD_LASTCHANGEPRCNT != null ? +row.CBRF_USD_LASTCHANGEPRCNT : null,
        date: row.CBRF_USD_TRADEDATE || null,
      };
    }
    if (fxOk(row.CBRF_EUR_LAST)) {
      out.EUR = {
        code: 'EUR', symbol: '€', source: 'cbr', sourceLabel: 'курс ЦБ',
        value: +row.CBRF_EUR_LAST,
        changePct: row.CBRF_EUR_LASTCHANGEPRCNT != null ? +row.CBRF_EUR_LASTCHANGEPRCNT : null,
        date: row.CBRF_EUR_TRADEDATE || null,
      };
    }
  }

  const rows = (cnyHist?.history || []).filter(r => fxOk(r.CLOSE) && r.TRADEDATE);
  if (rows.length) {
    const last = rows[rows.length - 1];
    const prev = rows.length > 1 ? rows[rows.length - 2] : null;
    out.CNY = {
      code: 'CNY', symbol: '¥', source: 'fixing', sourceLabel: 'фиксинг MOEX',
      value: +last.CLOSE,
      changePct: prev && +prev.CLOSE > 0 ? ((+last.CLOSE - +prev.CLOSE) / +prev.CLOSE) * 100 : null,
      date: last.TRADEDATE,
    };
  }

  return out;
}

/**
 * Живой биржевой курс (CETS) — запасной источник, если курс ЦБ не пришёл.
 *
 * Здесь работает то же правило согласованной пары, что и у облигаций
 * (normalize()): цена последней сделки идёт с изменением к закрытию
 * прошлого дня (LAST + LASTTOPREVPRICE). Если сделок сегодня не было —
 * берём цену предыдущего дня и НЕ показываем процент: у евро его просто
 * не из чего посчитать, а ноль от биржи означает «данных нет», а не «ноль»
 * («Грабли», п.1 и п.2).
 */
export async function fetchCurrencyMarket() {
  const d = await iss('/engines/currency/markets/selt/boards/CETS/securities.json', {
    'iss.only': 'securities,marketdata',
  });
  const S = new Map((d.securities || []).map(r => [r.SECID, r]));
  const M = new Map((d.marketdata || []).map(r => [r.SECID, r]));

  const MAP = [
    { secid: 'USD000UTSTOM', code: 'USD', symbol: '$' },
    { secid: 'EUR_RUB__TOM', code: 'EUR', symbol: '€' },
    { secid: 'CNYRUB_TOM', code: 'CNY', symbol: '¥' },
  ];

  const out = {};
  for (const { secid, code, symbol } of MAP) {
    const s = S.get(secid);
    const m = M.get(secid);
    if (!s) continue;
    const traded = m?.LAST != null && +m.LAST > 0;
    const value = traded ? +m.LAST : (s.PREVPRICE != null && +s.PREVPRICE > 0 ? +s.PREVPRICE : null);
    if (!fxOk(value)) continue;
    out[code] = {
      code, symbol, source: 'moex', sourceLabel: traded ? 'биржа' : 'биржа, прошлый день',
      value,
      changePct: (traded && m.LASTTOPREVPRICE != null && s.PREVPRICE != null)
        ? +m.LASTTOPREVPRICE : null,
      date: m?.SYSTIME ? String(m.SYSTIME).slice(0, 10) : null,
    };
  }
  return out;
}

/** Валюта для полосы: сначала курс ЦБ, при неудаче — живая биржа. */
export async function fetchTickerCurrencies() {
  const cbr = await fetchCurrencyRates().catch(() => ({}));
  const missing = TICKER_FX.filter(f => !cbr[f.code]);
  if (!missing.length) return cbr;
  const mkt = await fetchCurrencyMarket().catch(() => ({}));
  const out = { ...cbr };
  for (const f of missing) if (mkt[f.code]) out[f.code] = mkt[f.code];
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

/* ── Отрасли акций ────────────────────────────────────────────────────
 * Московская биржа ведёт 10 отраслевых индексов и по каждому отдаёт
 * состав — тикеры бумаг с весами. Это единственный машинный источник
 * отрасли: в описании бумаги поле SECTORID пустое у всех акций, а
 * /iss/securitygroups делит бумаги не по отраслям, а по типам
 * инструментов («акции», «депозитарные расписки» и так далее).
 *
 * Эндпоинт отдаёт CORS-заголовок ровно с адресом нашего сайта, поэтому
 * браузер обращается к нему напрямую — робот не нужен.
 *
 * Покрытие неполное, и это не наша недоработка: биржа включает в
 * отраслевые индексы не все бумаги. У Газпромнефти (SIBN) и ГАЗ-Тек
 * (GAZT) отрасли нет ни у нас, ни у оригинала — там одинаковый
 * прочерк. Честный прочерк лучше выдуманной отрасли.
 *
 * Десять запросов идут параллельно и кэшируются на время сессии.
 */

const SECTOR_INDICES = {
  MOEXFN: 'Финансы',
  MOEXOG: 'Нефть и газ',
  MOEXMM: 'Металлы и добыча',
  MOEXTL: 'Телекомы',
  MOEXCH: 'Химия',
  MOEXCN: 'Потребительский',
  MOEXEU: 'Электроэнергетика',
  MOEXIT: 'Технологии',
  MOEXTN: 'Транспорт',
  MOEXRE: 'Строительство',
};

let sectorsPromise = null;

export function fetchSectors() {
  if (sectorsPromise) return sectorsPromise;

  sectorsPromise = (async () => {
    const ids = Object.keys(SECTOR_INDICES);

    /* Один упавший индекс не должен ронять всю таблицу: остальные
       девять отраслей всё равно нужны. Поэтому ошибка глушится
       внутри, а не снаружи. */
    const parts = await Promise.all(ids.map(async id => {
      try {
        const r = await iss(`/statistics/engines/stock/markets/index/analytics/${id}.json`);
        return { id, rows: r?.analytics || [] };
      } catch {
        return { id, rows: [] };
      }
    }));

    const map = {};
    for (const { id, rows } of parts) {
      const label = SECTOR_INDICES[id];
      for (const row of rows) {
        const t = row && row.ticker;
        /* Первый индекс выигрывает. Бумага изредка попадает сразу в
           два отраслевых индекса, и тогда отрасль определяется
           порядком в списке выше, а не случайностью ответа биржи. */
        if (t && !map[t]) map[t] = label;
      }
    }
    return map;
  })();

  /* Неудачу не кэшируем — иначе одна сетевая ошибка лишила бы
     отрасли до перезагрузки страницы. */
  sectorsPromise.catch(() => { sectorsPromise = null; });
  return sectorsPromise;
}