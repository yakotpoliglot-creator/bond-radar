/* Робот новостной ленты.
 *
 * ── Что собираем ──────────────────────────────────────────────────────
 * Новости, которые касаются рынка облигаций: действия ЦБ и Минфина,
 * аукционы ОФЗ, размещения, рейтинговые действия, дефолты и купоны,
 * отчётность эмитентов. У каждой записи — заголовок, короткая выдержка,
 * источник, дата, ссылка и тема.
 *
 * ── Как отбираем (и почему именно так) ────────────────────────────────
 * Первая версия читала ОБЩИЕ новостные ленты (Интерфакс, РБК, ТАСС,
 * Ведомости, Коммерсантъ) и выкидывала лишнее на нашей стороне. Вышла
 * мусорная лента: в ней оказались Хэллоуин в Цюрихе, стрельба в Алабаме
 * и монеты XI века — потому что общая лента и есть общий поток, а любой
 * наш фильтр по словам либо пропускает мусор, либо режет нужное.
 *
 * Поэтому отбор отдан ИСТОЧНИКУ: мы спрашиваем у поиска Google News по
 * узким запросам («Минфин размещение ОФЗ», «ключевая ставка ЦБ», «дефолт
 * купон облигации» и так далее). Поисковик сам отбирает релевантное, а мы
 * ничего не выкидываем руками и не подгоняем картину. Плюс к этому идут
 * тематические рубрики двух изданий, где новости рынка и так профильные:
 * Ведомости (финансы) и smart-lab (новости компаний), и лента самой биржи.
 *
 * ── Почему робот, а не браузер ────────────────────────────────────────
 * Ленты и поиск отдаются без CORS: из браузера их не прочитать. Плюс
 * опрашивать десять источников каждые 20 минут из каждого браузера —
 * это и грубо, и медленно. Поэтому собирает робот и кладёт результат в
 * public/news.json рядом с сайтом — тем же приёмом, что рейтинги, первичка
 * и допуск выпусков.
 *
 * ── Чего здесь НЕТ и не будет ─────────────────────────────────────────
 *   · разборов и статей. Это работа редакции: у нас нет ни автора, ни
 *     времени на вычитку. Придумывать «аналитику» робот не может;
 *   · привязки новости к конкретному выпуску. Проверено на образце: когда
 *     новость цепляют к эмитенту, у Сбербанка к одной новости оказывается
 *     634 бумаги, и 630 из них к новости отношения не имеют. Писать «это
 *     новость вашей бумаги» мы не станем;
 *   · полных текстов. Только выдержка и ссылка на первоисточник: читатель
 *     идёт к тем, кто эту новость написал.
 *
 * ── Про даты ─────────────────────────────────────────────────────────
 * Ленты отдают дату кто в RFC-822, кто в ISO, и в разных часовых поясах.
 * Всё приводим к московскому времени: сайт показывает живые данные биржи,
 * и лента в чужом поясе выглядела бы как сбой.
 *
 * Запуск: node scripts/news.mjs
 */
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'public', 'news.json');

const UA = 'BondRadar/1.0 (open-source bond screener; +https://github.com/yakotpoliglot-creator/bond-radar)';
const TIMEOUT_MS = 20000;
const RETRIES = 3;
const PAUSE_MS = 250;      // пауза между источниками: чужие сайты не должны нас замечать
const WINDOW_DAYS = 14;    // глубина ленты
const MAX_ITEMS = 200;
const MIN_ITEMS = 15;      // меньше — значит источники поменяли формат или режут нас

const sleep = ms => new Promise(s => setTimeout(s, ms));

/* Поисковые запросы Google News. Каждый — отдельная тема рынка облигаций.
   Запрос узкий намеренно: широкий («облигации») тянет рекламу брокеров
   и статьи «как заработать», а он нам не нужен. */
const QUERIES = [
  ['ставка', 'ключевая ставка ЦБ решение'],
  ['ОФЗ', 'Минфин аукцион размещение ОФЗ'],
  ['размещения', 'эмитент разместил облигации выпуск'],
  ['рейтинги', 'кредитный рейтинг агентство присвоило'],
  ['дефолты', 'дефолт купон облигации эмитент'],
  ['эмитенты', 'эмитент отчётность прибыль облигации'],
];

/* Тематические рубрики и ленты: здесь новости рынка профильные, общий
   поток в них не попадает, и — в отличие от поиска Google — есть настоящая
   ссылка на статью и настоящая дата публикации.
 *
 * Интерфакс и ТАСС здесь СОЗНАТЕЛЬНО не используются, хотя отвечают
 * исправно. Причина: рубрики у них не работают — параметр ?sec= Интерфакс
 * игнорирует и во все разделы отдаёт одну и ту же ленту происшествий и
 * военной хроники (проверено: 0 % записей по теме облигаций), у ТАСС в
 * «экономике» 10 %. Ставить их в ленту про облигации — засорять её. */
const FEEDS = [
  ['Ведомости', 'https://www.vedomosti.ru/rss/rubric/finance', 'vedomosti.ru', 'рынок'],
  ['Коммерсантъ', 'https://www.kommersant.ru/RSS/section-finance.xml', 'kommersant.ru', 'рынок'],
  ['smart-lab', 'https://smart-lab.ru/news/rss/', 'smart-lab.ru', 'эмитенты'],
];

/* Отбор по теме. Рубрики «финансы» всё равно приносят часть постороннего
   (у Ведомостей по теме 71 %, у Коммерсанта 50 %), поэтому записи без
   единого слова о рынке в заголовке отсеиваем. Правило проверяемое и
   узкое: оно смотрит ТОЛЬКО заголовок, не трогает выдержку и не пытается
   «понять» новость. Всё, что прошло отбор, попадает в ленту как есть.
 *
 * Имена крупных эмитентов перечислены отдельно, и это не украшение.
 * Проверка отсева показала, что без них мимо проходило важное
 * корпоративное: «Григоренко покинул пост набсовета ВТБ», «Euroclear
 * получил €3,6 млрд от замороженных активов России», «Сделка ВТБ с RWB
 * может выйти за пределы 2026 года», «АФК Система рассчитывает… Сегежа
 * групп». Бумаги этих эмитентов есть в скринере, и такие новости
 * читателю нужны. */
const RELEVANT = new RegExp([
  /* рынок и инструменты */
  'облигац', 'ОФЗ', 'купон', 'эмитент', 'размещ', 'рейтинг', 'ставк', 'ЦБ', 'Банк России',
  'Минфин', 'инвестор', 'биржа', 'Мосбиржа', 'дефолт', 'выпуск', 'доходност', 'банк',
  'рубл', 'доллар', 'евро', 'юан', 'нефть', 'Brent', 'Urals', 'инфляц', 'дивиденд',
  'отчётност', 'прибыл', 'выручк', 'убыток', 'РСБУ', 'МСФО', 'EBITDA', 'акци', 'фондов',
  'торги', 'IPO', 'SPO', 'санац', 'банкрот', 'долг', 'кредит', 'ипотек', 'вклад', 'бюджет',
  'налог', 'Euroclear', 'НРД', 'замороженн', 'санкц', 'листинг', 'портфел', 'котиров',
  /* крупные эмитенты, чьи бумаги есть в скринере */
  'ВТБ', 'Сбер', 'Газпром', 'Роснефт', 'ЛУКОЙЛ', 'Норникел', 'НорНик', 'РЖД', 'Ростелеком',
  'МТС', 'Магнит', 'Система', 'АФК', 'Сегеж', 'Самолет', 'ПИК', 'ФосАгро', 'Северстал',
  'НЛМК', 'ММК', 'Полюс', 'Яндекс', 'X5', 'Транснефт', 'Татнефт', 'Сургутнефтегаз', 'НОВАТЭК',
  'Аэрофлот', 'Мечел', 'Русал', 'Евраз', 'Совкомбанк', 'Тинькофф', 'Т-Банк', 'Альфа',
  'Открытие', 'ДОМ.РФ', 'ВЭБ', 'ГТЛК', 'МГКЛ', 'Ломбард', 'Лизинг', 'Мосэнерго', 'Интер РАО',
  'РусГидро', 'ФСК', 'Россети', 'Акрон', 'Уралкали', 'Эн+', 'En+', 'КамАЗ', 'АвтоВАЗ',
].join('|'), 'i');

function isRelevant(title) {
  return RELEVANT.test(title);
}

const TOPICS = [
  ['ставка', /ключев[ао]й ставк|ставк[аи] ЦБ|Банк России|ЦБ РФ|решение ЦБ|ДКП|денежно-кредитн/i],
  ['ОФЗ', /ОФЗ|Минфин|госдолг|аукцион/i],
  ['размещения', /разместил|размещает|размещени|сбор заявок|выпуск облигац|доразмещ|book build|деbut|дебютн/i],
  ['рейтинги', /рейтинг|АКРА|Эксперт РА|НРА|ru[A-D]{1,2}[+-]|присвоил|повысил|понизил|пересмотр/i],
  ['дефолты', /дефолт|техдефолт|не выплат|просрочк|реструктуризац|банкрот|санац/i],
  ['эмитенты', /отчётност|выручк|прибыл|убыток|дивиденд|РСБУ|МСФО|EBITDA/i],
];

const strip = s => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&laquo;/g, '«').replace(/&raquo;/g, '»')
  .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/&amp;/g, '&')
  .replace(/&[a-z#0-9]+;/gi, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? strip(m[1]) : '';
}

function excerpt(text, limit = 300) {
  if (!text) return '';
  const t = text.trim();
  if (t.length <= limit) return t;
  const cut = t.slice(0, limit);
  const dot = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return dot > limit * 0.5 ? cut.slice(0, dot + 1) : cut.trimEnd() + '…';
}

/* Дата к московскому времени: ленты отдают разные пояса. */
function toMoscow(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Moscow',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d).replace('T', ' ');
}

/** Тема записи. У новостей из поиска тема — сам запрос, это точнее
    словесных правил; правила нужны только для рубрик. */
function topicOf(title, text, fallback) {
  const hay = `${title} ${text}`;
  for (const [name, re] of TOPICS) if (re.test(hay)) return name;
  return fallback || 'рынок';
}

/* Ключ дедупликации.
 *
 * Простой нормализации заголовка мало: smart-lab публикует об одном и том
 * же событии две записи — «Самолет РСБУ 9м2026: Выручка ₽12,8 млрд…» и
 * «🔎ГК Самолет Отчет РСБУ», — и по заголовку это разные строки, хотя
 * новость одна. Поэтому дополнительно вытаскиваем из заголовка «суть»:
 * имя эмитента и тип события (отчёт, дивиденды, рейтинг, размещение).
 * Совпали имя и тип — считаем одной новостью. */
const EVENT_KINDS = [
  ['отчёт', /РСБУ|МСФО|выручк|прибыл|убыток|отчётност|отчет/i],
  ['дивиденды', /дивиденд/i],
  ['рейтинг', /рейтинг|АКРА|Эксперт РА|НРА/i],
  ['размещение', /разместил|размещени|выпуск|сбор заявок/i],
  ['дефолт', /дефолт|техдефолт|не выплат|просрочк/i],
];

/** Имя эмитента из заголовка: первое слово с большой буквы, кроме служебных. */
const STOP = new Set(['гк', 'пао', 'ао', 'ооо', 'отчет', 'отчёт', 'рсбу', 'мсфо', 'сд', 'банк', 'россии', 'рф', 'сша', 'ес', 'цб', 'фрс', 'офз', 'мосбиржа', 'минфин', 'биржа', 'что', 'как', 'почему', 'курс', 'цены', 'ставка', 'сша']);

function subjectOf(title) {
  const words = title
    .replace(/[«»"'`🔎📉📈🔥]/g, ' ')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  for (const w of words) {
    const low = w.toLowerCase();
    if (STOP.has(low) || low.length < 3) continue;
    if (/^[А-ЯA-Z]/.test(w) && !/^\d/.test(w)) return low.slice(0, 12);
  }
  return '';
}

function eventKindOf(title) {
  for (const [name, re] of EVENT_KINDS) if (re.test(title)) return name;
  return '';
}

function dedupKey(title) {
  const base = title.toLowerCase()
    .replace(/[«»"'`]/g, '')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return base;
}

/** Второй ключ: «эмитент + тип события» — ловит дубли вида «Отчет РСБУ». */
function subjectKey(title) {
  const s = subjectOf(title);
  const k = eventKindOf(title);
  return s && k ? `${s}|${k}` : '';
}

async function getText(url, attempts = RETRIES) {
  let lastError = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, accept: 'application/rss+xml,application/xml,text/xml,application/json,*/*' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastError = e;
      await sleep(500 * i * i);
    }
  }
  throw lastError || new Error('не удалось');
}

/** Разбор RSS. У Google News заголовок идёт с припиской « - Издание», а
    ссылка ведёт не на издание, а на собственный редирект Google, который
    никуда не переадресует (проверено: 302 на самого себя). И настоящий
    адрес статьи, и её дата у Google бесполезны, поэтому записи из поиска
    помечаем `search: true` — их заголовок идёт на подсказку, а ссылку и
    время берём из лент, где они честные. */
function parseRss(xml, { srcName, host, topic, isGoogle }) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  const out = [];
  for (const b of blocks) {
    let title = tag(b, 'title');
    if (!title) continue;
    let sourceLabel = srcName;
    let sourceUrl = '';

    const srcMatch = b.match(/<source[^>]*url="([^"]*)"[^>]*>([\s\S]*?)<\/source>/i);
    if (isGoogle && srcMatch) {
      sourceUrl = srcMatch[1];
      sourceLabel = strip(srcMatch[2]) || srcName;
      const tail = ` - ${sourceLabel}`;
      if (title.endsWith(tail)) title = title.slice(0, -tail.length).trim();
    }

    const link = tag(b, 'link') || (b.match(/<link[^>]*href="([^"]+)"/i)?.[1] ?? '');
    const raw = tag(b, 'description') || tag(b, 'summary') || tag(b, 'content');
    const date = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date');

    /* Описание у Google — это тот же заголовок со ссылкой, выдержки там
       нет: не выдаём её за выдержку. */
    const cleanExcerpt = isGoogle ? '' : excerpt(raw);

    out.push({
      title,
      excerpt: cleanExcerpt,
      url: isGoogle ? '' : strip(link),
      ts: toMoscow(date),
      src: sourceLabel,
      host: isGoogle ? hostOf(sourceUrl) : (host || ''),
      topic: topicOf(title, raw, topic),
      search: !!isGoogle,
    });
  }
  return out;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** Лента биржи — единственный источник, который прямо называет бумагу. */
async function moexNews() {
  const body = await getText('https://iss.moex.com/iss/sitenews.json?iss.meta=off');
  const j = JSON.parse(body);
  const cols = j.sitenews.columns;
  const iT = cols.indexOf('title'), iD = cols.indexOf('published_at'), iId = cols.indexOf('id');
  const out = [];
  for (const row of j.sitenews.data) {
    const title = String(row[iT] || '').trim();
    if (!title) continue;
    const m = title.match(/ценной бумаги\s+([A-Z0-9]+)/i) || title.match(/акциями\s+([A-Z0-9]+)/i);
    out.push({
      title,
      excerpt: m ? `Сообщение биржи о бумаге ${m[1]}.` : '',
      url: row[iId] ? `https://www.moex.com/n${row[iId]}/` : '',
      ts: toMoscow(String(row[iD] || '').replace(' ', 'T') + '+03:00'),
      src: 'Московская биржа',
      host: 'moex.com',
      topic: 'биржа',
      ticker: m ? m[1] : '',
    });
  }
  return out;
}

/* ── Сбор ────────────────────────────────────────────────────────────── */

const collected = [];
const feedStats = [];

for (const [topic, query] of QUERIES) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ru&gl=RU&ceid=RU:ru`;
  try {
    const xml = await getText(url);
    const items = parseRss(xml, { srcName: 'Google News', host: 'news.google.com', topic, isGoogle: true });
    collected.push(...items);
    feedStats.push({ src: `поиск: ${topic}`, items: items.length, ok: true });
    console.log(`${('поиск: ' + topic).padEnd(22)} ${items.length} записей`);
  } catch (e) {
    feedStats.push({ src: `поиск: ${topic}`, items: 0, ok: false, error: e.message });
    console.log(`${('поиск: ' + topic).padEnd(22)} НЕ ОТВЕТИЛ: ${e.message}`);
  }
  await sleep(PAUSE_MS);
}

for (const [name, url, host, topic] of FEEDS) {
  try {
    const xml = await getText(url);
    const all = parseRss(xml, { srcName: name, host, topic });
    const items = all.filter(it => isRelevant(it.title));
    collected.push(...items);
    feedStats.push({ src: name, items: items.length, skipped: all.length - items.length, ok: true });
    console.log(`${name.padEnd(22)} ${String(items.length).padStart(3)} записей (отсеяно ${all.length - items.length})`);
  } catch (e) {
    feedStats.push({ src: name, items: 0, ok: false, error: e.message });
    console.log(`${name.padEnd(22)} НЕ ОТВЕТИЛИ: ${e.message}`);
  }
  await sleep(PAUSE_MS);
}

try {
  const moex = await moexNews();
  collected.push(...moex);
  feedStats.push({ src: 'Московская биржа', items: moex.length, ok: true });
  console.log(`${'Биржа'.padEnd(22)} ${moex.length} записей`);
} catch (e) {
  feedStats.push({ src: 'Московская биржа', items: 0, ok: false, error: e.message });
  console.log(`Биржа                  НЕ ОТВЕТИЛА: ${e.message}`);
}

/* Окно свежести и дедупликация.
 *
 * Тонкость, на которой легко обмануться: у записей из поиска Google дата
 * НЕ дата новости. По запросу «ключевая ставка» он отдаёт и материал 2020
 * года с датой публикации — как «свежий». Поэтому новостью считается
 * только запись с настоящим адресом и датой из рубрики или с биржи, а
 * поисковые записи служат пометкой «об этом ещё писали»: по ним видно,
 * что тема живая, но в ленту как событие они не идут.
 */
const edge = Date.now() - WINDOW_DAYS * 86400_000;
const seen = new Map();
const bySubject = new Map();
const searchOnly = [];

for (const it of collected) {
  if (!it.ts) continue;
  const t = new Date(it.ts.replace(' ', 'T') + '+03:00').getTime();

  if (it.search) {
    /* Поисковую запись придерживаем: она либо подтвердит уже собранную
       новость, либо, если такой новости нет, останется только подсказкой
       и в ленту не попадёт. */
    searchOnly.push(it);
    continue;
  }
  if (!(t >= edge)) continue;

  const key = dedupKey(it.title);

  /* Дубль по «эмитент + событие»: smart-lab пишет об отчёте дважды —
     подробно и коротко. Оставляем более содержательную запись. */
  const sk = subjectKey(it.title);
  if (sk && bySubject.has(sk)) {
    const prev = bySubject.get(sk);
    if ((it.excerpt || '').length > (prev.excerpt || '').length) {
      seen.delete(dedupKey(prev.title));
      seen.set(key, { ...it });
      bySubject.set(sk, it);
    }
    continue;
  }

  const prev = seen.get(key);
  if (prev) {
    if (!prev.excerpt && it.excerpt) prev.excerpt = it.excerpt;
    if (prev.topic === 'рынок' && it.topic !== 'рынок') prev.topic = it.topic;
    prev.alsoIn = [...new Set([...(prev.alsoIn || []), it.src])].filter(s => s !== prev.src);
    continue;
  }

  seen.set(key, { ...it });
  if (sk) bySubject.set(sk, it);
}

/* Поисковые записи добавляем к ленте ТОЛЬКО как дополнение к уже собранным:
   у них нет ни ссылки, ни достоверного времени, поэтому самостоятельными
   строками они быть не могут. */
for (const s of searchOnly) {
  const key = dedupKey(s.title);
  if (seen.has(key)) continue;
  /* Ищем, к какой собранной новости эта поисковая ближе всего: по первым
     значимым словам заголовка. */
  const probe = key.split(' ').filter(w => w.length > 4).slice(0, 2);
  if (!probe.length) continue;
  for (const [k, v] of seen) {
    if (probe.every(w => k.includes(w))) {
      v.alsoIn = [...new Set([...(v.alsoIn || []), s.src])].filter(x => x !== v.src);
      break;
    }
  }
}

const items = [...seen.values()].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, MAX_ITEMS);

const byTopic = {};
for (const it of items) byTopic[it.topic] = (byTopic[it.topic] || 0) + 1;

const bySource = {};
for (const it of items) bySource[it.src] = (bySource[it.src] || 0) + 1;

const fresh = items.filter(it => Date.now() - new Date(it.ts.replace(' ', 'T') + '+03:00').getTime() < 36 * 3600_000).length;

const payload = {
  generatedAt: new Date().toISOString(),
  source: 'Поиск Google News по темам рынка облигаций, рубрики «Ведомости. Финансы» и smart-lab, лента Московской биржи',
  note: 'Отбор делает источник: мы спрашиваем поиск по узким темам (ставка, ОФЗ, размещения, рейтинги, дефолты, отчётность) и читаем профильные рубрики. Общие новостные ленты сюда не попадают намеренно — проверено, что в них приходит общий поток вроде городских происшествий. Разборов и статей здесь нет: это работа редакции, а не робота. Новости не привязаны к конкретным выпускам — биржа называет бумагу прямо только в своих сообщениях, а привязка по названию эмитента даёт ложные срабатывания.',
  window: { days: WINDOW_DAYS },
  stats: {
    feeds: feedStats,
    feedsOk: feedStats.filter(f => f.ok).length,
    feedsTotal: feedStats.length,
    collected: collected.length,
    published: items.length,
    freshLast36h: fresh,
    byTopic,
    bySource,
  },
  items,
};

/* Не коммитим, если изменилось только время сбора: иначе робот каждые
   20 минут плодит пустые коммиты. Сравниваем всё, кроме generatedAt. */
if (existsSync(OUT)) {
  try {
    const prev = JSON.parse(readFileSync(OUT, 'utf8'));
    const a = JSON.stringify({ ...prev, generatedAt: null, stats: null });
    const b = JSON.stringify({ ...payload, generatedAt: null, stats: null });
    if (a === b) {
      console.log('\nСодержимое ленты не изменилось — файл не переписываем.');
      process.exit(0);
    }
  } catch { /* файл битый — перезапишем */ }
}

writeFileSync(OUT, JSON.stringify(payload), 'utf8');
console.log(`\nСобрано: ${collected.length}, после дедупликации: ${items.length}, за 36 часов: ${fresh}`);
console.log(`Темы: ${JSON.stringify(byTopic)}`);
console.log(`Источников ответило: ${feedStats.filter(f => f.ok).length} из ${feedStats.length} → ${OUT}`);

if (items.length < MIN_ITEMS) {
  console.error(`\nЗаписей меньше ${MIN_ITEMS} — похоже, источники поменяли формат или режут нас.`);
  console.error('Файл записан, но он подозрительно пустой.');
  process.exit(1);
}
