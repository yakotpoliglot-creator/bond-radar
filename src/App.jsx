import { useState, useEffect } from 'react';
import { HashRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import ScreenerPage from './pages/Screener';
// Lazy pages will be added later
import './styles/theme.css';

function HomePage() {
  return (
    <div>
      <div className="page-header">
        <div className="page-title">📊 Главная</div>
        <div className="page-subtitle">Кривая доходности ОФЗ, индексы, ключевая ставка</div>
      </div>
      <div className="metrics-row">
        <div className="metric">
          <div className="metric-value metric-green">14.00%</div>
          <div className="metric-label">Ключевая ставка ЦБ</div>
        </div>
        <div className="metric">
          <div className="metric-value" style={{ color: 'var(--text)' }}>—</div>
          <div className="metric-label">RGBI</div>
        </div>
        <div className="metric">
          <div className="metric-value" style={{ color: 'var(--text)' }}>—</div>
          <div className="metric-label">Корп. индекс</div>
        </div>
      </div>
      <div className="card">
        <div className="card-header">
          <div className="card-title">Кривая доходности ОФЗ</div>
        </div>
        <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text3)' }}>
          График будет построен через Chart.js
        </div>
      </div>
      <div className="card">
        <div className="card-header">
          <div className="card-title">Индекс гособлигаций (RGBI)</div>
        </div>
        <div style={{ height: 250, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text3)' }}>
          График будет построен через Chart.js
        </div>
      </div>
    </div>
  );
}

function CollectionsPage() {
  const categories = [
    { name: 'ОФЗ', slug: 'ofz', desc: 'Государственные облигации' },
    { name: 'Флоатеры', slug: 'floatery', desc: 'Плавающий купон' },
    { name: 'Замещающие', slug: 'zameshchayushchie', desc: 'Валютная доходность в рублях' },
    { name: 'ВДО', slug: 'vysokodohodnye', desc: 'Высокодоходные (BBB и ниже)' },
    { name: 'Валютные', slug: 'valyutnye', desc: 'Доллар, евро, юань' },
    { name: 'С офертой', slug: 's-ofertoy', desc: 'Досрочный выкуп' },
    { name: 'Ежемесячный купон', slug: 'ezhemesyachnyy-kupon', desc: 'Выплаты каждый месяц' },
    { name: 'С амортизацией', slug: 's-amortizaciey', desc: 'Возврат номинала частями' },
    { name: 'Субординированные', slug: 'subord', desc: 'Младший долг банков' },
    { name: 'Короткие (< 1 года)', slug: 'korotkie', desc: 'Погашение до года' },
    { name: 'Длинные (> 10 лет)', slug: 'dlinnye', desc: 'Погашение через 10+ лет' },
    { name: 'AAA рейтинг', slug: 'aaa', desc: 'Высшая надежность' },
  ];
  return (
    <div>
      <div className="page-header">
        <div className="page-title">📂 Подборки облигаций</div>
        <div className="page-subtitle">Готовые подборки: живые данные MOEX</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
        {categories.map(cat => (
          <div key={cat.slug} className="card" style={{ cursor: 'pointer' }}
            onClick={() => window.location.hash = '#/screener?cat=' + cat.slug}>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{cat.name}</div>
            <div style={{ fontSize: 13, color: 'var(--text2)', marginTop: 4 }}>{cat.desc}</div>
            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 8 }}>
              откроется в скринере с фильтром
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StocksPage() {
  return (
    <div>
      <div className="page-header">
        <div className="page-title">📈 Акции Мосбиржи</div>
        <div className="page-subtitle">Цены, дивиденды, капитализация</div>
      </div>
      <div className="card">
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text3)' }}>
          Страница акций будет добавлена
        </div>
      </div>
    </div>
  );
}

function PortfolioPage() {
  return (
    <div>
      <div className="page-header">
        <div className="page-title">💼 Мой портфель</div>
        <div className="page-subtitle">Учёт позиций в браузере</div>
      </div>
      <div className="card">
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text3)' }}>
          Функция портфеля будет добавлена (localStorage)
        </div>
      </div>
    </div>
  );
}

function FavoritesPage() {
  return (
    <div>
      <div className="page-header">
        <div className="page-title">⭐ Избранное</div>
        <div className="page-subtitle">Сохранённые облигации</div>
      </div>
      <div className="card">
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text3)' }}>
          Функция избранного будет добавлена (localStorage)
        </div>
      </div>
    </div>
  );
}

function CalendarPage() {
  return (
    <div>
      <div className="page-header">
        <div className="page-title">📅 Календарь событий</div>
        <div className="page-subtitle">Ближайшие купоны, погашения, оферты</div>
      </div>
      <div className="card">
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text3)' }}>
          Календарь будет построен из bondization данных MOEX
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [theme, setTheme] = useState(
    () => localStorage.getItem('br-theme') ||
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  );

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('br-theme', theme);
  }, [theme]);

  return (
    <HashRouter>
      <Layout theme={theme} setTheme={setTheme}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/screener" element={<ScreenerPage />} />
          <Route path="/collections" element={<CollectionsPage />} />
          <Route path="/stocks" element={<StocksPage />} />
          <Route path="/portfolio" element={<PortfolioPage />} />
          <Route path="/favorites" element={<FavoritesPage />} />
          <Route path="/calendar" element={<CalendarPage />} />
        </Routes>
      </Layout>
    </HashRouter>
  );
}