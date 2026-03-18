import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { getRoots, getThread, createNote, uploadNoteFiles, getNote } from './api';
import Layout from './Layout';
import NoteCard from './NoteCard';
import './StreamPage.css';

function buildTree(flat) {
  const byId = new Map(flat.map((n) => [n.id, { ...n, children: [] }]));
  const roots = [];
  for (const n of flat) {
    const node = byId.get(n.id);
    if (n.parent_id) {
      const parent = byId.get(n.parent_id);
      if (parent) parent.children.push(node);
      else roots.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function findNode(nodes, id) {
  for (const n of nodes) {
    if (n.id === id) return n;
    const f = findNode(n.children || [], id);
    if (f) return f;
  }
  return null;
}

function StreamList({
  nodes,
  depth,
  onFocusNote,
  onStarredChange,
  onNoteUpdate,
  onNoteDelete,
  staggerDelays,
}) {
  return (
    <>
      {nodes.map((n) => {
        const delayMs = depth > 0 && staggerDelays?.get(n.id);
        return (
          <li
            key={n.id}
            className={delayMs != null ? 'stream-page-reply-stagger' : undefined}
            style={delayMs != null ? { animationDelay: `${delayMs}ms` } : undefined}
          >
            <NoteCard
              note={n}
              depth={depth}
              hasReplies={(n.children?.length ?? 0) > 0}
              onOpenThread={() => onFocusNote(n.id)}
              onStarredChange={onStarredChange}
              onNoteUpdate={onNoteUpdate}
              onNoteDelete={onNoteDelete}
            />
            {n.children?.length > 0 && (
              <ul className="stream-page-replies">
                <StreamList
                  nodes={n.children}
                  depth={depth + 1}
                  onFocusNote={onFocusNote}
                  onStarredChange={onStarredChange}
                  onNoteUpdate={onNoteUpdate}
                  onNoteDelete={onNoteDelete}
                  staggerDelays={staggerDelays}
                />
              </ul>
            )}
          </li>
        );
      })}
    </>
  );
}

export default function StreamPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const threadRootId = searchParams.get('thread')?.trim() || null;
  const focusParam = searchParams.get('focus')?.trim() || null;

  const [roots, setRoots] = useState([]);
  const [thread, setThread] = useState([]);
  const [loadingRoots, setLoadingRoots] = useState(!threadRootId);
  const [loadingThread, setLoadingThread] = useState(!!threadRootId);
  const [loadError, setLoadError] = useState(null);

  const [starredOnly, setStarredOnly] = useState(false);
  const [newRootContent, setNewRootContent] = useState('');
  const [replyContent, setReplyContent] = useState('');
  const [pendingRootFiles, setPendingRootFiles] = useState([]);
  const [pendingReplyFiles, setPendingReplyFiles] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [focusId, setFocusId] = useState(null);

  const rootFileRef = useRef(null);
  const replyFileRef = useRef(null);
  const threadAnchorRef = useRef(null);
  const focusFromUrlApplied = useRef('');
  const floatTimerRef = useRef(null);
  const { logout } = useAuth();

  const [floatOpen, setFloatOpen] = useState(null);
  const [replyStagger, setReplyStagger] = useState(false);
  const [threadExiting, setThreadExiting] = useState(false);

  const loadRoots = useCallback(() => {
    setLoadError(null);
    return getRoots(starredOnly)
      .then(setRoots)
      .catch((err) => {
        setRoots([]);
        setLoadError(err.message || 'Could not load notes.');
      })
      .finally(() => setLoadingRoots(false));
  }, [starredOnly]);

  const loadThread = useCallback(
    (soft = false) => {
      if (!threadRootId) return Promise.resolve();
      if (!soft) {
        setLoadingThread(true);
        setThread([]);
      }
      return getThread(threadRootId, starredOnly)
        .then((rows) => {
          setThread(rows);
          if (rows.length === 0) setSearchParams({});
        })
        .catch(() => {
          setThread([]);
          setSearchParams({});
        })
        .finally(() => {
          if (!soft) setLoadingThread(false);
        });
    },
    [threadRootId, starredOnly, setSearchParams]
  );

  useEffect(() => {
    if (!threadRootId) {
      setLoadingRoots(true);
      loadRoots();
      setThread([]);
      setFocusId(null);
      setReplyStagger(false);
      if (floatTimerRef.current) {
        clearTimeout(floatTimerRef.current);
        floatTimerRef.current = null;
      }
      setFloatOpen(null);
      document.querySelectorAll('.stream-page-root-item').forEach((el) => {
        el.classList.remove('stream-page-root-fading', 'stream-page-root-item--picked');
      });
    }
  }, [threadRootId, starredOnly, loadRoots]);

  useEffect(() => {
    if (threadRootId) {
      loadThread(false);
    }
  }, [threadRootId, starredOnly, loadThread]);

  useEffect(() => {
    focusFromUrlApplied.current = '';
    setFocusId(null);
  }, [threadRootId]);

  const threadReady = Boolean(threadRootId && !loadingThread && thread.length > 0);
  useEffect(() => {
    if (!threadReady || !focusParam || !thread.length) return;
    const key = `${threadRootId}|${focusParam}`;
    if (focusFromUrlApplied.current === key) return;
    if (!findNode(buildTree(thread), focusParam)) return;
    focusFromUrlApplied.current = key;
    setFocusId(focusParam);
  }, [threadReady, threadRootId, focusParam, thread]);

  useEffect(() => {
    if (!threadRootId || !thread.length || loadingThread) return;
    requestAnimationFrame(() => {
      threadAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [threadRootId, thread[0]?.id, loadingThread]);

  const openThreadDirect = useCallback(
    (rootId) => {
      if (floatTimerRef.current) {
        clearTimeout(floatTimerRef.current);
        floatTimerRef.current = null;
      }
      setFloatOpen(null);
      setReplyStagger(false);
      setSearchParams({ thread: rootId });
      setFocusId(null);
    },
    [setSearchParams]
  );

  const beginOpenThread = useCallback(
    (rootId, e) => {
      const n = roots.find((r) => r.id === rootId);
      const li = e?.currentTarget?.closest?.('li.stream-page-root-item');
      if (!n || !li || typeof li.getBoundingClientRect !== 'function') {
        openThreadDirect(rootId);
        return;
      }
      if (floatTimerRef.current) {
        clearTimeout(floatTimerRef.current);
        floatTimerRef.current = null;
      }
      const r = li.getBoundingClientRect();
      li.classList.add('stream-page-root-item--picked');
      document.querySelectorAll('.stream-page-root-item').forEach((el) => {
        if (el !== li) el.classList.add('stream-page-root-fading');
      });
      setFloatOpen({
        note: { ...n },
        top: r.top,
        left: r.left,
        width: r.width,
        phase: 'idle',
      });
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setFloatOpen((prev) => (prev && prev.note.id === rootId ? { ...prev, phase: 'move' } : prev));
        });
      });
      floatTimerRef.current = setTimeout(() => {
        floatTimerRef.current = null;
        document.querySelectorAll('.stream-page-root-item').forEach((el) => {
          el.classList.remove('stream-page-root-fading', 'stream-page-root-item--picked');
        });
        setFloatOpen(null);
        setReplyStagger(true);
        setSearchParams({ thread: rootId });
        setFocusId(null);
      }, 480);
    },
    [roots, openThreadDirect, setSearchParams]
  );

  const closeThread = useCallback(() => {
    setThreadExiting(true);
    setTimeout(() => {
      setSearchParams({});
      setFocusId(null);
      setThreadExiting(false);
      setReplyStagger(false);
      loadRoots();
    }, 220);
  }, [setSearchParams, loadRoots]);

  const upOneLevel = useCallback(() => {
    focusFromUrlApplied.current = '';
    setFocusId(null);
    if (threadRootId) setSearchParams({ thread: threadRootId });
  }, [threadRootId, setSearchParams]);

  const tree = buildTree(thread);
  const actualRootId = thread[0]?.id;
  const focusedNode = focusId && actualRootId ? findNode(tree, focusId) : null;
  const displayTree =
    focusedNode && focusId !== actualRootId
      ? [{ ...focusedNode, children: focusedNode.children || [] }]
      : tree;

  const replyStaggerDelays = useMemo(() => {
    if (!replyStagger || !thread.length) return null;
    const t = buildTree(thread);
    const tr = thread[0]?.id;
    const fn = focusId && tr ? findNode(t, focusId) : null;
    const dt =
      fn && focusId !== tr ? [{ ...fn, children: fn.children || [] }] : t;
    const m = new Map();
    let i = 0;
    function walk(nodes, depth) {
      for (const n of nodes) {
        if (depth > 0) m.set(n.id, i++ * 42);
        walk(n.children || [], depth + 1);
      }
    }
    walk(dt, 0);
    return m;
  }, [replyStagger, thread, focusId]);

  useEffect(() => {
    if (!replyStagger || !threadReady) return;
    const t = setTimeout(() => setReplyStagger(false), 1400);
    return () => clearTimeout(t);
  }, [replyStagger, threadReady, threadRootId]);

  const onFocusNote = useCallback(
    (id) => {
      setFocusId(id);
      if (!threadRootId) return;
      const rid = thread[0]?.id;
      if (id && id !== rid) {
        setSearchParams({ thread: threadRootId, focus: id });
      } else {
        setSearchParams({ thread: threadRootId });
      }
    },
    [threadRootId, thread, setSearchParams]
  );

  const replyParentId = focusId && focusedNode ? focusId : threadRootId;
  const focusSnippet = focusedNode?.content?.slice(0, 50) || '';

  const refreshAll = () => {
    if (threadRootId) loadThread(true);
    else loadRoots();
  };

  const handleNewRoot = async (e) => {
    e.preventDefault();
    const text = newRootContent.trim();
    if ((!text && pendingRootFiles.length === 0) || submitting) return;
    setSubmitting(true);
    try {
      const note = await createNote({ content: text });
      if (pendingRootFiles.length > 0) await uploadNoteFiles(note.id, pendingRootFiles);
      const full =
        pendingRootFiles.length > 0
          ? await getNote(note.id)
          : { ...note, reply_count: note.reply_count ?? 0, attachments: note.attachments || [] };
      setNewRootContent('');
      setPendingRootFiles([]);
      if (rootFileRef.current) rootFileRef.current.value = '';
      setRoots((prev) => [full, ...prev.filter((x) => x.id !== full.id)]);
      openThreadDirect(full.id);
    } catch (err) {
      console.error(err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleReply = async (e) => {
    e.preventDefault();
    if (!threadRootId || !replyParentId) return;
    const text = replyContent.trim();
    if ((!text && pendingReplyFiles.length === 0) || submitting) return;
    setSubmitting(true);
    try {
      const note = await createNote({ content: text, parent_id: replyParentId });
      if (pendingReplyFiles.length > 0) await uploadNoteFiles(note.id, pendingReplyFiles);
      setReplyContent('');
      setPendingReplyFiles([]);
      if (replyFileRef.current) replyFileRef.current.value = '';
      await loadThread(true);
    } catch (err) {
      console.error(err);
    } finally {
      setSubmitting(false);
    }
  };

  const rootNote = thread[0];
  const layoutTitle = threadRootId && rootNote
    ? rootNote.content?.slice(0, 40) + (rootNote.content?.length > 40 ? '…' : '')
    : 'Stream';

  const navLinks = [
    { to: '/', label: 'Stream' },
    ...(threadRootId
      ? [{ to: `/outline/${threadRootId}`, label: 'Outline' }]
      : [{ to: '/outline', label: 'Outline' }]),
    { to: '/queue', label: 'Queue' },
    { to: '/tags', label: 'Tags' },
    { to: '/search', label: 'Search' },
  ];

  return (
    <Layout
      title={layoutTitle}
      starredOnly={starredOnly}
      onStarredOnlyChange={setStarredOnly}
      onLogout={logout}
      viewLinks={navLinks}
    >
      <div className="stream-page">
        {floatOpen && (
          <div
            className={`stream-page-float ${floatOpen.phase === 'move' ? 'stream-page-float--move' : ''}`}
            style={{
              '--fp-top': `${floatOpen.top}px`,
              '--fp-left': `${floatOpen.left}px`,
              '--fp-w': `${floatOpen.width}px`,
            }}
            aria-hidden
          >
            <NoteCard
              note={floatOpen.note}
              depth={0}
              hasReplies={(floatOpen.note.reply_count ?? 0) > 0}
              onOpenThread={() => {}}
              onStarredChange={() => {}}
              onNoteUpdate={() => {}}
              onNoteDelete={() => {}}
            />
          </div>
        )}
        <div className="stream-page-scroll">
          {threadRootId ? (
            <>
              <div className={`stream-page-nav-row ${threadExiting ? 'stream-page-nav-row--exit' : ''}`}>
                {focusId && focusId !== actualRootId ? (
                  <button type="button" className="stream-page-nav-btn" onClick={upOneLevel}>
                    ↑ One level
                  </button>
                ) : null}
                <button type="button" className="stream-page-nav-btn stream-page-nav-btn--root" onClick={closeThread}>
                  All threads
                </button>
              </div>
              {loadingThread ? (
                <p className="stream-page-muted">Loading thread…</p>
              ) : thread.length === 0 ? (
                <p className="stream-page-muted">Thread not found.</p>
              ) : (
                <div
                  className={`stream-page-thread-enter ${threadExiting ? 'stream-page-thread-enter--exit' : ''}`}
                  key={threadRootId}
                  ref={threadAnchorRef}
                >
                  {focusId && focusId !== actualRootId && (
                    <div className="stream-page-focus-bar">
                      <span className="stream-page-focus-label">
                        Branch: {focusSnippet}
                        {focusedNode?.content?.length > 50 ? '…' : ''}
                      </span>
                    </div>
                  )}
                  <ul className="stream-page-list">
                    <StreamList
                      nodes={displayTree}
                      depth={0}
                      onFocusNote={onFocusNote}
                      onStarredChange={refreshAll}
                      onNoteUpdate={() => loadThread(true)}
                      onNoteDelete={() => {
                        loadThread(true);
                        loadRoots();
                      }}
                      staggerDelays={replyStaggerDelays}
                    />
                  </ul>
                </div>
              )}
            </>
          ) : (
            <>
              {loadError && (
                <p className="stream-page-error" role="alert">
                  {loadError}
                </p>
              )}
              {loadingRoots ? (
                <p className="stream-page-muted">Loading…</p>
              ) : roots.length === 0 && !loadError ? (
                <p className="stream-page-muted">
                  {starredOnly ? 'No starred threads yet.' : 'No threads yet. Start one below.'}
                </p>
              ) : (
                <ul className="stream-page-list">
                  {roots.map((n) => (
                    <li key={n.id} className="stream-page-root-item">
                      <NoteCard
                        note={n}
                        depth={0}
                        hasReplies={(n.reply_count ?? 0) > 0}
                        onOpenThread={(ev) => beginOpenThread(n.id, ev)}
                        onStarredChange={loadRoots}
                        onNoteUpdate={loadRoots}
                        onNoteDelete={loadRoots}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        <div className="stream-page-compose-wrap">
          {threadRootId ? (
            <form className="stream-page-compose" onSubmit={handleReply}>
              <textarea
                placeholder={
                  replyParentId === threadRootId
                    ? 'Reply to thread…'
                    : `Reply to “${focusSnippet.slice(0, 36)}${focusSnippet.length > 36 ? '…' : ''}”…`
                }
                value={replyContent}
                onChange={(e) => setReplyContent(e.target.value)}
                rows={2}
              />
              <div className="stream-page-compose-row">
                <label className="stream-page-file-label">
                  <input
                    ref={replyFileRef}
                    type="file"
                    multiple
                    accept="image/*,.pdf,.txt,.md,.doc,.docx,.zip"
                    onChange={(e) => setPendingReplyFiles(Array.from(e.target.files || []))}
                  />
                  Attach files
                </label>
                {pendingReplyFiles.length > 0 && (
                  <span className="stream-page-file-hint">{pendingReplyFiles.length} file(s)</span>
                )}
                <button
                  type="submit"
                  disabled={(!replyContent.trim() && pendingReplyFiles.length === 0) || submitting}
                >
                  Send
                </button>
              </div>
            </form>
          ) : (
            <form className="stream-page-compose" onSubmit={handleNewRoot}>
              <textarea
                placeholder="New thread…"
                value={newRootContent}
                onChange={(e) => setNewRootContent(e.target.value)}
                rows={2}
              />
              <div className="stream-page-compose-row">
                <label className="stream-page-file-label">
                  <input
                    ref={rootFileRef}
                    type="file"
                    multiple
                    accept="image/*,.pdf,.txt,.md,.doc,.docx,.zip"
                    onChange={(e) => setPendingRootFiles(Array.from(e.target.files || []))}
                  />
                  Attach files
                </label>
                {pendingRootFiles.length > 0 && (
                  <span className="stream-page-file-hint">{pendingRootFiles.length} file(s)</span>
                )}
                <button
                  type="submit"
                  disabled={(!newRootContent.trim() && pendingRootFiles.length === 0) || submitting}
                >
                  Send
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </Layout>
  );
}
