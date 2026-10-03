import { useMemo, useState } from 'react';
import { Panel } from './ui';
import { nf } from '../lib/format';

/* ═══════════════════════════════════════════════════════════════════
   Калькулятор доходности акции — с дивидендами

   Заказчик просил «маленький процентный калькулятор, который считает
   изменения» и спросил, можно ли добавить дивиденды. Вот он: вводишь
   цену покупки, количество и год — получаешь, что вышло в рублях и в
   процентах, вместе с уже начисленными дивидендами.

   Дивиденды берём из той же таблицы, что ниже в карточке: это уже
   начисленные выплаты, а не предположение о будущих. Поэтому итог —
   «сколько вышло бы», а не «сколько выйдет»: цена покупки человек
   вводит сам, и задним числом её никто не знает.

   ЧЕГО ФОРМУЛА НЕ ОБЕЩАЕТ
     • Срок владения считаем с НАЧАЛА года покупки: точного дня мы не
       знаем, а придумывать его нельзя.
     • Годовую доходность считаем простым делением на срок, без
       реинвестирования дивидендов. Сложный процент дал бы больше, но
       он зависит от того, куда и когда вложены выплаты, — этого в
       данных нет.
     • Налог не вычитаем: 13 % с дивидендов и с прибыли от продажи
       зависят от срока владения и от других сделок за год.
     • Дивиденды за год получает тот, кто купил ДО даты отсечки, а она
       бывает раньше конца года. Поэтому по умолчанию выплату года
       покупки не считаем — на это есть отдельная галочка.
   ═══════════════════════════════════════════════════════════════════ */

/* Год берём один раз при загрузке модуля: new Date() не является чистой
   функцией, и вызывать её в теле компонента нельзя (правило чистоты
   React) — на этом уже спотыкались в помощнике yearsUntil. */
const TODAY = new Date();
const THIS_YEAR = TODAY.getFullYear();

/**
 * Русское склонение после числа: 1 год, 2 года, 5 лет.
 *
 * Нужно отдельной функцией, потому что «за 5 годов» — это то, что
 * получается из наивного «год + ов», и в карточке это выглядело ошибкой.
 * Отдельно обрабатываем 11–14: «11 лет», а не «11 год».
 */
function plural(n, one, few, many) {
  const abs = Math.abs(n) % 100;
  if (abs >= 11 && abs <= 14) return many;
  const last = abs % 10;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

export default function StockReturnCalculator({ price, div }) {
  /* Ссылку на объект не пересоздаём: `div?.perShare || {}` давал бы новый
     объект на каждом рендере, и useMemo пересчитывался бы всегда —
     сборщик это отметил замечанием «зависимость меняется каждый рендер». */
  const perShare = div?.perShare;

  /* Годы с настоящей выплатой. Ноль в данных — это «не платили»: у X5
     так помечены 2021–2023 годы, когда дивидендов не было вовсе.
     Показывать такой ноль как выплату в ноль рублей значит придумывать
     событие, которого не было. */
  const years = useMemo(() => {
    const ps = perShare || {};
    return Object.keys(ps).map(Number).filter(y => ps[y] > 0).sort((a, b) => a - b);
  }, [perShare]);

  /* Годы для выбора — СПЛОШНЫМ отрезком до нынешнего, а не только те, за
     которые есть выплата. Раньше список строился из лет с дивидендом, и
     2026 год выбрать было нельзя вовсе — просто потому, что дивиденд за
     него ещё не начислен. Но купить акцию можно в любой год, и посчитать
     «а если купить сейчас» — первое, что приходит в голову. Годы без
     выплат в списке тоже есть: выбрав такой, видишь нулевые дивиденды —
     это ответ, а не отсутствие ответа.

     По умолчанию ставим НЫНЕШНИЙ год — тот же, к которому относится
     предзаполненная цена: «купил сегодня по текущей цене». Это
     единственный сценарий, который не выдуман: поставить сегодняшнюю
     цену в 2017 год значило бы показать расчёт покупки по цене,
     которой тогда не было. */
  const firstPaidYear = years.length ? years[0] : THIS_YEAR;
  const yearOptions = useMemo(() => {
    const out = [];
    for (let y = THIS_YEAR; y >= firstPaidYear; y--) out.push(y);
    return out;
  }, [firstPaidYear]);

  const [buyPrice, setBuyPrice] = useState(() => (price != null ? String(Math.round(price * 100) / 100) : ''));
  const [qty, setQty] = useState('1');
  const [buyYear, setBuyYear] = useState(THIS_YEAR);
  const [withBuyYear, setWithBuyYear] = useState(false);

  /* С какого года считаем дивиденды. По умолчанию — со следующего за годом
     покупки: выплату за год получает тот, кто купил до даты отсечки, а она
     бывает раньше конца года. Галочка «успел получить» включает и год
     покупки. */
  const divFrom = withBuyYear ? buyYear : buyYear + 1;

  const calc = useMemo(() => {
    const buy = +String(buyPrice).replace(/\s/g, '').replace(',', '.');
    const n = +String(qty).replace(/\s/g, '').replace(',', '.');
    if (!Number.isFinite(buy) || buy <= 0) return null;
    if (!Number.isFinite(n) || n <= 0) return null;

    const invested = buy * n;
    const nowValue = price != null ? price * n : null;

    const paidYears = years.filter(y => y >= divFrom);
    const dividends = paidYears.reduce((s, y) => s + (perShare?.[y] || 0), 0) * n;

    const total = nowValue != null ? nowValue + dividends - invested : null;
    const totalPct = total != null ? total / invested * 100 : null;

    /* Срок — от начала года покупки до сегодня. Целое число лет здесь
       врало бы сильнее: покупка в 2024-м при сегодняшнем октябре 2026-го
       это 2,8 года, а не 2. */
    const heldYears = Math.max((TODAY - new Date(buyYear, 0, 1)) / (365.25 * 86400000), 0);
    const annualPct = totalPct != null && heldYears >= 1 ? totalPct / heldYears : null;

    return { buy, n, invested, nowValue, dividends, paidYears, total, totalPct, annualPct, heldYears };
  }, [buyPrice, qty, buyYear, divFrom, price, perShare, years]);

  const bad = calc == null;

  return (
    <Panel title="Калькулятор доходности акции" style={{ marginBottom: 14 }}
      right={<span className="c-3" style={{ fontSize: 10.5 }}>цена покупки — ваша, остальное из данных</span>}>
      {/* ── Ввод ── */}
      <div className="filters" style={{ marginBottom: 14 }}>
        <div className="fg">
          <label>Цена покупки, ₽</label>
          <input
            className="inp"
            style={{ width: 130 }}
            type="number"
            step="0.01"
            min="0"
            value={buyPrice}
            onChange={e => setBuyPrice(e.target.value)}
            title="По какой цене вы купили или купили бы акцию"
          />
          <div className="c-3" style={{ fontSize: 10, marginTop: 3 }}>
            {price == null ? 'текущая цена недоступна' : `сейчас ${nf(price, 2)} ₽`}
          </div>
        </div>
        <div className="fg">
          <label>Количество, шт</label>
          <input
            className="inp"
            style={{ width: 110 }}
            type="number"
            step="1"
            min="1"
            value={qty}
            onChange={e => setQty(e.target.value)}
            title="Сколько акций"
          />
        </div>
        <div className="fg">
          <label>Год покупки</label>
          <select
            className="inp"
            style={{ width: 110 }}
            value={buyYear}
            onChange={e => setBuyYear(+e.target.value)}
            title="В каком году куплена акция"
          >
            {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          {years.length > 0 && (
            <div className="c-3" style={{ fontSize: 10, marginTop: 3 }}>
              {divFrom > THIS_YEAR
                ? 'выплат после покупки ещё не было'
                : `дивиденды с ${divFrom} года`}
            </div>
          )}
        </div>
        {years.length > 0 && (
          <div className="fg">
            <label>Дивиденд года покупки</label>
            <label className="c-2" style={{ fontSize: 11.5, display: 'flex', gap: 6, alignItems: 'center', paddingTop: 6 }}>
              <input type="checkbox" checked={withBuyYear} onChange={e => setWithBuyYear(e.target.checked)} />
              успел получить
            </label>
            <div className="c-3" style={{ fontSize: 10, marginTop: 3 }}>
              выплату за год получает тот, кто купил до отсечки
            </div>
          </div>
        )}
      </div>

      {/* ── Результат ── */}
      {bad ? (
        <div className="empty" style={{ fontSize: 12 }}>
          Введите цену покупки и количество — посчитаем изменение и дивиденды.
        </div>
      ) : (
        <>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginBottom: 12 }}>
            <div className="kpi-card">
              <div className="kpi-l">Вложено</div>
              <div className="kpi-v">{nf(calc.invested, 0)}</div>
              <div className="kpi-s">{nf(calc.n, 0)} шт по {nf(calc.buy, 2)} ₽</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-l">Стоит сейчас</div>
              <div className="kpi-v">{calc.nowValue == null ? '—' : nf(calc.nowValue, 0)}</div>
              <div className="kpi-s">
                {calc.nowValue == null ? 'текущая цена недоступна'
                  : `без дивидендов, разница ${calc.nowValue - calc.invested >= 0 ? '+' : ''}${nf(calc.nowValue - calc.invested, 0)} ₽`}
              </div>
            </div>
            <div className="kpi-card">
              <div className="kpi-l">Дивиденды</div>
              <div className="kpi-v">{nf(calc.dividends, 0)}</div>
              <div className="kpi-s">
                {calc.paidYears.length === 0
                  ? 'за эти годы выплат не было'
                  : `за ${calc.paidYears.length} ${plural(calc.paidYears.length, 'год', 'года', 'лет')}`
                    + `: ${calc.paidYears[0]}–${calc.paidYears[calc.paidYears.length - 1]}`}
              </div>
            </div>
            <div className="kpi-card">
              <div className="kpi-l">Итого</div>
              <div className={'kpi-v ' + (calc.total == null ? '' : calc.total > 0 ? 'c-g' : calc.total < 0 ? 'c-r' : '')}>
                {calc.total == null ? '—' : (calc.total > 0 ? '+' : '') + nf(calc.total, 0)}
              </div>
              <div className="kpi-s">
                {calc.totalPct == null ? 'нет текущей цены'
                  : `цена и дивиденды вместе: ${calc.totalPct > 0 ? '+' : ''}${nf(calc.totalPct, 1)} %`}
              </div>
            </div>
            <div className="kpi-card">
              <div className="kpi-l">В среднем за год</div>
              <div className="kpi-v">
                {calc.annualPct == null ? '—' : (calc.annualPct > 0 ? '+' : '') + nf(calc.annualPct, 1) + '%'}
              </div>
              <div className="kpi-s">
                {calc.heldYears < 1
                  ? 'меньше года — годовой считать не на чем'
                  : `за ${nf(calc.heldYears, 1)} года владения`}
              </div>
            </div>
          </div>

          {/* Нынешний год по умолчанию — сценарий «купил сегодня по текущей
              цене». Он честный, но в нём всё по нулям, и без пояснения это
              выглядит как поломка. Говорим прямо, почему так и что делать. */}
          {buyYear === THIS_YEAR && (
            <div className="c-3" style={{ fontSize: 10.5, marginBottom: 10, lineHeight: 1.7 }}>
              Год покупки — нынешний, цена — сегодняшняя, поэтому изменений пока нет:
              это точка отсчёта, а не результат. Поставьте год и цену своей покупки —
              увидите, что вышло.
            </div>
          )}

          <div className="c-3" style={{ fontSize: 10.5, lineHeight: 1.7 }}>
            Дивиденды — <b>уже начисленные</b>, из таблицы ниже: прошлые выплаты не гарантируют
            будущих. Срок считаем с начала года покупки, точного дня мы не знаем. Годовую
            доходность считаем простым делением на срок, без реинвестирования дивидендов, —
            сложный процент дал бы больше, но зависит от того, куда вложены выплаты.
            Налог не вычитаем: 13 % с дивидендов и с прибыли зависят от срока владения
            и от других сделок за год. Это расчёт, а не совет и не прогноз.
          </div>
        </>
      )}
    </Panel>
  );
}
