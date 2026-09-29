import { NavLink } from 'react-router-dom';
import './../styles/theme.css';

const navItems = [
  { to: '/', icon: '📊', label: 'Главная' },
  { to: '/screener', icon: '🔍', label: 'Скринер' },
  { to: '/collections', icon: '📂', label: 'Подборки' },
  { to: '/stocks', icon: '📈', label: 'Акции' },
];

const proItems = [
  { to: '/portfolio', icon: '💼', label: 'Мой портфель' },
  { to: '/favorites', icon: '⭐', label: 'Избранное' },
  { to: '/calendar', icon: '📅', label: 'Календарь' },
];

export default function Layout({ children, theme, setTheme }) {
  return (
    <div className="app-layout">
      <nav className="sidebar">
        <NavLink to="/" className="sidebar-logo" onClick={e => e.preventDefault()}>
          📉 BondRadar
        </NavLink>

        <div className="sidebar-section">Разделы</div>
        {navItems.map(item => (
          <NavLink key={item.to} to={item.to} end={item.to === '/'}
            className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}>
            <span>{item.icon}</span> {item.label}
          </NavLink>
        ))}

        <div className="sidebar-section">Личное</div>
        {proItems.map(item => (
          <NavLink key={item.to} to={item.to}
            className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}>
            <span>{item.icon}</span> {item.label}
          </NavLink>
        ))}

        <div style={{ marginTop: 'auto', paddingTop: 16 }}>
          <div style={{ display: 'flex', gap: 4, padding: '0 12px' }}>
            <button onClick={() => setTheme('light')}
              style={{ flex: 1, padding: '4px 8px', borderRadius: 4, border: '1px solid var(--border)', background: theme === 'light' ? 'var(--surface)' : 'var(--bg)', color: 'var(--text)', fontSize: 11, cursor: 'pointer' }}>
              ☀️ Светлая
            </button>
            <button onClick={() => setTheme('dark')}
              style={{ flex: 1, padding: '4px 8px', borderRadius: 4, border: '1px solid var(--border)', background: theme === 'dark' ? 'var(--surface)' : 'var(--bg)', color: 'var(--text)', fontSize: 11, cursor: 'pointer' }}>
              🌙 Тёмная
            </button>
          </div>
          <div style={{ fontSize: 10, color: 'var(--text3)', textAlign: 'center', marginTop: 8 }}>
            Данные MOEX · обновление при загрузке
          </div>
        </div>
      </nav>
      <main className="main-content">
        {children}
      </main>
    </div>
  );
}