import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useTheme } from './lib/store';
import Layout from './components/Layout';
import './styles/theme.css';

import Home from './pages/Home';
import Screener from './pages/Screener';
import BondCard from './pages/BondCard';
import Issuer from './pages/Issuer';
import Issuers from './pages/Issuers';
import Collections from './pages/Collections';
import Stocks from './pages/Stocks';
import StockCard from './pages/StockCard';
import Portfolio from './pages/Portfolio';
import Favorites from './pages/Favorites';
import CalendarPage from './pages/Calendar';
import Placements from './pages/Placements';
import Risk from './pages/Risk';

export default function App() {
  const [theme, setTheme] = useTheme();

  return (
    <HashRouter>
      <Layout theme={theme} setTheme={setTheme}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/screener" element={<Screener />} />
          <Route path="/bond/:id" element={<BondCard />} />
          <Route path="/issuer/:key" element={<Issuer />} />
          <Route path="/issuers" element={<Issuers />} />
          <Route path="/collections" element={<Collections />} />
          <Route path="/collections/:slug" element={<Collections />} />
          <Route path="/stocks" element={<Stocks />} />
          <Route path="/stock/:secid" element={<StockCard />} />
          <Route path="/portfolio" element={<Portfolio />} />
          <Route path="/favorites" element={<Favorites />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/placements" element={<Placements />} />
          <Route path="/risk" element={<Risk />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </HashRouter>
  );
}