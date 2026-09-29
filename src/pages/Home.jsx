import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import Chart from 'chart.js/auto';
import {
  fetchBonds,
  fetchYieldCurve,
  fetchIndexHistory,
  KEY_RATE,
  KEY_RATE_HISTORY,
} from '../api/moex';
import { Kpi, Panel, Loading, ErrorBox, BondTable } from '../components/ui';
import { nf, dateShort, chgStr, chgClass } from '../lib/format';

/* ═══════════════════════════════════════════════════════════════════
   Главная страница — дашборд рынка облигаций (аналог bondradar.pro)

   Состав:
     1. KPI-строка: ключевая ставка, RGBI, индекс корпоратов, число выпусков
     2. Кривая доходности ОФЗ (линия, ось X — срок в годах)
     3. История индекса RGBI (~120 дней)
     4. Карта рынка «доходность × срок» (scatter, клик → карточка выпуска)
     5. Топ-10 выпусков по обороту (BondTable)
   ═══════════════════════════════════════════════════════════════════ */

/* ── Группы точек на карте рынка ─────────────────────────────────── */
const GROUPS = {
  ofz: { label: 'ОФЗ', colorVar: '--blue' },
  corp: { label: 'Корпораты', colorVar: '--green' },
  vdo: { label: 'ВДО', colorVar: '--red' },
};

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

/* Индекс корпоративных облигаций: RUCBTR, при пустом ответе — MICEXCBITR. */
async function loadCorpIndex() {
  for (const secid of ['RUCBTR', 'MICEXCBITR']) {
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
  const [group, setGroup] = useState('all');

  const curveCanvas = useRef(null);
  const rgbiCanvas = useRef(null);
  const scatterCanvas = useRef(null);

  /* ── Загрузка: всё параллельно, каждая часть изолирована ────────── */
  const load = useCallback(async () => {
    setLoading(true);
    setFatal(null);

    const [c, r, ci, b] = await Promise.all([
      fetchYieldCurve().catch(() => null),
      fetchIndexHistory('RGBI').catch(() => null),
      loadCorpIndex().catch(() => null),
      fetchBonds().catch(() => null),
    ]);

    setCurve(c && c.length ? c : null);
    setRgbi(r && r.length ? r : null);
    setCorp(ci);
    setBonds(b && b.length ? b : null);

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

  /* ── Топ-10 по обороту для таблицы ──────────────────────────────── */
  const topTurnover = useMemo(() => {
    if (!bonds) return [];
    return [...bonds].sort((a, b) => (b.turnover || 0) - (a.turnover || 0)).slice(0, 10);
  }, [bonds]);

  /* ── Точки карты рынка ──────────────────────────────────────────── */
  const scatterPoints = useMemo(() => {
    if (!bonds) return [];
    const out = [];
    for (const b of bonds) {
      if (b.ytm == null || !b.matDate) continue;
      const x = horizonYears(b);
      if (x == null || x < 0 || x > 30) continue;
      out.push({
        x,
        y: b.ytm,
        isin: b.isin,
        secid: b.secid,
        shortname: b.shortname,
        group: groupOf(b),
        listLevel: b.listLevel,
        turnover: b.turnover || 0,
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
    const showKeyRate = KEY_RATE >= lo - 2 && KEY_RATE <= hi + 2;

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
        label: `Ключевая ставка ${nf(KEY_RATE, 2)}%`,
        data: [{ x: Math.min(...xs), y: KEY_RATE }, { x: Math.max(...xs), y: KEY_RATE }],
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

  /* ═══════════════ График 3: карта рынка (scatter) ════════════════ */
  useEffect(() => {
    const canvas = scatterCanvas.current;
    if (!canvas) return;

    const p = palette();
    const visible = scatterPoints.filter(pt => group === 'all' || pt.group === group);
    // Пустая выборка — график не строим (иначе Chart.js рисует пустую ось).
    if (!visible.length) return;
    const keys = Object.keys(GROUPS).filter(k => visible.some(pt => pt.group === k));

    const opts = baseOptions(p, { yTitle: 'Доходность, %', xTitle: 'Срок, лет' });
    opts.interaction = { mode: 'nearest', intersect: true };
    opts.plugins.legend.display = true;
    opts.plugins.tooltip.callbacks = {
      title: items => visible.filter(pt => pt.group === keys[items[0].datasetIndex])[items[0].dataIndex]?.shortname || '',
      label: ctx => {
        const pt = visible.filter(x => x.group === keys[ctx.datasetIndex])[ctx.dataIndex];
        if (!pt) return '';
        return [
          `${pt.isin}`,
          `Доходность: ${nf(pt.y, 2)}%`,
          `Срок: ${nf(pt.x, 2)} лет`,
          `Листинг: ${pt.listLevel ?? '—'}`,
        ];
      },
    };
    opts.scales.x.min = 0;
    opts.scales.x.max = 30;
    opts.scales.x.ticks.stepSize = 2;
    opts.scales.y.ticks.callback = v => `${v}%`;
    // Курсор-указатель над точкой.
    opts.onHover = (evt, elements) => {
      evt.native.target.style.cursor = elements.length ? 'pointer' : 'default';
    };
    // Клик по точке → карточка выпуска.
    opts.onClick = (evt, elements, chart) => {
      const hit = chart.getElementsAtEventForMode(evt, 'nearest', { intersect: true }, true);
      const el = hit.length ? hit[0] : elements[0];
      if (!el) return;
      const pt = visible.filter(x => x.group === keys[el.datasetIndex])[el.index];
      if (pt?.isin) location.hash = '#/bond/' + pt.isin;
    };

    const datasets = keys.map(k => {
      const pts = visible.filter(pt => pt.group === k);
      const color = cssVar(GROUPS[k].colorVar, p.text2);
      return {
        label: `${GROUPS[k].label} (${pts.length})`,
        data: pts,
        backgroundColor: color,
        borderColor: color,
        pointRadius: 2.6,
        pointHoverRadius: 5,
        showLine: false,
      };
    });

    const chart = new Chart(canvas.getContext('2d'), {
      type: 'scatter',
      data: { datasets },
      options: opts,
    });

    return () => chart.destroy();
  }, [scatterPoints, group, theme]);

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

  return (
    <div>
      {/* ── Заголовок ─────────────────────────────────────────────── */}
      <div className="page-h" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div className="page-t">Обзор рынка облигаций</div>
          <div className="page-s">
            Ключевая ставка {nf(KEY_RATE, 2)}% · {bonds ? nf(bonds.length, 0) : '—'} выпусков в базе · данные MOEX ISS
          </div>
        </div>
        <button className="btn" onClick={load}>Обновить</button>
      </div>

      {/* ── 1. KPI ────────────────────────────────────────────────── */}
      <div style={kpiGrid}>
        <Kpi
          label="Ключевая ставка ЦБ"
          value={nf(KEY_RATE, 2) + '%'}
          sub={'с ' + dateShort(keyRateDate)}
        />
        <Kpi
          label="Индекс RGBI"
          value={rgbiLast?.close != null ? nf(rgbiLast.close, 2) : '—'}
          sub={rgbiLast
            ? `${dateShort(rgbiLast.date)} · ${chgStr(rgbiChange)}`
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
          sub={topTurnover.length ? `лидер оборота: ${topTurnover[0].shortname}` : 'основной режим TQCB'}
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

      {/* ── 4. Карта рынка ────────────────────────────────────────── */}
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
        {scatterPoints.filter(pt => group === 'all' || pt.group === group).length
          ? (
            <>
              <ChartBox height={380}><canvas ref={scatterCanvas} /></ChartBox>
              <div className="c-3" style={{ fontSize: 11, marginTop: 8 }}>
                Каждая точка — выпуск: правее — длиннее срок, выше — больше доходность.
                Клик по точке открывает карточку выпуска. Показано {scatterPoints.filter(pt => group === 'all' || pt.group === group).length} из {scatterPoints.length}.
              </div>
            </>
          )
          : <div className="empty">В выбранной группе нет выпусков с рассчитанной доходностью и сроком</div>}
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