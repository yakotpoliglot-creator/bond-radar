import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import Chart from 'chart.js/auto';
import {
  fetchBonds,
  fetchYieldCurve,
  fetchIndexHistory,
  fetchIndexValues,
  fetchStocks,
  fetchTickerCurrencies,
  TICKER_FX,
  KEY_RATE,
  KEY_RATE_HISTORY,
} from '../api/moex';
import { Kpi, Panel, Loading, ErrorBox, BondTable } from '../components/ui';
import { IndexCard, RatesNow, TopByYtm } from '../components/market';
import MarketMap from '../components/MarketMap';
import { nf, dateShort, chgStrA, chgClass } from '../lib/format';

/* ── Бегущая строка рынка ──────────────────────────────────────────
   Приём с bondradar.pro, повторённый по ИХ КОДУ (app-main.js), а не по
   догадке — разведка целиком в scripts/probe*.mjs и в журнале.

   Состав — ровно их TICKER_CONFIG: четыре индекса и четыре акции,
   закреплённые поимённо (Сбер, Т-Техно, Роснефть, Лукойл). В журнале
   было записано «три акции» — в оригинале их четыре, и IMOEX в ленте
   тоже есть; проверено выгрузкой их конфига.

   Валюты у оригинала стоят отдельным блоком слева и не бегут. На узком
   экране (<720px) блок скрыт, а курсы встают в начало ленты — их
   brNarrow720() и mobFx.concat(...). Здесь сделано так же.

   Движение — Web Animations API по transform, 32 px/с, с сохранением
   фазы. Почему не @keyframes и не пауза при наведении: оригинал прошёл
   этот путь и вернулся — их комментарии в коде перечисляют четыре
   захода на CSS-анимации (браузер вправе её придушить или заморозить, и
   об этом даже не узнаешь), заход на покадровый rAF в главном потоке
   (дёргался, пока страница разбирала 750 КБ биржевого JSON) и паузу по
   наведению (на тач-устройствах :hover залипает после тапа — строка
   вставала навсегда). Итог у них: композиторная анимация, копий ровно
   столько, чтобы закрыть экран, фаза переносится при обновлении цен, и
   сторож раз в 2,5 с перезапускает ленту, если позиция перестала
   меняться. Всё это повторено ниже. */
const TK_SPEED = 32;       // пикселей в секунду — та же скорость, что у оригинала
const TK_FLAT = 0.05;      // порог «плоско» в ленте: ниже него стрелки нет (их же порог)
const TK_FX_FLAT = 0.01;   // у валют порог мельче: курс ЦБ меняется в сотые доли
const TK_WATCH_MS = 2500;  // как часто сторож проверяет, что лента едет
const TK_MOBILE_PX = 720;  // на этом и уже — валюты уезжают в ленту, как у оригинала

/* Диагностика ленты: с «?tkdebug=1» в заголовке вкладки видно реальный
   сдвиг ленты и число копий. Нужна затем, чтобы утверждение «лента едет»
   проверялось фактом, а не на глаз (у оригинала для этого флаг _tkRaf). */
const TK_DEBUG = typeof location !== 'undefined' && /[?&]tkdebug=1/.test(location.search);

const TICKER_INDEXES = [
  { secid: 'IMOEX', label: 'IMOEX' },
  /* В бегущей строке у оригинала стоят ДРУГИЕ индексы, чем в блоках ниже:
     «Корп» — это RUCBICP (CBICP, 92,21), а не RUCBCPNS (99,59), который
     показан отдельным блоком «Индекс корпоративных облигаций». Сверено
     выгрузкой всех 868 индексов Мосбиржи: RUCBICP = 92,21 и
     RUCBHYCP = 68,10 совпали со строкой оригинала до копейки. */
  { secid: 'RGBI', label: 'RGBI' },
  { secid: 'RUCBICP', label: 'Корп' },
  { secid: 'RUCBHYCP', label: 'ВДО' },
];

/* Четыре акции оригинала — их TICKER_CONFIG: SBER, T (у них подписано
   «Т-Техно»), ROSN, LKOH. Именно закреплённые, а не «пятёрка по обороту»:
   состав ленты не должен меняться от дня к дню, иначе числа не с чем
   сравнивать. Т-Техно на бирже торгуется под кодом T. */
const TICKER_STOCKS = [
  { secid: 'SBER', label: 'Сбер' },
  { secid: 'T', label: 'Т-Техно' },
  { secid: 'ROSN', label: 'Роснефть' },
  { secid: 'LKOH', label: 'Лукойл' },
];

/** Изменение в ленте: «▲ +1,06 %» / «▼ −0,38 %» / «−0,04 %» без стрелки.
    Порог и вид стрелки у оригинала разные для ленты и для блока валют:
    в ленте ▲/▼ и порог 0,05 п.п., у валют ↑/↓ и порог 0,01 — у курса ЦБ
    изменение обычно в сотые доли процента, и там стрелка нужна. */
function tkChg(pct, { flat = TK_FLAT, arrows = ['▲', '▼'] } = {}) {
  if (pct == null || Number.isNaN(+pct)) return { cls: '', arrow: '', text: '' };
  const v = +pct;
  const cls = v > flat ? 'tk-up' : v < -flat ? 'tk-dn' : 'tk-flat';
  const arrow = v > flat ? arrows[0] : v < -flat ? arrows[1] : '';
  return { cls, arrow, text: (v >= 0 ? '+' : '') + nf(v, 2) + '%' };
}

/** Узкий ли экран. Тот же порог, что у оригинала (их brNarrow720). */
function useNarrow(px) {
  const query = `(max-width: ${px}px)`;
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia(query).matches,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(query);
    const onChange = e => setNarrow(e.matches);
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else mq.removeListener(onChange);
    };
  }, [query]);

  return narrow;
}

/* ── Движок ленты: сколько копий везти и как ───────────────────────
   Возвращает число копий набора, которые надо отрисовать. Вся логика —
   повтор их tkNeededCopies / tkMeasure / tkEngineStart / сторожа. */
function useTickerEngine(innerRef, viewRef, sig, count) {
  const [copies, setCopies] = useState(1);
  const halfRef = useRef(0);
  const animRef = useRef(null);

  /* Мерка одного набора и расчёт копий.
     Копий должно хватать, чтобы ЗАКРЫТЬ экран в самой дальней точке
     цикла: набор + ширина видимой ленты. Двух копий не хватало на
     широких мониторах — справа оставалась пустая чёрная полоса (их
     замер: набор 1479 px на экране 2560 оставлял 618 px пустоты). */
  const measure = useCallback(() => {
    const el = innerRef.current;
    const view = viewRef.current;
    if (!el || !view) return 0;
    const n = copies > 0 ? copies : 1;
    const setW = el.scrollWidth / n;
    const stripW = view.getBoundingClientRect().width;
    if (!(setW > 0) || !(stripW > 0)) return 0;
    const need = Math.max(2, Math.ceil((setW + stripW) / setW));
    if (need !== copies) { setCopies(need); return 0; }  // перерисуем и измерим заново
    return setW;
  }, [copies, innerRef, viewRef]);

  /* Запуск движения. Фазу переносим: если цены обновились и ширина
     набора изменилась, лента продолжает с того же места, а не прыгает
     в начало (их же приём — prev.currentTime). */
  const start = useCallback(() => {
    const el = innerRef.current;
    if (!el || typeof el.animate !== 'function') return;
    const setW = measure();
    if (!setW) return;
    halfRef.current = setW;
    const dur = (setW / TK_SPEED) * 1000;
    const prev = typeof el.getAnimations === 'function' ? el.getAnimations()[0] : null;
    const phase = prev ? (prev.currentTime || 0) : 0;
    if (prev) prev.cancel();
    el.style.transform = '';
    const anim = el.animate(
      [{ transform: 'translate3d(0,0,0)' }, { transform: `translate3d(${-setW}px,0,0)` }],
      { duration: dur, iterations: Infinity, easing: 'linear' },
    );
    if (phase) anim.currentTime = phase % dur;
    animRef.current = anim;
  }, [measure, innerRef]);

  useEffect(() => {
    const el = innerRef.current;
    if (!el || !count) return undefined;

    start();

    /* Возврат из фона и из bfcache: браузер вправе остановить анимацию,
       и это нормально — просто запускаем заново. */
    const onVis = () => { if (!document.hidden) start(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pageshow', start);
    window.addEventListener('focus', start);

    /* Сторож позиции: смотрим РЕАЛЬНЫЙ сдвиг, а не состояние анимации.
       Не сдвинулась дважды подряд — перезапускаем. Так лечится любая
       причина остановки, и не нужно каждый раз выяснять, кто заморозил. */
    let lastX = null;
    let slow = 0;
    const watch = setInterval(() => {
      if (document.hidden) return;
      const x = el.getBoundingClientRect().left;
      if (TK_DEBUG) {
        document.title = `tk ${x.toFixed(1)}px · копий ${copies} · набор ${Math.round(halfRef.current)}px`;
      }
      if (lastX != null && Math.abs(x - lastX) < 0.5) {
        slow += 1;
        if (slow >= 2) { slow = 0; lastX = null; start(); return; }
      } else {
        slow = 0;
      }
      lastX = x;
    }, TK_WATCH_MS);

    window.addEventListener('resize', start);

    /* Ширины ячеек меняются сами: подгрузился шрифт, обновились цены.
       Тогда набор стал другой длины — пересобираем анимацию, фазу храним. */
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => start());
      ro.observe(el);
    }

    return () => {
      clearInterval(watch);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pageshow', start);
      window.removeEventListener('focus', start);
      window.removeEventListener('resize', start);
      if (ro) ro.disconnect();
      const a = animRef.current;
      if (a) a.cancel();
      animRef.current = null;
    };
  }, [sig, count, copies, start, innerRef]);

  return copies;
}

function MarketTicker({ rates, stocks, fx }) {
  const isMobile = useNarrow(TK_MOBILE_PX);
  const innerRef = useRef(null);
  const viewRef = useRef(null);

  const items = useMemo(() => {
    const out = [];
    for (const t of TICKER_INDEXES) {
      const r = rates?.[t.secid];
      if (r?.value != null) {
        out.push({ key: t.secid, name: t.label, val: nf(r.value, r.decimals ?? 2), pct: r.changePct });
      }
    }
    /* Цена и изменение акции — та же пара, что и в таблицах: LAST и
       LASTTOPREVPRICE. Если сделок сегодня не было, изменения нет, и
       лента честно показывает «—», а не ноль. */
    for (const t of TICKER_STOCKS) {
      const s = (stocks || []).find(x => x.secid === t.secid);
      if (s?.price != null) {
        out.push({ key: t.secid, name: t.label, val: nf(s.price, 2) + ' ₽', pct: s.change });
      }
    }
    return out;
  }, [rates, stocks]);

  const fxItems = useMemo(() => TICKER_FX
    .map(f => {
      const r = fx?.[f.code];
      if (!r || r.value == null) return null;
      return {
        key: 'fx-' + f.code,
        name: `${f.symbol} ${f.code}`,
        val: nf(r.value, 2) + ' ₽',
        pct: r.changePct,
        src: r.sourceLabel,
        date: r.date,
      };
    })
    .filter(Boolean), [fx]);

  /* На узком экране статичный блок валют скрыт, а курсы встают в начало
     ленты — как у оригинала на мобиле. */
  const cells = useMemo(
    () => (isMobile ? [...fxItems, ...items] : items),
    [isMobile, fxItems, items],
  );

  const sig = useMemo(() => cells.map(c => c.key).join('|'), [cells]);
  const copies = useTickerEngine(innerRef, viewRef, sig, cells.length);

  if (!cells.length) return null;

  const fxTitle = fxItems
    .map(f => `${f.name} ${f.val} ${f.src || ''} ${f.date || ''}`.trim())
    .join(' · ');

  return (
    <div className="tk-strip" role="region" aria-label="Котировки рынка">
      {!isMobile && fxItems.length ? (
        <div className="tk-fx" title={fxTitle}>
          {fxItems.map(f => {
            const c = tkChg(f.pct, { flat: TK_FX_FLAT, arrows: ['↑', '↓'] });
            return (
              <div className="tk-fx-item" key={f.key}>
                <div className="tk-fx-lbl">{f.name}</div>
                <div className="tk-fx-rate">{f.val}</div>
                <div className={'tk-fx-chg ' + c.cls}>{c.arrow} {c.text}</div>
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="tk-view" ref={viewRef}>
        <div className="tk-inner" ref={innerRef}>
          {Array.from({ length: copies }, (_, copy) => cells.map(cell => {
            const c = tkChg(cell.pct);
            return (
              <div className="tk-item" key={copy + '|' + cell.key} aria-hidden={copy > 0 ? 'true' : undefined}>
                <span className="tk-name">{cell.name}</span>
                <span className="tk-val">{cell.val}</span>
                {c.text ? <span className={'tk-chg ' + c.cls}>{c.arrow} {c.text}</span> : null}
              </div>
            );
          }))}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   Главная страница — дашборд рынка облигаций (аналог bondradar.pro)

   Состав:
     1. KPI-строка: ключевая ставка, RGBI, индекс корпоратов, число выпусков
     2. Кривая доходности ОФЗ (линия, ось X — срок в годах)
     3. История индекса RGBI (~120 дней)
     4. Карта рынка «доходность × срок» (SVG: зум, панорама, клик → карточка)
     5. Топ-10 выпусков по обороту (BondTable)
   ═══════════════════════════════════════════════════════════════════ */

/* ── Группы точек на карте рынка ─────────────────────────────────── */
const GROUP_CHIPS = [
  ['all', 'Все'],
  ['ofz', 'Гос'],
  ['corp', 'Корпораты'],
  ['vdo', 'ВДО'],
];

/* ── Цвета темы: читаем CSS-переменные в момент построения графика ── */
function cssVar(name, fallback = '#888888') {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

function palette() {
  return {
    text: cssVar('--text', '#111111'),
    text2: cssVar('--text2', '#555555'),
    text3: cssVar('--text3', '#999999'),
    grid: cssVar('--border', '#e8e6e1'),
    surface: cssVar('--surface', '#ffffff'),
    blue: cssVar('--blue', '#1d4ed8'),
    green: cssVar('--green', '#15803d'),
    red: cssVar('--red', '#dc2626'),
    amber: cssVar('--amber', '#b45309'),
    purple: cssVar('--purple', '#7c3aed'),
  };
}

/* Название активной темы; перерисовывает графики при переключении. */
function useThemeName() {
  const [theme, setTheme] = useState(
    () => (typeof document !== 'undefined' && document.documentElement.dataset.theme) || 'light',
  );

  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => setTheme(el.dataset.theme || 'light'));
    obs.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  return theme;
}

/* ── Оформление осей/подсказок, общее для всех графиков ──────────── */
function baseOptions(p, { yTitle, xTitle } = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 260 },
    interaction: { mode: 'nearest', intersect: false },
    plugins: {
      legend: {
        display: true,
        position: 'top',
        align: 'end',
        labels: { color: p.text2, boxWidth: 10, boxHeight: 10, usePointStyle: true, font: { size: 10 } },
      },
      tooltip: {
        backgroundColor: p.surface,
        titleColor: p.text,
        bodyColor: p.text2,
        borderColor: p.grid,
        borderWidth: 1,
        padding: 8,
        displayColors: false,
        titleFont: { size: 11 },
        bodyFont: { size: 11 },
      },
    },
    scales: {
      x: {
        type: 'linear',
        title: xTitle ? { display: true, text: xTitle, color: p.text3, font: { size: 10 } } : undefined,
        grid: { color: p.grid, drawTicks: false },
        border: { color: p.grid },
        ticks: { color: p.text3, font: { size: 10 }, maxRotation: 0, autoSkipPadding: 12 },
      },
      y: {
        title: yTitle ? { display: true, text: yTitle, color: p.text3, font: { size: 10 } } : undefined,
        grid: { color: p.grid, drawTicks: false },
        border: { color: p.grid },
        ticks: { color: p.text3, font: { size: 10 } },
      },
    },
  };
}

/* Обёртка canvas: Chart.js с maintainAspectRatio:false требует высоту. */
function ChartBox({ height = 250, children }) {
  return <div style={{ position: 'relative', height }}>{children}</div>;
}

/* ── Срок до даты в годах (может быть отрицательным) ─────────────── */
function yearsTo(dateStr) {
  if (!dateStr || dateStr === '0000-00-00') return null;
  const t = new Date(dateStr + 'T00:00:00').getTime();
  if (Number.isNaN(t)) return null;
  return (t - Date.now()) / (365.25 * 86400000);
}

/* Срок до погашения, но если оферта раньше — срок до оферты. */
function horizonYears(b) {
  const mat = yearsTo(b.matDate);
  if (mat == null) return null;
  const offer = yearsTo(b.offerDate);
  if (offer != null && offer > 0 && offer < mat) return offer;
  return mat;
}

/* Классификация выпуска для карты рынка. */
function groupOf(b) {
  const isOfz = /^ОФЗ|^SU\d/.test(b.shortname || '') || /федерального займа/i.test(b.bondType || '');
  if (isOfz) return 'ofz';
  if (b.ytm != null && b.ytm >= 20 && b.listLevel === 3) return 'vdo';
  return 'corp';
}

/* Индекс корпоративных облигаций.
   В истории MOEX доступны суффиксные версии: RUCBCPNS (ценовой, аналог RGBI)
   и RUCBTRNS (полной доходности). Базовые RUCBTR/RUCBITR историю не отдают. */
async function loadCorpIndex() {
  for (const secid of ['RUCBCPNS', 'RUCBTRNS']) {
    const rows = await fetchIndexHistory(secid).catch(() => null);
    if (rows && rows.length) return { secid, rows };
  }
  return null;
}

export default function Home() {
  const theme = useThemeName();

  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState(null);
  const [bonds, setBonds] = useState(null);
  const [curve, setCurve] = useState(null);
  const [rgbi, setRgbi] = useState(null);
  const [corp, setCorp] = useState(null);
  const [rates, setRates] = useState(null);
  const [stocks, setStocks] = useState(null);
  const [fx, setFx] = useState(null);
  const [group, setGroup] = useState('all');

  const curveCanvas = useRef(null);
  const rgbiCanvas = useRef(null);

  /* ── Загрузка: всё параллельно, каждая часть изолирована ────────── */
  const load = useCallback(async () => {
    setLoading(true);
    setFatal(null);

    const [c, r, ci, b, rt, st, fxr] = await Promise.all([
      fetchYieldCurve().catch(() => null),
      fetchIndexHistory('RGBI').catch(() => null),
      loadCorpIndex().catch(() => null),
      fetchBonds().catch(() => null),
      fetchIndexValues().catch(() => null),
      fetchStocks().catch(() => null),
      /* Курс ЦБ для полосы валют. Падение этого запроса фатальным не
         считается: лента индексов и акций живёт и без курса. */
      fetchTickerCurrencies().catch(() => null),
    ]);

    setCurve(c && c.length ? c : null);
    setRgbi(r && r.length ? r : null);
    setCorp(ci);
    setBonds(b && b.length ? b : null);
    setRates(rt);
    setStocks(st && st.length ? st : null);
    setFx(fxr);

    // Фатально, только если не пришло вообще ничего — иначе показываем
    // рабочие блоки, а упавшие панели помечаем как недоступные.
    if (!c?.length && !r?.length && !b?.length && !ci) {
      setFatal('Московская биржа не ответила ни на один запрос. Проверьте соединение.');
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  /* ── Производные значения для KPI ───────────────────────────────── */
  const rgbiLast = rgbi && rgbi.length ? rgbi[rgbi.length - 1] : null;
  const rgbiPrev = rgbi && rgbi.length > 1 ? rgbi[rgbi.length - 2] : null;
  const rgbiChange = rgbiLast && rgbiPrev && rgbiLast.close != null && rgbiPrev.close
    ? ((rgbiLast.close - rgbiPrev.close) / rgbiPrev.close) * 100
    : null;

  const corpLast = corp && corp.rows.length ? corp.rows[corp.rows.length - 1] : null;

  const keyRateDate = KEY_RATE_HISTORY[KEY_RATE_HISTORY.length - 1][0];

  /* Ключевая ставка приходит живым индексом KEYRATE с Московской биржи.
     Зашитая константа остаётся только запасным вариантом на случай,
     если биржа этот индекс не отдаст. */
  const liveRate = rates?.KEYRATE?.value ?? KEY_RATE;
  const liveRateDate = rates?.KEYRATE?.date || keyRateDate;

  /* ── Топ-10 по обороту для таблицы ──────────────────────────────── */
  const topTurnover = useMemo(() => {
    if (!bonds) return [];
    return [...bonds].sort((a, b) => (b.turnover || 0) - (a.turnover || 0)).slice(0, 10);
  }, [bonds]);

  /* ── Точки карты рынка ────────────────────────────────────────────
     Отбор по правилам, подписи и вся возня с зумом живут в
     components/MarketMap.jsx. Здесь — только подготовка данных: срок до
     ближайшей даты возврата и поля, нужные карте для правил и подсказки. */
  const scatterPoints = useMemo(() => {
    if (!bonds) return [];
    const out = [];
    for (const b of bonds) {
      if (b.ytm == null || !b.matDate) continue;
      const mapTerm = horizonYears(b);
      if (mapTerm == null || mapTerm < 0 || mapTerm > 30) continue;
      out.push({
        isin: b.isin,
        secid: b.secid,
        shortname: b.shortname,
        group: groupOf(b),
        listLevel: b.listLevel,
        turnover: b.turnover || 0,
        ytm: b.ytm,
        mapTerm,
        price: b.price,
        numTrades: b.numTrades,
        durationDays: b.durationDays,
        couponKind: b.couponKind,
        bondType: b.bondType,
        isCurrencyBond: b.isCurrencyBond,
      });
    }
    return out;
  }, [bonds]);

  /* ═══════════════ График 1: кривая доходности ОФЗ ════════════════ */
  useEffect(() => {
    const canvas = curveCanvas.current;
    if (!canvas || !curve) return;

    const p = palette();
    const opts = baseOptions(p, { yTitle: 'Доходность, %', xTitle: 'Срок, лет' });
    opts.plugins.legend.display = false;
    opts.plugins.tooltip.callbacks = {
      title: items => `${nf(items[0].parsed.x, 2)} лет`,
      label: ctx => `Доходность: ${nf(ctx.parsed.y, 2)}%`,
    };
    opts.scales.x.ticks.callback = v => `${v}`;

    const values = curve.map(d => d.value);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const showKeyRate = liveRate >= lo - 2 && liveRate <= hi + 2;

    const datasets = [{
      label: 'Кривая ОФЗ',
      data: curve.map(d => ({ x: d.period, y: d.value })),
      borderColor: p.blue,
      backgroundColor: p.blue,
      borderWidth: 2,
      pointRadius: 3,
      pointHoverRadius: 5,
      tension: 0.25,
      fill: false,
    }];

    // Порог ключевой ставки — горизонтальная штриховая линия.
    if (showKeyRate) {
      const xs = curve.map(d => d.period);
      datasets.push({
        label: `Ключевая ставка ${nf(liveRate, 2)}%`,
        data: [{ x: Math.min(...xs), y: liveRate }, { x: Math.max(...xs), y: liveRate }],
        borderColor: p.red,
        borderWidth: 1.5,
        borderDash: [6, 4],
        pointRadius: 0,
        pointHitRadius: 0,
        fill: false,
      });
      opts.plugins.legend.display = true;
    }

    const chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { datasets },
      options: opts,
    });

    return () => chart.destroy();
  }, [curve, theme]);

  /* ═══════════════ График 2: индекс RGBI ═════════════════════════ */
  useEffect(() => {
    const canvas = rgbiCanvas.current;
    if (!canvas || !rgbi) return;

    const p = palette();
    const rows = rgbi.slice(-120);
    const opts = baseOptions(p, { yTitle: 'Пункты', xTitle: undefined });
    opts.plugins.legend.display = false;
    opts.interaction = { mode: 'index', intersect: false };
    opts.plugins.tooltip.callbacks = {
      title: items => dateShort(rows[items[0].dataIndex]?.date) || '',
      label: ctx => {
        const r = rows[ctx.dataIndex];
        const parts = [`RGBI: ${nf(ctx.parsed.y, 2)}`];
        if (r?.yield != null) parts.push(`доходность: ${nf(r.yield, 2)}%`);
        if (r?.duration != null) parts.push(`дюрация: ${nf(r.duration, 2)} г.`);
        return parts;
      },
    };
    // Ось X — категориальная по датам (линейный тип тут не нужен).
    opts.scales.x = {
      grid: { color: p.grid, drawTicks: false },
      border: { color: p.grid },
      ticks: {
        color: p.text3,
        font: { size: 10 },
        maxRotation: 0,
        autoSkip: true,
        maxTicksLimit: 8,
        callback(value) {
          const label = this.getLabelForValue(value);
          return label ? dateShort(label) : '';
        },
      },
    };
    opts.scales.y.ticks.callback = v => nf(v, 0);

    const chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: rows.map(r => r.date),
        datasets: [{
          label: 'RGBI',
          data: rows.map(r => r.close),
          borderColor: p.green,
          backgroundColor: 'transparent',
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.2,
          spanGaps: true,
          fill: false,
        }],
      },
      options: opts,
    });

    return () => chart.destroy();
  }, [rgbi, theme]);

  /* Карты рынка здесь больше нет: она переехала в components/MarketMap.jsx
     и рисуется на SVG. Chart.js не умеет ни зум вокруг курсора, ни подписи
     бумаг на облаке точек — а именно этого карте и не хватало. */

  /* ── Группы для таблиц «топ по доходности» ─────────────────────── *
   * Регионы отличаем по формату регистрационного номера (RU + 5 цифр
   * + 3 буквы + 1 цифра) — это не эвристика по названию, а строгий
   * государственный формат. Корпораты — всё остальное, что не ОФЗ.
   */
  const govBonds = useMemo(
    () => (bonds || []).filter(b => b.isOfz || b.isSubfederal),
    [bonds],
  );
  const corpBonds = useMemo(
    () => (bonds || []).filter(b => !b.isOfz && !b.isSubfederal),
    [bonds],
  );
  const fixBonds = useMemo(
    () => corpBonds.filter(b => b.couponKind === 'fix'),
    [corpBonds],
  );
  const floatBonds = useMemo(
    () => corpBonds.filter(b => b.couponKind === 'float'),
    [corpBonds],
  );

  /* ── Состояния загрузки/ошибки ──────────────────────────────────── */
  if (loading) {
    return (
      <div>
        <div className="page-h">
          <div className="page-t">Обзор рынка облигаций</div>
          <div className="page-s">Загрузка данных Московской биржи…</div>
        </div>
        <Loading />
      </div>
    );
  }

  if (fatal) {
    return (
      <div>
        <div className="page-h">
          <div className="page-t">Обзор рынка облигаций</div>
          <div className="page-s">Данные MOEX ISS недоступны</div>
        </div>
        <ErrorBox error={fatal} onRetry={load} />
      </div>
    );
  }

  const kpiGrid = {
    display: 'grid',
    gap: 12,
    gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
    marginBottom: 12,
  };

  const chartGrid = {
    display: 'grid',
    gap: 12,
    gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))',
    marginBottom: 12,
  };

  /* ── Три группы для таблиц «топ по доходности» ─────────────────── */
  const tableGrid = {
    display: 'grid',
    gap: 12,
    gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
    marginBottom: 12,
  };

  return (
    <div>
      {/* ── Заголовок ─────────────────────────────────────────────── */}
      <div className="page-h" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div className="page-t">Обзор рынка облигаций</div>
          <div className="page-s">
            Ключевая ставка {nf(liveRate, 2)}% · {bonds ? nf(bonds.length, 0) : '—'} выпусков в базе · данные MOEX ISS
          </div>
        </div>
        <button className="btn" onClick={load}>Обновить</button>
      </div>

      {/* ── Бегущая строка рынка ──────────────────────────────────── */}
      <MarketTicker rates={rates} stocks={stocks} fx={fx} />

      {/* ── 1. KPI ────────────────────────────────────────────────── */}
      <div style={kpiGrid}>
        <Kpi
          label="Ключевая ставка ЦБ"
          value={nf(liveRate, 2) + '%'}
          sub={(rates?.KEYRATE?.value != null ? 'MOEX, ' : 'с ') + dateShort(liveRateDate)}
        />
        <Kpi
          label="Индекс RGBI"
          value={rgbiLast?.close != null ? nf(rgbiLast.close, 2) : '—'}
          sub={rgbiLast
            ? `${dateShort(rgbiLast.date)} · ${chgStrA(rgbiChange)}`
            : 'история недоступна'}
          cls={rgbiChange == null ? '' : chgClass(rgbiChange)}
        />
        <Kpi
          label="Индекс корпоративных облигаций"
          value={corpLast?.close != null ? nf(corpLast.close, 2) : '—'}
          sub={corp
            ? `${corp.secid} · ${dateShort(corpLast?.date)}`
            : 'история недоступна'}
        />
        <Kpi
          label="Выпусков в базе"
          value={bonds ? nf(bonds.length, 0) : '—'}
          sub={topTurnover.length ? `лидер оборота: ${topTurnover[0].shortname}` : 'TQCB + TQOB'}
        />
      </div>

      {/* ── 2 и 3. Кривая ОФЗ + RGBI ──────────────────────────────── */}
      <div style={chartGrid}>
        <Panel
          title="Кривая доходности ОФЗ"
          right={<span className="c-3" style={{ fontSize: 10.5 }}>срок в годах → доходность, %</span>}
        >
          {curve
            ? <ChartBox height={250}><canvas ref={curveCanvas} /></ChartBox>
            : <div className="empty">Кривая доходности недоступна</div>}
        </Panel>

        <Panel
          title="Индекс гособлигаций RGBI"
          right={<span className="c-3" style={{ fontSize: 10.5 }}>последние {rgbi ? Math.min(rgbi.length, 120) : 0} дней</span>}
        >
          {rgbi
            ? <ChartBox height={250}><canvas ref={rgbiCanvas} /></ChartBox>
            : <div className="empty">История RGBI недоступна</div>}
        </Panel>
      </div>

      {/* ── 4. Где сейчас доходность + индекс корпоратов ──────────── */}
      <div style={chartGrid}>
        <RatesNow rates={rates} curve={curve} bonds={bonds} />
        <IndexCard
          secid="RUCBCPNS"
          title="Индекс корпоративных облигаций"
          note="MOEX · полная доходность"
        />
      </div>

      {/* ── 5. Топ выпусков: ОФЗ и регионы, корпораты ─────────────── */}
      <div style={tableGrid}>
        <TopByYtm
          title="Гособлигации: ОФЗ и регионы"
          bonds={govBonds}
          note="топ по доходности"
          empty="Гособлигации не найдены"
        />
        <TopByYtm
          title="Корпораты · фикс"
          bonds={fixBonds}
          note="топ по доходности"
          empty="Нет выпусков с фиксированным купоном"
        />
        <TopByYtm
          title="Корпораты · флоатеры"
          bonds={floatBonds}
          note="топ по доходности"
          empty="Нет выпусков с плавающим купоном"
        />
      </div>

      {/* ── Легенда к цвету доходности ────────────────────────────────
          Без неё цвет читается как оценка «хорошо/плохо», а это не так:
          это шкала доходности. Поясняем прямо под таблицами. */}
      <div className="legend">
        <span className="legend-t">Цвет доходности</span>
        <span className="legend-i"><i className="c-g" />до 18%</span>
        <span className="legend-i"><i className="c-a" />18–24%</span>
        <span className="legend-i"><i className="c-r" />от 24%</span>
        <span className="legend-n">
          шкала доходности, а не оценка надёжности: выше доходность — выше и риск, который за неё платят
        </span>
      </div>

      {/* ── 6. Карта рынка ────────────────────────────────────────── */}
      <Panel
        title="Карта рынка: доходность × срок"
        style={{ marginBottom: 12 }}
        right={
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {GROUP_CHIPS.map(([key, label]) => (
              <button
                key={key}
                className={'chip' + (group === key ? ' on' : '')}
                onClick={() => setGroup(key)}
              >
                {label}
              </button>
            ))}
          </div>
        }
      >
        {/* Карта — своя отрисовка на SVG (components/MarketMap.jsx):
            зум колесом, панорама, подсказка и клик по отдельной точке. */}
        <MarketMap points={scatterPoints} group={group} curve={curve} />
      </Panel>

      {/* ── 5. Популярные выпуски ─────────────────────────────────── */}
      <Panel
        title="Популярные выпуски"
        pad={false}
        right={<span className="c-3" style={{ fontSize: 10.5 }}>10 самых ликвидных по обороту</span>}
      >
        {topTurnover.length
          ? <BondTable bonds={topTurnover} limit={10} initialSort="turnover" />
          : <div className="empty">Данные по оборотам недоступны</div>}
      </Panel>
    </div>
  );
}