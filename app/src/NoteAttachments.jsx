import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { getToken } from './api';
import { isImageMime, noteFileUrl } from './attachmentUtils';
import './NoteAttachments.css';

function isPdfMime(m, filename) {
  if (m === 'application/pdf') return true;
  if (typeof filename === 'string' && filename.toLowerCase().endsWith('.pdf')) return true;
  return false;
}

function AttachmentPreviewModal({ att, url, kind, onClose, onDownload }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  if (!url || !kind) return null;

  return createPortal(
    <div
      className="note-attachment-preview-backdrop"
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
      >
        <div className="note-attachment-preview-toolbar">
          <span id="note-attachment-preview-title" className="note-attachment-preview-title">
            {att.filename || 'Attachment'}
          </span>
          <div className="note-attachment-preview-actions">
            <button type="button" className="note-attachment-preview-btn" onClick={onDownload}>
              Download
            </button>
            <button
              type="button"
              className="note-attachment-preview-btn note-attachment-preview-btn--primary"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </div>
        <div className="note-attachment-preview-body">
          {kind === 'image' ? (
            <img src={url} alt={att.filename || ''} className="note-attachment-preview-img" />
          ) : (
            <iframe title={att.filename || 'PDF'} src={url} className="note-attachment-preview-iframe" />
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

/** Paperclip / attach (assets/attach.svg), themed via currentColor */
function AttachmentIcon(props) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="note-attachment-icon"
      aria-hidden
      focusable={false}
      {...props}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M5.25 9C5.25 5.27208 8.27208 2.25 12 2.25C15.7279 2.25 18.75 5.27208 18.75 9V16C18.75 16.4142 18.4142 16.75 18 16.75C17.5858 16.75 17.25 16.4142 17.25 16V9C17.25 6.1005 14.8995 3.75 12 3.75C9.10051 3.75 6.75 6.10051 6.75 9V17C6.75 18.7949 8.20507 20.25 10 20.25C11.7949 20.25 13.25 18.7949 13.25 17V10C13.25 9.30964 12.6904 8.75 12 8.75C11.3096 8.75 10.75 9.30964 10.75 10V16C10.75 16.4142 10.4142 16.75 10 16.75C9.58579 16.75 9.25 16.4142 9.25 16V10C9.25 8.48122 10.4812 7.25 12 7.25C13.5188 7.25 14.75 8.48122 14.75 10V17C14.75 19.6234 12.6234 21.75 10 21.75C7.37665 21.75 5.25 19.6234 5.25 17V9Z"
        fill="currentColor"
      />
    </svg>
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

function AttachmentItem({ att, onDeleted }) {
  const [imgSrc, setImgSrc] = useState(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewKind, setPreviewKind] = useState(null);
  const [pdfPreviewUrl, setPdfPreviewUrl] = useState(null);
  const [pdfLoading, setPdfLoading] = useState(false);

  const isImage = isImageMime(att.mime_type, att.filename);
  const isPdf = isPdfMime(att.mime_type, att.filename);

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

  const previewUrl = previewKind === 'image' ? imgSrc : previewKind === 'pdf' ? pdfPreviewUrl : null;

  return (
    <div className="note-attachment-item">
      {previewOpen && previewUrl && previewKind ? (
        <AttachmentPreviewModal
          att={att}
          url={previewUrl}
          kind={previewKind}
          onClose={closePreview}
          onDownload={(e) => download(e)}
        />
      ) : null}
      {isImage && imgSrc ? (
        <button
          type="button"
          className="note-attachment-img-btn"
          onClick={openPreview}
          aria-label={`Preview ${att.filename || 'image'}`}
        >
          <img src={imgSrc} alt={att.filename} className="note-attachment-img" />
        </button>
      ) : isPdf ? (
        <button
          type="button"
          className="note-attachment-file note-attachment-file--preview"
          onClick={openPreview}
          disabled={pdfLoading}
        >
          <AttachmentIcon />
          <span className="note-attachment-filename">{att.filename}</span>
          <span className="note-attachment-size">
            ({Math.round((att.byte_size || 0) / 1024)} KB){pdfLoading ? ' …' : ''}
          </span>
        </button>
      ) : (
        <button type="button" className="note-attachment-file" onClick={download}>
          <AttachmentIcon />
          <span className="note-attachment-filename">{att.filename}</span>
          <span className="note-attachment-size">({Math.round((att.byte_size || 0) / 1024)} KB)</span>
        </button>
      )}
      {onDeleted && (
        <button
          type="button"
          className="note-attachment-remove"
          onClick={(e) => {
            e.stopPropagation();
            const name = att.filename || 'this file';
            if (
              !window.confirm(
                `Remove “${name}” from this note?\n\nThe file will be permanently deleted from the server.`
              )
            ) {
              return;
            }
            onDeleted(att);
          }}
          aria-label={`Remove ${att.filename}`}
        >
          ×
        </button>
      )}
    </div>
  );
}

export default function NoteAttachments({ attachments, onDeleted, excludeAttachmentIds }) {
  if (!attachments?.length) return null;
  const exclude =
    excludeAttachmentIds != null && excludeAttachmentIds.length > 0
      ? new Set(excludeAttachmentIds.map((id) => String(id)))
      : null;
  const list = exclude
    ? attachments.filter((a) => a?.id != null && !exclude.has(String(a.id)))
    : attachments;
  if (!list.length) return null;
  return (
    <div className="note-attachments">
      {list.map((a) => (
        <AttachmentItem key={a.id} att={a} onDeleted={onDeleted} />
      ))}
    </div>
  );
}
