/* ═══════════════════════════════════════════════════════════════════
   Календарь событий по облигациям.

   ЭТО КАЛЕНДАРЬ РЫНКА, А НЕ КАЛЕНДАРЬ ВАШИХ ВЫПЛАТ:
   показаны события по всем выпускам MOEX (TQCB и TQOB), независимо
   от того, есть ли бумага у вас в портфеле.

   Источник данных — один запрос fetchBonds():
     · nextCoupon (NEXTCOUPON)  → ближайший купон выпуска
     · matDate    (MATDATE)     → погашение
     · offerDate  (OFFERDATE)   → оферта (досрочный выкуп)

   fetchBondCard() намеренно НЕ вызывается: полное расписание купонов
   потребовало бы отдельного запроса на каждую из ~3000 бумаг.
   Обратная сторона: прошедшие купоны в данных биржи недоступны —
   вкладка «Прошлая неделя» показывает только погашения и оферты.
   ═══════════════════════════════════════════════════════════════════ */
import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { fetchBonds } from '../api/moex';
import { Panel, Kpi, Loading, ErrorBox, LevelTag } from '../components/ui';
import { nf, money, dateShort, timeLeft, ytmClass } from '../lib/format';

/* ── работа с датами в формате YYYY-MM-DD (локально, без UTC-сдвигов) ── */
function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function todayISO() { return iso(new Date()); }
function addDaysISO(base, n) {
  const d = new Date(base + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return iso(d);
}

/* ── вкладки-периоды ─────────────────────────────────────────────── */
const TABS = [
  { id: 'next', label: 'Будущая неделя', from: 0, to: 7 },
  { id: 'month', label: 'Ближайший месяц', from: 0, to: 30 },
  /* Год задан календарным, а не «через N дней»: папа спрашивал именно
     «погашения-оферты 2026 года», и ответ должен быть про год, а не про
     окно в 365 дней от сегодняшнего числа. */
  { id: 'y2026', label: 'Погашения и оферты 2026', year: 2026 },
  { id: 'prev', label: 'Прошлая неделя', from: -7, to: 0 },
];

const MONTHS = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];
/** «2026-05» → «май 2026» */
function monthName(key) {
  const [y, m] = key.split('-');
  return `${MONTHS[Number(m) - 1] || m} ${y}`;
}

/** Объём выпуска в рублях: номинал × количество бумаг. Это весь выпуск,
    а не чья-то позиция — позиции считаются в портфеле. */
function issueVolume(bond) {
  const size = Number(bond?.issuesize);
  const face = Number(bond?.faceValue);
  if (!Number.isFinite(size) || !Number.isFinite(face) || size <= 0 || face <= 0) return null;
  return size * face;
}

const TYPE_LABEL = { coupon: 'Купон', mat: 'Погашение', offer: 'Оферта' };
const TYPE_TAG = { coupon: 'b', mat: 'g', offer: 'a' };

/* Максимум строк на вкладку — «месяц» может дать сотни событий */
const MAX_ROWS = 400;

export default function CalendarPage() {
  const [bonds, setBonds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('next');

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true); setError(null);
    try { setBonds(await fetchBonds()); }
    catch (e) { setError(e); }
    finally { setLoading(false); }
  }

  /* Собираем три типа событий из уже загруженного списка бумаг */
  const events = useMemo(() => {
    const out = [];
    for (const b of bonds) {
      if (b.nextCoupon) {
        out.push({ key: b.secid + '|c', date: b.nextCoupon, type: 'coupon', bond: b, amount: b.couponValue, amountLabel: 'купон' });
      }
      if (b.matDate) {
        out.push({ key: b.secid + '|m', date: b.matDate, type: 'mat', bond: b, amount: b.faceValue, amountLabel: 'номинал' });
      }
      if (b.offerDate) {
        out.push({ key: b.secid + '|o', date: b.offerDate, type: 'offer', bond: b, amount: b.faceValue, amountLabel: 'номинал' });
      }
    }
    return out.sort((a, b) =>
      a.date.localeCompare(b.date) || (a.bond.shortname || '').localeCompare(b.bond.shortname || '', 'ru')
    );
  }, [bonds]);

  const active = TABS.find(t => t.id === tab) || TABS[0];
  const yearMode = Boolean(active.year);
  const today = todayISO();
  const from = yearMode ? `${active.year}-01-01` : addDaysISO(today, active.from);
  const to = yearMode ? `${active.year}-12-31` : addDaysISO(today, active.to);

  /* Строковое сравнение корректно для ISO-дат.

     В режиме года купоны не берём вовсе: в витрине биржи есть только
     ближайший купон каждого выпуска, и «купонный поток за год» по таким
     данным был бы выдумкой — полное расписание грузится по одной бумаге
     в её карточке. Поэтому вкладка года честно про погашения и оферты. */
  const period = useMemo(() => {
    const arr = events.filter(e => e.date >= from && e.date <= to);
    return yearMode ? arr.filter(e => e.type !== 'coupon') : arr;
  }, [events, from, to, yearMode]);

  /* Сводка по месяцам: сколько гасится и на какую сумму — это и есть
     ответ на «столько погашений». */
  const months = useMemo(() => {
    if (!yearMode) return [];
    const m = new Map();
    for (const e of period) {
      const key = e.date.slice(0, 7);
      if (!m.has(key)) m.set(key, { key, mat: 0, offer: 0, volume: 0, unknown: 0 });
      const x = m.get(key);
      if (e.type === 'mat') x.mat++; else x.offer++;
      const v = issueVolume(e.bond);
      if (v == null) x.unknown++; else x.volume += v;
    }
    return [...m.values()].sort((a, b) => a.key.localeCompare(b.key));
  }, [period, yearMode]);

  const matEvents = useMemo(() => period.filter(e => e.type === 'mat'), [period]);
  const offerEvents = useMemo(() => period.filter(e => e.type === 'offer'), [period]);
  const ahead = useMemo(() => period.filter(e => e.date >= today), [period, today]);
  const matVolume = useMemo(() => matEvents.reduce((a, e) => a + (issueVolume(e.bond) || 0), 0), [matEvents]);
  const volUnknown = useMemo(() => matEvents.filter(e => issueVolume(e.bond) == null).length, [matEvents]);

  const couponEvents = period.filter(e => e.type === 'coupon');
  /* Купонный поток считаем по ОДНОЙ облигации каждого выпуска */
  const couponFlow = couponEvents.reduce((a, e) => a + (e.amount || 0), 0);
  const hasUnknownCoupon = couponEvents.some(e => e.amount == null);

  const shown = period.slice(0, MAX_ROWS);

  if (loading) return <Loading text="Загрузка событий с Московской биржи…" />;
  if (error) return <ErrorBox error={error} onRetry={load} />;

  return (
    <div>
      <div className="page-h">
        <div className="page-t">▤ Календарь событий</div>
        <div className="page-s">
          Купоны, погашения и оферты по {nf(bonds.length, 0)} выпускам Мосбиржи ·
          это календарь рынка, а не ваши личные выплаты
        </div>
      </div>

      {/* ── Честная оговорка о данных ────────────────────────────── */}
      <Panel style={{ marginBottom: 14 }}>
        <div className="c-2" style={{ fontSize: 11.5, lineHeight: 1.7 }}>
          Показаны события по <b>всем</b> выпускам облигаций MOEX (TQCB и TQOB) — независимо от того,
          есть ли бумага в вашем портфеле. По купонам доступна только <b>ближайшая</b> выплата
          каждого выпуска (поле NEXTCOUPON из витрины биржи); полное расписание купонов
          подгружается отдельно в карточке выпуска. Поэтому прошедшие купоны здесь не видны —
          вкладка «Прошлая неделя» показывает только погашения и оферты.
        </div>
      </Panel>

      {/* ── KPI ──────────────────────────────────────────────────── */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', marginBottom: 14 }}>
        {yearMode ? (
          <>
            <Kpi label="Погашений за год" value={nf(matEvents.length, 0)} sub="выпусков гасится по номиналу" />
            <Kpi label="Оферт за год" value={nf(offerEvents.length, 0)} sub="эмитент может выкупить бумагу" />
            <Kpi
              label="Объём гасящихся выпусков"
              value={money(matVolume)}
              sub={'номинал × число бумаг' + (volUnknown ? ` · по ${nf(volUnknown, 0)} объёма нет` : '')}
            />
            <Kpi
              label="Ещё впереди"
              value={nf(ahead.length, 0)}
              sub={`из ${nf(period.length, 0)} событий · сегодня ${dateShort(today)}`}
            />
          </>
        ) : (
          <>
            <Kpi
              label={'Событий: ' + active.label.toLowerCase()}
              value={nf(period.length, 0)}
              sub={`период ${dateShort(from)} — ${dateShort(to)}`}
            />
            <Kpi label="Купонов в периоде" value={nf(couponEvents.length, 0)} sub="выплат по выпускам" />
            <Kpi
              label="Купонный поток"
              value={money(couponFlow)}
              sub={'по 1 облигации каждого выпуска' + (hasUnknownCoupon ? ' · часть сумм н/д' : '')}
            />
            <Kpi
              label="Ближайшее событие"
              value={period.length ? dateShort(period[0].date) : '—'}
              sub={period.length ? period[0].bond.shortname + ' · ' + TYPE_LABEL[period[0].type].toLowerCase() : 'нет событий'}
            />
          </>
        )}
      </div>

      {/* ── Переключатель периодов ───────────────────────────────── */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {TABS.map(t => (
          <button
            key={t.id}
            className={'chip' + (t.id === tab ? ' on' : '')}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
        <span className="c-3" style={{ alignSelf: 'center', fontSize: 11.5 }}>
          период: {dateShort(from)} — {dateShort(to)}
        </span>
      </div>

      {/* ── Помесячная сводка: только для вкладки года ────────────── */}
      {yearMode && months.length > 0 && (
        <Panel title="По месяцам" pad={false} style={{ marginBottom: 14 }}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Месяц</th>
                  <th>Погашений</th>
                  <th>Оферт</th>
                  <th>Объём гасящихся выпусков</th>
                </tr>
              </thead>
              <tbody>
                {months.map(m => (
                  <tr key={m.key} style={{ cursor: 'default' }}>
                    <td style={{ fontWeight: 600 }}>{monthName(m.key)}</td>
                    <td className="mono">{m.mat ? nf(m.mat, 0) : <span className="c-3">—</span>}</td>
                    <td className="mono">{m.offer ? nf(m.offer, 0) : <span className="c-3">—</span>}</td>
                    <td className="mono">
                      {m.volume ? money(m.volume) : <span className="c-3">нет данных</span>}
                      {m.unknown > 0 && (
                        <span className="c-3" style={{ fontSize: 10, marginLeft: 6 }}>
                          без объёма: {nf(m.unknown, 0)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
                <tr style={{ cursor: 'default' }}>
                  <td style={{ fontWeight: 600 }}>Всего за год</td>
                  <td className="mono">{nf(matEvents.length, 0)}</td>
                  <td className="mono">{nf(offerEvents.length, 0)}</td>
                  <td className="mono">{money(matVolume)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="c-3" style={{ fontSize: 11, padding: '8px 12px', lineHeight: 1.6 }}>
            Объём — это весь выпуск (номинал × число бумаг), а не чья-то позиция: сколько именно вернётся вам,
            считается в «Моём портфеле». Оферта и погашение — разные вещи, и ниже написано, чем именно.
          </div>
        </Panel>
      )}

      <Panel title={'События: ' + active.label.toLowerCase()} pad={false}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Дата</th>
                <th>Выпуск</th>
                <th>Тип события</th>
                <th>Сумма на 1 облигацию</th>
                <th>Доходность</th>
                <th>Лист.</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(e => (
                <tr key={e.key}>
                  <td>
                    <div className="mono">{dateShort(e.date)}</div>
                    <div className="c-3" style={{ fontSize: 10 }}>{timeLeft(e.date)}</div>
                  </td>
                  <td>
                    <Link to={'/bond/' + e.bond.isin} style={{ fontWeight: 600 }}>{e.bond.shortname}</Link>
                    <div className="mono c-3" style={{ fontSize: 10 }}>{e.bond.isin}</div>
                  </td>
                  <td><span className={'tag ' + (TYPE_TAG[e.type] || '')}>{TYPE_LABEL[e.type]}</span></td>
                  <td className="mono">
                    {e.amount == null
                      ? <span className="c-3">—</span>
                      : nf(e.amount, 2) + ' ₽'}
                    {e.type === 'coupon' && e.bond.couponPercent != null && (
                      <span className="c-3" style={{ fontSize: 10, marginLeft: 5 }}>
                        {nf(e.bond.couponPercent, 2)}%
                      </span>
                    )}
                  </td>
                  <td>
                    {e.bond.ytm == null
                      ? <span className="c-3">—</span>
                      : <span className={ytmClass(e.bond.ytm)}>{nf(e.bond.ytm, 2)}%</span>}
                  </td>
                  <td><LevelTag level={e.bond.listLevel} /></td>
                </tr>
              ))}
              {!shown.length && (
                <tr>
                  <td colSpan={6} className="empty">
                    <div style={{ marginBottom: 6 }}>В этом периоде событий нет</div>
                    {tab === 'prev' && (
                      <div style={{ fontSize: 11.5 }}>
                        Прошедшие купоны в витрине биржи отсутствуют —
                        сюда попадают только погашения и оферты с прошедшей датой.
                      </div>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {period.length > shown.length && (
          <div className="empty" style={{ padding: '14px' }}>
            Показаны первые {shown.length} из {period.length} событий периода.
          </div>
        )}
      </Panel>

      {/* ── Как читать эти даты: только для вкладки года ──────────── */}
      {yearMode && (
        <Panel title="Как читать даты погашения и оферты" style={{ marginTop: 14 }}>
          <div className="c-2" style={{ fontSize: 11.5, lineHeight: 1.8 }}>
            <b>Погашение</b> — день, когда эмитент обязан вернуть номинал. Возвращает он его{' '}
            <b>по номиналу</b>, а не по цене на рынке: если бумага торгуется за 95 % от номинала,
            при погашении вернётся 100 %. Плюс последний купон.
            <br />
            <b>Оферта</b> — это право, а не обязанность, причём у обеих сторон. Эмитент выкупает бумагу
            по объявленной цене (обычно 100 % номинала), но вы можете её и не предъявлять. Если не
            предъявить, выпуск живёт дальше — и купон по нему может стать другим: у флоатеров он
            привязан к ключевой ставке, у остальных эмитент устанавливает новый на следующий период.
            <br />
            <b>Доходность к оферте и к погашению — разные числа.</b> Если бумага стоит ниже номинала,
            к близкой оферте доходность выше, чем к далёкому погашению: те же деньги возвращаются
            раньше. Поэтому в карточке выпуска подписано, к какой именно дате посчитана доходность.
            <br />
            <b>Налог.</b> НДФЛ 13 % берётся и с купона, и с разницы между ценой покупки и номиналом
            при погашении. Удерживает брокер сам — при погашении деньги приходят уже за вычетом налога.
            <br />
            <b>Риск реинвестирования.</b> Когда бумага гасится, деньги возвращаются, и их нужно куда-то
            деть. Если ставки к тому времени упали, вложить их под ту же доходность не получится. Это
            не «плюс» и не «минус» — это факт, который стоит держать в голове рядом с датой.
            <br />
            <b>Чего здесь нет.</b> Частичных погашений (амортизации): биржа даёт одну дату окончания, а
            у амортизируемых выпусков деньги приходят частями раньше — расписание частей есть только
            в эмиссионных документах. И прошедших дат: бумага, которая уже погасилась, уходит из
            торгового списка биржи, поэтому вкладка года получается календарём того, что ещё предстоит,
            а не полной историей года. И это календарь рынка: сколько вернётся именно вам, считается
            в «Моём портфеле».
            <br />
            <span className="c-3">
              Мы показываем, что и когда происходит. Стоит ли избавляться от бумаги до этой даты, —
              не наш вопрос и не наш ответ: это зависит от ваших планов, а не от календаря.
            </span>
          </div>
        </Panel>
      )}

      <div className="c-3" style={{ fontSize: 11, marginTop: 10, lineHeight: 1.6 }}>
        Сумма по купону — couponValue на одну облигацию (без учёта количества в портфеле),
        поэтому «купонный поток» — это оценка рынка, а не ожидаемая выплата вам.
        Погашение и оферта показаны номиналом на одну облигацию.
      </div>
    </div>
  );
}