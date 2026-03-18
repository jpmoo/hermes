import React, { useState, useEffect } from 'react';
import { useAuth } from './AuthContext';
import { getOrphanAttachments, deleteOrphanAttachment } from './api';
import Layout from './Layout';
import './OrphanFilesView.css';

export default function OrphanFilesView() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const { logout } = useAuth();

  const load = () => {
    setErr(null);
    return getOrphanAttachments()
      .then(setRows)
      .catch((e) => {
        setErr(e.message);
        setRows([]);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const removeOne = async (row) => {
    if (
      !window.confirm(
        `Permanently delete “${row.filename}” (${Math.round(row.byte_size / 1024)} KB)?\n\nThis cannot be undone.`
      )
    ) {
      return;
    }
    try {
      await deleteOrphanAttachment(row.id);
      setRows((prev) => prev.filter((r) => r.id !== row.id));
    } catch (e) {
      console.error(e);
      setErr(e.message);
    }
  };

  const removeAll = async () => {
    if (
      !window.confirm(
        `Delete all ${rows.length} orphan file(s) from the database? This cannot be undone.`
      )
    ) {
      return;
    }
    for (const row of [...rows]) {
      try {
        await deleteOrphanAttachment(row.id);
      } catch (e) {
        console.error(e);
      }
    }
    await load();
  };

  return (
    <Layout
      title="Orphans"
      starredOnly={false}
      onStarredOnlyChange={() => {}}
      onLogout={logout}
      viewLinks={[
        { to: '/', label: 'Stream' },
        { to: '/queue', label: 'Queue', tooltip: 'Autotagging approval' },
        { to: '/tags', label: 'Tags' },
        { to: '/search', label: 'Search' },
      ]}
    >
      <div className="orphan-files">
        <p className="orphan-files-intro">
          Files stored in the database whose note no longer exists (e.g. after manual DB edits or
          legacy data). With normal deletes, attachments are removed with their note — this list is
          usually empty.
        </p>
        {err && <p className="orphan-files-error">{err}</p>}
        {loading ? (
          <p className="orphan-files-muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="orphan-files-muted">No orphan attachments.</p>
        ) : (
          <>
            <div className="orphan-files-toolbar">
              <button type="button" className="orphan-files-delete-all" onClick={removeAll}>
                Delete all ({rows.length})
              </button>
            </div>
            <ul className="orphan-files-list">
              {rows.map((row) => (
                <li key={row.id} className="orphan-files-row">
                  <div className="orphan-files-meta">
                    <span className="orphan-files-name">{row.filename}</span>
                    <span className="orphan-files-size">{Math.round(row.byte_size / 1024)} KB</span>
                    <span className="orphan-files-mime">{row.mime_type}</span>
                    <span className="orphan-files-date">
                      {new Date(row.created_at).toLocaleString()}
                    </span>
                    <code className="orphan-files-note-id" title="Former note id">
                      note: {row.note_id?.slice(0, 8)}…
                    </code>
                  </div>
                  <button type="button" className="orphan-files-delete" onClick={() => removeOne(row)}>
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Layout>
  );
}
