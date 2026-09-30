import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { duration, nf } from '../lib/format';
import { curveAt } from '../api/moex';

/* ═══════════════════════════════════════════════════════════════════
   Карта рынка «доходность × срок» — своя отрисовка на SVG.

   Почему переписана с Chart.js: точек тысячи, и в облаке из них нельзя
   ни приблизиться, ни попасть в отдельную бумагу. У оригинала карта
   сделана ровно так же — руками на SVG, с зумом колесом, панорамой
   перетаскиванием, подсказкой на наведении и подписями прямо на карте
   (разведка: app-main.js, hmDrawMap). Здесь повторено их поведение,
   размеры и порядок работы; отличается только источник данных — у нас
   он свой, из уже загруженного пула облигаций.

   Что взято у оригинала дословно:
     · холст 1120×320, отступы 44/16/14/30 — их числа;
     · зум колесом ВОКРУГ КУРСОРА (k = 0,82 наружу / 1,22 внутрь);
     · границы зума: не глубже 0,3 года по сроку и 0,5 п.п. по доходности;
       шире 8 лет или 60 п.п. — это уже сброс, а не зум;
     · панорама тянется мышью, порог 4 px: после перетаскивания клик по
       точке НЕ открывает карточку (иначе панорама превращается в переходы);
     · двойной клик — сброс, плюс отдельная кнопка «Сбросить зум»;
     · подписи бумаг — до 48 штук, от самых торгуемых, с поиском места
       справа, слева и над точкой и проверкой на наложение;
     · радиус точки 3,8 у госбумаг и 3,3 у остальных, заливка 0,7,
       белая обводка;
     · подсказка: имя, доходность, срок, премия к ОФЗ, цена и число сделок.

   Что взято от оригинала в правилах отбора (их hmRenderMap + liqOk):
     · только «простые» рублёвые выпуски: без валютных, структурных,
       линкеров, конвертируемых и флоатеров — у них доходность
       несопоставима с остальными;
     · ликвидность: оборот от 50 000 ₽ в день, и НИЧЕГО больше. Их
       правка от 24.08: число сделок не годится ни в ту, ни в другую
       сторону — у дорогих лотов сделок единицы при живом обороте, а у
       копеечных сделок много при обороте в тысячу рублей;
     · доходность от 5 до 45 % — мусорные и «дефолтные» значения не
       рисуем, а всё, что выше 45 %, — это уже Радар риска;
     · срок от 2 месяцев до 6 лет: ближе погашения — «хвосты» с
       случайной доходностью, дальше — почти ничего не торгуется.
   Границы и оставшееся число точек написаны прямо под картой, чтобы
   отбор не выглядел пропажей данных.

   Отличия, которые сделаны сознательно:
     · по горизонтали — срок до ближайшей даты возврата (оферта, если она
       раньше погашения), а не дюрация: так эта ось называлась на сайте
       и раньше, менять смысл оси молча нельзя;
     · цвета — из темы сайта, а не жёсткие #16a34a/#2563eb/#dc2626:
       в тёмной теме их зелёный и синий слепнут.
   ═══════════════════════════════════════════════════════════════════ */

const W = 1120, H = 320, PL = 44, PR = 16, PT = 14, PB = 30;
const TERM_MAX = 6;      // лет — дальше карта пустая
const TERM_MIN = 0.16;   // ≈2 месяца; ближе — «хвосты» перед погашением
const YTM_LO = 5;        // ниже — мусор и дефолтные значения
const YTM_HI = 45;       // выше — территория Радара риска
const MIN_TURNOVER = 50000;  // ₽ в день — их единственный критерий ликвидности
const LABEL_MAX = 48;
const ZOOM_IN = 0.82, ZOOM_OUT = 1.22;

/** «Простая» бумага: доходность сопоставима с остальными. */
function isSimpleBond(b) {
  if (b.isCurrencyBond) return false;
  if (/Валютн|Структурн|Линкер|Конвертир/i.test(b.bondType || '')) return false;
  return b.couponKind !== 'float' && b.couponKind !== 'struct' && b.couponKind !== 'convert';
}

/** Ликвидность: оборот от 50 000 ₽ в день (как в liqOk у оригинала). */
function isLiquidBond(b) {
  return (b.turnover || 0) >= MIN_TURNOVER;
}

/** Подходит ли бумага под правила карты (без учёта выбранной группы). */
function isMapBond(b) {
  if (b.ytm == null || b.mapTerm == null) return false;
  if (!isSimpleBond(b) || !isLiquidBond(b)) return false;
  return b.ytm > YTM_LO && b.ytm < YTM_HI && b.mapTerm >= TERM_MIN && b.mapTerm <= TERM_MAX;
}

const GROUPS_RU = { ofz: 'Гос', corp: 'Корпораты', vdo: 'ВДО' };

/* Окно зума живёт вне компонента — как mapState.view у оригинала. Причина
   та же: страница перерисовывается по мере прихода данных с биржи, и окно
   не должно слетать в авто-вид посреди работы. Сброс — двойным кликом или
   кнопкой, они на виду. */
let savedView = null;

const cssColor = (name, fallback) =>
  `var(${name}${fallback ? `, ${fallback}` : ''})`;

export default function MarketMap({ points, group, curve }) {
  const [view, setViewState] = useState(savedView);  // окно зума {x0,x1,y0,y1} или null (авто)
  const setView = useCallback(v => { savedView = v; setViewState(v); }, []);
  const [hover, setHover] = useState(null);    // { pt, cx, cy }
  const boxRef = useRef(null);
  const svgRef = useRef(null);
  const tipRef = useRef(null);
  const dragRef = useRef(null);
  const draggedRef = useRef(false);

  /* ── Отбор точек ────────────────────────────────────────────────── */
  const inRules = useMemo(() => (points || []).filter(isMapBond), [points]);
  const shown = useMemo(
    () => inRules.filter(p => group === 'all' || p.group === group),
    [inRules, group],
  );

  /* ── Домен: авто либо текущее окно зума ─────────────────────────── */
  const domain = useMemo(() => {
    if (view) return view;
    if (!shown.length) return { x0: 0, x1: TERM_MAX, y0: 0, y1: 1 };
    const ys = shown.map(p => p.ytm);
    return {
      x0: 0,
      x1: TERM_MAX,
      y0: Math.min(...ys) - 1,
      y1: Math.max(...ys) + 1,
    };
  }, [view, shown]);

  const xOf = useCallback(t => PL + (t - domain.x0) / ((domain.x1 - domain.x0) || 1) * (W - PL - PR), [domain]);
  const yOf = useCallback(v => PT + (domain.y1 - v) / ((domain.y1 - domain.y0) || 1) * (H - PT - PB), [domain]);

  const inWindow = useMemo(
    () => shown.filter(p => p.mapTerm >= domain.x0 && p.mapTerm <= domain.x1
      && p.ytm >= domain.y0 && p.ytm <= domain.y1),
    [shown, domain],
  );

  /* ── Подписи бумаг прямо на карте: от самых торгуемых, без наложений ──
     Кандидату ищем место справа, слева или над точкой; если все три
     заняты — подпись не рисуем (лучше без подписи, чем каша). */
  const labels = useMemo(() => {
    const placed = [];
    const out = [];
    const byLiq = [...inWindow].sort((a, b) => (b.turnover || 0) - (a.turnover || 0));
    for (const p of byLiq) {
      if (out.length >= LABEL_MAX) break;
      const name = (p.shortname || '').replace(/"/g, '').slice(0, 16);
      if (!name) continue;
      const wpx = 6 + name.length * 4.7;
      const hpx = 9;
      const px = xOf(p.mapTerm);
      const py = yOf(p.ytm);
      const spots = [[px + 7, py + 3], [px - 7 - wpx, py + 3], [px - wpx / 2, py - 8]];
      let spot = null;
      for (const [lx, ly] of spots) {
        if (lx < PL + 2 || lx + wpx > W - PR - 2 || ly - hpx < PT || ly > H - PB) continue;
        const clash = placed.some(b => lx < b.x + b.w && lx + wpx > b.x && ly - hpx < b.y + b.h && ly > b.y);
        if (clash) continue;
        spot = [lx, ly];
        break;
      }
      if (!spot) continue;
      placed.push({ x: spot[0], y: spot[1] - hpx, w: wpx, h: hpx + 3 });
      out.push({ key: p.isin || p.secid, name, x: spot[0], y: spot[1], group: p.group });
    }
    return out;
  }, [inWindow, xOf, yOf]);

  /* ── Сетка ──────────────────────────────────────────────────────── */
  const yTicks = useMemo(() => {
    const out = [];
    for (let i = 0; i <= 4; i++) out.push(domain.y0 + (domain.y1 - domain.y0) / 4 * i);
    return out;
  }, [domain]);
  const xTicks = useMemo(() => {
    const out = [];
    for (let i = 1; i <= 6; i++) out.push(domain.x0 + (domain.x1 - domain.x0) / 6 * i);
    return out;
  }, [domain]);

  const zoomed = view != null;

  /* ── Зум колесом вокруг курсора + панорама мышью ────────────────── */
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;

    const onWheel = e => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const { x0, x1, y0, y1 } = domain;
      const fx = ((e.clientX - rect.left) / rect.width * W - PL) / (W - PL - PR);
      const fy = ((e.clientY - rect.top) / rect.height * H - PT) / (H - PT - PB);
      const k = e.deltaY < 0 ? ZOOM_IN : ZOOM_OUT;
      const cx = x0 + fx * (x1 - x0);
      const cy = y1 - fy * (y1 - y0);
      const nx0 = cx - (cx - x0) * k;
      const nx1 = cx + (x1 - cx) * k;
      const ny0 = cy - (cy - y0) * k;
      const ny1 = cy + (y1 - cy) * k;
      /* Глубже этого зум бессмыслен: точки начнут слипаться в одну. */
      if (nx1 - nx0 < 0.3 || ny1 - ny0 < 0.5) return;
      /* Шире исходного — «отзеркалили» зум, значит возвращаем авто-вид. */
      if (nx1 - nx0 > 8 || ny1 - ny0 > 60) { setView(null); return; }
      setView({ x0: Math.max(0, nx0), x1: nx1, y0: ny0, y1: ny1 });
    };

    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
    /* Зависимость от domain: обработчик должен видеть текущее окно зума.
       Переподписка на каждом шаге зума дешевле, чем ref, который
       пришлось бы менять прямо во время отрисовки. */
  }, [domain, setView]);

  useEffect(() => {
    const onMove = e => {
      const drag = dragRef.current;
      const svg = svgRef.current;
      if (!drag || !svg) return;
      const rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const dx = (e.clientX - drag.x) / rect.width * W / (W - PL - PR) * (drag.x1 - drag.x0);
      const dy = (e.clientY - drag.y) / rect.height * H / (H - PT - PB) * (drag.y1 - drag.y0);
      if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4) draggedRef.current = true;
      if (!draggedRef.current) return;
      setView({
        x0: Math.max(0, drag.x0 - dx),
        x1: drag.x1 - dx,
        y0: drag.y0 + dy,
        y1: drag.y1 + dy,
      });
      /* Перетаскивание — жест «одним движением»: как у оригинала,
         после первого сдвига его надо начать заново. */
      dragRef.current = null;
    };
    const onUp = () => {
      dragRef.current = null;
      /* Снимаем флаг с задержкой: click приходит сразу после mouseup. */
      window.setTimeout(() => { draggedRef.current = false; }, 50);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [setView]);

  const resetView = useCallback(() => { setView(null); setHover(null); }, [setView]);

  const onMouseDown = e => {
    draggedRef.current = false;
    dragRef.current = {
      x: e.clientX, y: e.clientY,
      x0: domain.x0, x1: domain.x1, y0: domain.y0, y1: domain.y1,
    };
  };

  const idxOf = e => {
    const raw = e.target?.getAttribute?.('data-i');
    return raw == null ? null : +raw;
  };

  const onMouseMove = e => {
    const i = idxOf(e);
    if (i == null || !inWindow[i]) { if (hover) setHover(null); return; }
    const box = boxRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    setHover({ pt: inWindow[i], cx: e.clientX - rect.left, cy: e.clientY - rect.top });
  };

  const onClick = e => {
    if (draggedRef.current) return;
    const i = idxOf(e);
    if (i == null || !inWindow[i]) return;
    const pt = inWindow[i];
    if (pt.isin) location.hash = '#/bond/' + pt.isin;
  };

  /* ── Подсказка: ставим над курсором, у правого края откидываем влево ── */
  useLayoutEffect(() => {
    const el = tipRef.current;
    const box = boxRef.current;
    if (!el || !box || !hover) return;
    const bw = box.getBoundingClientRect().width;
    let left = hover.cx + 14;
    if (left + el.offsetWidth > bw - 4) left = hover.cx - el.offsetWidth - 14;
    el.style.left = Math.max(4, left) + 'px';
    el.style.top = Math.max(0, hover.cy - el.offsetHeight - 10) + 'px';
  }, [hover]);

  /* ── Состояния «пусто» ──────────────────────────────────────────── */
  if (inRules.length < 5) {
    return <div className="empty">Слишком мало бумаг под правила карты — данные биржи ещё не пришли</div>;
  }
  if (!inWindow.length) {
    return (
      <div className="empty">
        В этом окне пусто.
        {' '}
        <button type="button" className="btn" onClick={resetView}>Сбросить зум</button>
      </div>
    );
  }

  const hoverPt = hover?.pt;
  const hoverOfz = hoverPt ? curveAt(curve, hoverPt.mapTerm) : null;
  const hoverPrem = hoverPt && hoverPt.group !== 'ofz' && hoverOfz != null
    && (hoverPt.numTrades || 0) >= 5
    ? hoverPt.ytm - hoverOfz
    : null;

  return (
    <div className="mm-box" ref={boxRef}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="mm-svg"
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseLeave={() => setHover(null)}
        onClick={onClick}
        onDoubleClick={resetView}
        role="img"
        aria-label="Карта рынка: доходность облигаций по сроку"
      >
        {yTicks.map(v => (
          <g key={'y' + v.toFixed(2)}>
            <line
              x1={PL} y1={yOf(v)} x2={W - PR} y2={yOf(v)}
              style={{ stroke: cssColor('--border', '#e8e6e1') }}
            />
            <text
              x={PL - 6} y={yOf(v) + 3} textAnchor="end" fontSize="9"
              style={{ fill: cssColor('--text3', '#999') }}
            >
              {v.toFixed(0)}%
            </text>
          </g>
        ))}

        {xTicks.map(t => (
          <text
            key={'x' + t.toFixed(2)}
            x={xOf(t)} y={H - 10} textAnchor="middle" fontSize="9"
            style={{ fill: cssColor('--text3', '#999') }}
          >
            {t < 1.5 ? t.toFixed(1) : t.toFixed(domain.x1 - domain.x0 < 3 ? 1 : 0)} г.
          </text>
        ))}

        {labels.map(l => (
          <text
            key={'l' + l.key}
            className="mm-label"
            x={l.x} y={l.y}
            fontSize="8.5" fontWeight="500"
            style={{ fill: cssColor('--' + (l.group === 'ofz' ? 'green' : l.group === 'vdo' ? 'red' : 'blue')), fillOpacity: .9, pointerEvents: 'none' }}
          >
            {l.name}
          </text>
        ))}

        {inWindow.map((p, i) => {
          const isHover = hoverPt === p;
          return (
            <circle
              key={(p.isin || p.secid) + i}
              data-i={i}
              cx={xOf(p.mapTerm)}
              cy={yOf(p.ytm)}
              r={isHover ? (p.group === 'ofz' ? 5.4 : 4.8) : (p.group === 'ofz' ? 3.8 : 3.3)}
              style={{
                fill: cssColor('--' + (p.group === 'ofz' ? 'green' : p.group === 'vdo' ? 'red' : 'blue')),
                fillOpacity: .7,
                stroke: 'var(--card, #fff)',
                strokeWidth: 1,
                cursor: 'pointer',
              }}
            />
          );
        })}
      </svg>

      {hoverPt ? (
        <div className="mm-tip" ref={tipRef}>
          <b>{hoverPt.shortname}</b><br />
          YTM: <b>{nf(hoverPt.ytm, 2)}%</b> · {duration(hoverPt.durationDays)}<br />
          {hoverPrem != null
            ? <>премия к ОФЗ: <b>{hoverPrem >= 0 ? '+' : ''}{nf(hoverPrem, 1)} пп</b><br /></>
            : null}
          цена {nf(hoverPt.price, 1)}% · сделок {hoverPt.numTrades ?? '—'}
        </div>
      ) : null}

      <div className="mm-foot">
        <span className="c-3" style={{ fontSize: 10.5 }}>
          Показано {inWindow.length} из {inRules.length} выпусков
          {group !== 'all' ? ` (группа: ${GROUPS_RU[group]})` : ''}.
          {' '}Правила: рублёвые выпуски без валютных, структурных и флоатеров,
          {' '}оборот от 50 000 ₽ в день, срок от 2 месяцев до 6 лет,
          {' '}доходность 5–45 %.
        </span>
        <span className="c-3" style={{ fontSize: 10.5 }}>
          Колёсико — зум вокруг курсора, перетаскивание — панорама, двойной клик — сброс.
          {' '}Клик по точке открывает карточку выпуска.
        </span>
        {zoomed ? (
          <button type="button" className="btn" onClick={resetView}>Сбросить зум</button>
        ) : null}
      </div>
    </div>
  );
}
