/* ═══════════════════════════════════════════════════════════════════
   Новости рынка облигаций.

   Данные — public/news.json, его собирает робот (scripts/news.mjs)
   раз в три часа. Здесь только показ: фильтр по теме, поиск по
   заголовку и ссылка на первоисточник. Ничего своего сайт не пишет.

   Чего здесь намеренно НЕТ:
     · разборов и аналитики — это работа редакции, а не робота;
     · привязки новости к конкретному выпуску. Биржа называет бумагу
       прямо только в своих сообщениях, а по названию эмитента привязка
       даёт ложные срабатывания (у Сбербанка к одной новости «находится»
       634 выпуска, и 630 из них к ней отношения не имеют).
   ═══════════════════════════════════════════════════════════════════ */
import { useEffect, useMemo, useState } from 'react';
import { Panel, Loading, ErrorBox } from '../components/ui';

const TOPICS = [
  { id: 'all', label: 'Все' },
  { id: 'ставка', label: 'Ключевая ставка' },
  { id: 'ОФЗ', label: 'ОФЗ и Минфин' },
  { id: 'размещения', label: 'Размещения' },
  { id: 'рейтинги', label: 'Рейтинги' },
  { id: 'дефолты', label: 'Дефолты' },
  { id: 'эмитенты', label: 'Эмитенты' },
  { id: 'биржа', label: 'Биржа' },
  { id: 'рынок', label: 'Рынок' },
];

/* Время показываем по-человечески: сегодня — «14:32», вчера — «вчера
   14:32», раньше — «29 окт 14:32». Даты в файле уже московские. */
function whenStr(ts) {
  if (!ts) return '';
  const [datePart, timePart] = ts.split(' ');
  const [y, m, d] = datePart.split('-').map(Number);
  const now = new Date();
  const msk = new Date(now.getTime() + (now.getTimezoneOffset() + 180) * 60000);
  const today = new Date(msk.getFullYear(), msk.getMonth(), msk.getDate());
  const day = new Date(y, m - 1, d);
  const diff = Math.round((today - day) / 86400000);
  if (diff === 0) return timePart || '';
  if (diff === 1) return `вчера ${timePart || ''}`.trim();
  if (diff > 1 && diff < 7) {
    const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
    return `${d} ${MONTHS[m - 1]} ${timePart || ''}`.trim();
  }
  return ts;
}

/** Дата для группировки: «Сегодня», «Вчера» или «29 октября». */
function dayStr(ts) {
  if (!ts) return '';
  const [datePart] = ts.split(' ');
  const [y, m, d] = datePart.split('-').map(Number);
  const now = new Date();
  const msk = new Date(now.getTime() + (now.getTimezoneOffset() + 180) * 60000);
  const today = new Date(msk.getFullYear(), msk.getMonth(), msk.getDate());
  const day = new Date(y, m - 1, d);
  const diff = Math.round((today - day) / 86400000);
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Вчера';
  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  return `${d} ${MONTHS[m - 1]}`;
}

export default function NewsPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [topic, setTopic] = useState('all');
  const [q, setQ] = useState('');

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true); setError(null);
    try {
      const base = import.meta.env?.BASE_URL || '/';
      const r = await fetch(`${base}news.json`, { credentials: 'omit' });
      if (!r.ok) throw new Error(`лента недоступна (HTTP ${r.status})`);
      setData(await r.json());
    } catch (e) { setError(e); }
    finally { setLoading(false); }
  }

  const items = data?.items || [];

  /* Счётчики по темам — по всему окну, а не по выборке: так видно,
     есть ли вообще новости в теме, прежде чем её включать. */
  const counts = useMemo(() => {
    const c = { all: items.length };
    for (const it of items) c[it.topic] = (c[it.topic] || 0) + 1;
    return c;
  }, [items]);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter(it => {
      if (topic !== 'all' && it.topic !== topic) return false;
      if (!needle) return true;
      return `${it.title} ${it.excerpt || ''} ${it.src || ''}`.toLowerCase().includes(needle);
    });
  }, [items, topic, q]);

  /* Группировка по дням: лента плоским списком читается хуже. */
  const groups = useMemo(() => {
    const out = [];
    for (const it of list) {
      const day = dayStr(it.ts);
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(it);
      else out.push({ day, items: [it] });
    }
    return out;
  }, [list]);

  if (loading) return <Loading text="Загружаем ленту новостей…" />;
  if (error) {
    return (
      <div>
        <div className="page-h">
          <div className="page-t">Новости</div>
          <div className="page-s">Лента рынка облигаций</div>
        </div>
        <ErrorBox error={error} onRetry={load} />
        <Panel>
          <div className="c-3" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
            Ленту собирает робот раз в три часа. Если файла нет вовсе, значит робот
            ещё ни разу не отработал — остальной сайт от этого не зависит.
          </div>
        </Panel>
      </div>
    );
  }

  const stats = data?.stats || {};
  const updated = data?.generatedAt ? new Date(data.generatedAt) : null;

  return (
    <div>
      <div className="page-h">
        <div className="page-t">Новости</div>
        <div className="page-s">
          Что происходит на рынке облигаций: ставка, ОФЗ, размещения, рейтинги и дефолты
        </div>
      </div>

      <Panel>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {TOPICS.map(t => {
            const n = counts[t.id] || 0;
            if (t.id !== 'all' && !n) return null;
            return (
              <button
                key={t.id}
                className={'chip' + (topic === t.id ? ' on' : '')}
                onClick={() => setTopic(t.id)}
                title={t.id === 'all' ? 'Вся лента' : `Только тема «${t.label}»`}
              >
                {t.label}{t.id !== 'all' ? ` · ${n}` : ` · ${n}`}
              </button>
            );
          })}
        </div>

        <input
          className="inp"
          style={{ width: '100%', maxWidth: 420, marginBottom: 12 }}
          placeholder="поиск по заголовку, например «ОФЗ» или «МГКЛ»"
          value={q}
          onChange={e => setQ(e.target.value)}
        />

        <div className="c-3" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
          Показано {list.length} из {items.length} новостей · окно {data?.window?.days || 14} дней
          {updated ? ` · собрано ${updated.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}` : ''}
          {stats.feedsOk != null ? ` · источников ответило ${stats.feedsOk} из ${stats.feedsTotal}` : ''}
        </div>
      </Panel>

      {!list.length && (
        <Panel>
          <div className="empty" style={{ padding: '30px 20px' }}>
            {q ? 'По этому запросу ничего не нашлось' : 'В этой теме сейчас нет новостей'}
            {topic !== 'all' && (
              <div style={{ marginTop: 10 }}>
                <button className="btn btn-sm" onClick={() => { setTopic('all'); setQ(''); }}>
                  Показать всю ленту
                </button>
              </div>
            )}
          </div>
        </Panel>
      )}

      {groups.map(g => (
        <div key={g.day} style={{ marginBottom: 14 }}>
          <div
            style={{
              fontSize: 12, fontWeight: 700, color: 'var(--text3)',
              textTransform: 'uppercase', letterSpacing: 0.4,
              margin: '4px 2px 8px',
            }}
          >
            {g.day}
          </div>
          <Panel pad={false}>
            {g.items.map((it, i) => (
              <article
                key={`${it.ts}-${i}`}
                style={{
                  padding: '13px 16px',
                  borderTop: i ? '1px solid var(--border)' : 'none',
                }}
              >
                <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
                  <div className="mono c-3" style={{ fontSize: 11, minWidth: 84, flexShrink: 0 }}>
                    {whenStr(it.ts)}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 14, lineHeight: 1.35 }}>
                      {it.url ? (
                        <a href={it.url} target="_blank" rel="noopener noreferrer nofollow" title="Открыть первоисточник">
                          {it.title}
                        </a>
                      ) : (
                        it.title
                      )}
                    </div>

                    {/* У части лент (smart-lab) описание — это тот же
                        заголовок. Показывать его второй раз незачем. */}
                    {it.excerpt && it.excerpt.trim() !== it.title.trim() && (
                      <div className="c-2" style={{ fontSize: 12.5, lineHeight: 1.5, marginTop: 4 }}>
                        {it.excerpt}
                      </div>
                    )}

                    <div className="c-3" style={{ fontSize: 11, marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span>{it.src}</span>
                      {it.ticker && <span className="tag b" style={{ fontSize: 10 }}>{it.ticker}</span>}
                      {topic === 'all' && it.topic && it.topic !== 'рынок' && (
                        <span className="tag" style={{ fontSize: 10 }}>{it.topic}</span>
                      )}
                      {it.alsoIn?.length ? <span>ещё писали: {it.alsoIn.join(', ')}</span> : null}
                      {it.url && (
                        <a href={it.url} target="_blank" rel="noopener noreferrer nofollow">источник ↗</a>
                      )}
                    </div>
                  </div>
                </div>
              </article>
            ))}
          </Panel>
        </div>
      ))}

      <Panel title="Откуда эти новости и почему здесь нет разборов">
        <div style={{ fontSize: 12.5, lineHeight: 1.65, color: 'var(--text2)' }}>
          <p style={{ marginTop: 0 }}>
            <b>Источники.</b> Рубрики «Ведомости. Финансы» и «Коммерсантъ. Финансы», новости
            компаний smart-lab, лента Московской биржи и поиск Google News по темам рынка
            облигаций. У каждой новости — дата, издание и ссылка на первоисточник: полный
            текст читайте там, где он написан.
          </p>
          <p>
            <b>Почему не общие новостные ленты.</b> Пробовали: в общей ленте Интерфакса и
            ТАСС приходит всё подряд — городские происшествия, военная хроника, спорт. Ставить
            это рядом с облигациями значит засорять ленту. Поэтому источники профильные, а
            лишнее (без единого слова о рынке в заголовке) отсеивается.
          </p>
          <p>
            <b>Почему нет разборов.</b> Разбор — это текст от автора, который отвечает за
            каждое слово. Робот так не может, а выдавать пересказ за аналитику мы не станем.
            Здесь только то, что написали другие издания, с ссылками на них.
          </p>
          <p>
            <b>Почему нет привязки к вашей бумаге.</b> Биржа называет бумагу прямо только в
            своих сообщениях (они помечены кодом бумаги). А если цеплять новость к выпуску по
            названию эмитента, получается неверно: у одного только Сбербанка к новости
            «получил 6 тыс. обращений» относится 634 выпуска, и к самой новости они отношения
            не имеют. Поэтому для своей бумаги смотрите ленту биржи и карточку выпуска.
          </p>
          <p style={{ marginBottom: 0 }}>
            <b>Обновление.</b> Робот обновляет ленту раз в три часа. Данные предоставляются
            «как есть» и не являются индивидуальной инвестиционной рекомендацией.
          </p>
        </div>
      </Panel>
    </div>
  );
}
