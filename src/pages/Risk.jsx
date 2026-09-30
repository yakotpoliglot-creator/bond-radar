import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchBonds } from '../api/moex';
import { Panel, Kpi, Loading, ErrorBox } from '../components/ui';
import { nf, money, duration, ytmTone } from '../lib/format';

/* Радар риска.
 *
 * Всё на этой странице ВЫЧИСЛЯЕТСЯ из данных Московской биржи: цена,
 * доходность, оборот, уровень листинга. Ни одного редакционного суждения
 * здесь нет — в том числе нет колонки вроде «преддефолтное состояние»
 * из оригинала: такие фразы пишет человек, а не формула, и поддерживать
 * их вручную мы не будем.
 *
 * Нет и кредитных рейтингов. Оригинал показывает их из своей базы
 * АКРА и Эксперт РА, биржа эти сведения не публикует. Поэтому KPI
 * «с риском для новичка» у нас нет — он без рейтинга не считается.
 */

/** Порог, с которого бумага считается проблемной зоной. */
const RISK_YTM = 40;

export default function Risk() {
  const [bonds, setBonds] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const b = await fetchBonds();
        if (alive) setBonds(b);
      } catch (e) {
        if (alive) setError(e);
      }
    })();
    return () => { alive = false; };
  }, []);

  const stat = useMemo(() => {
    if (!bonds) return null;
    const corp = bonds.filter(b => !b.isOfz && !b.isSubfederal);

    /* «Под давлением» — доходность выше порога И цена ниже номинала.
       Одной доходности мало: у бумаги с офертой через две недели она
       взлетает сама по себе, без всякого риска. Поэтому второе условие
       обязательно — рынок платит за риск только тогда, когда продаёт
       бумагу дешевле того, что эмитент обещает вернуть. */
    const pressure = bonds
      .filter(b => b.ytm != null && b.ytm > RISK_YTM && b.price != null && b.price < 95)
      .sort((a, b) => b.ytm - a.ytm);

    return {
      pressure,
      inZone: pressure.length,
      over30: bonds.filter(b => b.ytm != null && b.ytm > 30).length,
      over100: bonds.filter(b => b.ytm != null && b.ytm > 100).length,
      corpTraded: corp.filter(b => b.turnover != null && b.turnover > 0).length,
      corpAll: corp.length,
    };
  }, [bonds]);

  if (error) {
    return (
      <div>
        <div className="page-h">
          <div className="page-t">◇ Радар риска</div>
          <div className="page-s">Данные MOEX ISS недоступны</div>
        </div>
        <ErrorBox error={error} onRetry={() => window.location.reload()} />
      </div>
    );
  }

  if (!stat) {
    return (
      <div>
        <div className="page-h">
          <div className="page-t">◇ Радар риска</div>
          <div className="page-s">Загрузка данных Московской биржи…</div>
        </div>
        <Loading />
      </div>
    );
  }

  return (
    <div>
      <div className="page-h">
        <div className="page-t">◇ Радар риска</div>
        <div className="page-s">
          Выпуски, которые рынок продаёт заметно дешевле номинала · данные MOEX ISS
        </div>
      </div>

      <div className="lead" style={{ marginBottom: 14 }}>
        Доходность сама по себе — не признак проблемы: она бывает высокой у бумаги
        с офертой через месяц и у бумаги, которую просто никто не покупает. Поэтому
        здесь собраны выпуски, где сошлись <b>два</b> условия: доходность выше{' '}
        {RISK_YTM}% и цена ниже 95% от номинала. Второе и означает, что продавцов
        больше, чем покупателей. Это не приговор — несправедливо распроданные бумаги
        бывают, — но покупать их стоит, понимая, откуда взялась такая цена.
      </div>

      <div
        className="grid"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', marginBottom: 14 }}
      >
        <Kpi
          label="В проблемной зоне"
          value={nf(stat.inZone, 0)}
          cls="c-r"
          sub={`YTM > ${RISK_YTM}% и цена < 95%`}
        />
        <Kpi
          label="Доходность выше 30%"
          value={nf(stat.over30, 0)}
          cls="c-a"
          sub="по всем выпускам в базе"
        />
        <Kpi
          label="Доходность выше 100%"
          value={nf(stat.over100, 0)}
          cls="c-r"
          sub="рынок закладывает дефолт"
        />
        <Kpi
          label="Корп. бумаг в торгах"
          value={nf(stat.corpTraded, 0)}
          sub={`из ${nf(stat.corpAll, 0)} в базе`}
        />
      </div>

      <Panel
        title="Бумаги под давлением"
        right={
          <span className="c-3" style={{ fontSize: 11 }}>
            доходность выше {RISK_YTM}% · от худших
          </span>
        }
      >
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Выпуск</th>
                <th className="num">YTM</th>
                <th className="num">Цена, %</th>
                <th className="num">Купон, %</th>
                <th className="num">Дюрация</th>
                <th className="num">Оборот</th>
                <th>Что видно из данных</th>
              </tr>
            </thead>
            <tbody>
              {stat.pressure.slice(0, 60).map(b => {
                /* Пояснение собирается из самих чисел, а не пишется руками:
                   цена ниже номинала, срок до оферты, отсутствие сделок. */
                const parts = [`цена ${nf(b.price, 1)}% от номинала`];
                if (b.offerDate) parts.push('есть оферта');
                if (b.turnover == null || b.turnover === 0) parts.push('сегодня сделок не было');
                if (b.durationDays == null) parts.push('дюрация MOEX не рассчитана');
                return (
                  <tr key={b.secid}>
                    <td>
                      <Link to={'/bond/' + b.secid}>{b.shortname || b.name || b.secid}</Link>
                      <div className="c-3" style={{ fontSize: 11, marginTop: 2 }}>
                        {b.isOfz ? 'гос · ОФЗ' : b.isSubfederal ? 'гос · регион' : 'корп'}
                        {b.listLevel != null ? ` · ${b.listLevel} ур.` : ''}
                      </div>
                    </td>
                    <td className={'num ' + ytmTone(b.ytm)}>{nf(b.ytm, 2)}%</td>
                    <td className="num">{nf(b.price, 2)}</td>
                    <td className="num">{b.couponPercent == null ? '—' : nf(b.couponPercent, 2) + '%'}</td>
                    <td className="num">{duration(b.durationDays)}</td>
                    <td className="num">{b.turnover ? money(b.turnover) : '—'}</td>
                    <td className="c-3" style={{ fontSize: 11 }}>{parts.join(' · ')}</td>
                  </tr>
                );
              })}
              {!stat.pressure.length && (
                <tr><td colSpan={7} className="empty">Выпусков с такими условиями сейчас нет</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {stat.pressure.length > 60 && (
          <div className="c-3" style={{ fontSize: 11, marginTop: 8 }}>
            Показано 60 из {nf(stat.pressure.length, 0)} — остальные смотрите в скринере
            с фильтром по доходности.
          </div>
        )}
      </Panel>

      <Panel title="Чего здесь нет" style={{ marginTop: 14 }}>
        <div className="c-3" style={{ fontSize: 12, lineHeight: 1.7 }}>
          <p style={{ marginTop: 0 }}>
            <b>Кредитных рейтингов.</b> Оригинал показывает их из своей базы АКРА и
            Эксперт РА. Московская биржа рейтинги не публикует, в описании бумаги нет
            ни одного поля про рейтинг, а агентства данные в браузер не отдают. Поэтому
            показателя «с риском для новичка» здесь тоже нет: без рейтинга он не
            считается.
          </p>
          <p style={{ marginBottom: 0 }}>
            <b>Редакционных пометок.</b> Колонка «что видно из данных» собирается
            из самих чисел — цена, оферта, оборот, дюрация. Фраз вроде
            «преддефолтное состояние» вы здесь не встретите: их пишет человек, а
            не формула, и обновлять их вручную никто не будет.
          </p>
        </div>
      </Panel>
    </div>
  );
}
