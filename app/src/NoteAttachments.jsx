import React, { useEffect, useState } from 'react';
import { getToken } from './api';
import './NoteAttachments.css';

const BASE = (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '';

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

function fileUrl(id) {
  return `${BASE.replace(/\/$/, '')}/api/note-files/${id}`;
}

function AttachmentItem({ att, onDeleted }) {
  const [imgSrc, setImgSrc] = useState(null);
  const isImage = att.mime_type?.startsWith('image/');

  useEffect(() => {
    if (!isImage) return undefined;
    let objectUrl;
    let cancelled = false;
    const t = getToken();
    fetch(fileUrl(att.id), { headers: t ? { Authorization: `Bearer ${t}` } : {} })
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

  const download = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const t = getToken();
    const r = await fetch(fileUrl(att.id), { headers: t ? { Authorization: `Bearer ${t}` } : {} });
    if (!r.ok) return;
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = att.filename || 'download';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="note-attachment-item">
      {isImage && imgSrc ? (
        <a href={imgSrc} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
          <img src={imgSrc} alt={att.filename} className="note-attachment-img" />
        </a>
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

export default function NoteAttachments({ attachments, onDeleted }) {
  if (!attachments?.length) return null;
  return (
    <div className="note-attachments">
      {attachments.map((a) => (
        <AttachmentItem key={a.id} att={a} onDeleted={onDeleted} />
      ))}
    </div>
  );
}
