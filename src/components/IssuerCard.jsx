import { Link } from 'react-router-dom';
import { Panel, RatingTag } from './ui';
import { money, dateShort, dateTime } from '../lib/format';
import { girboUrl, moexReportsUrl } from '../api/moex';

/* ═══════════════════════════════════════════════════════════════════
   Карточка предприятия — «кто выпустил бумагу».

   Сделана по образцу карточки выпуска bondradar.pro: там над ценой и
   доходностью стоит блок «О компании» с подписанными частями (бизнес,
   риски, отчётность), а ниже — панель «Финансы группы · поручитель».
   У них это текст, написанный человеком или моделью («устойчивость ядра
   зависит от госзаказа РЖД и уровня ставок»), и мы его не копируем:
   заказчик просил редакционное не делать. В карточке про деньги догадка
   опаснее пустого места — по ней человек и принимает решение.

   Поэтому здесь только проверяемые поля из трёх источников:
     • реестр эмитентов Московской биржи (название, ИНН, ОГРН, адрес,
       сайт, капитализация) — /iss/emitters;
     • рейтинг — таблица котировок smart-lab.ru, тот же робот, что кормит
       скринер; агентства и даты в источнике нет, поэтому и не пишем;
     • отчётность — ГИР БО ФНС (РСБУ), робот раз в неделю.

   Чего нет — говорим прямо. Поручителя, обеспечения и консолидированной
   отчётности группы биржа не публикует: вместо придуманного поручителя
   стоит строка, где он в действительности указан.

   Один компонент на два места — как у них loadIssuerBrief: и в карточке
   выпуска (compact), и на странице эмитента (полностью). Иначе два
   описания одной компании начнут расходиться.
   ═══════════════════════════════════════════════════════════════════ */

/* Организационно-правовая форма — только то, что прямо видно в названии
   и меняет чтение отчётности. Про отрасль по названию не гадаем. */
const ORG_FORMS = [
  {
    re: /специализированн\w+ финансов\w+ обществ|(^|[^а-яё])сфо([^а-яё]|$)|секьюр|секьюрит/i,
    label: 'специализированное финансовое общество (СФО)',
    note: 'Собственного бизнеса у СФО нет: это техническая компания, созданная под выпуск облигаций, а по обязательствам отвечает поручитель или гарант группы. Цифры РСБУ ниже — её технический баланс, а не выручка бизнеса.',
  },
  {
    re: /ипотечн\w+ агент/i,
    label: 'ипотечный агент',
    note: 'Ипотечный агент — тоже техническая компания: он держит пул закладных и выпускает под него облигации. Прибыльность бизнеса по его балансу не читается.',
  },
  {
    re: /банк/i,
    label: 'банк',
    note: 'У банка отчётность по РСБУ устроена иначе, чем у обычной компании: выручки в привычном смысле там нет.',
  },
];

/* Код страны в реестре — по ОКСМ. Показываем словами только те, что у
   эмитентов облигаций реально встречаются, остальное — как есть. */
const COUNTRIES = { 643: 'Россия', 112: 'Беларусь', 398: 'Казахстан', 804: 'Украина' };

function orgForm(title) {
  if (!title) return null;
  return ORG_FORMS.find(f => f.re.test(title)) || null;
}

/* Короткое имя из полного: «Общество с ограниченной ответственностью
   "Специализированное финансовое общество Синара Секьюр"» → «СФО Синара
   Секьюр». Реестр MOEX короткое имя отдаёт не всегда, поэтому убираем
   организационно-правовую форму и кавычки сами — так же делает образец.
   Длинное имя в шапке панели занимает две строки и мешает читать. */
function shortName(title) {
  if (!title) return null;
  const s = title
    .replace(/^(публичное |непубличное )?(акционерное общество|общество с ограниченной ответственностью)\s*/i, '')
    .replace(/^(ООО|ОАО|ЗАО|ПАО|АО)\s+/i, '')
    .replace(/[«»"]/g, '')
    .replace(/^специализированное финансовое общество\s+/i, 'СФО ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  return s.length > 52 ? s.slice(0, 50).replace(/\s+\S*$/, '') + '…' : s;
}

function Row({ k, v, mono }) {
  return (
    <tr>
      <td className="c-3" style={{ width: 190 }}>{k}</td>
      <td className={mono ? 'mono' : undefined}>{v}</td>
    </tr>
  );
}

export default function IssuerCard({
  title,
  shortTitle,
  inn,
  ogrn,
  okpo,
  country,
  legalAddress,
  postalAddress,
  website,
  capitalization,
  emitterCapitalization,
  capitalUpdatedAt,
  rating,
  ratingCode,
  bonds = [],
  girbo,
  girboDate,
  issuerKey,
  emitterId,
  compact = false,
}) {
  const form = orgForm(title);
  /* Реестр MOEX короткое имя отдаёт в виде «ООО "СФО Синара Секьюр"» —
     организационно-правовую форму всё равно убираем сами. */
  const short = shortName(shortTitle || title);

  /* Рейтинг по выпускам: у одного эмитента бумаги бывают с разными
     рейтингами (старые и новые серии), и «лучший» — это не то же самое,
     что «рейтинг эмитента». Показываем картинку целиком. */
  const spread = (() => {
    const by = new Map();
    for (const b of bonds) {
      if (!b.rating) continue;
      by.set(b.rating, (by.get(b.rating) || 0) + 1);
    }
    return [...by.entries()].sort((a, b) => b[1] - a[1]);
  })();

  const years = girbo?.years || [];
  const shownYears = compact ? years.slice(0, 3) : years.slice(0, 6);
  const hasRequites = title || inn || ogrn || okpo || legalAddress || website || capitalization != null;

  /* В заголовке панели — короткое имя из реестра: полное наименование СФО
     занимает две строки и в шапке читается плохо. Полное остаётся первой
     строкой таблицы реквизитов. */
  return (
    <Panel
      title={'Карточка предприятия' + (short ? ' · ' + short : '')}
      style={{ marginBottom: 14 }}
      right={<span className="c-3" style={{ fontSize: 11 }}>
        {compact ? 'источники: MOEX, ГИР БО ФНС, smart-lab' : 'реестр MOEX · ГИР БО ФНС · smart-lab'}
      </span>}
    >
      {/* ── Чьи это цифры ────────────────────────────────────────────
          Первое, что нужно понять про бумагу: за бумагой стоит сам
          эмитент или техническая компания группы. Об этом — до таблиц. */}
      <div className="c-2" style={{ fontSize: 12, lineHeight: 1.75, marginBottom: 12 }}>
        {form ? (
          <>
            По названию это <b>{form.label}</b>. {form.note}
          </>
        ) : (
          <>
            Ниже — реквизиты и отчётность <b>самого юридического лица-эмитента</b>.
            Если облигации выпускала техническая компания группы (СФО, ипотечный агент),
            собственных оборотов у неё обычно нет — и тогда её цифры о риске бумаги
            почти ничего не говорят.
          </>
        )}
      </div>

      {/* ── Рейтинг ──────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 12 }}>
        <span className="c-3" style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px' }}>
          Рейтинг
        </span>
        {rating
          ? <RatingTag rating={rating} code={ratingCode} />
          : <span className="c-3">в наших источниках рейтинга нет</span>}
        {spread.length > 1 && (
          <span className="c-3" style={{ fontSize: 11.5 }}>
            по выпускам: {spread.map(([r, n]) => `${r} — ${n}`).join(', ')}
          </span>
        )}
        <span className="c-3" style={{ fontSize: 11.5 }}>
          источник — таблица котировок smart-lab.ru; агентство и дату присвоения источник не указывает
        </span>
      </div>

      {/* ── Реквизиты ────────────────────────────────────────────── */}
      {hasRequites && (
        <div className="tbl-wrap" style={{ marginBottom: 12 }}>
          <table className="tbl">
            <tbody>
              {title ? <Row k="Полное наименование" v={title} /> : null}
              {inn ? <Row k="ИНН" v={inn} mono /> : null}
              {ogrn ? <Row k="ОГРН" v={ogrn} mono /> : null}
              {!compact && okpo ? <Row k="ОКПО" v={okpo} mono /> : null}
              {country ? <Row k="Страна регистрации" v={COUNTRIES[country] || country} /> : null}
              {legalAddress ? <Row k="Юридический адрес" v={legalAddress} /> : null}
              {!compact && postalAddress ? <Row k="Почтовый адрес" v={postalAddress} /> : null}
              <Row
                k="Сайт"
                v={website
                  ? <a href={website} target="_blank" rel="noopener noreferrer">{website}</a>
                  : <span className="c-3">в реестре не указан</span>}
              />
              <Row
                k="Капитализация"
                v={<>
                  {emitterCapitalization != null ? money(emitterCapitalization) : <span className="c-3">—</span>}
                  {capitalization != null && capitalization !== emitterCapitalization
                    ? <span className="c-3" style={{ marginLeft: 8, fontSize: 11.5 }}>вся группа: {money(capitalization)}</span>
                    : null}
                  {capitalUpdatedAt
                    ? <span className="c-3" style={{ marginLeft: 8, fontSize: 11.5 }}>обновлено {String(capitalUpdatedAt).slice(0, 16)}</span>
                    : null}
                </>}
              />
            </tbody>
          </table>
        </div>
      )}

      {/* ── Отчётность ───────────────────────────────────────────── */}
      <div className="c-3" style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 8 }}>
        Отчётность · РСБУ, ГИР БО ФНС{girboDate ? ` · данные от ${dateTime(girboDate)}` : ''}
      </div>
      {girbo?.closed ? (
        <div className="c-2" style={{ fontSize: 12, lineHeight: 1.7 }}>
          Организация <b>закрыла свою отчётность</b> от публичного доступа в ГИР БО ФНС.
          Это её право, и мы его уважаем — обходить ограничение не будем.
        </div>
      ) : shownYears.length ? (
        <>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="nosort">Год</th>
                  <th className="nosort">Выручка</th>
                  <th className="nosort">Активы</th>
                  <th className="nosort">Опубликовано</th>
                </tr>
              </thead>
              <tbody>
                {shownYears.map(y => (
                  <tr key={y.year} style={{ cursor: 'default' }}>
                    <td className="mono" style={{ fontWeight: 600 }}>{y.year}</td>
                    <td className="mono">{money(y.revenue)}</td>
                    <td className="mono">{money(y.assets)}</td>
                    <td className="c-3" style={{ fontSize: 11.5 }}>{y.publishedAt ? dateShort(y.publishedAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="c-2" style={{ fontSize: 11.5, lineHeight: 1.7, marginTop: 10 }}>
            Показаны только <b>выручка и валюта баланса</b> — то, что ФНС отдаёт открыто.
            Чистая прибыль, EBITDA и долг лежат в полной форме отчётности, а её часть
            организаций закрывает от публичного доступа.
            {years.length > shownYears.length
              ? <span className="c-3"> Показаны {shownYears.length} года из {years.length}.</span>
              : null}
            {girbo?.name ? <span className="c-3"> Организация в реестре: {girbo.name}.</span> : null}
          </div>
        </>
      ) : (
        <div className="c-2" style={{ fontSize: 12, lineHeight: 1.7 }}>
          {inn
            ? 'Отчётности этой организации в ГИР БО ФНС нет: робот не нашёл её по ИНН. Она могла сдать отчётность позже остальных или не сдавать её вовсе.'
            : 'ИНН эмитента биржа по этому выпуску не отдала, а по названию организация в ГИР БО не ищется — ошибёшься и покажешь чужие цифры. Финансовых показателей у нас нет.'}
        </div>
      )}

      {/* ── Поручитель и группа ──────────────────────────────────────
          Самый частый вопрос по таким выпускам — «кто отвечает, кроме
          эмитента». У bondradar.pro здесь панель «Финансы группы ·
          поручитель» с названием поручителя. Мы его не знаем: биржа
          поручителя в открытом API не отдаёт. Врать названием нельзя,
          поэтому объясняем, где он указан на самом деле. */}
      <div className="c-2" style={{ fontSize: 11.5, lineHeight: 1.7, marginTop: 12 }}>
        <b>Про поручителя, гаранта и отчётность группы.</b> В источниках, которые мы собираем
        (MOEX, ГИР БО ФНС, smart-lab), их нет: биржа поручителя в открытом API не публикует.
        Поручитель и обеспечение указываются в решении о выпуске — оно раскрывается
        на <a href="https://www.e-disclosure.ru/" target="_blank" rel="noopener noreferrer">e-disclosure.ru</a>,
        в разделе раскрытия информации эмитента.
        {form
          ? ' Пока поручитель не проверен, читать цифры РСБУ технической компании как оценку всего выпуска нельзя.'
          : null}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        {girbo?.girboId ? (
          <a className="btn btn-sm" href={girboUrl(girbo.girboId)} target="_blank" rel="noopener noreferrer">
            Открыть в ГИР БО ↗
          </a>
        ) : null}
        {!compact && moexReportsUrl(emitterId) ? (
          <a className="btn btn-sm" href={moexReportsUrl(emitterId)} target="_blank" rel="noopener noreferrer">
            Отчётность на MOEX ↗
          </a>
        ) : null}
        {issuerKey ? (
          <Link className="btn btn-sm" to={'/issuer/' + issuerKey}>
            {compact ? 'Карточка предприятия и все выпуски →' : 'Все выпуски и события →'}
          </Link>
        ) : null}
      </div>
    </Panel>
  );
}
