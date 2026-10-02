import { useMemo, useState } from 'react';
import { Panel } from './ui';
import { nf, yearsUntil, couponsWithin, lastKnownCoupon } from '../lib/format';

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

export default function YieldCalculator({ bond, coupons }) {
  /* Курс: 1 для рублёвых бумаг, курс биржи — для валютных.
     У валютной бумаги номинал и купон в валюте, а НКД биржа отдаёт
     в рублях. Складывать их напрямую нельзя: получалась бумага за
     3 260 ₽ вместо 57 000 ₽. Пересчитываем номинал курсом. */
  const rate = bond?.fxRate ?? 1;
  const isFxCurrency = !!bond?.isCurrency;
  const faceRub = (bond?.faceValue || 1000) * rate;

  /* Стоимость одной бумаги с НКД — от неё считаем «сколько влезает».
     Всё в рублях: НКД уже рублёвый, номинал пересчитан курсом. */
  const priceKnown = bond?.price != null && !bond?.fxMissing;
  const unitCost = priceKnown ? bond.price / 100 * faceRub + (bond.nkd || 0) : null;

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

    /* Купоны за срок. Если есть график выплат — берём суммы прямо из
       него (биржа отдаёт рублёвую сумму каждой выплаты), иначе считаем
       по текущей ставке, и это допущение, а не факт. */
    const periodDays = bond.couponPeriod || 182;
    const paymentsPerYear = periodDays > 0 ? 365 / periodDays : 2;
    /* Ставку берём из поля, но ноль — это «не раскрыта», а не «ноль
       рублей»: у плавающих выпусков COUPONVALUE = 0 и COUPONPERCENT
       пустой, и купоны считались нулём (Россет1Р11: −0,1 % годовых
       при доходности биржи 16,5 %). Тогда опираемся на последний
       известный купон из графика и говорим, что это оценка. */
    const rateFromField = bond.couponValue != null && bond.couponValue > 0
      ? bond.couponValue
      : (bond.couponPercent != null && bond.couponPercent > 0
        ? bond.couponPercent / 100 * (bond.faceValue || 1000) * periodDays / 365
        : null);
    const lastKnown = lastKnownCoupon(coupons, rate);
    const couponNative = rateFromField ?? lastKnown;
    const couponEstimated = rateFromField == null && lastKnown != null;
    const couponPerBond = couponNative != null ? couponNative * rate : null;

    /* График считаем здесь, потому что он зависит от введённого срока.
       Из графика берём ЧИСЛО выплат — оно точное. Суммы у части
       выпусков не заполнены (плавающая ставка: у Россет1Р11 из 39
       будущих купонов сумма есть у нуля), поэтому:
         • все суммы известны — берём их как есть;
         • иначе считаем по текущей ставке, и это допущение. */
    const sched = couponsWithin(coupons, term, rate);
    const bySchedule = sched != null;

    const payments = bySchedule ? sched.count
      : (couponPerBond != null ? Math.floor(paymentsPerYear * term) : null);

    let couponsTotal = null, amountKnown = false;
    if (bySchedule) {
      if (sched.count === 0) {
        couponsTotal = 0;
        amountKnown = true;
      } else if (sched.byRub) {
        couponsTotal = sched.totalRub * bondsN;
        amountKnown = true;
      } else if (couponPerBond != null) {
        couponsTotal = sched.count * couponPerBond * bondsN;
      }
    } else if (payments != null && couponPerBond != null) {
      couponsTotal = payments * couponPerBond * bondsN;
    }
    /* Если хотя бы часть сумм из графика известна, а ставки нет —
       добираем известные, чтобы не показать ноль. */
    if (bySchedule && !amountKnown && couponsTotal == null && sched.known > 0) {
      couponsTotal = sched.totalRub * bondsN;
      amountKnown = true;
    }

    /* Возврат номинала. При амортизации часть номинала уже вернулась
       купонами-погашениями, которых мы не видим, поэтому честно
       помечаем, что итог завышен без учёта графика амортизации.

       Номинал возвращается только если введённый срок ДОЖИВАЕТ до
       погашения или оферты. Иначе получалась выдумка: по РЖД-30 с
       погашением в 2028 году при сроке 1 год мы прибавляли номинал,
       которого в этом сроке не будет, и рисовали 8 % вместо купонных.

       Отдельный случай — бессрочная бумага: даты погашения нет вовсе,
       и обещать возврат номинала нельзя. Так у ВТБ ЗО-Т1 выходило 61 %
       годовых против 14,7 % у биржи; биржа считает бессрочную как купон
       к цене, и это правильнее.

       В обоих случаях в расчёт идёт только купонный доход, а номинал
       остаётся вложенным: вернуть его можно продажей по рыночной цене,
       которой мы не знаем. */
    const yearsToRedemption = yearsUntil(bond.offerDate || bond.matDate);
    const redeemInTerm = yearsToRedemption != null && term >= yearsToRedemption - 0.02;
    const noRedemption = !redeemInTerm;
    const redemption = faceRub * bondsN;

    const gross = noRedemption
      ? (couponsTotal || 0)
      : (couponsTotal || 0) + redemption - invested;
    const tax = gross > 0 ? gross * NDFL : 0;
    const net = gross - tax;

    /* Простая доходность за срок и приведённая к году. Без реинвеста. */
    const simpleReturn = invested > 0 ? (gross / invested) * 100 : null;
    const annualReturn = simpleReturn != null && term > 0 ? simpleReturn / term : null;

    return {
      lots, bondsN, invested, payments, couponPerBond, couponNative, couponsTotal,
      redemption, gross, tax, net, simpleReturn, annualReturn,
      term, rate, isFxCurrency, bySchedule, amountKnown, couponEstimated,
      noRedemption, yearsToRedemption,
    };
  }, [amount, years, unitCost, lotCost, lotSize, bond, coupons, faceRub, rate, isFxCurrency]);

  /* Курса нет — считать в рублях не из чего. Честнее сказать это прямо,
     чем показать красивое число, посчитанное по чужой валюте. */
  if (bond?.fxMissing) {
    return (
      <Panel title="Калькулятор доходности" style={{ marginBottom: 14 }}>
        <div className="empty">
          Номинал этой бумаги — в {bond.currency}, а биржа не отдаёт курс этой валюты.
          Без курса рублёвый расчёт был бы выдумкой, поэтому мы его не показываем.
        </div>
      </Panel>
    );
  }

  if (bond?.price == null) {
    return (
      <Panel title="Калькулятор доходности" style={{ marginBottom: 14 }}>
        <div className="empty">
          Цена этой бумаги биржей не отдана, поэтому посчитать покупку нельзя.
        </div>
      </Panel>
    );
  }

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
              <div className="kpi-s">с учётом НКД, в рублях</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-l">Купоны за срок</div>
              <div className="kpi-v">{calc.couponsTotal == null ? '—' : nf(calc.couponsTotal, 0)}</div>
              {/* Это СУММА денег, а не число выплат: раньше подпись
                  «Купонов за срок» читалась как количество, и 47,5 ₽
                  выглядели как «48 купонов». Число выплат — ниже. */}
              <div className="kpi-s">
                {calc.payments == null ? 'ставка купона неизвестна'
                  : calc.payments === 0 ? 'в этот срок выплат нет'
                    : calc.amountKnown
                      ? <>{calc.payments} выплат{calc.bySchedule ? ' по графику биржи' : ''}</>
                      : <>{calc.payments} выплат{calc.bySchedule ? ' по графику' : ''}, сумма оценена{
                        calc.couponEstimated ? ' по последнему известному купону' : ' по текущей ставке'}</>}
              </div>
            </div>
            <div className="kpi-card">
              <div className="kpi-l">Прибыль до налога</div>
              <div className={'kpi-v ' + (calc.gross >= 0 ? 'c-g' : 'c-r')}>
                {nf(calc.gross, 0)}
              </div>
              <div className="kpi-s">
                {calc.noRedemption ? 'только купоны: номинал остаётся вложенным' : 'номинал + купоны − вложено'}
              </div>
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
            {calc.noRedemption ? (
              <>В конце срока вернётся только купонный доход. Номинал{' '}
              <b>{nf(calc.redemption, 0)} ₽</b> остаётся вложенным:{' '}
              {bond.isPerpetual || calc.yearsToRedemption == null
                ? 'даты погашения у выпуска нет'
                : <>до погашения {nf(calc.yearsToRedemption, 1)} г., а срок вы взяли {nf(calc.term, 1)} г.</>}.
              {' '}Вернуть номинал можно продажей по рыночной цене — её мы не знаем.
              Налог с прибыли (13 %) — <b>{nf(calc.tax, 0)} ₽</b>, на руки останется{' '}
              <b>{nf(calc.net, 0)} ₽</b> купонами.</>
            ) : (
              <>В конце срока вернётся номинал <b>{nf(calc.redemption, 0)} ₽</b>, налог с прибыли
              (13 %) — <b>{nf(calc.tax, 0)} ₽</b>, на руки останется <b>{nf(calc.net, 0)} ₽</b>.</>
            )}
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
            {isFxCurrency && (
              <> {' '}<b>Номинал и купон у этой бумаги в {bond.currency}.</b> Мы
              пересчитали их в рубли по курсу {nf(rate, 2)} ₽ за 1 {bond.currency}
              {bond.fxRateSrc === 'moex'
                ? ' — это курс из расчётов самой биржи по сделкам с этой бумагой'
                : ' — это курс валютной секции, потому что сегодня бумага не торговалась'}.
              {' '}Рублёвые суммы купонов взяты из графика выплат биржи: она считает
              каждую по курсу на дату выплаты, и у прошедших выплат это уже факт,
              а не оценка. Поэтому выплаты в рублях будут другими, если курс
              изменится. Раньше здесь складывались доллары с рублями, и выходила
              бессмысленная сумма.</>
            )}
            {bond.isPerpetual && (
              <> {' '}<b>Это бессрочная бумага:</b> даты погашения у неё нет вовсе, поэтому
              возврат номинала в расчёт не входит — иначе выходила бы обещанная
              прибыль, которой выпуск не гарантирует.</>
            )}
            {!bond.isPerpetual && calc.yearsToRedemption != null && calc.term < calc.yearsToRedemption && (
              <> {' '}<b>Срок короче, чем до погашения:</b> за это время номинал не
              вернётся, поэтому в расчёте только купоны. Чтобы увидеть погашение,
              поставьте срок {nf(calc.yearsToRedemption, 1)} г. или больше.</>
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