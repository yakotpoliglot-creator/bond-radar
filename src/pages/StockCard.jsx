import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import Chart from 'chart.js/auto';
import { fetchStocks, fetchStockHistory } from '../api/moex';
import { Panel, Kpi, Loading, ErrorBox } from '../components/ui';
import { nf, money, dateShort, chgStrA, chgPill, ytmTone } from '../lib/format';

/* ═══════════════════════════════════════════════════════════════════
   Карточка акции — /stock/{SECID}

   Раньше со страницы «Акции Мосбиржи» клик по бумаге не вёл никуда:
   строки были обычным текстом, и открывать было нечего. Здесь то,
   что биржа реально отдаёт по конкретной акции.

   Чего здесь СОЗНАТЕЛЬНО нет:
     • дивидендов и дивидендной доходности — MOEX ISS не публикует
       дивидендную историю в открытом API (проверено: у эндпоинта
       /iss/securities/{SECID}/dividends.json блока dividends нет,
       он отдаёт только описание бумаги и список режимов торгов);
     • «разбора отчётности» — это редакционный текст, а не данные.

   Не подставляем сюда цифры из головы ради заполненности экрана.
   ═══════════════════════════════════════════════════════════════════ */

/** Тема меняется атрибутом на <html> — следим, чтобы перерисовать график. */
function useTheme() {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme || 'light');
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => setTheme(el.dataset.theme || 'light'));
    obs.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return theme;
}

/** Цвета берём из CSS-переменных темы, а не хардкодом. */
function palette() {
  const s = getComputedStyle(document.documentElement);
  const v = n => s.getPropertyValue(n).trim();
  return {
    grid: v('--border'),
    text3: v('--text3'),
    text2: v('--text2'),
    green: v('--green'),
    red: v('--red'),
    blue: v('--blue'),
    card: v('--card'),
  };
}

export default function StockCard() {
  const { secid } = useParams();
  const theme = useTheme();

  const [stock, setStock] = useState(null);
  const [history, setHistory] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const canvasRef = useRef(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);

    (async () => {
      /* Список акций уже грузится одной пачкой — берём из него нужную
         строку, чтобы не дёргать биржу отдельным запросом. Историю
         цен тянем отдельно: она есть только по конкретной бумаге. */
      const [all, hist] = await Promise.all([
        fetchStocks().catch(() => null),
        fetchStockHistory(secid).catch(() => null),
      ]);
      if (!alive) return;

      const found = (all || []).find(s => s.secid === secid) || null;
      if (!found && !(hist && hist.length)) {
        setError(new Error(`Бумага «${secid}» не найдена в режиме TQBR.`));
        setLoading(false);
        return;
      }
      setStock(found);
      setHistory(hist && hist.length ? hist : null);
      setLoading(false);
    })();

    return () => { alive = false; };
  }, [secid]);

  /* ── График цены за полгода ────────────────────────────────────── */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !history) return;

    const p = palette();
    const rows = history.slice(-130);
    const rising = rows.length > 1 && rows[rows.length - 1].close >= rows[0].close;

    const chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: rows.map(r => r.date),
        datasets: [{
          label: 'Цена, ₽',
          data: rows.map(r => r.close),
          borderColor: rising ? p.green : p.red,
          backgroundColor: (rising ? p.green : p.red) + '22',
          borderWidth: 2,
          pointRadius: 0,
          pointHitRadius: 8,
          fill: true,
          tension: 0.25,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 260 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: items => dateShort(rows[items[0].dataIndex]?.date) || '',
              label: ctx => {
                const r = rows[ctx.dataIndex];
                const out = [`Цена: ${nf(ctx.parsed.y, 2)} ₽`];
                if (r?.value != null) out.push(`Оборот: ${money(r.value)}`);
                if (r?.numTrades != null) out.push(`Сделок: ${nf(r.numTrades, 0)}`);
                return out;
              },
            },
          },
        },
        scales: {
          x: {
            grid: { color: p.grid, drawTicks: false },
            border: { color: p.grid },
            ticks: {
              color: p.text3,
              font: { size: 10 },
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 7,
              callback(value) {
                const label = this.getLabelForValue(value);
                return label ? dateShort(label) : '';
              },
            },
          },
          y: {
            position: 'right',
            grid: { color: p.grid, drawTicks: false },
            border: { display: false },
            ticks: { color: p.text3, font: { size: 10 }, maxTicksLimit: 6 },
          },
        },
      },
    });

    return () => chart.destroy();
  }, [history, theme]);

  const range = useMemo(() => {
    if (!history || !history.length) return null;
    const lows = history.map(r => r.low).filter(v => v != null);
    const highs = history.map(r => r.high).filter(v => v != null);
    if (!lows.length || !highs.length) return null;
    return { low: Math.min(...lows), high: Math.max(...highs) };
  }, [history]);

  if (loading) return <Loading text={`Загрузка карточки ${secid}…`} />;
  if (error) return <ErrorBox error={error} />;

  const name = stock?.name || stock?.shortname || secid;
  const price = stock?.price ?? (history?.length ? history[history.length - 1].close : null);

  /* Название эмитента для поиска в скринере. Биржа даёт «ВТБ ао»,
     «Сбер ао», «ГАЗПРОМ ао» — отбрасываем пометку типа акции, остаётся
     тот же корень, по которому называются и облигации эмитента
     («ВТБ С1-733», «Сбер Sb51R»). Это поиск по подстроке, поэтому
     точное юридическое имя здесь только навредило бы. */
  const issuerToken = String(stock?.shortname || stock?.name || '')
    .replace(/\s+(ао|ап|ao|ap)\.?$/i, '')
    .trim();

  return (
    <div>
      {/* ── Шапка ─────────────────────────────────────────────────── */}
      <div className="page-h">
        <div className="page-t">{name}</div>
        <div className="page-s">
          <span className="mono">{secid}</span>
          {stock?.isin ? <> · ISIN <span className="mono">{stock.isin}</span></> : null}
          {stock?.isPreferred ? ' · привилегированная' : ' · обыкновенная'}
          {stock?.listLevel ? ` · ${stock.listLevel} уровень листинга` : ''}
        </div>
        <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link className="btn btn-sm" to="/stocks">← Все акции</Link>
          <a className="btn btn-sm" href={`https://www.moex.com/ru/issue.aspx?code=${secid}`}
            target="_blank" rel="noopener noreferrer">Карточка на MOEX ↗</a>
          {/* Здесь раньше стояла кнопка «Скринер облигаций» — просто ссылка
              на /screener без единого параметра. Она ничего не находила и
              только уводила со страницы. Вместо неё — переход с уже
              подставленным эмитентом, то есть то, ради чего в скринер
              вообще идут с карточки акции. */}
          {issuerToken && (
            <Link className="btn btn-sm" to={'/screener?q=' + encodeURIComponent(issuerToken)}>
              Облигации «{issuerToken}» в скринере
            </Link>
          )}
        </div>
      </div>

      {/* ── Сводка ────────────────────────────────────────────────── */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginBottom: 14 }}>
        <Kpi
          label="Цена"
          value={price == null ? '—' : nf(price, 2) + ' ₽'}
          sub={stock?.change == null ? 'изменение за день недоступно' : null}
          cls=""
        />
        <Kpi
          label="Изменение за день"
          value={stock?.change == null ? '—' : chgStrA(stock.change)}
          sub="к предыдущему закрытию"
          cls={stock?.change == null ? '' : stock.change > 0 ? 'c-g' : stock.change < 0 ? 'c-r' : ''}
        />
        <Kpi label="Открытие" value={stock?.open == null ? '—' : nf(stock.open, 2) + ' ₽'} sub="цена первой сделки" />
        <Kpi label="Минимум" value={stock?.low == null ? '—' : nf(stock.low, 2) + ' ₽'} sub="за торговый день" />
        <Kpi label="Максимум" value={stock?.high == null ? '—' : nf(stock.high, 2) + ' ₽'} sub="за торговый день" />
        <Kpi label="Оборот за день" value={stock?.turnover == null ? '—' : money(stock.turnover)} sub={
          stock?.numTrades == null ? 'сделок нет данных' : `${nf(stock.numTrades, 0)} сделок`
        } />
        <Kpi
          label="Капитализация"
          value={stock?.capitalization == null ? '—' : money(stock.capitalization)}
          sub={stock?.issuesize == null ? 'бумаг в выпуске нет данных' : `${nf(stock.issuesize, 0)} бумаг`}
        />
        {range && (
          <Kpi
            label="Диапазон за полгода"
            value={`${nf(range.low, 2)} — ${nf(range.high, 2)}`}
            sub="минимум и максимум цены"
          />
        )}
      </div>

      {/* ── График ────────────────────────────────────────────────── */}
      <Panel title="Цена за последние полгода" style={{ marginBottom: 14 }}
        right={<span className="c-3" style={{ fontSize: 11 }}>источник — история торгов MOEX</span>}>
        {history ? (
          <div style={{ height: 280 }}>
            <canvas ref={canvasRef} />
          </div>
        ) : (
          <div className="empty">История торгов по этой бумаге недоступна.</div>
        )}
      </Panel>

      {/* ── Честно о том, чего нет ────────────────────────────────── */}
      <Panel title="Чего здесь нет">
        <div className="c-2" style={{ fontSize: 11.5, lineHeight: 1.7 }}>
          <b>Дивидендов и дивидендной доходности здесь нет.</b> Московская биржа не публикует
          дивидендную историю в открытом API — мы это проверяли отдельно: у соответствующего
          адреса ISS блока с дивидендами просто не существует, он отдаёт только описание бумаги
          и список режимов торгов. Разбор отчётности эмитента — это редакционный текст, и
          придумывать его мы не станем.
          {' '}Всё, что на этой странице показано, взято из торговых данных биржи: цена,
          изменение, оборот, капитализация и история сделок.
        </div>
      </Panel>

      {/* ── Подсказка по соседним разделам ────────────────────────── */}
      <Panel title="Дальше" style={{ marginTop: 14 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link className="btn btn-sm" to="/issuers">Все эмитенты облигаций</Link>
          {issuerToken && (
            <Link className="btn btn-sm" to={'/screener?q=' + encodeURIComponent(issuerToken)}>
              Облигации «{issuerToken}» в скринере
            </Link>
          )}
        </div>
        <div className="c-3" style={{ fontSize: 11, marginTop: 10, lineHeight: 1.6 }}>
          Ссылка на скринер открывает его с уже подставленным названием эмитента в поле
          поиска — сравнивать выпуски по доходности, дюрации и цене удобнее там. Если в выдаче
          пусто, значит облигаций этого эмитента на Московской бирже сейчас нет: биржа
          называет выпуски иначе, чем акции, и поиск идёт по подстроке.
        </div>
      </Panel>
    </div>
  );
}
