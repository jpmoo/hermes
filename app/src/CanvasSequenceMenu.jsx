import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  CANVAS_ARRANGEMENT,
  CANVAS_CONNECTOR_MODE,
  CANVAS_MANUAL_NEW_NOTE_ANCHOR,
} from './canvasLayoutApi';
import './CanvasSequenceMenu.css';

const ARR_OPTIONS = [
  { value: CANVAS_ARRANGEMENT.VERTICAL, label: 'Rearrange vertically by sort order' },
  { value: CANVAS_ARRANGEMENT.HORIZONTAL, label: 'Rearrange horizontally by sort order' },
  { value: CANVAS_ARRANGEMENT.MANUAL, label: 'Manual layout' },
];

const MANUAL_NEW_NOTE_OPTIONS = [
  {
    value: CANVAS_MANUAL_NEW_NOTE_ANCHOR.FOCUS,
    label: 'Place new notes near focus note',
  },
  {
    value: CANVAS_MANUAL_NEW_NOTE_ANCHOR.LAST,
    label: 'Place new notes near last note in sort order',
  },
];

const LINE_OPTIONS = [
  {
    value: CANVAS_CONNECTOR_MODE.FOCUS_TO_CHILDREN,
    label: 'Show line from focus note to each child',
  },
  {
    value: CANVAS_CONNECTOR_MODE.THREAD_CHAIN,
    label: 'Show thread from focus through each note in sort order',
  },
  {
    value: CANVAS_CONNECTOR_MODE.NONE,
    label: 'Do not show lines',
  },
];

/**
 * @param {{
 *   open: boolean,
 *   onOpenToggle: () => void,
 *   onClose: () => void,
 *   arrangement: string,
 *   connectorMode: string,
 *   onArrangementChange: (v: string) => void,
 *   onConnectorModeChange: (v: string) => void,
 *   showLines: boolean,
 *   onShowLinesChange: (v: boolean) => void,
 *   showLinesActive: boolean,
 *   manualNewNoteAnchor: string,
 *   onManualNewNoteAnchorChange: (v: string) => void,
 *   onApply: () => void,
 *   children: React.ReactNode,
 * }} props
 */
export default function CanvasSequenceMenu({
  open,
  onOpenToggle,
  onClose,
  arrangement,
  connectorMode,
  showLines,
  showLinesActive = true,
  manualNewNoteAnchor,
  onArrangementChange,
  onConnectorModeChange,
  onShowLinesChange,
  onManualNewNoteAnchorChange,
  onApply,
  children,
}) {
  const pickConnectorMode = (v) => {
    onConnectorModeChange(v);
    if (v === CANVAS_CONNECTOR_MODE.NONE) {
      onShowLinesChange(false);
    } else if (connectorMode === CANVAS_CONNECTOR_MODE.NONE) {
      onShowLinesChange(true);
    }
  };

  const [panelPos, setPanelPos] = useState(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);

  const updatePanelPos = useCallback(() => {
    if (!open) return;
    const el = triggerRef.current;
    if (!el || typeof window === 'undefined') return;
    const r = el.getBoundingClientRect();
    setPanelPos({
      top: r.bottom + 6,
      right: window.innerWidth - r.right,
    });
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setPanelPos(null);
      return;
    }
    updatePanelPos();
    const el = triggerRef.current;
    const ro =
      el && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => updatePanelPos())
        : null;
    if (el && ro) ro.observe(el);
    window.addEventListener('resize', updatePanelPos);
    window.addEventListener('scroll', updatePanelPos, true);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', updatePanelPos);
      window.removeEventListener('scroll', updatePanelPos, true);
    };
  }, [open, updatePanelPos]);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      const t = e.target;
      if (triggerRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDoc, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose]);

  const panel =
    open && panelPos ? (
      <div
        ref={panelRef}
        className="canvas-sequence-menu__panel canvas-sequence-menu__panel--portal"
        style={{ top: panelPos.top, right: panelPos.right }}
        role="dialog"
        aria-label="Canvas sequence and connectors"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="canvas-sequence-menu__section">
          <div className="canvas-sequence-menu__section-title">Card layout</div>
          {ARR_OPTIONS.map((o) => (
            <label key={o.value} className="canvas-sequence-menu__radio">
              <input
                type="radio"
                name="canvas-arrangement"
                value={o.value}
                checked={
                  o.value === CANVAS_ARRANGEMENT.MANUAL
                    ? arrangement === CANVAS_ARRANGEMENT.MANUAL || arrangement === CANVAS_ARRANGEMENT.KEEP
                    : arrangement === o.value
                }
                onChange={() => onArrangementChange(o.value)}
              />
              {o.label}
            </label>
          ))}
          {(arrangement === CANVAS_ARRANGEMENT.MANUAL || arrangement === CANVAS_ARRANGEMENT.KEEP) && (
            <>
              <div className="canvas-sequence-menu__section-title canvas-sequence-menu__section-title--sub">
                New notes (manual layout)
              </div>
              {MANUAL_NEW_NOTE_OPTIONS.map((o) => (
                <label key={o.value} className="canvas-sequence-menu__radio">
                  <input
                    type="radio"
                    name="canvas-manual-new-note"
                    value={o.value}
                    checked={manualNewNoteAnchor === o.value}
                    onChange={() => onManualNewNoteAnchorChange(o.value)}
                  />
                  {o.label}
                </label>
              ))}
            </>
          )}
        </div>
        <div className="canvas-sequence-menu__section">
          <label className="canvas-sequence-menu__check">
            <input
              type="checkbox"
              disabled={connectorMode === CANVAS_CONNECTOR_MODE.NONE}
              checked={connectorMode === CANVAS_CONNECTOR_MODE.NONE ? false : showLines}
              onChange={(e) => {
                const on = e.target.checked;
                if (!on) {
                  pickConnectorMode(CANVAS_CONNECTOR_MODE.NONE);
                } else {
                  onShowLinesChange(true);
                }
              }}
            />
            Show dashed connector lines
          </label>
          <div className="canvas-sequence-menu__section-title">Line display</div>
          {LINE_OPTIONS.map((o) => (
            <label key={o.value} className="canvas-sequence-menu__radio">
              <input
                type="radio"
                name="canvas-connector"
                value={o.value}
                checked={connectorMode === o.value}
                onChange={() => pickConnectorMode(o.value)}
              />
              {o.label}
            </label>
          ))}
        </div>
        <button type="button" className="canvas-sequence-menu__apply" onClick={onApply}>
          Apply
        </button>
      </div>
    ) : null;

  return (
    <div className="canvas-sequence-menu">
      <button
        ref={triggerRef}
        type="button"
        className={`canvas-icon-btn${open ? ' canvas-icon-btn--open' : ''}${
          showLinesActive ? '' : ' canvas-icon-btn--off'
        }`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Sequence lines and layout"
        title="Sequence lines and layout"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onOpenToggle();
        }}
      >
        {children}
      </button>
      {typeof document !== 'undefined' && panel ? createPortal(panel, document.body) : null}
    </div>
  );
}
