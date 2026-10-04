import { useEffect, useRef } from 'react';

/* ── Модальное окно ──────────────────────────────────────────────────
 *
 * Как в оригинале (`#bond-detail-modal`): затемнение с размытием на весь
 * экран, окно 580px по центру, липкая шапка с заголовком и ✕, тело со
 * своей прокруткой. Закрывается тремя привычными способами — по ✕, по
 * Esc и по клику мимо окна, чтобы выход не приходилось искать.
 *
 * Почему окно, а не страница: карточка предприятия стояла и на карточке
 * выпуска, и на странице эмитента — один и тот же блок в двух местах.
 * Теперь она одна и открывается окном с обеих страниц.
 *
 * Прокрутку страницы под окном выключаем: иначе колесо мыши уводит
 * список под попапом, и это читается как поломка.
 */
export default function Modal({ open, title, subtitle, right, onClose, children, width = 580 }) {
  const closeRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onKey = e => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose?.(); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.3)', zIndex: 400,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12,
        backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : 'Карточка предприятия'}
        style={{
          background: 'var(--surface)', borderRadius: 14, width, maxWidth: '95vw',
          maxHeight: '85vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.15)',
        }}
      >
        <div style={{
          padding: '18px 20px', borderBottom: '1px solid var(--border)', display: 'flex',
          alignItems: 'center', justifyContent: 'space-between', gap: 10, position: 'sticky',
          top: 0, background: 'var(--surface)', zIndex: 1,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{title}</div>
            {subtitle ? <div className="c-3" style={{ fontSize: 11.5, marginTop: 3 }}>{subtitle}</div> : null}
          </div>
          <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexShrink: 0 }}>
            {right}
            <button
              ref={closeRef}
              onClick={onClose}
              aria-label="Закрыть"
              title="Закрыть (Esc)"
              style={{
                background: 'none', border: '1px solid var(--border)', width: 28, height: 28,
                borderRadius: 6, cursor: 'pointer', fontSize: 15, lineHeight: 1, color: 'inherit',
              }}
            >✕</button>
          </div>
        </div>
        <div style={{ padding: 20 }}>{children}</div>
      </div>
    </div>
  );
}
