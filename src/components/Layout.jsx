import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

/* ── Боковое меню в стиле bondradar (242px, секции, акцентная полоса) ──
 *
 * На экранах до 900px меню превращается в выдвижную панель:
 * появляется шапка с бургером, меню уезжает влево и выезжает по тапу,
 * под ним — затемнение. Раньше этого не было: CSS прятал меню
 * (transform: translateX(-100%)), но класс .open никто не выставлял,
 * и на телефоне навигация пропадала совсем.
 */

const SECTIONS = [
  {
    title: 'Инструменты',
    items: [
      { to: '/', icon: '◉', label: 'Главная', end: true },
      { to: '/screener', icon: '☰', label: 'Скринер облигаций' },
      { to: '/issuers', icon: '▣', label: 'Эмитенты' },
      { to: '/stocks', icon: '◈', label: 'Акции Мосбиржи' },
      { to: '/calendar', icon: '▤', label: 'Календарь событий' },
      { to: '/placements', icon: '◈', label: 'Размещения' },
    ],
  },
  {
    title: 'Подборки',
    items: [
      { to: '/collections/ofz', icon: '◆', label: 'ОФЗ' },
      { to: '/collections/floatery', icon: '◆', label: 'Флоатеры' },
      { to: '/collections/valyutnye', icon: '◆', label: 'Валютные' },
      { to: '/collections/zameshchayushchie', icon: '◆', label: 'Замещающие' },
      { to: '/collections/vysokodohodnye', icon: '◆', label: 'Высокодоходные' },
      { to: '/collections/s-ofertoy', icon: '◆', label: 'С офертой' },
      { to: '/collections', icon: '▦', label: 'Все подборки' },
    ],
  },
  {
    title: 'Личное',
    items: [
      { to: '/portfolio', icon: '▥', label: 'Мой портфель' },
      { to: '/favorites', icon: '★', label: 'Избранное' },
    ],
  },
];

const ALL_ITEMS = SECTIONS.flatMap(s => s.items);

/** Что показать в шапке справа — название текущего раздела. */
function currentLabel(pathname) {
  const exact = ALL_ITEMS.find(i => i.to === pathname);
  if (exact) return exact.label;
  if (pathname.startsWith('/bond/')) return 'Карточка выпуска';
  if (pathname.startsWith('/issuer/')) return 'Эмитент';
  if (pathname.startsWith('/collections/')) return 'Подборка';
  return null;
}

export default function Layout({ children, theme, setTheme }) {
  const loc = useLocation();
  const [open, setOpen] = useState(false);

  /* Перешли на другую страницу — меню закрываем. */
  useEffect(() => { setOpen(false); }, [loc.pathname]);

  /* Esc закрывает меню; пока оно открыто, страница под ним не скроллится. */
  useEffect(() => {
    if (!open) return undefined;
    const onKey = e => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  const label = currentLabel(loc.pathname);

  return (
    <div className="app">
      {/* ── Шапка с бургером: видна только на узких экранах ───────── */}
      <header className="topbar">
        <button
          type="button"
          className="burger"
          onClick={() => setOpen(o => !o)}
          aria-label={open ? 'Закрыть меню' : 'Открыть меню'}
          aria-expanded={open}
        >
          {open ? '✕' : '☰'}
        </button>
        <span className="topbar-t">ПапаБонд</span>
        {label ? <span className="topbar-cur">{label}</span> : null}
      </header>

      {/* ── Затемнение: тап по нему закрывает меню ────────────────── */}
      <div
        className={'backdrop' + (open ? ' show' : '')}
        onClick={() => setOpen(false)}
        aria-hidden="true"
      />

      <nav className={'side' + (open ? ' open' : '')}>
        <NavLink to="/" className="logo">
          <span className="dot" />
          ПапаБонд
        </NavLink>

        {SECTIONS.map(sec => (
          <div key={sec.title}>
            <div className="side-sec">{sec.title}</div>
            {sec.items.map(it => (
              <NavLink
                key={it.to}
                to={it.to}
                end={it.end}
                className={({ isActive }) => 'ni' + (isActive ? ' on' : '')}
              >
                <span className="ico">{it.icon}</span>
                {it.label}
              </NavLink>
            ))}
          </div>
        ))}

        <div className="side-foot">
          <div className="theme-sw">
            <button className={theme === 'light' ? 'on' : ''} onClick={() => setTheme('light')}>Светлая</button>
            <button className={theme === 'dark' ? 'on' : ''} onClick={() => setTheme('dark')}>Тёмная</button>
          </div>
          <div style={{ fontSize: 10, color: 'var(--text3)', textAlign: 'center', marginTop: 9, lineHeight: 1.5 }}>
            Данные Московской биржи<br />
            <span className="mono">{loc.pathname}</span>
          </div>
        </div>
      </nav>

      <main className="main">{children}</main>
    </div>
  );
}