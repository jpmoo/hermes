import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getToken } from './api';
import { isImageMime, isPdfMime, noteFileUrl, noteFileThumbnailUrl } from './attachmentUtils';
import { NavIconAttach } from './icons/NavIcons';
import './NoteAttachments.css';

const ZOOM_MIN = 0.35;
const ZOOM_MAX = 4;
const WHEEL_ZOOM_STEP = 1.09;

function clampScale(s) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s));
}

/** Contain natural size into a reasonable preview box (CSS px). */
function fitImageLayout(nw, nh) {
  const maxW = Math.min(typeof window !== 'undefined' ? window.innerWidth * 0.94 : 1100, 1100);
  const maxH = Math.min(typeof window !== 'undefined' ? window.innerHeight * 0.74 : 820, 820);
  let w = nw;
  let h = nh;
  if (w > maxW) {
    h = (h * maxW) / w;
    w = maxW;
  }
  if (h > maxH) {
    w = (w * maxH) / h;
    h = maxH;
  }
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
}

/**
 * Image preview: real scroll extents (pan), zoom-to-cursor / pinch focal via scroll compensation.
 * `outerRef` is the scroll viewport (same as parent zoomWrapRef).
 */
function AttachmentPreviewImageZoom({ url, alt, outerRef, scale, setScale, bumpZoomRef, resetNonce }) {
  const [fit, setFit] = useState(null);
  const scrollPendingRef = useRef(null);
  const imgRef = useRef(null);

  const onImgLoad = useCallback((e) => {
    const el = e.currentTarget;
    setFit(fitImageLayout(el.naturalWidth, el.naturalHeight));
  }, []);

  useLayoutEffect(() => {
    const im = imgRef.current;
    if (im?.complete && im.naturalWidth) {
      setFit(fitImageLayout(im.naturalWidth, im.naturalHeight));
    }
  }, [url]);

  useLayoutEffect(() => {
    const p = scrollPendingRef.current;
    const vp = outerRef.current;
    if (!p || !vp) return;
    const maxSl = Math.max(0, vp.scrollWidth - vp.clientWidth);
    const maxSt = Math.max(0, vp.scrollHeight - vp.clientHeight);
    vp.scrollLeft = Math.max(0, Math.min(p.sl, maxSl));
    vp.scrollTop = Math.max(0, Math.min(p.st, maxSt));
    scrollPendingRef.current = null;
  }, [scale, outerRef]);

  useLayoutEffect(() => {
    const vp = outerRef.current;
    if (!vp || !fit) return undefined;
    const center = () => {
      vp.scrollLeft = Math.max(0, (vp.scrollWidth - vp.clientWidth) / 2);
      vp.scrollTop = Math.max(0, (vp.scrollHeight - vp.clientHeight) / 2);
    };
    const id = requestAnimationFrame(center);
    return () => cancelAnimationFrame(id);
  }, [fit, url, resetNonce, outerRef]);

  useEffect(() => {
    const vp = outerRef.current;
    if (!vp || !fit) return undefined;

    const onWheel = (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const rect = vp.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const delta = -e.deltaY;
      const factor = delta > 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP;
      setScale((s0) => {
        const s1 = clampScale(s0 * factor);
        if (s1 === s0) return s0;
        scrollPendingRef.current = {
          sl: (mx + vp.scrollLeft) * (s1 / s0) - mx,
          st: (my + vp.scrollTop) * (s1 / s0) - my,
        };
        return s1;
      });
    };

    let pinch0 = null;
    const onTouchStart = (e) => {
      if (e.touches.length === 2) {
        const [a, b] = [e.touches[0], e.touches[1]];
        pinch0 = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      }
    };

    const onTouchMove = (e) => {
      if (e.touches.length !== 2 || pinch0 == null || pinch0 <= 0) return;
      e.preventDefault();
      const [a, b] = [e.touches[0], e.touches[1]];
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (d <= 0) return;
      const midX = (a.clientX + b.clientX) / 2;
      const midY = (a.clientY + b.clientY) / 2;
      const rect = vp.getBoundingClientRect();
      const mx = midX - rect.left;
      const my = midY - rect.top;
      const ratio = d / pinch0;
      pinch0 = d;
      setScale((s0) => {
        const s1 = clampScale(s0 * ratio);
        if (s1 === s0) return s0;
        scrollPendingRef.current = {
          sl: (mx + vp.scrollLeft) * (s1 / s0) - mx,
          st: (my + vp.scrollTop) * (s1 / s0) - my,
        };
        return s1;
      });
    };

    const onTouchEnd = () => {
      pinch0 = null;
    };

    vp.addEventListener('wheel', onWheel, { passive: false });
    vp.addEventListener('touchstart', onTouchStart, { passive: true });
    vp.addEventListener('touchmove', onTouchMove, { passive: false });
    vp.addEventListener('touchend', onTouchEnd, { passive: true });
    vp.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      vp.removeEventListener('wheel', onWheel);
      vp.removeEventListener('touchstart', onTouchStart);
      vp.removeEventListener('touchmove', onTouchMove);
      vp.removeEventListener('touchend', onTouchEnd);
      vp.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [fit, setScale, outerRef]);

  useEffect(() => {
    bumpZoomRef.current = (dir) => {
      const vp = outerRef.current;
      if (!vp || !fit) return;
      const rect = vp.getBoundingClientRect();
      const mx = rect.width / 2;
      const my = rect.height / 2;
      setScale((s0) => {
        const f = dir > 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP;
        const s1 = clampScale(s0 * f);
        if (s1 === s0) return s0;
        scrollPendingRef.current = {
          sl: (mx + vp.scrollLeft) * (s1 / s0) - mx,
          st: (my + vp.scrollTop) * (s1 / s0) - my,
        };
        return s1;
      });
    };
    return () => {
      bumpZoomRef.current = null;
    };
  }, [fit, setScale, outerRef, bumpZoomRef]);

  const panDragRef = useRef(null);

  const onPanPointerDown = useCallback(
    (e) => {
      if (e.button !== 0) return;
      if (e.pointerType === 'touch') return;
      const vp = outerRef.current;
      if (!vp || !fit) return;
      if (vp.scrollWidth <= vp.clientWidth + 2 && vp.scrollHeight <= vp.clientHeight + 2) return;
      panDragRef.current = { lastX: e.clientX, lastY: e.clientY };
      vp.style.cursor = 'grabbing';
      try {
        vp.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    },
    [fit, outerRef]
  );

  const onPanPointerMove = useCallback(
    (e) => {
      const d = panDragRef.current;
      const vp = outerRef.current;
      if (!d || !vp) return;
      const dx = e.clientX - d.lastX;
      const dy = e.clientY - d.lastY;
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      vp.scrollLeft -= dx;
      vp.scrollTop -= dy;
    },
    [outerRef]
  );

  const onPanPointerUp = useCallback(
    (e) => {
      const vp = outerRef.current;
      panDragRef.current = null;
      if (vp) {
        vp.style.cursor = '';
        try {
          vp.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }
    },
    [outerRef]
  );

  return (
    <div
      className="note-attachment-preview-zoom-wrap note-attachment-preview-zoom-wrap--image"
      ref={outerRef}
      onPointerDown={onPanPointerDown}
      onPointerMove={onPanPointerMove}
      onPointerUp={onPanPointerUp}
      onPointerCancel={onPanPointerUp}
    >
      <div
        className="note-attachment-preview-image-sizer"
        style={
          fit
            ? { width: fit.w * scale, height: fit.h * scale, margin: '0 auto' }
            : { minHeight: 'min(70vh, 560px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }
        }
      >
        <img
          ref={imgRef}
          src={url}
          alt={alt}
          draggable={false}
          onLoad={onImgLoad}
          className="note-attachment-preview-img note-attachment-preview-img--zoom"
          style={
            fit
              ? { width: '100%', height: '100%', objectFit: 'contain', display: 'block' }
              : { maxWidth: 'min(94vw, 1080px)', maxHeight: 'min(72vh, 800px)', width: 'auto', height: 'auto', opacity: 0.35 }
          }
        />
      </div>
    </div>
  );
}

function getReactPortalContainer() {
  if (typeof document === 'undefined') return null;
  return document.getElementById('root') || document.body;
}

function AttachmentPreviewModal({ att, url, kind, onClose, onDownload }) {
  const [scale, setScale] = useState(1);
  const [imageResetNonce, setImageResetNonce] = useState(0);
  const zoomWrapRef = useRef(null);
  const imageBumpRef = useRef(null);
  const pinchDistRef = useRef(null);

  useEffect(() => {
    setScale(1);
    setImageResetNonce((n) => n + 1);
  }, [url, kind]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  useEffect(() => {
    if (kind !== 'pdf') return undefined;
    const el = zoomWrapRef.current;
    if (!el) return undefined;

    const onWheel = (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const delta = -e.deltaY;
      const factor = delta > 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP;
      setScale((s) => clampScale(s * factor));
    };

    const touchDist = (touches) => {
      if (touches.length < 2) return 0;
      const a = touches[0];
      const b = touches[1];
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    };

    const onTouchStart = (e) => {
      if (e.touches.length === 2) {
        pinchDistRef.current = touchDist(e.touches);
      }
    };

    const onTouchMove = (e) => {
      if (e.touches.length !== 2 || pinchDistRef.current == null) return;
      e.preventDefault();
      const d = touchDist(e.touches);
      if (d <= 0 || pinchDistRef.current <= 0) return;
      const ratio = d / pinchDistRef.current;
      pinchDistRef.current = d;
      setScale((s) => clampScale(s * ratio));
    };

    const onTouchEnd = () => {
      pinchDistRef.current = null;
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [kind]);

  const bumpZoom = useCallback(
    (dir) => {
      if (kind === 'image' && typeof imageBumpRef.current === 'function') {
        imageBumpRef.current(dir);
        return;
      }
      setScale((s) => {
        const next = dir > 0 ? s * WHEEL_ZOOM_STEP : s / WHEEL_ZOOM_STEP;
        return clampScale(next);
      });
    },
    [kind]
  );

  const handleClosePointer = useCallback(
    (e) => {
      if (e.button != null && e.button !== 0) return;
      e.stopPropagation();
      onClose();
    },
    [onClose]
  );

  const portalParent = getReactPortalContainer();
  if (!url || !kind || !portalParent) return null;

  const pct = Math.round(scale * 100);

  return createPortal(
    <div
      className="note-attachment-preview-backdrop"
      data-note-attachment-preview
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="note-attachment-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="note-attachment-preview-title"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="note-attachment-preview-toolbar">
          <span id="note-attachment-preview-title" className="note-attachment-preview-title">
            {att.filename || 'Attachment'}
          </span>
          <div className="note-attachment-preview-toolbar-right">
            <div className="note-attachment-preview-zoom" role="group" aria-label="Zoom">
              <button
                type="button"
                className="note-attachment-preview-btn note-attachment-preview-btn--icon"
                onClick={() => bumpZoom(-1)}
                aria-label="Zoom out"
                title="Zoom out"
              >
                −
              </button>
              <span className="note-attachment-preview-zoom-pct" title="Two-finger pinch or Ctrl+scroll (trackpad)">
                {pct}%
              </span>
              <button
                type="button"
                className="note-attachment-preview-btn note-attachment-preview-btn--icon"
                onClick={() => bumpZoom(1)}
                aria-label="Zoom in"
                title="Zoom in"
              >
                +
              </button>
              <button
                type="button"
                className="note-attachment-preview-btn"
                onClick={() => {
                  setScale(1);
                  if (kind === 'image') setImageResetNonce((n) => n + 1);
                }}
                disabled={scale === 1}
                aria-label="Reset zoom"
                title="Reset zoom"
              >
                Reset
              </button>
            </div>
            <div className="note-attachment-preview-actions">
              <button
                type="button"
                className="note-attachment-preview-btn"
                onClick={onDownload}
                onPointerDown={(e) => {
                  if (e.button != null && e.button !== 0) return;
                  e.stopPropagation();
                }}
              >
                Download
              </button>
              <button
                type="button"
                className="note-attachment-preview-btn note-attachment-preview-btn--primary"
                onClick={onClose}
                onPointerDown={handleClosePointer}
              >
                Close
              </button>
            </div>
          </div>
        </div>
        {kind === 'image' ? (
          <AttachmentPreviewImageZoom
            url={url}
            alt={att.filename || ''}
            outerRef={zoomWrapRef}
            scale={scale}
            setScale={setScale}
            bumpZoomRef={imageBumpRef}
            resetNonce={imageResetNonce}
          />
        ) : (
          <div ref={zoomWrapRef} className="note-attachment-preview-zoom-wrap note-attachment-preview-zoom-wrap--pdf">
            <div
              className="note-attachment-preview-zoom-inner"
              style={{
                transform: `scale(${scale})`,
                transformOrigin: 'center top',
              }}
            >
              <iframe title={att.filename || 'PDF'} src={url} className="note-attachment-preview-iframe" />
            </div>
          </div>
        )}
      </div>
    </div>,
    portalParent
  );
}

function NonImageAttachmentPlaceholder() {
  return (
    <span className="note-attachment-file-placeholder" aria-hidden>
      <NavIconAttach className="note-attachment-file-placeholder__svg" width="100%" height="100%" />
    </span>
  );
}

/**
 * Oval profile image for person- and organization-type cards (stream/canvas).
 * Opens the same preview modal as attachment thumbnails.
 */
export function PersonProfileAvatar({ att }) {
  const [imgSrc, setImgSrc] = useState(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const isImage = isImageMime(att?.mime_type, att?.filename);

  useEffect(() => {
    if (!isImage || !att?.id) return undefined;
    let objectUrl;
    let cancelled = false;
    const t = getToken();
    fetch(noteFileUrl(att.id), { headers: t ? { Authorization: `Bearer ${t}` } : {} })
      .then((r) => (r.ok ? r.blob() : null))
      .then((blob) => {
        if (cancelled || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        setImgSrc(objectUrl);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setImgSrc(null);
    };
  }, [att?.id, isImage]);

  const download = useCallback(
    async (e) => {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      const t = getToken();
      const r = await fetch(noteFileUrl(att.id), { headers: t ? { Authorization: `Bearer ${t}` } : {} });
      if (!r.ok) return;
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = att.filename || 'download';
      a.click();
      URL.revokeObjectURL(a.href);
    },
    [att.id, att.filename]
  );

  const closePreview = useCallback(() => setPreviewOpen(false), []);

  if (!isImage || !att?.id) return null;

  return (
    <>
      {previewOpen && imgSrc ? (
        <AttachmentPreviewModal
          att={att}
          url={imgSrc}
          kind="image"
          onClose={closePreview}
          onDownload={(e) => download(e)}
        />
      ) : null}
      <button
        type="button"
        className="note-card-profile-avatar-btn"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (imgSrc) setPreviewOpen(true);
        }}
        disabled={!imgSrc}
        aria-label={`View ${att.filename || 'profile image'}`}
        title={att.filename || 'Profile image'}
      >
        {imgSrc ? (
          <img src={imgSrc} alt="" className="note-card-profile-avatar-img" />
        ) : (
          <span className="note-card-profile-avatar-skeleton" aria-hidden />
        )}
      </button>
    </>
  );
}

function AttachmentItem({
  att,
  index,
  total,
  onDeleted,
  onReorderPersist,
  reorderBusy,
  setReorderBusy,
  showBannerToggle,
  onToggleBanner,
  bannerBusy,
  selectedBannerAttachmentId,
  bannerSelectionControlled,
}) {
  const [imgSrc, setImgSrc] = useState(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewKind, setPreviewKind] = useState(null);
  const [pdfPreviewUrl, setPdfPreviewUrl] = useState(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfThumbSrc, setPdfThumbSrc] = useState(null);

  const isImage = isImageMime(att.mime_type, att.filename);
  const isPdf = isPdfMime(att.mime_type, att.filename);
  const showReorder = Boolean(onReorderPersist) && total > 1;
  const name = att.filename || 'File';

  useEffect(() => {
    if (!isImage) return undefined;
    let objectUrl;
    let cancelled = false;
    const t = getToken();
    fetch(noteFileUrl(att.id), { headers: t ? { Authorization: `Bearer ${t}` } : {} })
      .then((r) => (r.ok ? r.blob() : null))
      .then((blob) => {
        if (cancelled || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        setImgSrc(objectUrl);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setImgSrc(null);
    };
  }, [att.id, isImage]);

  useEffect(() => {
    if (!isPdf) return undefined;
    let objectUrl;
    let cancelled = false;
    const t = getToken();
    fetch(noteFileThumbnailUrl(att.id), { headers: t ? { Authorization: `Bearer ${t}` } : {} })
      .then((r) => (r.ok ? r.blob() : null))
      .then((blob) => {
        if (cancelled || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        setPdfThumbSrc(objectUrl);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setPdfThumbSrc(null);
    };
  }, [att.id, isPdf]);

  useEffect(() => {
    return () => {
      if (pdfPreviewUrl) URL.revokeObjectURL(pdfPreviewUrl);
    };
  }, [pdfPreviewUrl]);

  const download = useCallback(
    async (e) => {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      const t = getToken();
      const r = await fetch(noteFileUrl(att.id), { headers: t ? { Authorization: `Bearer ${t}` } : {} });
      if (!r.ok) return;
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = att.filename || 'download';
      a.click();
      URL.revokeObjectURL(a.href);
    },
    [att.id, att.filename]
  );

  const closePreview = useCallback(() => {
    setPreviewOpen(false);
    setPreviewKind(null);
    setPdfPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, []);

  const openPreview = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (isImage && imgSrc) {
      setPreviewKind('image');
      setPreviewOpen(true);
      return;
    }
    if (isPdf) {
      setPdfLoading(true);
      try {
        const t = getToken();
        const r = await fetch(noteFileUrl(att.id), { headers: t ? { Authorization: `Bearer ${t}` } : {} });
        if (!r.ok) throw new Error('fetch failed');
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        setPdfPreviewUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return url;
        });
        setPreviewKind('pdf');
        setPreviewOpen(true);
      } catch {
        window.alert('Could not load preview. Try Download instead.');
      } finally {
        setPdfLoading(false);
      }
    }
  };

  const onMoveLeft = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (index <= 0 || !onReorderPersist || reorderBusy) return;
    setReorderBusy(true);
    try {
      await onReorderPersist(index, index - 1);
    } finally {
      setReorderBusy(false);
    }
  };

  const onMoveRight = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (index >= total - 1 || !onReorderPersist || reorderBusy) return;
    setReorderBusy(true);
    try {
      await onReorderPersist(index, index + 1);
    } finally {
      setReorderBusy(false);
    }
  };

  const previewUrl = previewKind === 'image' ? imgSrc : previewKind === 'pdf' ? pdfPreviewUrl : null;

  const openNonImage = (e) => {
    e.preventDefault();
    e.stopPropagation();
    download(e);
  };
  const bannerChecked =
    bannerSelectionControlled
      ? String(selectedBannerAttachmentId) === String(att.id)
      : att.is_banner === true;

  return (
    <div className="note-attachment-tile">
      {previewOpen && previewUrl && previewKind ? (
        <AttachmentPreviewModal
          att={att}
          url={previewUrl}
          kind={previewKind}
          onClose={closePreview}
          onDownload={(e) => download(e)}
        />
      ) : null}
      <div className="note-attachment-thumb-frame">
        {isImage && imgSrc ? (
          <button
            type="button"
            className="note-attachment-thumb-hit"
            onClick={openPreview}
            aria-label={`Preview ${name}`}
          >
            <img src={imgSrc} alt="" className="note-attachment-thumb-img" />
          </button>
        ) : isPdf ? (
          <button
            type="button"
            className={`note-attachment-thumb-hit ${pdfThumbSrc ? '' : 'note-attachment-thumb-hit--file'}`}
            onClick={openPreview}
            disabled={pdfLoading}
            aria-label={`Preview PDF ${name}`}
          >
            {pdfThumbSrc ? (
              <img src={pdfThumbSrc} alt="" className="note-attachment-thumb-img" />
            ) : (
              <NonImageAttachmentPlaceholder />
            )}
          </button>
        ) : (
          <button type="button" className="note-attachment-thumb-hit note-attachment-thumb-hit--file" onClick={openNonImage}>
            <NonImageAttachmentPlaceholder />
          </button>
        )}
        {showReorder ? (
          <div className="note-attachment-reorder-cluster">
            <button
              type="button"
              className="note-attachment-reorder-btn"
              disabled={index === 0 || reorderBusy}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={onMoveLeft}
              aria-label="Move attachment left"
              title="Move left"
            >
              ‹
            </button>
            <button
              type="button"
              className="note-attachment-reorder-btn"
              disabled={index >= total - 1 || reorderBusy}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={onMoveRight}
              aria-label="Move attachment right"
              title="Move right"
            >
              ›
            </button>
          </div>
        ) : null}
        {onDeleted ? (
          <button
            type="button"
            className="note-attachment-remove"
            onClick={(e) => {
              e.stopPropagation();
              const nm = att.filename || 'this file';
              if (
                !window.confirm(
                  `Remove “${nm}” from this note?\n\nThe file will be permanently deleted from the server.`
                )
              ) {
                return;
              }
              onDeleted(att);
            }}
            aria-label={`Remove ${name}`}
            title="Remove file"
          >
            ×
          </button>
        ) : null}
      </div>
      <div className="note-attachment-tile-caption" title={name}>
        {name}
      </div>
      {showBannerToggle ? (
        <label className="note-attachment-banner-toggle" title="Render this image as the card header banner">
          <input
            type="checkbox"
            checked={bannerChecked}
            disabled={bannerBusy}
            onChange={(e) => {
              e.stopPropagation();
              onToggleBanner?.(att, e.target.checked);
            }}
            onClick={(e) => e.stopPropagation()}
          />
          <span>Banner</span>
        </label>
      ) : null}
    </div>
  );
}

export default function NoteAttachments({
  attachments,
  onDeleted,
  excludeAttachmentIds,
  onReorderAttachments,
  showBannerToggle = false,
  onToggleBanner = null,
  bannerBusy = false,
  bannerAttachmentId = undefined,
  bannerSelectionControlled = false,
}) {
  const [reorderBusy, setReorderBusy] = useState(false);

  if (!attachments?.length) return null;
  const exclude =
    excludeAttachmentIds != null && excludeAttachmentIds.length > 0
      ? new Set(excludeAttachmentIds.map((id) => String(id)))
      : null;
  const list = exclude
    ? attachments.filter((a) => a?.id != null && !exclude.has(String(a.id)))
    : attachments;
  if (!list.length) return null;

  const persistSwap = useCallback(
    async (i, j) => {
      if (!onReorderAttachments || i === j) return;
      /* API requires every blob on the note; visible list may omit profile image etc. */
      const norm = (x) => String(x ?? '').trim().toLowerCase();
      const fullIds = attachments.map((a) => norm(a.id));
      const idI = norm(list[i].id);
      const idJ = norm(list[j].id);
      const idxI = fullIds.indexOf(idI);
      const idxJ = fullIds.indexOf(idJ);
      if (idxI < 0 || idxJ < 0) {
        console.error('attachment reorder: id not in full list', { idI, idJ, fullIds, listIds: list.map((x) => norm(x.id)) });
        window.alert('Could not reorder attachments. Try refreshing the page.');
        return;
      }
      const next = [...fullIds];
      [next[idxI], next[idxJ]] = [next[idxJ], next[idxI]];
      await onReorderAttachments(next);
    },
    [attachments, list, onReorderAttachments]
  );

  return (
    <div className="note-attachments-row">
      {list.map((a, i) => (
        <AttachmentItem
          key={a.id}
          att={a}
          index={i}
          total={list.length}
          onDeleted={onDeleted}
          onReorderPersist={onReorderAttachments ? persistSwap : null}
          reorderBusy={reorderBusy}
          setReorderBusy={setReorderBusy}
          showBannerToggle={showBannerToggle && isImageMime(a.mime_type, a.filename)}
          onToggleBanner={onToggleBanner}
          bannerBusy={bannerBusy}
          selectedBannerAttachmentId={bannerAttachmentId}
          bannerSelectionControlled={bannerSelectionControlled}
        />
      ))}
    </div>
  );
}
