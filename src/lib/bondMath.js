/* ═══════════════════════════════════════════════════════════════════
   Математика облигации: доходность к погашению и к оферте.

   Зачем отдельный файл. Раньше весь расчёт жил в компоненте, и проверить
   его можно было только глазами — по одной карточке за раз. А ошибка тут
   не в одной карточке: прогон по 273 выпускам рынка показал, что прежняя
   формула расходилась с доходностью биржи в среднем на 3,4 пп, а на 87 %
   бумаг — больше чем на 1 пп. На бумагах, купленных дороже номинала с
   крупным купоном, знак вообще был противоположный (у RU000A1035H1
   калькулятор показывал −65 %, биржа +0,6 %).

   Причина не в арифметике, а в формуле. Калькулятор брал «всю прибыль,
   делённую на срок, и возводил в степень» — это доходность БЕЗ
   реинвестирования купонов. Биржа считает иначе: единая ставка, при
   которой выплаты, вложенные под неё же до конца срока, дают ровно то,
   что обещает график. Разница не косметическая: на коротких сроках и на
   бумагах с большим купоном она в разы.

   Здесь чистые функции: ни React, ни «сегодня» внутри — дату передаём
   аргументом. Поэтому тот же расчёт можно прогнать по всему рынку и
   сверить с биржей — что и делается в проверке.
   ═══════════════════════════════════════════════════════════════════ */

export const MS_DAY = 86400000;

/** Дата ISO → миллисекунды (полночь местного времени, как считает биржа). */
export function isoMs(iso) {
  return new Date(iso + 'T00:00:00').getTime();
}

/** Лет между двумя датами ISO. Год — 365 дней: так считает биржа. */
export function yearsBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  return (isoMs(toIso) - isoMs(fromIso)) / MS_DAY / 365;
}

/** Дата ISO через n дней. */
export function isoPlusDays(iso, n) {
  const d = new Date(isoMs(iso) + n * MS_DAY);
  const p = x => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Что и когда выпуск заплатит за срок владения.
 *
 * Возвращает денежные потоки в рублях на одну бумагу и то, что вернётся
 * в конце. Три вида выплат:
 *   • купоны — по графику биржи; где сумма не раскрыта (плавающая ставка),
 *     подставляем оценку и честно помечаем её;
 *   • частичные погашения номинала (амортизация) — это тоже деньги, и они
 *     приходят РАНЬШЕ срока, поэтому заметно поднимают доходность;
 *   • остаток номинала в конце.
 *
 * Номинал возвращается один раз. Биржа кладёт финальный возврат в тот же
 * график амортизации строкой «100 % номинала»; если взять и её, и номинал
 * целиком, номинал посчитается дважды — на этом калькулятор завышал
 * амортизирующие выпуски.
 */
export function buildFlows({
  coupons = [], amortizations = [], rate = 1,
  fromIso, toIso, eventIso, faceRub, couponFallbackRub = null,
  amortCapped = false,
}) {
  const flows = [];
  let couponsTotalRub = 0, couponsCount = 0, couponsKnown = 0, couponEstimated = false;

  for (const c of coupons) {
    if (!c?.date || c.date <= fromIso || c.date > toIso) continue;
    couponsCount++;
    let rub = c.valueRub != null ? c.valueRub : (c.value != null ? c.value * rate : null);
    /* Ноль и пусто у плавающего выпуска значат «не раскрыто», а не «ноль
       рублей»: считая такие купоны нулём, получали отрицательную доходность
       у бумаги с доходностью 16,5 %. */
    if (!(rub > 0)) {
      rub = couponFallbackRub;
      couponEstimated = true;
    }
    if (!(rub > 0)) continue;
    couponsKnown++;
    couponsTotalRub += rub;
    flows.push({ date: c.date, t: yearsBetween(fromIso, c.date), rub, kind: 'coupon' });
  }

  /* Частичные погашения номинала до события. */
  const partials = [];
  if (!amortCapped) {
    for (const a of amortizations) {
      if (!a?.date || !(a.value > 0)) continue;
      if (a.date <= fromIso || a.date >= eventIso) continue;   // финальный возврат — не сюда
      if (a.value >= faceRub * 0.99) continue;                 // «100 %» — это и есть погашение
      const rub = a.value * rate;
      if (a.date > toIso) continue;                            // вне срока владения
      partials.push({ date: a.date, rub });
      flows.push({ date: a.date, t: yearsBetween(fromIso, a.date), rub, kind: 'amort' });
    }
  }
  const amortTotalRub = partials.reduce((s, a) => s + a.rub, 0);

  /* Держим ли до события. Если нет — номинал не возвращается в этом сроке:
     деньги остаются в бумаге, а вернуть их можно продажей по рыночной
     цене, которой мы не знаем. */
  const heldToEvent = !!(eventIso && toIso >= eventIso);
  const remainingFaceRub = heldToEvent ? Math.max(0, faceRub - amortTotalRub) : 0;

  return {
    flows: flows.sort((a, b) => (a.date < b.date ? -1 : 1)),
    couponsTotalRub,
    couponsCount,
    couponsKnown,
    couponEstimated,
    amortTotalRub,
    partials: partials.length,
    remainingFaceRub,
    heldToEvent,
  };
}

/**
 * Доходность к событию — так её считает биржа.
 *
 * Единая годовая ставка y, при которой вложенная сумма с учётом
 * реинвестирования всех выплат под ту же ставку даёт ровно обещанное:
 *
 *     Σ CF(t) · (1+y)^(T−t)  =  вложено · (1+y)^T
 *
 * points — выплаты { t, cf }, где t — момент в годах от сегодня.
 * Решаем бисекцией: она сходится всегда, когда поток меняет знак, и не
 * требует производных. Если решения в разумном диапазоне нет (например,
 * цена не даёт ни прибыли, ни убытка ни при какой ставке), возвращаем
 * null — страница скажет об этом прямо, а не покажет выдуманное число.
 */
export function yieldToEvent({ points = [], tEnd, investedRub }) {
  if (!(investedRub > 0) || !(tEnd > 0)) return null;
  const f = (y) => {
    const yy = Math.max(y, -0.999);
    let v = -investedRub * Math.pow(1 + yy, tEnd);
    for (const p of points) {
      if (!(p.cf > 0)) continue;
      v += p.cf * Math.pow(1 + yy, Math.max(tEnd - p.t, 0));
    }
    return v;
  };
  const lo0 = -0.95, hi0 = 5;
  if (!Number.isFinite(f(lo0)) || !Number.isFinite(f(hi0))) return null;
  if (f(lo0) * f(hi0) > 0) return null;
  let lo = lo0, hi = hi0;
  for (let i = 0; i < 120; i++) {
    const mid = (lo + hi) / 2;
    if (f(lo) * f(mid) <= 0) hi = mid; else lo = mid;
  }
  return ((lo + hi) / 2) * 100;
}
