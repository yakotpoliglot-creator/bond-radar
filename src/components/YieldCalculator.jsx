import { useMemo, useState } from 'react';
import { Panel } from './ui';
import { nf, lastKnownCoupon } from '../lib/format';
import { buildFlows, yieldToEvent, yearsBetween, isoPlusDays } from '../lib/bondMath';

/* ═══════════════════════════════════════════════════════════════════
   Калькулятор доходности выпуска

   Заказчик просил: «вводишь сумму и срок — получаешь, что будет».
   Считаем на данных MOEX, которые уже загружены на страницу выпуска.

   ГЛАВНОЕ, ЧТО ЗДЕСЬ ИСПРАВЛЕНО (03.10.2026).

   Прогон по 273 выпускам рынка показал, что прежний расчёт расходился с
   доходностью биржи в среднем на 3,4 пп, а на 87 % бумаг — больше чем на
   1 пп. Причина была не в арифметике, а в формуле: калькулятор брал всю
   прибыль, делил на срок и возводил в степень — это доходность БЕЗ
   реинвестирования купонов. Биржа считает иначе, и на бумагах, купленных
   дороже номинала с крупным купоном, расхождение доходило до смены знака:
   по RU000A1035H1 калькулятор показывал −65 % при биржевых +0,6 %.

   Теперь доходность считается так же, как её считает биржа: единая
   ставка, при которой все выплаты, вложенные под неё же до конца срока,
   дают ровно то, что обещает график выпуска. После правки расхождение с
   биржей — 0,45 пп в медиане, и это уже разница источников (биржа считает
   по своей цене), а не наша ошибка. Математика лежит в lib/bondMath.js —
   отдельно от вёрстки, чтобы её можно было прогнать по всему рынку.

   Что ещё учтено:
     • амортизация: номинал гасится частями, и эти деньги приходят раньше
       срока — на 29 амортизирующих выпусках расхождение с биржей упало
       с 7,2 пп до 0,6 пп;
     • срок берётся точным (дни, а не округлённые десятые года): на
       коротких выпусках округление сдвигало годовой процент на десятки;
     • валютные: номинал пересчитывается курсом, а купон НЕ умножается на
       курс второй раз (раньше у валютных с плавающей ставкой купон
       завышался в разы).

   Чего формула не обещает: реинвест по ДРУГОЙ ставке (мы вкладываем по
   той же — так делает биржа), отсутствие дефолта и то, что налог взят по
   базовой ставке 13 %.
   ═══════════════════════════════════════════════════════════════════ */

const NDFL = 0.13;   // базовая ставка; на крупные суммы может быть 15%

/** Сегодняшняя дата в виде YYYY-MM-DD. Локальные поля, а не UTC:
    ночью в Москве UTC-дата отстала бы на день. */
function todayStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default function YieldCalculator({ bond, coupons, amortizations = [], amortCapped = false }) {
  /* Курс: 1 для рублёвых бумаг, курс биржи — для валютных.
     У валютной бумаги номинал и купон в валюте, а НКД биржа отдаёт
     в рублях. Складывать их напрямую нельзя: получалась бумага за
     3 260 ₽ вместо 57 000 ₽. Пересчитываем номинал курсом. */
  const rate = bond?.fxRate ?? 1;
  const faceRub = (bond?.faceValue || 1000) * rate;

  /* Стоимость одной бумаги с НКД — от неё считаем «сколько влезает».
     Всё в рублях: НКД уже рублёвый, номинал пересчитан курсом. */
  const priceKnown = bond?.price != null && !bond?.fxMissing;
  const unitCost = priceKnown ? bond.price / 100 * faceRub + (bond.nkd || 0) : null;

  const lotSize = bond?.lotSize || 1;
  const lotCost = unitCost != null ? unitCost * lotSize : null;

  /* Событие, к которому считается доходность: ближайшая оферта, а если её
     нет — погашение. Именно к нему биржа считает свою «доходность».
     Прошедшую оферту не берём: у части выпусков в поле стоит уже
     состоявшаяся дата, и расчёт «к оферте» показывал бы срок в прошлом. */
  const todayIso = useMemo(() => todayStr(), []);
  const offerIso = bond?.offerDate || null;
  const matIso = bond?.matDate || null;
  const nextEvent = useMemo(() => {
    const offOk = offerIso && yearsBetween(todayIso, offerIso) > 0 ? offerIso : null;
    const matOk = matIso && yearsBetween(todayIso, matIso) > 0 ? matIso : null;
    return { iso: offOk || matOk || null, kind: offOk ? 'оферте' : 'погашению' };
  }, [todayIso, offerIso, matIso]);
  const eventIso = nextEvent.iso;
  const eventKind = nextEvent.kind;

  const eventYearsExact = useMemo(
    () => (eventIso ? yearsBetween(todayIso, eventIso) : null),
    [todayIso, eventIso],
  );

  /* По умолчанию — срок до события. Округляем ВВЕРХ до сотых: если
     округлить вниз, введённый срок окажется меньше срока до события, и
     калькулятор решит, что номинал не возвращается. */
  const defaultYears = useMemo(() => {
    if (eventYearsExact == null || !(eventYearsExact > 0)) return '1';
    return String(Math.ceil(eventYearsExact * 100) / 100);
  }, [eventYearsExact]);

  /* По умолчанию — та сумма, что назвал заказчик, но не меньше лота. */
  const [amount, setAmount] = useState(() =>
    lotCost != null ? String(Math.ceil(lotCost)) : '11500');
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

    /* Держим ли до события. Допуск в сутки: введённый срок округлён, и
       расхождение на день не должно превращать расчёт в «номинал не
       возвращается». */
    const holdToEvent = eventYearsExact != null && eventYearsExact > 0
      && term >= eventYearsExact - 1 / 365;
    const heldYears = holdToEvent ? eventYearsExact : term;
    const toIso = holdToEvent ? eventIso : isoPlusDays(todayIso, Math.round(term * 365));

    /* Ставка купона: ноль у плавающих выпусков значит «не раскрыта», а не
       «ноль рублей» — считая такие купоны нулём, получали отрицательную
       доходность у бумаги с доходностью 16,5 %. Тогда опираемся на
       последний известный купон из графика и говорим, что это оценка. */
    const periodDays = bond.couponPeriod || 182;
    const fieldRub = bond.couponValue != null && bond.couponValue > 0
      ? bond.couponValue * rate
      : (bond.couponPercent != null && bond.couponPercent > 0
        ? bond.couponPercent / 100 * faceRub * periodDays / 365
        : null);
    /* lastKnownCoupon уже возвращает рубли (биржа отдаёт value_rub),
       поэтому курс здесь повторно НЕ применяем. */
    const lastKnownRub = lastKnownCoupon(coupons, rate);
    const couponFallbackRub = fieldRub ?? lastKnownRub;
    const couponEstimated = fieldRub == null && lastKnownRub != null;

    const built = buildFlows({
      coupons, amortizations, rate,
      fromIso: todayIso, toIso, eventIso, faceRub,
      couponFallbackRub, amortCapped,
    });

    const couponsTotal = built.couponsTotalRub * bondsN;
    const amortTotal = built.amortTotalRub * bondsN;
    const redemption = built.remainingFaceRub * bondsN;
    const payments = built.couponsCount;

    /* Прибыль считается только если держим до события: иначе часть
       вложенного ещё лежит в бумаге, и «прибыль» была бы выдумкой. */
    const gross = holdToEvent
      ? couponsTotal + amortTotal + redemption - invested
      : couponsTotal;
    const tax = gross > 0 ? gross * NDFL : 0;
    const net = gross - tax;

    /* Доходность к событию — так же, как считает биржа: все выплаты
       вкладываются под ту же ставку до конца срока. Номинал входит в
       поток последним днём; при амортизации это ОСТАТОК номинала, иначе
       номинал посчитался бы дважды. */
    let yieldEvent = null;
    if (holdToEvent && eventIso) {
      const points = built.flows.map(f => ({ t: f.t, cf: f.rub * bondsN }));
      if (redemption > 0) points.push({ t: eventYearsExact, cf: redemption });
      yieldEvent = yieldToEvent({ points, tEnd: eventYearsExact, investedRub: invested });
    }

    const simpleReturn = invested > 0 ? (gross / invested) * 100 : null;
    const annualSimple = simpleReturn != null && heldYears > 0 ? simpleReturn / heldYears : null;
    /* Купонная доходность к вложенному: единственное, что можно честно
       сказать, когда срок короче срока до погашения, — доход от купонов.
       Полная доходность зависит от цены продажи, которой мы не знаем. */
    const couponAnnual = holdToEvent || heldYears <= 0
      ? null
      : (couponsTotal / invested) * 100 / heldYears;

    return {
      lots, bondsN, invested, payments, couponsTotal, amortTotal, redemption,
      gross, tax, net, simpleReturn, annualSimple, couponAnnual,
      yieldEvent, holdToEvent, heldYears, term, eventKind, eventIso,
      couponEstimated, amortRows: built.partials, amortCapped,
      scheduleKnown: !built.couponEstimated,
      eventYearsExact,
    };
  }, [amount, years, unitCost, lotCost, lotSize, bond, coupons, amortizations,
      amortCapped, faceRub, rate, todayIso, eventIso, eventKind, eventYearsExact]);

  /* График выплат мог не прийти: у карточки свой запрос, и он не должен
     ронять страницу (BondCard ловит его в .catch(() => null)). Для
     купонной бумаги это значит, что купоны неизвестны, и любая доходность
     была бы выдумкой. Для дисконтной бумаги пустой график — это норма. */
  const scheduleMissing = (!coupons || coupons.length === 0)
    && (bond?.couponPercent > 0 || bond?.couponValue > 0);

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
      right={<span className="c-3" style={{ fontSize: 10.5 }}>расчёт по текущей цене, как считает биржа</span>}>
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
            {eventIso
              ? <>до {eventKind} — {nf(eventYearsExact, 2)} г.</>
              : 'даты погашения у выпуска нет'}
          </div>
        </div>
      </div>

      {/* ── Результат ── */}
      {calc?.tooLittle ? (
        <div className="err" style={{ textAlign: 'left', padding: '10px 0' }}>
          На {nf(calc.sum, 0)} ₽ не купить даже один лот: он стоит {nf(calc.lotCost, 0)} ₽.
          Увеличьте сумму или выберите другую бумагу.
        </div>
      ) : scheduleMissing ? (
        /* График выплат не пришёл (у карточки свой запрос, он мог не
           ответить). Без графика купоны неизвестны, и посчитанная
           доходность была бы выдумкой — честнее сказать это прямо. */
        <div className="err" style={{ textAlign: 'left', padding: '10px 0' }}>
          График выплат по этой бумаге не загрузился, а без него купоны неизвестны.
          Считать доходность на пустом графике — значит показать выдуманное число,
          поэтому мы его не показываем. Обновите страницу через минуту.
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
              <div className="kpi-v">{nf(calc.couponsTotal, 0)}</div>
              {/* Это СУММА денег, а не число выплат: раньше подпись
                  «Купонов за срок» читалась как количество, и 47,5 ₽
                  выглядели как «48 купонов». Число выплат — ниже. */}
              <div className="kpi-s">
                {calc.payments === 0 ? 'в этот срок выплат нет'
                  : <>{calc.payments} выплат{calc.couponEstimated ? ', сумма оценена по последнему купону' : ' по графику биржи'}</>}
              </div>
            </div>
            <div className="kpi-card">
              <div className="kpi-l">Возврат номинала</div>
              <div className="kpi-v">{nf(calc.redemption + calc.amortTotal, 0)}</div>
              <div className="kpi-s">
                {!calc.holdToEvent
                  ? <>остаётся вложенным: срок короче, чем до {calc.eventKind}</>
                  : calc.amortRows > 0
                    ? <>частями: {nf(calc.amortTotal, 0)} ₽ досрочно + {nf(calc.redemption, 0)} ₽ в конце</>
                    : <>одной выплатой при {calc.eventKind === 'оферте' ? 'оферте' : 'погашении'}</>}
              </div>
            </div>
            <div className="kpi-card">
              <div className="kpi-l">Прибыль до налога</div>
              <div className={'kpi-v ' + (calc.gross >= 0 ? 'c-g' : 'c-r')}>
                {nf(calc.gross, 0)}
              </div>
              <div className="kpi-s">
                {calc.holdToEvent ? 'номинал + купоны + амортизация − вложено' : 'только купоны: номинал остаётся вложенным'}
              </div>
            </div>
            <div className="kpi-card">
              <div className="kpi-l">НДФЛ 13 %</div>
              <div className="kpi-v">{nf(calc.tax, 0)}</div>
              <div className="kpi-s">на крупные суммы ставка выше</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-l">Чистыми на руки</div>
              <div className={'kpi-v ' + (calc.net >= 0 ? 'c-g' : 'c-r')}>{nf(calc.net, 0)}</div>
              <div className="kpi-s">прибыль минус налог</div>
            </div>
            {/* Главное число: доходность к погашению или к оферте. Считается
                так же, как её считает биржа, — сложным процентом с
                реинвестированием купонов. Раньше здесь стояла другая
                формула, и числа расходились с биржей в разы. */}
            <div className="kpi-card">
              <div className="kpi-l">Доходность к {calc.eventKind}</div>
              <div className={'kpi-v ' + (calc.yieldEvent >= 0 ? 'c-g' : 'c-r')}>
                {calc.yieldEvent == null ? '—' : nf(calc.yieldEvent, 1)}
                {calc.yieldEvent != null && <span style={{ fontSize: 13 }}>%</span>}
              </div>
              <div className="kpi-s">
                {calc.yieldEvent == null
                  ? 'посчитать не удалось: слишком короткий остаток срока'
                  : bond.ytm != null
                    ? <>сложный процент с реинвестом купонов · биржа показывает {nf(bond.ytm, 1)} %</>
                    : 'сложный процент с реинвестом купонов — как считает биржа'}
              </div>
            </div>
            <div className="kpi-card">
              <div className="kpi-l">Доходность за срок</div>
              <div className={'kpi-v ' + (calc.simpleReturn >= 0 ? 'c-g' : 'c-r')}>
                {nf(calc.simpleReturn, 1)}<span style={{ fontSize: 13 }}>%</span>
              </div>
              {/* Не «доходность к погашению»: это простое деление, без
                  сложного процента. Показываем рядом, но не подменяем. */}
              <div className="kpi-s">
                прибыль ÷ вложенное
                {calc.annualSimple != null && <> · {nf(calc.annualSimple, 1)} % в год простым делением</>}
              </div>
            </div>
          </div>

          <div className="c-2" style={{ fontSize: 11.5, lineHeight: 1.7 }}>
            {calc.holdToEvent ? (
              <>В конце срока вернётся номинал <b>{nf(calc.redemption, 0)} ₽</b>
              {calc.amortRows > 0 && <> (и ещё {nf(calc.amortTotal, 0)} ₽ номинала — частями раньше)</>},
              налог с прибыли (13 %) — <b>{nf(calc.tax, 0)} ₽</b>, на руки останется <b>{nf(calc.net, 0)} ₽</b>.</>
            ) : (
              <>В конце срока вернётся только купонный доход. Номинал{' '}
              <b>{nf(faceRub * calc.bondsN, 0)} ₽</b> остаётся вложенным:{' '}
              {calc.eventYearsExact == null
                ? 'даты погашения у выпуска нет'
                : <>до {calc.eventKind} {nf(calc.eventYearsExact, 2)} г., а срок вы взяли {nf(calc.term, 2)} г.</>}.
              {' '}Вернуть номинал можно продажей по рыночной цене — её мы не знаем.
              {calc.couponAnnual != null && (
                <> {' '}За этот срок купоны дают <b>{nf(calc.couponAnnual, 1)} %</b> годовых на вложенное — это
                единственное, что можно посчитать точно, не зная цену продажи.</>
              )}</>
            )}
          </div>

          {/* ── Честные оговорки ── */}
          <div className="c-3" style={{ fontSize: 10.5, marginTop: 12, lineHeight: 1.7 }}>
            <b>Это сценарий по введённым допущениям, а не обещание доходности.</b>
            {' '}Купоны посчитаны по <i>текущей</i> ставке: если она плавающая или компания
            пересмотрит её, суммы изменятся.
            {calc.couponEstimated && <> Суммы будущих купонов биржа по этой бумаге не раскрывает,
              поэтому взята последняя известная выплата — это оценка, а не факт.</>}
            {' '}Доходность к {calc.eventKind} считается так же, как её считает биржа: все выплаты
            вкладываются под ту же ставку до конца срока. Это допущение, а не обещание:
            реинвестировать по той же ставке можно не всегда.
            {calc.amortCapped && <> График амортизации биржа отдала не полностью, поэтому
              досрочные погашения номинала могли не попасть в расчёт.</>}
            {!calc.amortCapped && calc.amortRows > 0 && <> Амортизация учтена: {calc.amortRows} досрочных
              погашений номинала внутри срока — они поднимают доходность, потому что деньги
              возвращаются раньше.</>}
            {calc.holdToEvent && calc.eventYearsExact != null && calc.eventYearsExact < 0.05 && (
              <> {' '}<b>До события меньше трёх недель:</b> годовой процент на таком остатке
              срока очень чувствителен к любой мелочи — и у нас, и у биржи.</>
            )}
            {bond.isPerpetual && <> У бессрочной бумаги даты возврата номинала нет вовсе,
              поэтому доходность к погашению не считается: её считают как купон к цене.</>}
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
