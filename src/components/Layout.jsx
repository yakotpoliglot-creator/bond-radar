import { NavLink, useLocation } from 'react-router-dom';

/* ── Боковое меню в стиле bondradar (242px, секции, акцентная полоса) ── */

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

export default function Layout({ children, theme, setTheme }) {
  const loc = useLocation();

  return (
    <div className="app">
      <nav className="side">
        <NavLink to="/" className="logo">
          <span className="dot" />
          БондРадар
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