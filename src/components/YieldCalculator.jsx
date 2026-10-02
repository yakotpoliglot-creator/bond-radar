import { useMemo, useState } from 'react';
import { Panel } from './ui';
import { nf, yearsUntil } from '../lib/format';

/* ═══════════════════════════════════════════════════════════════════
   Калькулятор доходности выпуска

   Заказчик просил: «вводишь сумму и срок — получаешь, что будет».
   Считаем на данных MOEX, которые уже загружены на страницу выпуска.

   Что считается ЧЕСТНО:
     • сколько бумаг влезает в сумму с учётом лота и НКД;
     • сколько купонов придёт за срок (по текущей ставке купона);
     • сколько вернётся номинала при погашении/оферте;
     • простая и годовая доходность на вложенное.

   Чего формула НЕ обещает:
     • реинвест купонов: сложный процент зависит от будущих ставок,
       которых мы не знаем. Считаем без реинвеста и говорим об этом;
     • налог: показываем «до налога» и отдельно сумму НДФЛ;
     • амортизированные выпуски: номинал гасится частями, поэтому
       итоговая выплата — не весь номинал. Предупреждаем.
   ═══════════════════════════════════════════════════════════════════ */

const NDFL = 0.13;   // базовая ставка; на крупные суммы может быть 15%

export default function YieldCalculator({ bond }) {
  /* Стоимость одной бумаги с НКД — от неё считаем «сколько влезает». */
  const unitCost = useMemo(() => {
    if (bond?.price == null) return null;
    const face = bond.faceValue || 1000;
    return bond.price / 100 * face + (bond.nkd || 0);
  }, [bond]);

  const lotSize = bond?.lotSize || 1;
  const lotCost = unitCost != null ? unitCost * lotSize : null;

  /* По умолчанию — та сумма, что назвал заказчик, но не меньше лота. */
  const [amount, setAmount] = useState(() =>
    lotCost != null ? String(Math.ceil(lotCost)) : '11500');

  /* Срок: по умолчанию — до ближайшего события (оферта или погашение).
     Расчёт даты — в помощнике yearsUntil: new Date() не чистая функция,
     и вызывать её прямо в теле компонента нельзя. */
  const defaultYears = useMemo(() => {
    const y = yearsUntil(bond?.offerDate || bond?.matDate);
    return y == null ? '1' : String(y);
  }, [bond]);

  const [years, setYears] = useState(defaultYears);

  /* ── расчёт ── */
  const calc = useMemo(() => {
    const sum = +String(amount).replace(/\s/g, '').replace(',', '.');
    const term = +String(years).replace(',', '.');
    if (!Number.isFinite(sum) || sum <= 0 || unitCost == null || lotCost == null) return null;
    if (!Number.isFinite(term) || term <= 0) return null;

    /* Сколько лотов влезает в сумму. Лот — минимальная покупка. */
    const lots = Math.floor(sum / lotCost);
    if (lots <= 0) return { tooLittle: true, lotCost, sum };

    const bondsN = lots * lotSize;          // бумаг всего
    const invested = lots * lotCost;        // реально потрачено

    /* Купоны за срок. Ставка берётся текущая — это допущение, а не факт. */
    const periodDays = bond.couponPeriod || 182;
    const paymentsPerYear = periodDays > 0 ? 365 / periodDays : 2;
    const couponPerBond = bond.couponValue != null
      ? bond.couponValue
      : (bond.couponPercent != null ? bond.couponPercent / 100 * (bond.faceValue || 1000) * periodDays / 365 : null);

    const payments = couponPerBond != null ? Math.floor(paymentsPerYear * term) : null;
    const couponsTotal = (payments != null && couponPerBond != null)
      ? payments * couponPerBond * bondsN
      : null;

    /* Возврат номинала. При амортизации часть номинала уже вернулась
       купонами-погашениями, которых мы не видим, поэтому честно
       помечаем, что итог завышен без учёта графика амортизации. */
    const face = bond.faceValue || 1000;
    const redemption = face * bondsN;

    const gross = (couponsTotal || 0) + redemption - invested;
    const tax = gross > 0 ? gross * NDFL : 0;
    const net = gross - tax;

    /* Простая доходность за срок и приведённая к году. Без реинвеста. */
    const simpleReturn = invested > 0 ? (gross / invested) * 100 : null;
    const annualReturn = simpleReturn != null && term > 0 ? simpleReturn / term : null;

    return {
      lots, bondsN, invested, payments, couponPerBond, couponsTotal,
      redemption, gross, tax, net, simpleReturn, annualReturn,
      term, currency: bond.currency || 'RUB',
    };
  }, [amount, years, unitCost, lotCost, lotSize, bond]);

  if (bond?.price == null) {
    return (
      <Panel title="Калькулятор доходности" style={{ marginBottom: 14 }}>
        <div className="empty">
          Цена этой бумаги биржей не отдана, поэтому посчитать покупку нельзя.
        </div>
      </Panel>
    );
  }

  const cur = calc?.currency === 'RUB' ? '₽' : ' ' + (calc?.currency || '');

  return (
    <Panel title="Калькулятор доходности" style={{ marginBottom: 14 }}
      right={<span className="c-3" style={{ fontSize: 10.5 }}>расчёт по текущей цене и купону</span>}>
      {/* ── Ввод ── */}
      <div className="filters" style={{ marginBottom: 14 }}>
        <div className="fg">
          <label>Сумма, ₽</label>
          <input
            className="inp"
            style={{ width: 140 }}
            type="number"
            step="100"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            title="Сколько денег вкладываем"
          />
          {lotCost != null && (
            <div className="c-3" style={{ fontSize: 10, marginTop: 3 }}>
              один лот стоит {nf(lotCost, 0)} ₽
            </div>
          )}
        </div>
        <div className="fg">
          <label>Срок владения, лет</label>
          <input
            className="inp"
            style={{ width: 110 }}
            type="number"
            step="0.5"
            min="0.1"
            value={years}
            onChange={e => setYears(e.target.value)}
            title="Сколько лет держим бумагу"
          />
          <div className="c-3" style={{ fontSize: 10, marginTop: 3 }}>
            до {bond.offerDate ? 'оферты' : 'погашения'} — {defaultYears} г.
          </div>
        </div>
      </div>

      {/* ── Результат ── */}
      {calc?.tooLittle ? (
        <div className="err" style={{ textAlign: 'left', padding: '10px 0' }}>
          На {nf(calc.sum, 0)} ₽ не купить даже один лот: он стоит {nf(calc.lotCost, 0)} ₽.
          Увеличьте сумму или выберите другую бумагу.
        </div>
      ) : calc ? (
        <>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginBottom: 12 }}>
            <div className="kpi-card">
              <div className="kpi-l">Куплено бумаг</div>
              <div className="kpi-v">{nf(calc.bondsN, 0)}</div>
              <div className="kpi-s">{calc.lots} лот{calc.lots === 1 ? '' : calc.lots < 5 ? 'а' : 'ов'} · по {nf(unitCost, 0)} ₽ с НКД</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-l">Вложено</div>
              <div className="kpi-v">{nf(calc.invested, 0)}</div>
              <div className="kpi-s">с учётом НКД{cur}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-l">Купонов за срок</div>
              <div className="kpi-v">{calc.couponsTotal == null ? '—' : nf(calc.couponsTotal, 0)}</div>
              <div className="kpi-s">
                {calc.payments == null ? 'ставка купона неизвестна' : `${calc.payments} выплат по ${nf(calc.couponPerBond, 2)} ₽`}
              </div>
            </div>
            <div className="kpi-card">
              <div className="kpi-l">Прибыль до налога</div>
              <div className={'kpi-v ' + (calc.gross >= 0 ? 'c-g' : 'c-r')}>
                {nf(calc.gross, 0)}
              </div>
              <div className="kpi-s">номинал + купоны − вложено</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-l">Доходность за срок</div>
              <div className={'kpi-v ' + (calc.simpleReturn >= 0 ? 'c-g' : 'c-r')}>
                {nf(calc.simpleReturn, 1)}<span style={{ fontSize: 13 }}>%</span>
              </div>
              <div className="kpi-s">прибыль ÷ вложенное</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-l">То же в год</div>
              <div className={'kpi-v ' + (calc.annualReturn >= 0 ? 'c-g' : 'c-r')}>
                {nf(calc.annualReturn, 1)}<span style={{ fontSize: 13 }}>%</span>
              </div>
              {/* Не «доходность к погашению»: это простое деление на срок,
                  без сложного процента. YTM биржа считает иначе, и
                  подменять одно другим нельзя. */}
              <div className="kpi-s">простое деление на срок</div>
            </div>
          </div>

          <div className="c-2" style={{ fontSize: 11.5, lineHeight: 1.7 }}>
            В конце срока вернётся номинал <b>{nf(calc.redemption, 0)} {cur}</b>, налог с прибыли
            (13 %) — <b>{nf(calc.tax, 0)} {cur}</b>, на руки останется <b>{nf(calc.net, 0)} {cur}</b>.
          </div>

          {/* ── Честные оговорки ── */}
          <div className="c-3" style={{ fontSize: 10.5, marginTop: 12, lineHeight: 1.7 }}>
            <b>Это сценарий по введённым допущениям, а не обещание доходности.</b>
            {' '}Купоны посчитаны по <i>текущей</i> ставке: если она плавающая или компания
            пересмотрит её, суммы изменятся. Реинвест купонов не учтён — сложный процент
            зависел бы от будущих ставок, которых мы не знаем. «В год» — это прибыль,
            поделённая на срок, а <b>не доходность к погашению</b>: биржа считает её иначе,
            и в плитках выше она своя.
            {bond.isAmort && (
              <> {' '}<b>У этой бумаги амортизация номинала:</b> он гасится частями по графику,
              поэтому возврат в конце меньше полного номинала, и наши цифры его завышают —
              точный расчёт требует графика амортизации.</>
            )}
            {bond.isCurrency && (
              <> {' '}<b>Номинал в валюте</b> — расчёт не учитывает изменение курса.</>
            )}
            {' '}Налог взят по базовой ставке 13 %; на крупные суммы ставка выше.
            Не является инвестиционной рекомендацией.
          </div>
        </>
      ) : (
        <div className="empty">Введите сумму и срок.</div>
      )}
    </Panel>
  );
}