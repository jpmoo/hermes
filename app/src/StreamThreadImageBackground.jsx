import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getToken } from './api';
import { noteFileUrl } from './attachmentUtils';
import './StreamThreadImageBackground.css';

function resolveImageFetchUrl(attachmentId, fetchUrl) {
  if (typeof fetchUrl === 'string' && fetchUrl.trim()) return fetchUrl.trim();
  if (attachmentId) return noteFileUrl(attachmentId);
  return null;
}

const DRIFT_SPEED = 6;
/** Pan box is this fraction of the viewport; extra margin = (PAN_FRAC - 1) / 2 per side. */
const PAN_FRAC = 1.22;

function randomVelocity() {
  const a = Math.random() * Math.PI * 2;
  return { x: Math.cos(a) * DRIFT_SPEED, y: Math.sin(a) * DRIFT_SPEED };
}

export default function StreamThreadImageBackground({
  attachmentId,
  fetchUrl,
  imageOpacity,
  animate = true,
  crtEffect = false,
  /** Cover the full browser viewport (not only the Stream column). */
  fullViewport = true,
}) {
  const [blobUrl, setBlobUrl] = useState(null);
  const wrapRef = useRef(null);
  const innerRef = useRef(null);
  const posRef = useRef({ x: 0, y: 0 });
  const velRef = useRef(randomVelocity());
  const slackRef = useRef({ x: 40, y: 40 });
  const rafRef = useRef(null);

  const resolvedFetchUrl = resolveImageFetchUrl(attachmentId, fetchUrl);

  useEffect(() => {
    if (!resolvedFetchUrl) {
      setBlobUrl(null);
      return undefined;
    }
    let cancelled = false;
    let objectUrl;
    const t = getToken();
    fetch(resolvedFetchUrl, { headers: t ? { Authorization: `Bearer ${t}` } : {} })
      .then((r) => (r.ok ? r.blob() : null))
      .then((blob) => {
        if (cancelled || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setBlobUrl(null);
    };
  }, [resolvedFetchUrl]);

  useEffect(() => {
    posRef.current = { x: 0, y: 0 };
    if (animate) velRef.current = randomVelocity();
  }, [resolvedFetchUrl, animate]);

  useLayoutEffect(() => {
    if (!blobUrl || !innerRef.current) return;
    if (!animate) {
      innerRef.current.style.transform = 'translate(-50%, -50%)';
    }
  }, [blobUrl, animate]);

  useEffect(() => {
    if (!blobUrl || !wrapRef.current || !animate) return undefined;

    const measure = () => {
      const el = wrapRef.current;
      if (!el) return;
      const w = el.clientWidth;
      const h = el.clientHeight;
      const extra = PAN_FRAC - 1;
      slackRef.current = {
        x: (extra / 2) * w,
        y: (extra / 2) * h,
      };
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrapRef.current);

    let last = performance.now();
    const tick = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const { x: maxX, y: maxY } = slackRef.current;
      let { x, y } = posRef.current;
      const { x: vx, y: vy } = velRef.current;
      x += vx * dt;
      y += vy * dt;
      let bounced = false;
      if (x > maxX) {
        x = maxX;
        bounced = true;
      } else if (x < -maxX) {
        x = -maxX;
        bounced = true;
      }
      if (y > maxY) {
        y = maxY;
        bounced = true;
      } else if (y < -maxY) {
        y = -maxY;
        bounced = true;
      }
      if (bounced) {
        velRef.current = randomVelocity();
      }
      posRef.current = { x, y };
      if (innerRef.current) {
        innerRef.current.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      ro.disconnect();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [blobUrl, animate]);

  useEffect(() => {
    if (!fullViewport || typeof document === 'undefined') return undefined;
    if (!resolvedFetchUrl) return undefined;
    document.documentElement.classList.add('hermes-viewport-bg-active');
    return () => {
      document.documentElement.classList.remove('hermes-viewport-bg-active');
    };
  }, [fullViewport, resolvedFetchUrl]);

  const op =
    typeof imageOpacity === 'number' && Number.isFinite(imageOpacity)
      ? Math.min(1, Math.max(0, imageOpacity))
      : 0.35;

  if (!blobUrl) return null;

  const rootClass = [
    'stream-thread-image-bg',
    fullViewport && 'stream-thread-image-bg--viewport',
    !animate && 'stream-thread-image-bg--static',
    crtEffect && 'stream-thread-image-bg--crt',
  ]
    .filter(Boolean)
    .join(' ');

  const layer = (
    <div
      className={rootClass}
      ref={wrapRef}
      aria-hidden
      style={{
        '--stream-thread-bg-opacity': String(op),
      }}
    >
      <div className="stream-thread-image-bg__pan" ref={innerRef}>
        <img src={blobUrl} alt="" className="stream-thread-image-bg__img" draggable={false} />
      </div>
    </div>
  );

  if (fullViewport && typeof document !== 'undefined') {
    return createPortal(layer, document.body);
  }
  return layer;
}
