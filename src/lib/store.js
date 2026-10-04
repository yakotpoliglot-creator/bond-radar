import { useState, useEffect, useCallback } from 'react';

/* ── localStorage-хранилище с синхронизацией между вкладками ─────── */

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

export function useLocalState(key, initial) {
  const [value, setValue] = useState(() => read(key, initial));

  useEffect(() => {
    const onStorage = e => { if (e.key === key) setValue(read(key, initial)); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [key]);

  const set = useCallback(v => {
    setValue(prev => {
      const next = typeof v === 'function' ? v(prev) : v;
      try { localStorage.setItem(key, JSON.stringify(next)); } catch {}
      return next;
    });
  }, [key]);

  return [value, set];
}

/* ── Избранное ───────────────────────────────────────────────────── */
export function useFavorites() {
  const [list, setList] = useLocalState('br:favorites', []);
  const has = useCallback(isin => list.includes(isin), [list]);
  const toggle = useCallback(isin => {
    setList(prev => prev.includes(isin) ? prev.filter(x => x !== isin) : [...prev, isin]);
  }, [setList]);
  return { list, has, toggle };
}

/* ── Портфель ────────────────────────────────────────────────────── */
// Позиция: { isin, secid, shortname, qty, buyPrice, buyDate }
export function usePortfolio() {
  const [positions, setPositions] = useLocalState('br:portfolio', []);

  const add = useCallback(pos => {
    setPositions(prev => [...prev, { id: Date.now() + Math.random().toString(36).slice(2, 7), ...pos }]);
  }, [setPositions]);

  const remove = useCallback(id => {
    setPositions(prev => prev.filter(p => p.id !== id));
  }, [setPositions]);

  const update = useCallback((id, patch) => {
    setPositions(prev => prev.map(p => (p.id === id ? { ...p, ...patch } : p)));
  }, [setPositions]);

  return { positions, add, remove, update };
}

/* ── Тема ────────────────────────────────────────────────────────── */
export function useTheme() {
  const [theme, setTheme] = useLocalState('br:theme', 'light');
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);
  return [theme, setTheme];
}

/* ── Крупный шрифт ─────────────────────────────────────────────────
 * Заказчик смотрит сайт в очках, и ему мало того размера, который удобен
 * остальным. Кнопка «Крупнее» в меню поднимает текст во всём интерфейсе,
 * выбор запоминается в браузере — как тема. Это не зум страницы: размеры
 * у нас заданы в пикселях, поэтому в theme.css есть отдельный набор
 * правил html[data-big="1"], который увеличивает именно то, что читают
 * глазами, и не трогает сетку. */
export function useBigFont() {
  const [big, setBig] = useLocalState('br:big', false);
  useEffect(() => {
    document.documentElement.setAttribute('data-big', big ? '1' : '0');
  }, [big]);
  return [big, setBig];
}