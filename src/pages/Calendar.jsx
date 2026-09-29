/* ═══════════════════════════════════════════════════════════════════
   Календарь событий по облигациям.

   ЭТО КАЛЕНДАРЬ РЫНКА, А НЕ КАЛЕНДАРЬ ВАШИХ ВЫПЛАТ:
   показаны события по всем выпускам основного режима TQCB, независимо
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
  { id: 'prev', label: 'Прошлая неделя', from: -7, to: 0 },
];

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
  const from = addDaysISO(todayISO(), active.from);
  const to = addDaysISO(todayISO(), active.to);

  /* Строковое сравнение корректно для ISO-дат */
  const period = useMemo(
    () => events.filter(e => e.date >= from && e.date <= to),
    [events, from, to]
  );

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
          Показаны события по <b>всем</b> выпускам основного режима TQCB — независимо от того,
          есть ли бумага в вашем портфеле. По купонам доступна только <b>ближайшая</b> выплата
          каждого выпуска (поле NEXTCOUPON из витрины биржи); полное расписание купонов
          подгружается отдельно в карточке выпуска. Поэтому прошедшие купоны здесь не видны —
          вкладка «Прошлая неделя» показывает только погашения и оферты.
        </div>
      </Panel>

      {/* ── KPI ──────────────────────────────────────────────────── */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', marginBottom: 14 }}>
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

      <div className="c-3" style={{ fontSize: 11, marginTop: 10, lineHeight: 1.6 }}>
        Сумма по купону — couponValue на одну облигацию (без учёта количества в портфеле),
        поэтому «купонный поток» — это оценка рынка, а не ожидаемая выплата вам.
        Погашение и оферта показаны номиналом на одну облигацию.
      </div>
    </div>
  );
}