import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  fetchBondCard, fetchIssuerInfo, fetchEmitter, fetchGirboByInn, fetchGirboDate,
  fetchFundamentals, findIssuerFundamentals, moexIssueUrl,
} from '../api/moex';
import { Kpi, CouponTag, LevelTag, RatingTag, timesWord } from './ui';
import IssuerCard from './IssuerCard';
import Modal from './Modal';
import { ratioStats, latestPeriodLine } from '../lib/ratios';
import { nf, dateShort, duration, timeLeft, ytmClass, chgStrA } from '../lib/format';

/* ── Быстрый просмотр бумаги из списка ───────────────────────────────
 *
 * Как в оригинале: клик по строке скринера открывает окно, а не уводит
 * на другую страницу — сразу видно, кому принадлежит бумага и что у
 * компании с долгом, а на полную карточку выпуска ведёт кнопка в шапке.
 *
 * Данные те же и тем же путём, что у страницы выпуска: паспорт выпуска
 * (fetchBondCard) — для флагов риска и оферты, реестр MOEX (fetchEmitter)
 * — для реквизитов, ГИР БО ФНС по ИНН — для РСБУ, а fundamentals.json
 * (2,5 МБ) — фоном, он нужен только для плиток метрик.
 *
 * Чего здесь нет намеренно: калькулятора доходности, графика купонов и
 * соседних выпусков. Это работа страницы выпуска — дублировать расчёты в
 * окне значило бы показывать два разных ответа на один вопрос.
 */
export default function BondPopup({ bond, onClose }) {
  const [card, setCard] = useState(null);
  const [issuer, setIssuer] = useState(null);
  const [emitter, setEmitter] = useState(null);
  const [girbo, setGirbo] = useState(null);
  const [girboDate, setGirboDate] = useState(null);
  const [fdata, setFdata] = useState(null);

  const isin = bond?.isin;

  /* Паспорт выпуска и эмитент — параллельно: карточка выпуска может не
     прийти (у ОФЗ её нет), но окно из-за этого падать не должно.
     Сбрасывать состояние здесь не нужно: список открывает окно с key по
     ISIN, значит под другую бумагу React смонтирует компонент заново. */
  useEffect(() => {
    if (!isin) return;
    let alive = true;
    fetchBondCard(isin).then(c => { if (alive) setCard(c); }).catch(() => {});
    fetchIssuerInfo(isin).then(i => { if (alive) setIssuer(i); }).catch(() => {});
    return () => { alive = false; };
  }, [isin]);

  useEffect(() => {
    if (issuer?.id == null) return;
    let alive = true;
    fetchEmitter(issuer.id).then(r => { if (alive) setEmitter(r); }).catch(() => {});
    return () => { alive = false; };
  }, [issuer?.id]);

  useEffect(() => {
    if (!issuer?.inn) return;
    let alive = true;
    fetchGirboByInn(issuer.inn).then(r => { if (alive) setGirbo(r); }).catch(() => {});
    fetchGirboDate().then(d => { if (alive) setGirboDate(d); }).catch(() => {});
    return () => { alive = false; };
  }, [issuer?.inn]);

  useEffect(() => {
    let alive = true;
    fetchFundamentals()
      .then(f => {
        if (!alive) return;
        setFdata(findIssuerFundamentals(f, [
          emitter?.title, emitter?.shortTitle, issuer?.title, issuer?.name, bond?.name,
        ]));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [emitter?.title, emitter?.shortTitle, issuer?.title, issuer?.name, bond?.name]);

  const stats = useMemo(() => ratioStats(fdata?.data?.fin), [fdata]);
  const period = useMemo(() => latestPeriodLine(fdata?.data?.q), [fdata]);

  if (!bond) return null;

  const matDate = bond.matDate || (card?.description?.MATDATE !== '0000-00-00' ? card?.description?.MATDATE : null);
  const offerDate = bond.offerDate || (card?.description?.OFFERDATE !== '0000-00-00' ? card?.description?.OFFERDATE : null);
  const paymentsPerYear = bond.couponPeriod ? 365 / bond.couponPeriod : (card?.couponFrequency ? +card.couponFrequency : null);
  const couponToPrice = bond.couponPercent != null && bond.price ? (bond.couponPercent / bond.price) * 100 : null;
  const issuerName = issuer?.shortTitle || issuer?.title || null;

  return (
    <Modal
      open
      onClose={onClose}
      width={620}
      title={bond.name || isin}
      subtitle={[
        issuerName,
        isin ? 'ISIN ' + isin : null,
        issuer?.inn ? 'ИНН ' + issuer.inn : null,
      ].filter(Boolean).join(' · ')}
      right={(
        <Link className="btn btn-sm btn-green" to={'/bond/' + isin} onClick={onClose}>
          Страница выпуска →
        </Link>
      )}
    >
      {/* ── Флаги выпуска одной строкой ───────────────────────────── */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {card?.hasDefault && <span className="tag r" style={{ fontWeight: 700 }}>ДЕФОЛТ</span>}
        {card?.hasTechDefault && <span className="tag a" style={{ fontWeight: 700 }}>Технический дефолт</span>}
        {card?.isQualified && <span className="tag p">Только для квалов</span>}
        {bond.isAmort && <span className="tag">Амортизация</span>}
        {bond.isCurrency && <span className="tag a">{bond.currency}</span>}
        {bond.couponKind && <CouponTag kind={bond.couponKind} />}
        {bond.listLevel != null && <span>Уровень листинга: <LevelTag level={bond.listLevel} /></span>}
        {card?.rating && <span>Рейтинг: <RatingTag rating={card.rating} code={card.ratingCode} own={card.ratingOwn} /></span>}
      </div>

      {/* ── Ключевые цифры выпуска ────────────────────────────────
          Ровно те, что биржа отдаёт по строке списка: цена, доходность,
          купон, дюрация, оферта, погашение. Остальное — на странице. */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))', marginBottom: 16 }}>
        <Kpi
          label="Цена, %"
          value={bond.price == null ? '—' : nf(bond.price, 2)}
          sub={bond.priceSrc === 'prev'
            ? (bond.priceChange == null ? 'предыдущий торговый день' : chgStrA(bond.priceChange) + ' за день')
            : (bond.priceChange == null ? 'от номинала' : chgStrA(bond.priceChange) + ' за день')}
        />
        <Kpi
          label="Доходность, %"
          value={bond.ytm == null ? 'н/д' : nf(bond.ytm, 2)}
          cls={ytmClass(bond.ytm)}
          sub={bond.ytm == null ? 'биржа не отдаёт' : (bond.yieldDateType === 'OFFER' ? 'к оферте' : 'к погашению')}
        />
        <Kpi
          label="Купон, %"
          value={bond.couponPercent == null ? '—' : nf(bond.couponPercent, 2)}
          sub={bond.couponValue == null ? 'ставка неизвестна' : (
            nf(bond.couponValue, 2) + (bond.currency === 'RUB' ? ' ₽' : ' ' + bond.currency) + ' за выплату'
          )}
        />
        <Kpi label="Купон к цене, %" value={couponToPrice == null ? '—' : nf(couponToPrice, 2)} sub="купон % ÷ цена × 100" />
        <Kpi
          label="Выплат в год"
          value={paymentsPerYear == null ? '—' : timesWord(paymentsPerYear)}
          sub={bond.couponPeriod ? `период ${bond.couponPeriod} дн.` : 'по данным MOEX'}
        />
        <Kpi label="Дюрация" value={duration(bond.durationDays)} sub={bond.durationDays != null ? nf(bond.durationDays, 0) + ' дней' : '—'} />
        <Kpi
          label="Оферта"
          value={offerDate ? dateShort(offerDate) : '—'}
          sub={offerDate ? timeLeft(offerDate) : 'оферты нет'}
        />
        <Kpi label="Погашение" value={matDate ? dateShort(matDate) : '—'} sub={matDate ? timeLeft(matDate) : 'даты нет'} />
      </div>

      {/* ── Кто за бумагой: та же карточка предприятия, что открывается
          с карточки выпуска и со страницы эмитента. Один компонент на
          все три входа — расходиться им нельзя. ───────────────────── */}
      <IssuerCard
        variant="detail"
        showBrief
        title={emitter?.title || issuer?.title}
        shortTitle={emitter?.shortTitle || issuer?.shortTitle}
        inn={emitter?.inn || issuer?.inn}
        ogrn={emitter?.ogrn}
        okpo={emitter?.okpo}
        country={emitter?.country}
        legalAddress={emitter?.legalAddress}
        postalAddress={emitter?.postalAddress}
        website={emitter?.website}
        capitalization={emitter?.capitalization}
        emitterCapitalization={emitter?.emitterCapitalization}
        capitalUpdatedAt={emitter?.capitalizationUpdatedAt}
        rating={card?.rating || bond?.rating}
        ratingCode={card?.ratingCode || bond?.ratingCode}
        bonds={[bond]}
        girbo={girbo}
        girboDate={girboDate}
        issuerKey={bond.issuerKey}
        emitterId={issuer?.id ?? emitter?.id}
        stats={stats}
        period={period}
      />

      {/* ── Куда идти дальше ────────────────────────────────────────
          «Страница выпуска →» стоит в шапке окна (как «Страница выпуска ↗»
          у оригинала), а на страницу эмитента ведёт зелёная кнопка внутри
          карточки — второй такой же ссылки здесь не нужно. */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
        {moexIssueUrl(bond.secid, bond.board) && (
          <a className="btn btn-sm" href={moexIssueUrl(bond.secid, bond.board)} target="_blank" rel="noopener noreferrer"
            title="Карточка выпуска на сайте Московской биржи">
            Выпуск на MOEX ↗
          </a>
        )}
      </div>
    </Modal>
  );
}
