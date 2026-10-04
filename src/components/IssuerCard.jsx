import { Link } from 'react-router-dom';
import { Panel, RatingTag } from './ui';
import { money, dateShort, dateTime } from '../lib/format';
import { girboUrl, moexReportsUrl } from '../api/moex';
import { TONE_CLS } from '../lib/ratios';

/* ═══════════════════════════════════════════════════════════════════
   Эмитент: карточка на выпуске и подробности на его странице.

   В оригинале это две разные вещи, и мы делаем так же:
     • variant="card" — короткая карточка «О компании» на карточке
       выпуска: кто за бумагой, метрики отчётности плитками (как их
       Долг/EBITDA, EBITDA-маржа, чистая маржа), кнопка на страницу
       эмитента. Таблиц реквизитов и отчётности здесь нет: карточка
       выпуска — про бумагу, а не про всю компанию;
     • variant="detail" — на самой странице эмитента: реквизиты из
       реестра MOEX, отчётность РСБУ из ГИР БО и честная строка про
       поручителя. Плиток метрик тут нет — ниже на этой же странице
       стоит полная панель МСФО (components/Fundamentals).

   Прозу про бизнес и риски, как в их блоке «О компании», не пишем:
   заказчик просил редакционное не делать. В карточке про деньги
   догадка опаснее пустого места — по ней человек и принимает решение.
   Поэтому только проверяемые поля и числа из трёх источников:
     • реестр эмитентов Московской биржи (/iss/emitters) — название,
       ИНН, ОГРН, адрес, сайт, капитализация юрлица и всей группы;
     • smart-lab.ru — рейтинг выпусков и отчётность МСФО с готовыми
       коэффициентами; агентства и даты присвоения рейтинга источник
       не указывает, поэтому и мы не пишем;
     • ГИР БО ФНС (РСБУ) — робот собирает раз в неделю.

   Чего нет — говорим прямо: поручителя, обеспечения и консолидированной
   отчётности группы биржа в открытом API не публикует, вместо
   придуманного поручителя стоит строка, где он в действительности указан.
   ═══════════════════════════════════════════════════════════════════ */

/* Организационно-правовая форма — только то, что прямо видно в названии
   и меняет чтение отчётности. Про отрасль по названию не гадаем. */
const ORG_FORMS = [
  {
    re: /специализированн\w+ финансов\w+ обществ|(^|[^а-яё])сфо([^а-яё]|$)|секьюр|секьюрит/i,
    label: 'специализированное финансовое общество (СФО)',
    note: 'Собственного бизнеса у СФО нет: это техническая компания, созданная под выпуск облигаций, а по обязательствам отвечает поручитель или гарант группы. Цифры РСБУ — её технический баланс, а не выручка бизнеса.',
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

/* Код страны в реестре — по ОКСМ. Словами показываем те, что у эмитентов
   облигаций реально встречаются, остальное — как есть. */
const COUNTRIES = { 643: 'Россия', 112: 'Беларусь', 398: 'Казахстан', 804: 'Украина' };

/* Цвет и подпись светофора — одни на весь сайт: и подписи, и цвета берём
   из общего модуля порогов (lib/ratios) — там же считаются сами значения,
   поэтому карточка и панель коэффициентов не могут разойтись. */

function orgForm(title) {
  if (!title) return null;
  return ORG_FORMS.find(f => f.re.test(title)) || null;
}

/* Короткое имя из полного: «Общество с ограниченной ответственностью
   "Специализированное финансовое общество Синара Секьюр"» → «СФО Синара
   Секьюр». Реестр MOEX короткое имя отдаёт в виде «ООО "СФО Синара
   Секьюр"», организационно-правовую форму всё равно убираем сами.
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

/* Тонкая метрика одной строкой: «Отчётность МСФО · 2026Q2 · опубликована
   28.08.2026 · выручка 1 880,0 млрд ₽ · чистая прибыль 286,1 млрд ₽». */
function PeriodLine({ period }) {
  if (!period) return null;
  return (
    <div style={{ fontSize: 12, lineHeight: 1.75, marginTop: 12 }}>
      <span className="c-3" style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px' }}>
        Отчётность МСФО
      </span>
      {' '}· {period.label}
      {period.date ? ` · опубликована ${period.date}` : ''} · {period.text}
    </div>
  );
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
  variant = 'detail',
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
  stats = [],
  period = null,
  showBrief = false,   // попап: показать и блок «О компании», а не только таблицы
  onExpand,            // страница выпуска: кнопка, открывающая карточку окном
}) {
  const card = variant === 'card';
  const form = orgForm(title);
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

  /* Годы ГИР БО идут сверху вниз: свежий первым. */
  const years = girbo?.years || [];
  const latest = years[0] || null;

  /* ── Куски, общие для карточки и попапа ───────────────────────────
     Текст берём отсюда в оба места: расходиться им нельзя. */
  const head = (
    <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      {rating
        ? <RatingTag rating={rating} code={ratingCode} />
        : <span className="c-3" style={{ fontSize: 11 }}>рейтинга в источниках нет</span>}
      <span className="c-3" style={{ fontSize: 11 }}>MOEX · smart-lab · ГИР БО ФНС</span>
    </span>
  );

  /* Кто за бумагой — до цифр: у СФО и ипотечного агента своего бизнеса
     нет, и метрики МСФО по такой компании не найдутся. Внутри самого
     попапа на карточку не ссылаемся — она и есть то, что открыто. */
  const fact = (
    <div className="c-2" style={{ fontSize: 12.5, lineHeight: 1.75 }}>
      {form
        ? <>Это <b>{form.label}</b>. {form.note}</>
        : <>
          <b>{short || 'Эмитент'}</b> — организация, выпустившая бумагу.{' '}
          {showBrief
            ? 'Ниже — метрики её отчётности и рейтинг выпуска, реквизиты и отчётность.'
            : 'Ниже — метрики её отчётности и рейтинг выпуска, реквизиты и отчётность — в карточке предприятия.'}
        </>}
    </div>
  );

  /* ── Метрики отчётности плитками ─────────────────────────────────
     Ранжирование — как в карточке у оригинала: цветной светофор стоит у
     кредитных коэффициентов (долг к EBITDA, чистый долг к EBITDA,
     покрытие процентов), а маржа и ROE серые и подписаны «справочно» —
     без отрасли «хорошо/плохо» у них не бывает. Где знаменатель около
     нуля, вместо абсурдного числа стоит «н/д».
     Значения и цвета считает lib/ratios — здесь только показ. */
  const briefBlock = (
    <>
      {stats.length > 0 && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginTop: 12 }}>
            {stats.map(s => (
              <div key={s.key} className="kpi-card" title={s.hint} style={{ cursor: 'help' }}>
                <div className="kpi-l">{s.label}</div>
                <div className={'kpi-v ' + TONE_CLS[s.tone]}>
                  {s.text}
                  {!s.na && <span style={{ fontSize: 13 }}>{s.unit}</span>}
                </div>
                <div className="kpi-s">
                  <span className={TONE_CLS[s.tone]}>●</span> {s.toneLabel} · {s.year}
                </div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 11, fontSize: 11, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <span><span className="c-g">●</span> в норме</span>
            <span><span className="c-a">●</span> внимание</span>
            <span><span className="c-r">●</span> риск</span>
            <span className="c-3">серые — справочно, зависят от отрасли</span>
          </div>
          <div className="c-3" style={{ fontSize: 10.5, marginTop: 8, lineHeight: 1.6 }}>
            Цифры — из отчётности МСФО (smart-lab.ru), цвет — наша оценка порогов, а не факт из отчёта:
            границы «нормы» зависят от отрасли. Где знаменатель около нуля, вместо абсурдного числа
            стоит «н/д»: это не «очень плохо», а «считать не из чего». Наведите курсор на метрику —
            в подсказке, что она значит.
          </div>
        </>
      )}

      {/* ── Отчётность одной строкой ────────────────────────────────
          Если МСФО по компании нет (так у СФО и у банков), показываем
          то, что есть: РСБУ из ГИР БО. Прочерк вместо цифры честнее
          пустого места. */}
      {period
        ? <PeriodLine period={period} />
        : latest ? (
          <div style={{ fontSize: 12, lineHeight: 1.75, marginTop: 12 }}>
            <span className="c-3" style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px' }}>
              Отчётность РСБУ
            </span>
            {' '}· ГИР БО ФНС · {latest.year} · выручка {money(latest.revenue)} · активы {money(latest.assets)}
            {girboDate ? <span className="c-3"> · данные от {dateTime(girboDate)}</span> : null}
          </div>
        ) : null}
    </>
  );

  /* ══════════════════ Карточка на странице выпуска ══════════════════ */
  if (card) {
    return (
      <Panel title="О компании" style={{ marginBottom: 14 }} right={head}>
        {fact}

        {/* Идентификаторы одной строкой: ИНН нужен, чтобы сверить компанию
            в ГИР БО или у брокера. Полная таблица реквизитов — в карточке
            предприятия, она открывается кнопкой ниже. */}
        <div className="c-3" style={{ fontSize: 11.5, marginTop: 7, lineHeight: 1.7 }}>
          {inn ? <>ИНН {inn}</> : null}
          {ogrn ? <> · ОГРН {ogrn}</> : null}
          {country ? <> · {COUNTRIES[country] || country}</> : null}
          {website
            ? <> · <a href={website} target="_blank" rel="noopener noreferrer">{website.replace(/^https?:\/\//, '')}</a></>
            : null}
        </div>

        {briefBlock}

        {/* Куда идти дальше — зелёной кнопкой, как «Полный разбор» в их
            карточке: на карточке выпуска это главное действие. Кнопка
            «Карточка предприятия» открывает окно с реквизитами и
            отчётностью — как в оригинале, вместо второй страницы. */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          {onExpand ? (
            <button
              className="btn btn-sm"
              onClick={onExpand}
              title="Открыть карточку предприятия отдельным окном"
            >
              Карточка предприятия ⤢
            </button>
          ) : null}
          {issuerKey ? (
            <Link className="btn btn-sm btn-green" to={'/issuer/' + issuerKey}>
              Страница эмитента →
            </Link>
          ) : null}
          {girbo?.girboId ? (
            <a className="btn btn-sm" href={girboUrl(girbo.girboId)} target="_blank" rel="noopener noreferrer">
              ГИР БО ФНС ↗
            </a>
          ) : null}
        </div>

        {/* Про поручителя — коротко: для СФО это и есть главный вопрос к
            бумаге, но на карточке выпуска хватит одной честной строки. */}
        <div className="c-3" style={{ fontSize: 11, marginTop: 10, lineHeight: 1.65 }}>
          Поручителя, обеспечения и отчётности группы здесь нет: биржа их в открытом API не публикует.
          Они указаны в решении о выпуске — оно раскрывается на{' '}
          <a href="https://www.e-disclosure.ru/" target="_blank" rel="noopener noreferrer">e-disclosure.ru</a>.
        </div>
      </Panel>
    );
  }

  /* ══════ Подробности: реквизиты, РСБУ, поручитель ════════════════ */
  const hasRequites = title || inn || ogrn || okpo || legalAddress || website || capitalization != null;
  const shownYears = years.slice(0, 6);

  return (
    <>
      {/* ── О компании ─────────────────────────────────────────────
          В попапе карточка начинается тем же блоком, что и на карточке
          выпуска: кто это, метрики плитками, строка отчётности. Ниже —
          реквизиты, РСБУ и поручитель, чтобы за ними не уходить на
          другую страницу. */}
      {showBrief ? (
        <Panel title="О компании" right={head} style={{ marginBottom: 14 }}>
          {fact}
          {briefBlock}
        </Panel>
      ) : null}

      {/* ── Реквизиты ────────────────────────────────────────────── */}
      <Panel
        title={'Данные об эмитенте' + (short ? ' · ' + short : '')}
        style={{ marginBottom: 14 }}
        right={<span className="c-3" style={{ fontSize: 11 }}>реестр эмитентов Московской биржи</span>}
      >
        {/* Чьи это цифры — до таблицы: у технической компании группы
            собственных оборотов нет, и её баланс о риске бумаги почти
            ничего не говорит. */}
        <div className="c-2" style={{ fontSize: 12, lineHeight: 1.75, marginBottom: 12 }}>
          {form
            ? <>По названию это <b>{form.label}</b>. {form.note}</>
            : <>
              Ниже — реквизиты и отчётность <b>самого юридического лица-эмитента</b>.
              Если облигации выпускала техническая компания группы (СФО, ипотечный агент),
              собственных оборотов у неё обычно нет — и тогда её цифры о риске бумаги
              почти ничего не говорят.
            </>}
        </div>

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

        {hasRequites && (
          <div className="tbl-wrap">
            <table className="tbl">
              <tbody>
                {title ? <Row k="Полное наименование" v={title} /> : null}
                {inn ? <Row k="ИНН" v={inn} mono /> : null}
                {ogrn ? <Row k="ОГРН" v={ogrn} mono /> : null}
                {okpo ? <Row k="ОКПО" v={okpo} mono /> : null}
                {country ? <Row k="Страна регистрации" v={COUNTRIES[country] || country} /> : null}
                {legalAddress ? <Row k="Юридический адрес" v={legalAddress} /> : null}
                {postalAddress ? <Row k="Почтовый адрес" v={postalAddress} /> : null}
                <Row
                  k="Сайт"
                  v={website
                    ? <a href={website} target="_blank" rel="noopener noreferrer">{website}</a>
                    : <span className="c-3">в реестре не указан</span>}
                />
                <Row
                  k="Капитализация"
                  v={<>
                    {/* Ноль у биржи значит «данных нет», а не нулевую
                        капитализацию: с ним выходило «вся группа: 0 ₽». */}
                    {emitterCapitalization > 0 ? money(emitterCapitalization) : <span className="c-3">—</span>}
                    {capitalization > 0 && capitalization !== emitterCapitalization
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
      </Panel>

      {/* ── Отчётность РСБУ ──────────────────────────────────────── */}
      <Panel
        title="Отчётность · РСБУ, ГИР БО ФНС"
        style={{ marginBottom: 14 }}
        right={girboDate
          ? <span className="c-3" style={{ fontSize: 11 }}>данные от {dateTime(girboDate)}</span>
          : null}
      >
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
                ? <span className="c-3"> Показаны {shownYears.length} лет из {years.length}.</span>
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

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          {issuerKey ? (
            <Link className="btn btn-sm btn-green" to={'/issuer/' + issuerKey}>
              Страница эмитента →
            </Link>
          ) : null}
          {girbo?.girboId ? (
            <a className="btn btn-sm" href={girboUrl(girbo.girboId)} target="_blank" rel="noopener noreferrer">
              Открыть в ГИР БО ↗
            </a>
          ) : null}
          {moexReportsUrl(emitterId) ? (
            <a className="btn btn-sm" href={moexReportsUrl(emitterId)} target="_blank" rel="noopener noreferrer">
              Отчётность на MOEX ↗
            </a>
          ) : null}
        </div>
      </Panel>

      {/* ── Поручитель и группа ──────────────────────────────────────
          Самый частый вопрос по таким выпускам — «кто отвечает, кроме
          эмитента». У bondradar.pro здесь панель «Финансы группы ·
          поручитель» с названием поручителя. Мы его не знаем: биржа
          поручителя в открытом API не отдаёт. Врать названием нельзя,
          поэтому объясняем, где он указан на самом деле. */}
      <Panel title="Поручитель и отчётность группы" style={{ marginBottom: 14 }}>
        <div className="c-2" style={{ fontSize: 12, lineHeight: 1.75 }}>
          В источниках, которые мы собираем (MOEX, ГИР БО ФНС, smart-lab), поручителя и обеспечения
          нет: биржа их в открытом API не публикует, а консолидированную отчётность группы ГИР БО
          отдаёт только по головной компании и не всегда. Поручитель и обеспечение указываются
          в решении о выпуске — оно раскрывается
          на <a href="https://www.e-disclosure.ru/" target="_blank" rel="noopener noreferrer">e-disclosure.ru</a>,
          в разделе раскрытия информации эмитента.
          {form
            ? ' Пока поручитель не проверен, читать цифры РСБУ технической компании как оценку всего выпуска нельзя.'
            : null}
        </div>
      </Panel>
    </>
  );
}
