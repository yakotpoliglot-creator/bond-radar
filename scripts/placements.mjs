/**
 * Робот: собирает первичные размещения облигаций с Московской биржи.
 *
 * ── Почему робот, а не браузер ─────────────────────────────────────
 * Список новостей биржи (iss.moex.com/iss/sitenews.json) браузер читает
 * напрямую — там есть CORS. А вот ТЕКСТЫ анонсов лежат обычными
 * HTML-страницами на www.moex.com, и CORS-заголовка они не отдают:
 * из браузера их не прочитать. Поэтому тексты разбирает робот и
 * складывает результат в public/placements.json рядом с сайтом.
 *
 * ── Что здесь есть и чего нет ─────────────────────────────────────
 * Биржа публикует по каждому размещению отдельное сообщение, в котором
 * перечислены поля «поле → значение»: эмитент, серия, регистрационный
 * номер, торговый код (ISIN), дата начала размещения, период сбора
 * заявок с точным временем, режим и цена размещения, андеррайтер.
 * В сообщениях «Итоги выпуска» — фактический объём размещённого,
 * количество бумаг, фактическая цена и доля размещённых.
 *
 * Купона в этих сообщениях НЕТ: ставку купона эмитент раскрывает сам,
 * а не биржа. Купон и признаки выпуска (квал, погашение, тип купона)
 * робот добирает из торговых данных биржи по ISIN — но только после
 * того, как бумага появилась в списках. До размещения этих полей нет
 * ни у кого, поэтому в карточке будущего размещения они пустые, а не
 * выдуманные.
 *
 * Рейтингов здесь нет намеренно: у доступного источника нет ни
 * агентства, ни даты присвоения.
 *
 * ── Что делает ─────────────────────────────────────────────────────
 *   1. Листает ленту новостей биржи назад до границы окна (45 дней).
 *   2. Отбирает анонсы размещений по заголовку и определяет вид:
 *      сбор заявок · проведение размещения · итоги выпуска ·
 *      приостановка торгов в процессе размещения.
 *   3. Открывает текст анонса и разбирает поля.
 *   4. Добирает по ISIN данные выпуска из торговых списков биржи.
 *   5. Пишет public/placements.json.
 *
 * Запускается по расписанию GitHub Actions каждые три часа: анонсы
 * появляются в течение дня, чаще опрашивать незачем.
 */

import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'public', 'placements.json');

/* Честный User-Agent: кто ходит и куда — чтобы биржа это видела. */
const UA = 'BondRadar/1.0 (open-source bond screener; +https://github.com/yakotpoliglot-creator/bond-radar)';

/* Вежливые паузы между запросами к бирже. */
const NEWS_DELAY_MS = 120;
const PAGE_DELAY_MS = 200;
const BOND_DELAY_MS = 120;

/* Окно хранения: анонсы старше этого срока в файл не попадают. */
const WINDOW_DAYS = 45;

/* Анонсы свежее этого срока перечитываем каждый прогон: биржа публикует
   уточнения (перенос сбора заявок, приостановку), и карточка должна
   меняться. Всё, что старше, берём из прошлого файла — без запросов. */
const REFRESH_DAYS = 7;

/* Сколько страниц ленты перебирать максимум (50 новостей на странице). */
const MAX_NEWS_PAGES = 90;

/* Защита от обрезанного файла: если в ленте анонсы размещений были,
   а разобрать не удалось ни одного — прогон считаем сбойным. */
const MIN_PARSED = 3;

const sleep = ms => new Promise(r => setTimeout(r, ms));

const ISS = 'https://iss.moex.com/iss';

/* ── низкоуровневые запросы ──────────────────────────────────────── */

/**
 * Запрос к ISS. extended=true → ответ вида [charsetinfo, {блок: [...]}],
 * отдаём вторую часть. Осторожно: у /iss/securities/{ISIN}.json в
 * extended-режиме блок description приходит ПУСТЫМ (проверено на живом
 * ISS), поэтому паспорт бумаги читаем с extended=false и разбираем
 * обычный объект {columns, data}.
 */
async function iss(path, params = {}, { extended = true, retries = 3 } = {}) {
  const url = new URL(ISS + path);
  url.searchParams.set('iss.meta', 'off');
  if (extended) url.searchParams.set('iss.json', 'extended');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`ISS ${r.status}`);
      const text = await r.text();
      if (text.trimStart().startsWith('<')) throw new Error('ISS вернул HTML');
      const arr = JSON.parse(text);
      return extended && Array.isArray(arr) && arr.length > 1 ? arr[1] : arr;
    } catch (e) {
      if (attempt === retries) throw new Error(`${path}: ${e.message}`);
      await sleep(400 * attempt);
    }
  }
}

/** {columns, data} → массив объектов. */
function rowsOf(block) {
  if (!block || !block.columns || !Array.isArray(block.data)) return [];
  return block.data.map(r => Object.fromEntries(block.columns.map((c, i) => [c, r[i]])));
}

/* ── виды анонсов ────────────────────────────────────────────────── */

/* Заголовки у биржи устойчивые, поэтому вид определяется по заголовку.
   «Регистрация выпуска» сюда не входит: это ещё не размещение, таких
   сообщений больше всего, и в первичке они только мешают. */
const KINDS = [
  { kind: 'collect', re: /о порядке сбора заявок/i },
  { kind: 'placing', re: /о проведении\s+.{0,60}?(размещени|аукциона по размещению)/i },
  { kind: 'results', re: /итоги выпуска биржевых облигаций/i },
  { kind: 'suspend', re: /приостановк[аеи]\s+.{0,40}?(торгов|размещени)/i },
];

function kindOf(title) {
  const t = String(title || '');
  for (const k of KINDS) if (k.re.test(t)) return k.kind;
  return null;
}

/* ── разбор текста анонса ────────────────────────────────────────── */

/* Поля, которые биржа перечисляет в анонсе. Порядок важен: строку
   считаем началом нового поля, только если она совпадает с меткой
   целиком — иначе «Дата начала размещения» поймает и «Дата начала
   периода сбора заявок». */
const LABELS = [
  'Наименование Эмитента',
  'Наименование ценной бумаги',
  'Идентификационный номер выпуска',
  'Идентификационный/регистрационный номер выпуска',
  'Регистрационный номер выпуска биржевых облигаций',
  'Государственный регистрационный номер выпуска',
  'Номинальная стоимость биржевых облигаций',
  'Дата начала размещения',
  'Дата окончания размещения',
  'Дата начала торгов',
  'Дата проведения аукциона',
  'Информация о размещении (Режим торгов, форма размещения)',
  'Предварительный сбор заявок',
  'Торговый код',
  'ISIN код',
  'Цена размещения',
  'Фактическая цена размещения биржевых облигаций',
  'Код расчетов',
  'Андеррайтер',
  'Объем размещенных биржевых облигаций по номинальной стоимости',
  'Количество размещенных биржевых облигаций',
  'Доля размещенных и неразмещенных биржевых облигаций',
  'Время проведения торгов в дату начала размещения',
  'Дата активации',
  'Время активации',
  'Дата начала периода сбора заявок',
  'Дата окончания периода сбора заявок',
  'Время сбора заявок каждый рабочий день Биржи',
];

/** HTML страницы анонса → строки текста, по одной на строку. */
function htmlToLines(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .split('\n')
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** «30 сентября 2026 г.» / «30.09.2026» → «2026-09-30». */
const MONTHS = {
  января: 1, февраля: 2, марта: 3, апреля: 4, мая: 5, июня: 6,
  июля: 7, августа: 8, сентября: 9, октября: 10, ноября: 11, декабря: 12,
};

function parseDate(text) {
  const s = String(text || '');
  let m = s.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = s.match(/(\d{1,2})\s+([а-яё]+)\s+(\d{4})/i);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()];
    if (mo) return `${m[3]}-${String(mo).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  }
  return null;
}

/** «9 901 480 000 (Девять миллиардов…) руб.» → 9901480000 */
function parseMoney(text) {
  const m = String(text || '').replace(/\u00a0/g, ' ').match(/(\d[\d\s]{2,})/);
  if (!m) return null;
  const n = Number(m[1].replace(/\s/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Текст после заголовка анонса: шапка сайта и сам заголовок отрезаны.
 *
 * Заголовок на странице встречается ДВАЖДЫ: в самой статье и в блоке
 * «похожие новости» в подвале. Если взять последнее вхождение (так было
 * в первой версии робота), тело окажется пустым и разбор даст ноль
 * полей — на этом робот и попался. Поэтому идём по вхождениям сверху
 * вниз и берём первое, за которым действительно идут поля анонса.
 */
function bodyOf(lines, title) {
  const norm = s => s.replace(/\s+/g, ' ').trim();
  const t = norm(String(title || '').replace(/&quot;/g, '"'));
  const at = [];
  for (let i = 0; i < lines.length; i++) if (norm(lines[i]) === t) at.push(i);
  if (!at.length) return lines;
  for (const i of at) {
    const tail = lines.slice(i + 1, i + 80);
    const labels = tail.filter(s => matchLabel(s)).length;
    /* Два поля подряд — точно статья, а не ссылка в подвале. */
    if (labels >= 2) return tail;
  }
  return lines.slice(at[0] + 1);
}

/**
 * Приводит метку к каноническому виду. Биржа пишет одни и те же поля
 * немного по-разному: в анонсах «Дата начала размещения», в итогах
 * выпуска «Дата начала размещения биржевых облигаций». Двоеточие и
 * хвост «биржевых облигаций» отбрасываем, регистр не учитываем — биржа
 * пишет «Идентификационный/Регистрационный», а в списке меток строчная.
 */
function canonLabel(s) {
  return String(s).replace(/\s*:\s*$/, '').trim().replace(/\s+биржевых облигаций$/i, '').trim();
}

/** Ключ сравнения меток: без учёта регистра. */
function canonKey(s) {
  return canonLabel(s).toLowerCase();
}

const CANON = new Map(LABELS.map(l => [canonKey(l), l]));

/* Ключи для поиска метки в начале строки, от длинного к короткому:
   длинная метка должна проверяться раньше короткой, иначе «Дата начала
   размещения» перехватит строку «Дата начала размещения биржевых
   облигаций …». */
const MATCH_KEYS = [...new Set([...LABELS, ...LABELS.map(canonLabel)])]
  .map(canonKey)
  .sort((a, b) => b.length - a.length);

/**
 * Опознаёт метку в начале строки. Возвращает метку и остаток строки —
 * значение, если биржа написала его в той же строке.
 *
 * Биржа пишет одни и те же поля тремя способами, и все три надо уметь:
 *   «Дата начала размещения»            — значение на следующих строках;
 *   «Дата начала размещения: 30.09.2026»— значение в строке;
 *   «…выпуска 4B02-05-36485-R-001P»     — значение без двоеточия.
 *
 * Тонкость: метка в списке может быть КОРОЧЕ реальной («Дата начала
 * размещения» против «Дата начала размещения биржевых облигаций»),
 * поэтому в варианте с двоеточием канонизируем часть строки до
 * двоеточия, а в варианте без двоеточия — срезаем у хвоста слова
 * «биржевых облигаций».
 */
function matchLabel(line) {
  const low = line.toLowerCase();
  if (CANON.has(canonKey(low))) return { label: CANON.get(canonKey(low)), rest: '' };

  const colon = line.indexOf(':');
  if (colon > 0) {
    const key = canonKey(line.slice(0, colon));
    if (CANON.has(key)) return { label: CANON.get(key), rest: line.slice(colon + 1).trim() };
  }

  for (const key of MATCH_KEYS) {
    if (!low.startsWith(key)) continue;
    const tail = line.slice(key.length);
    if (!/^\s+\S/.test(tail)) continue;
    const rest = tail.replace(/^\s+/, '').replace(/^биржевых облигаций\s*/i, '').trim();
    return { label: CANON.get(key) || key, rest };
  }
  return null;
}

/**
 * Разбирает блок «метка → значение» в двух форматах, которые биржа
 * реально использует:
 *   анонс  — метка отдельной строкой, значение на следующих строках;
 *   итоги  — «Метка: значение» в одной строке.
 * Возвращает функцию доступа к значениям по исходной метке.
 */
function fieldsOf(lines) {
  const out = {};
  let cur = null;
  for (const line of lines) {
    const m = matchLabel(line);
    if (m) { cur = m.label; out[cur] = m.rest ? [m.rest] : []; continue; }
    if (cur) out[cur].push(line);
  }
  const val = k => {
    const v = out[k];
    if (!v || !v.length) return null;
    const s = v.join(' ').trim();
    return s || null;
  };
  return { val, keys: Object.keys(out) };
}

/** Организационно-правовая форма в строке — признак заголовка эмитента. */
const ORG_RE = /(публичное акционерное общество|акционерное общество|общество с ограниченной ответственностью|банк|ООО|ПАО|АО|АБ|МКПАО)/i;

/* Строка с регистрационным номером выпуска — начало блока об ОДНОМ
   выпуске в «итогах». В одном сообщении биржа перечисляет несколько
   выпусков, а иногда и несколько эмитентов, поэтому резать текст надо
   по выпускам: у каждого свой объём, цена и доля размещённых. */
const REG_LINE_RE = /^(Регистрационный номер выпуска|Идентификационный номер выпуска|Идентификационный\/регистрационный номер выпуска|Государственный регистрационный номер выпуска)/i;

/* Запасной признак заголовка эмитента, если регистрационных номеров в
   тексте нет: строка кончается двоеточием И следующая строка — поле
   выпуска. Одного двоеточия мало: в тексте хватает других строк с
   двоеточием («Место нахождения эмитента: …»). */
const ISSUER_HEAD_NEXT = /^(Регистрационный номер выпуска|Номинальная стоимость)/i;

/**
 * Разрезает текст «итогов выпуска» на блоки по одному выпуску.
 * Имя эмитента берём из ближайшей строки выше, которая кончается
 * двоеточием и похожа на организацию: в «итогах» она стоит заголовком
 * перед полями выпуска.
 */
function splitIssueBlocks(lines) {
  const starts = [];
  lines.forEach((line, i) => { if (REG_LINE_RE.test(line) && matchLabel(line)) starts.push(i); });

  /* Если регистрационных номеров в тексте нет вовсе — раскладываем по
     заголовкам эмитентов, как раньше. Лучше приблизительно, чем никак. */
  if (!starts.length) {
    const blocks = [];
    let cur = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const next = lines[i + 1] || '';
      const isHead = /:$/.test(line) && ORG_RE.test(line) && line.length < 400
        && ISSUER_HEAD_NEXT.test(next);
      if (isHead) {
        if (cur) blocks.push(cur);
        cur = { issuer: line.replace(/:$/, '').trim(), lines: [] };
        continue;
      }
      if (cur) cur.lines.push(line);
      else cur = { issuer: null, lines: [line] };
    }
    if (cur) blocks.push(cur);
    return blocks.filter(b => b.lines.length > 1);
  }

  const blocks = [];
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : lines.length;
    /* Эмитент — ближайшая строка выше с названием организации. Смотрим
       далеко назад: биржа перечисляет несколько выпусков одного
       эмитента подряд, а его название пишет один раз в начале. */
    let issuer = null;
    for (let j = from - 1; j >= Math.max(0, from - 25); j--) {
      const line = lines[j];
      if (/:$/.test(line) && ORG_RE.test(line) && line.length < 400) {
        issuer = line.replace(/:$/, '').trim();
        break;
      }
    }
    blocks.push({ issuer, lines: lines.slice(from, to) });
  }
  return blocks;
}

/** Эмитент из сообщения, где он написан голой строкой без метки.

    В сообщениях о приостановке торгов эмитент идёт просто строкой перед
    «Наименование ценной бумаги», без подписи — обычный разбор по меткам
    его не видит, и карточка оставалась без эмитента. Берём строку перед
    названием бумаги (или перед регномером), если она похожа на название
    организации. */
function issuerFromText(lines) {
  const marks = [
    /^Наименование ценной бумаги/i,
    /^Идентификационный\s*\/?\s*[Рр]егистрационный номер выпуска/i,
    /^Регистрационный номер выпуска/i,
  ];
  for (let i = 0; i < lines.length; i++) {
    if (!marks.some(re => re.test(lines[i]))) continue;
    for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
      const line = lines[j];
      if (line.length > 300 || /:$/.test(line)) continue;
      if (ORG_RE.test(line) && !/^Наименование/i.test(line)) return line.trim();
    }
  }
  return null;
}

/** «10:00 - 23:50 Сбор заявок возможен в вечернюю сессию…» → «10:00 - 23:50».
    Значение поля накапливается до следующей метки, а после расписания
    биржа пишет ещё абзац правил («Процедура контроля обеспечения…»).
    В карточке нужны только часы. */
function timeRange(s) {
  const m = String(s || '').match(/(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/);
  return m ? `${m[1]} - ${m[2]}` : null;
}

/** «10:00 Расписание предварительного сбора заявок:» → «10:00» */
function clock(s) {
  const m = String(s || '').match(/(\d{1,2}:\d{2})/);
  return m ? m[1] : null;
}

/** Одна запись из разобранного анонса. */
function recordFromFields({ kind, id, title, publishedAt, url, issuer, val }) {
  const book = {
    activationDate: parseDate(val('Дата активации')),
    activationTime: clock(val('Время активации')),
    from: parseDate(val('Дата начала периода сбора заявок')),
    to: parseDate(val('Дата окончания периода сбора заявок')),
    daily: timeRange(val('Время сбора заявок каждый рабочий день Биржи')),
  };
  const hasBook = book.from || book.to || book.activationDate || book.daily;

  /* Расписание в день размещения: «период сбора заявок: 10:00 - 13:30;
     период удовлетворения заявок: 13:45 - 14:45». */
  const scheduleRaw = val('Время проведения торгов в дату начала размещения') || '';
  const collectTime = scheduleRaw.match(/период сбора заявок:\s*([\d:]{4,5}\s*[-–]\s*[\d:]{4,5})/i);
  const satisfyTime = scheduleRaw.match(/период удовлетворения заявок:\s*([\d:]{4,5}\s*[-–]\s*[\d:]{4,5})/i);

  const priceRaw = val('Цена размещения') || '';
  const pricePercent = priceRaw.match(/соответствует\s+([\d.,]+)\s*(?:\([^)]*\)\s*)?процент/i);
  const actualPrice = val('Фактическая цена размещения биржевых облигаций');
  const shareRaw = val('Доля размещенных и неразмещенных биржевых облигаций') || '';
  const shares = [...shareRaw.matchAll(/([\d.,]+)\s*%/g)].map(m => Number(m[1].replace(',', '.')));

  const isinRaw = val('ISIN код') || val('Торговый код') || '';
  const isin = (isinRaw.match(/[A-Z]{2}[A-Z0-9]{9}\d/) || [null])[0];

  /* Биржа пишет регномер вместе с датой регистрации: «4B02-1298-01000-B-005P
     от 15.07.2026 года». Для связи с торговым списком (поле REGNUMBER)
     оставляем только сам номер. */
  const regRaw = val('Идентификационный номер выпуска')
    || val('Идентификационный/регистрационный номер выпуска')
    || val('Регистрационный номер выпуска биржевых облигаций')
    || val('Государственный регистрационный номер выпуска')
    || '';
  const regNumber = regRaw.split(/\s+от\s+/i)[0].replace(/[.,;]+$/, '').trim() || null;

  return {
    id,
    kind,
    url,
    publishedAt,
    title: String(title || '').replace(/&quot;/g, '"').trim(),
    /* Биржа пишет эмитента вместе с местом нахождения: «Банк ВТБ
       (публичное акционерное общество) (Место нахождения эмитента
       биржевых облигаций: Российская Федерация, город Москва)».
       В карточке это лишнее — оставляем только название. */
    issuer: String(issuer || val('Наименование Эмитента') || '')
      .replace(/\s*\(Место нахождения[^)]*\)?\s*$/i, '')
      .replace(/[,\s]+$/, '')
      .trim() || null,
    series: val('Наименование ценной бумаги') || null,
    isin,
    regNumber,
    nominal: parseMoney(val('Номинальная стоимость биржевых облигаций')),
    placementStart: parseDate(val('Дата начала размещения')) || parseDate(val('Дата проведения аукциона')),
    placementEnd: parseDate(val('Дата окончания размещения')),
    firstTrade: parseDate(val('Дата начала торгов')),
    priceRub: parseMoney(priceRaw),
    pricePercent: pricePercent ? Number(pricePercent[1].replace(',', '.')) : null,
    mode: val('Информация о размещении (Режим торгов, форма размещения)'),
    underwriter: val('Андеррайтер'),
    book: hasBook ? book : null,
    collectTime: collectTime ? collectTime[1].replace(/\s+/g, ' ').trim() : null,
    satisfyTime: satisfyTime ? satisfyTime[1].replace(/\s+/g, ' ').trim() : null,
    volumePlaced: parseMoney(val('Объем размещенных биржевых облигаций по номинальной стоимости')),
    quantityPlaced: parseMoney(val('Количество размещенных биржевых облигаций')),
    actualPrice: parseMoney(actualPrice),
    sharePlaced: shares.length ? shares[0] : null,
    shareUnplaced: shares.length > 1 ? shares[1] : null,
  };
}

/* ── сбор данных выпуска из торговых списков ─────────────────────── */

/** Ключ для поиска выпуска: без пробелов и в верхнем регистре. */
function keyOf(s) {
  return String(s || '').toUpperCase().replace(/\s+/g, '');
}

/**
 * Данные выпуска из торговых списков биржи и паспорта бумаги.
 *
 * Ищем по ISIN, а если его в анонсе нет (так бывает в «итогах выпуска»)
 * — по регистрационному номеру: он есть и в сообщении биржи, и в поле
 * REGNUMBER торгового списка. До размещения бумаги в списках нет, тогда
 * вернётся null — это честный ответ «биржа ещё ничего не публикует».
 */
async function bondInfo({ isin, regNumber }, pool, descCache) {
  const sec = pool.byIsin.get(keyOf(isin)) || pool.byReg.get(keyOf(regNumber)) || null;
  const lookupId = sec?.SECID || isin;

  /* Паспорт бумаги нужен только ради признака «для квалифицированных
     инвесторов»: он есть лишь там. Остальное даёт торговый список. */
  let desc = descCache.get(keyOf(lookupId));
  if (!desc && lookupId) {
    try {
      const raw = await iss(`/securities/${lookupId}.json`, {}, { extended: false });
      desc = Object.fromEntries(rowsOf(raw.description).map(x => [x.name, x.value]));
    } catch {
      desc = {};
    }
    descCache.set(keyOf(lookupId), desc);
    await sleep(BOND_DELAY_MS);
  }

  if (!sec && !Object.keys(desc || {}).length) return null;
  desc = desc || {};

  const num = v => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
  /* Для цены и доходности ноль — это не значение, а «биржа не считала»:
     без сделок YIELD и MARKETPRICE приходят ровно нулями. Отдельная
     функция, чтобы это правило нельзя было забыть в одном месте. */
  const pos = v => (v != null && v > 0 ? v : null);
  const coupon = sec?.COUPONPERCENT != null ? num(sec.COUPONPERCENT) : num(desc.COUPONPERCENT);

  return {
    /* Формула плавающего купона: у флоатеров биржа пишет её текстом,
       например «Ключевая ставка + 3,50 %». Показываем как дала биржа. */
    couponPercent: coupon,
    couponDetails: sec?.COUPON_DETAILS || desc.COUPON_DETAILS || null,
    couponPeriodDays: num(sec?.COUPONPERIOD),
    nextCoupon: sec?.NEXTCOUPON || null,
    matDate: sec?.MATDATE || desc.MATDATE || null,
    offerDate: sec?.OFFERDATE || desc.OFFERDATE || null,
    bondType: sec?.BONDTYPE || desc.BONDTYPE || null,
    qualified: desc.ISQUALIFIEDINVESTORS === 1 || desc.ISQUALIFIEDINVESTORS === '1' ? true
      : (desc.ISQUALIFIEDINVESTORS === 0 || desc.ISQUALIFIEDINVESTORS === '0' ? false : null),
    listLevel: num(sec?.LISTLEVEL),
    faceValue: num(sec?.FACEVALUE),
    issuesSize: num(sec?.ISSUESIZE),
    issuesSizePlaced: num(sec?.ISSUESIZEPLACED),
    board: sec?.BOARDID || null,
    currency: sec?.FACEUNIT || 'SUR',
    secid: sec?.SECID || null,
    traded: sec ? Boolean(sec.PREVPRICE || sec.PREVLEGALCLOSEPRICE) : false,
    /* То, что видно в брокере по уже торгуемой бумаге: цена, НКД и
       доходность. У свежего размещения всего этого ещё нет — биржа
       ничего не публикует, пока не прошли первые сделки, и прочерк
       здесь честнее нуля.

       ВАЖНО про ноль: по выпуску, где сегодня не было сделок, биржа
       отдаёт YIELD и MARKETPRICE ровно нулями. Ноль доходности — это не
       «доходности нет, но ноль», это «биржа не считала»: показывать его
       значит врать в самом чувствительном месте. Поймал на живом файле:
       у ВТБ и Роснано в анонсах стоял 0 %. */
    price: pos(num(sec?.LAST)) ?? pos(num(sec?.MARKETPRICE)) ?? pos(num(sec?.PREVPRICE)) ?? pos(num(sec?.PREVLEGALCLOSEPRICE)),
    nkd: num(sec?.ACCRUEDINT),
    ytm: pos(num(sec?.YIELD)),
    yieldDateType: sec?.YIELDDATETYPE || null,
  };
}

/* ── основной проход ─────────────────────────────────────────────── */

/**
 * Страница анонса — обычный HTML на www.moex.com. Повторяем попытку:
 * одиночный обрыв связи не должен превращать анонс в запись без полей.
 */
async function fetchPage(url, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) {
      if (i === attempts) throw e;
      await sleep(700 * i);
    }
  }
}

async function main() {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const windowFrom = new Date(now.getTime() - WINDOW_DAYS * 864e5).toISOString().slice(0, 10);
  const refreshFrom = new Date(now.getTime() - REFRESH_DAYS * 864e5).toISOString().slice(0, 10);

  /* Прошлый файл: из него берём уже разобранные анонсы, чтобы не
     дёргать биржу заново. */
  let prev = null;
  if (existsSync(OUT)) {
    try { prev = JSON.parse(readFileSync(OUT, 'utf8')); } catch { prev = null; }
  }
  const prevById = new Map((prev?.items || []).map(x => [String(x.id), x]));

  console.log(`Окно: ${windowFrom} … ${today} (${WINDOW_DAYS} дней), `
    + `перечитываем свежее ${refreshFrom}`);

  /* 1. Лента новостей биржи назад до границы окна. */
  const news = [];
  let pages = 0;
  for (let start = 0; start < MAX_NEWS_PAGES * 50; start += 50) {
    const d = await iss('/sitenews.json', { start });
    const list = d.sitenews || [];
    if (!list.length) break;
    pages++;
    news.push(...list);
    const oldest = String(list[list.length - 1].published_at || '').slice(0, 10);
    if (oldest && oldest < windowFrom) break;
    await sleep(NEWS_DELAY_MS);
  }
  console.log(`Лента: ${news.length} новостей на ${pages} страницах`);

  /* 2. Отбор анонсов размещений. */
  const announcements = [];
  const byKind = {};
  for (const n of news) {
    const kind = kindOf(n.title);
    if (!kind) continue;
    const publishedAt = String(n.published_at || '').slice(0, 10);
    if (publishedAt && publishedAt < windowFrom) continue;
    byKind[kind] = (byKind[kind] || 0) + 1;
    announcements.push({
      id: n.id, kind, title: n.title,
      publishedAt,
      url: `https://www.moex.com/n${n.id}/?nt=101`,
    });
  }
  console.log(`Анонсов размещений: ${announcements.length} — ${JSON.stringify(byKind)}`);

  /* 3. Тексты: свежие перечитываем, старые берём из прошлого файла. */
  const items = [];
  let parsed = 0; let reused = 0; let failed = 0;
  for (const a of announcements) {
    const cached = prevById.get(String(a.id));
    /* Из прошлого файла берём только то, что перечитывать незачем. Два
       исключения: неполный разбор и «приостановка» без эмитента —
       однажды такие записи сохранились до того, как разбор научился
       находить эмитента в сообщениях этого вида. Метка noIssuer не
       даёт дёргать биржу за одной и той же страницей каждый прогон. */
    const wantIssuer = a.kind === 'suspend' && cached && !cached.issuer && !cached.noIssuer;
    if (cached && a.publishedAt < refreshFrom && !cached.incomplete && !wantIssuer) {
      items.push({ ...cached, kind: a.kind, title: a.title, url: a.url });
      reused++;
      continue;
    }
    try {
      const lines = bodyOf(htmlToLines(await fetchPage(a.url)), a.title);

      if (a.kind === 'results') {
        /* В одном сообщении «итогов» биржа перечисляет несколько
           выпусков, а иногда и нескольких эмитентов: у каждого свой
           объём, цена и доля размещённых. Режем текст по выпускам. */
        const blocks = splitIssueBlocks(lines);
        let made = 0;
        for (const b of blocks) {
          const { val } = fieldsOf(b.lines);
          const rec = recordFromFields({
            kind: a.kind, id: `${a.id}-${made + 1}`, title: a.title,
            publishedAt: a.publishedAt, url: a.url, issuer: b.issuer, val,
          });
          /* Пустой блок (шапка или подвал страницы) отбрасываем. */
          if (!rec.volumePlaced && !rec.quantityPlaced && !rec.regNumber) continue;
          items.push(rec); made++;
        }
        if (!made) {
          /* Структура не распозналась — записываем анонс как есть,
             чтобы он не потерялся, и помечаем incomplete. */
          items.push({
            ...a, id: String(a.id), incomplete: true,
            issuer: null, series: null, isin: null, book: null,
          });
          failed++;
        }
      } else {
        const { val } = fieldsOf(lines);
        const rec = recordFromFields({
          kind: a.kind, id: String(a.id), title: a.title,
          publishedAt: a.publishedAt, url: a.url,
          issuer: issuerFromText(lines), val,
        });
        /* Для «приостановки» достаточно ISIN и серии: дат размещения в
           таком сообщении нет по определению. */
        if (!rec.isin && !rec.placementStart && !rec.book) rec.incomplete = true;
        if (!rec.issuer) rec.noIssuer = true;
        items.push(rec);
      }
      parsed++;
    } catch (e) {
      /* Сбой одной страницы не должен ронять прогон: сохраняем анонс
         без подробностей — он всё равно полезен (заголовок + дата). */
      console.warn(`  не разобрал ${a.url}: ${e.message}`);
      items.push({
        ...a, id: String(a.id), incomplete: true,
        issuer: null, series: null, isin: null, book: null,
      });
      failed++;
    }
    await sleep(PAGE_DELAY_MS);
  }
  console.log(`Разобрано страниц: ${parsed}, взято из прошлого файла: ${reused}, сбоев: ${failed}`);

  /* Предохранитель: в ленте анонсы были, а разобрать не удалось ничего —
     значит биржа поменяла вёрстку. Файл НЕ перезаписываем. */
  const withDetails = items.filter(x => !x.incomplete).length;
  if (announcements.length >= MIN_PARSED && withDetails < MIN_PARSED) {
    console.error(`\nАнонсов в ленте ${announcements.length}, а разобрано ${withDetails}. `
      + 'Похоже, биржа поменяла формат сообщений. Файл НЕ перезаписываем — '
      + 'лучше устаревшие данные, чем пустые.');
    process.exit(1);
  }

  /* 4. Данные выпусков из торговых списков биржи: и по ISIN, и по
     регистрационному номеру — в «итогах выпуска» ISIN не указывают,
     а регномер есть и в сообщении, и в поле REGNUMBER торгового списка. */
  const pool = { byIsin: new Map(), byReg: new Map() };
  for (const board of ['TQCB', 'TQOB']) {
    const d = await iss(`/engines/stock/markets/bonds/boards/${board}/securities.json`);
    /* Цена и доходность лежат НЕ в блоке securities, а в двух соседних:
       marketdata (LAST, MARKETPRICE, YIELD) и marketdata_yields
       (YIELDDATETYPE — к погашению или к оферте). Раньше брали только
       securities, поэтому в анонсе размещения нечего было показать про
       доходность — а брокер её показывает, и папа спрашивал именно про
       то, что видно в брокере. */
    const M = new Map((d.marketdata || []).map(r => [r.SECID, r]));
    const Y = new Map((d.marketdata_yields || []).map(r => [r.SECID, r]));
    for (const s of d.securities || []) {
      const m = M.get(s.SECID), y = Y.get(s.SECID);
      const row = {
        ...s,
        BOARDID: board,
        LAST: m?.LAST ?? null,
        MARKETPRICE: m?.MARKETPRICE ?? null,
        YIELD: m?.YIELD ?? null,
        YIELDDATETYPE: y?.YIELDDATETYPE ?? null,
      };
      if (s.ISIN) pool.byIsin.set(keyOf(s.ISIN), row);
      if (s.SECID && !pool.byIsin.has(keyOf(s.SECID))) pool.byIsin.set(keyOf(s.SECID), row);
      if (s.REGNUMBER) pool.byReg.set(keyOf(s.REGNUMBER), row);
    }
    await sleep(NEWS_DELAY_MS);
  }
  console.log(`Торговые списки: ${pool.byIsin.size} по ISIN, ${pool.byReg.size} по регномеру`);

  const descCache = new Map();
  let enriched = 0; let enrichedCached = 0;
  for (const x of items) {
    /* У записей, взятых из прошлого файла, данные выпуска уже есть.
       Обновляем их только для свежих сообщений — иначе робот дёргал бы
       биржу за каждой бумагой на каждом прогоне, восемь раз в сутки. */
    if (x.bond && String(x.publishedAt) < refreshFrom) { enrichedCached++; continue; }
    const info = await bondInfo(x, pool, descCache);
    if (info) { x.bond = info; enriched++; }
  }
  console.log(`Данные выпуска: получено заново по ${enriched}, взято из прошлого файла по ${enrichedCached}`);

  /* 5. Чистим расписания у ВСЕХ записей, включая взятые из прошлого
     файла: иначе длинный абзац правил, затянутый в поле, остался бы в
     данных до тех пор, пока анонс не перечитается заново. */
  for (const x of items) {
    if (!x.book) continue;
    x.book.daily = timeRange(x.book.daily);
    x.book.activationTime = clock(x.book.activationTime);
  }

  /* 6. Детерминированный порядок: по дате сообщения, затем по id.
     Иначе порядок обхода биржи менялся бы от прогона к прогону и робот
     коммитил бы огромный diff при тех же данных. */
  items.sort((a, b) => String(a.publishedAt).localeCompare(String(b.publishedAt))
    || String(a.id).localeCompare(String(b.id)));

  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'Московская Биржа: лента новостей (iss.moex.com/iss/sitenews.json) '
      + 'и тексты сообщений о размещениях (www.moex.com)',
    note: 'Анонсы первичных размещений облигаций. Купон в сообщениях биржи не публикуется — '
      + 'он появляется в данных выпуска после начала торгов. Рейтингов нет: у источника '
      + 'нет ни агентства, ни даты присвоения.',
    window: { from: windowFrom, to: today, days: WINDOW_DAYS },
    stats: {
      newsScanned: news.length,
      newsPages: pages,
      announcements: announcements.length,
      parsedPages: parsed,
      reusedFromPrevious: reused,
      failedPages: failed,
      withDetails,
      byKind,
    },
    items,
  };

  const next = JSON.stringify(payload);
  if (prev) {
    const a = JSON.stringify({ ...prev, generatedAt: null, stats: null });
    const b = JSON.stringify({ ...payload, generatedAt: null, stats: null });
    if (a === b) {
      console.log('\nДанные не изменились — коммит не нужен.');
      return;
    }
  }

  writeFileSync(OUT, next, 'utf8');
  console.log(`\nЗаписано: public/placements.json (${(next.length / 1024).toFixed(0)} КБ, `
    + `${items.length} записей)`);
}

/* Разбор вынесен в экспорт: его удобно проверять точечно, не гоняя
   весь сбор (scripts/verify-placements.mjs). */
export { htmlToLines, bodyOf, kindOf, matchLabel, fieldsOf, splitIssueBlocks, recordFromFields, issuerFromText };

/* Запуск сбора — только при прямом вызове файла, чтобы импорт ради
   проверки разбора не запускал весь обход биржи. */
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch(e => {
    console.error('Робот упал:', e.message);
    process.exit(1);
  });
}
