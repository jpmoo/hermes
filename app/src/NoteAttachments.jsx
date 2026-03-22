import React, { useEffect, useState } from 'react';
import { getToken } from './api';
import './NoteAttachments.css';

const BASE = (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '';

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
          📎 {att.filename}
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
