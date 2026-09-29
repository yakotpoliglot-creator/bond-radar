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