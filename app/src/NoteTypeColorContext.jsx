import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAuth } from './AuthContext';
import { fetchUserSettings, patchUserSettings } from './api';
import {
  NOTE_TYPE_COLOR_KEYS,
  loadNoteTypeColorsFromStorage,
  saveNoteTypeColorsToStorage,
  applyNoteTypeColorVars,
  normalizeNoteTypeHex,
  parseNoteTypeColorsObject,
} from './noteTypeColorSettings';
import { normalizeDefaultStartPage } from './defaultStartPage';

const NoteTypeColorContext = createContext(null);

export function NoteTypeColorProvider({ children }) {
  const { user } = useAuth();
  const [colors, setColors] = useState(() => loadNoteTypeColorsFromStorage());
  const [similarNotesMinChars, setSimilarNotesMinChars] = useState(null);
  const [similarNotesLimitResultsToMinChars, setSimilarNotesLimitResultsToMinChars] = useState(false);
  const [similarNotesMinDefault, setSimilarNotesMinDefault] = useState(48);
  const [inboxThreadRootId, setInboxThreadRootId] = useState('');
  const [spaztickApiUrl, setSpaztickApiUrl] = useState('');
  const [spaztickApiKeySet, setSpaztickApiKeySet] = useState(false);
  const [calendarFeedUrls, setCalendarFeedUrls] = useState([]);
  const [defaultStartPage, setDefaultStartPage] = useState('stream');
  const [serverReady, setServerReady] = useState(false);
  const skipNoteTypeColorsSave = useRef(false);
  const skipSimilarNotesSave = useRef(false);
  const skipInboxSave = useRef(false);
  const skipSpaztickSave = useRef(false);
  const skipCalendarFeedsSave = useRef(false);
  const skipDefaultStartPageSave = useRef(false);
  const saveTimer = useRef(null);
  const similarSaveTimer = useRef(null);
  const inboxSaveTimer = useRef(null);
  const spaztickSaveTimer = useRef(null);
  const calendarFeedsSaveTimer = useRef(null);
  const defaultStartPageSaveTimer = useRef(null);
  const prevUserRef = useRef(null);

  /* Load from server when logged in (canonical); seed server from this device if account has none yet. */
  useEffect(() => {
    if (!user?.id) {
      setServerReady(false);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchUserSettings();
        if (cancelled) return;
        const serverParsed = parseNoteTypeColorsObject(data.noteTypeColors);
        const local = loadNoteTypeColorsFromStorage();
        const def =
          typeof data.similarNotesMinDefault === 'number' && Number.isFinite(data.similarNotesMinDefault)
            ? data.similarNotesMinDefault
            : 48;
        setSimilarNotesMinDefault(def);
        setSimilarNotesMinChars(
          typeof data.similarNotesMinChars === 'number' && Number.isFinite(data.similarNotesMinChars)
            ? data.similarNotesMinChars
            : null
        );
        setSimilarNotesLimitResultsToMinChars(data.similarNotesLimitResultsToMinChars === true);
        setInboxThreadRootId(typeof data.inboxThreadRootId === 'string' ? data.inboxThreadRootId : '');
        setSpaztickApiUrl(typeof data.spaztickApiUrl === 'string' ? data.spaztickApiUrl : '');
        setSpaztickApiKeySet(data.spaztickApiKeySet === true);
        setCalendarFeedUrls(Array.isArray(data.calendarFeedUrls) ? data.calendarFeedUrls : []);
        setDefaultStartPage(normalizeDefaultStartPage(data.defaultStartPage));
        if (Object.keys(serverParsed).length === 0 && Object.keys(local).length > 0) {
          setColors(local);
          skipNoteTypeColorsSave.current = true;
          skipSimilarNotesSave.current = true;
          skipInboxSave.current = true;
          skipSpaztickSave.current = true;
          skipCalendarFeedsSave.current = true;
          skipDefaultStartPageSave.current = true;
          try {
            await patchUserSettings({ noteTypeColors: local });
          } catch (e) {
            console.error(e);
          }
        } else {
          setColors(serverParsed);
          skipNoteTypeColorsSave.current = true;
          skipSimilarNotesSave.current = true;
          skipInboxSave.current = true;
          skipSpaztickSave.current = true;
          skipCalendarFeedsSave.current = true;
          skipDefaultStartPageSave.current = true;
        }
      } catch (e) {
        console.error(e);
        skipNoteTypeColorsSave.current = true;
        skipSimilarNotesSave.current = true;
        skipInboxSave.current = true;
        skipSpaztickSave.current = true;
        skipCalendarFeedsSave.current = true;
        skipDefaultStartPageSave.current = true;
      } finally {
        if (!cancelled) setServerReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  /* Logged out (transition from signed-in → signed-out only; do not clear on login page first paint). */
  useEffect(() => {
    const prev = prevUserRef.current;
    prevUserRef.current = user;
    if (prev != null && user == null) {
      setColors({});
      setSimilarNotesMinChars(null);
      setSimilarNotesLimitResultsToMinChars(false);
      setInboxThreadRootId('');
      setSpaztickApiUrl('');
      setSpaztickApiKeySet(false);
      setCalendarFeedUrls([]);
      setDefaultStartPage('stream');
      skipNoteTypeColorsSave.current = true;
      skipSimilarNotesSave.current = true;
      skipInboxSave.current = true;
      skipSpaztickSave.current = true;
      skipCalendarFeedsSave.current = true;
      skipDefaultStartPageSave.current = true;
    }
  }, [user]);

  useLayoutEffect(() => {
    applyNoteTypeColorVars(colors);
    saveNoteTypeColorsToStorage(colors);
  }, [colors]);

  /* Debounced sync to account (cross-device). */
  useEffect(() => {
    if (!user?.id || !serverReady) return;
    if (skipNoteTypeColorsSave.current) {
      skipNoteTypeColorsSave.current = false;
      return;
    }
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      patchUserSettings({ noteTypeColors: colors }).catch((e) => console.error(e));
    }, 450);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [colors, user?.id, serverReady]);

  useEffect(() => {
    if (!user?.id || !serverReady) return;
    if (skipSimilarNotesSave.current) {
      skipSimilarNotesSave.current = false;
      return;
    }
    if (similarSaveTimer.current) clearTimeout(similarSaveTimer.current);
    similarSaveTimer.current = setTimeout(() => {
      similarSaveTimer.current = null;
      patchUserSettings({
        similarNotesMinChars,
        similarNotesLimitResultsToMinChars,
      }).catch((e) => console.error(e));
    }, 450);
    return () => {
      if (similarSaveTimer.current) clearTimeout(similarSaveTimer.current);
    };
  }, [similarNotesMinChars, similarNotesLimitResultsToMinChars, user?.id, serverReady]);

  useEffect(() => {
    if (!user?.id || !serverReady) return;
    if (skipInboxSave.current) {
      skipInboxSave.current = false;
      return;
    }
    if (inboxSaveTimer.current) clearTimeout(inboxSaveTimer.current);
    inboxSaveTimer.current = setTimeout(() => {
      inboxSaveTimer.current = null;
      patchUserSettings({ inboxThreadRootId: inboxThreadRootId || null }).catch((e) => console.error(e));
    }, 450);
    return () => {
      if (inboxSaveTimer.current) clearTimeout(inboxSaveTimer.current);
    };
  }, [inboxThreadRootId, user?.id, serverReady]);

  useEffect(() => {
    if (!user?.id || !serverReady) return;
    if (skipSpaztickSave.current) {
      skipSpaztickSave.current = false;
      return;
    }
    if (spaztickSaveTimer.current) clearTimeout(spaztickSaveTimer.current);
    spaztickSaveTimer.current = setTimeout(() => {
      spaztickSaveTimer.current = null;
      patchUserSettings({ spaztickApiUrl: spaztickApiUrl.trim() || null }).catch((e) => console.error(e));
    }, 450);
    return () => {
      if (spaztickSaveTimer.current) clearTimeout(spaztickSaveTimer.current);
    };
  }, [spaztickApiUrl, user?.id, serverReady]);

  useEffect(() => {
    if (!user?.id || !serverReady) return;
    if (skipCalendarFeedsSave.current) {
      skipCalendarFeedsSave.current = false;
      return;
    }
    if (calendarFeedsSaveTimer.current) clearTimeout(calendarFeedsSaveTimer.current);
    calendarFeedsSaveTimer.current = setTimeout(() => {
      calendarFeedsSaveTimer.current = null;
      patchUserSettings({
        calendarFeedUrls: calendarFeedUrls.length > 0 ? calendarFeedUrls : null,
      }).catch((e) => console.error(e));
    }, 450);
    return () => {
      if (calendarFeedsSaveTimer.current) clearTimeout(calendarFeedsSaveTimer.current);
    };
  }, [calendarFeedUrls, user?.id, serverReady]);

  useEffect(() => {
    if (!user?.id || !serverReady) return;
    if (skipDefaultStartPageSave.current) {
      skipDefaultStartPageSave.current = false;
      return;
    }
    if (defaultStartPageSaveTimer.current) clearTimeout(defaultStartPageSaveTimer.current);
    defaultStartPageSaveTimer.current = setTimeout(() => {
      defaultStartPageSaveTimer.current = null;
      patchUserSettings({
        defaultStartPage: defaultStartPage === 'stream' ? null : defaultStartPage,
      }).catch((e) => console.error(e));
    }, 450);
    return () => {
      if (defaultStartPageSaveTimer.current) clearTimeout(defaultStartPageSaveTimer.current);
    };
  }, [defaultStartPage, user?.id, serverReady]);

  const setDefaultStartPageSetting = useCallback((id) => {
    setDefaultStartPage(normalizeDefaultStartPage(id));
  }, []);

  const setTypeColor = useCallback((type, hexOrNull) => {
    if (!NOTE_TYPE_COLOR_KEYS.includes(type)) return;
    setColors((prev) => {
      const next = { ...prev };
      if (hexOrNull == null || hexOrNull === '') {
        delete next[type];
        return next;
      }
      const h = normalizeNoteTypeHex(hexOrNull);
      if (!h) return prev;
      next[type] = h;
      return next;
    });
  }, []);

  const resetAllTypeColors = useCallback(() => {
    setColors({});
  }, []);

  const setSimilarNotesMinCharsSetting = useCallback((n) => {
    if (n === null || n === undefined) {
      setSimilarNotesMinChars(null);
      return;
    }
    const v = Math.round(Number(n));
    if (!Number.isFinite(v) || v < 0 || v > 500) return;
    setSimilarNotesMinChars(v);
  }, []);

  const setSimilarNotesLimitResultsSetting = useCallback((on) => {
    setSimilarNotesLimitResultsToMinChars(Boolean(on));
  }, []);

  const setInboxThreadRootIdSetting = useCallback((id) => {
    if (typeof id !== 'string') {
      setInboxThreadRootId('');
      return;
    }
    setInboxThreadRootId(id.trim());
  }, []);

  const setSpaztickApiUrlSetting = useCallback((url) => {
    if (typeof url !== 'string') {
      setSpaztickApiUrl('');
      return;
    }
    setSpaztickApiUrl(url.trim());
  }, []);

  const saveSpaztickApiKey = useCallback(async (secretOrNull) => {
    const data = await patchUserSettings({
      spaztickApiKey: secretOrNull == null || secretOrNull === '' ? null : String(secretOrNull),
    });
    setSpaztickApiKeySet(data.spaztickApiKeySet === true);
    if (typeof data.spaztickApiUrl === 'string') setSpaztickApiUrl(data.spaztickApiUrl);
    skipSpaztickSave.current = true;
  }, []);

  const setCalendarFeedUrlsSetting = useCallback((urls) => {
    if (!Array.isArray(urls)) {
      setCalendarFeedUrls([]);
      return;
    }
    setCalendarFeedUrls(urls);
  }, []);

  const spaztickReady =
    Boolean(spaztickApiUrl?.trim()) && spaztickApiKeySet;

  const value = useMemo(
    () => ({
      colors,
      setTypeColor,
      resetAllTypeColors,
      similarNotesMinChars,
      similarNotesLimitResultsToMinChars,
      similarNotesMinDefault,
      setSimilarNotesMinChars: setSimilarNotesMinCharsSetting,
      setSimilarNotesLimitResultsToMinChars: setSimilarNotesLimitResultsSetting,
      inboxThreadRootId,
      setInboxThreadRootId: setInboxThreadRootIdSetting,
      spaztickApiUrl,
      setSpaztickApiUrl: setSpaztickApiUrlSetting,
      spaztickApiKeySet,
      saveSpaztickApiKey,
      spaztickReady,
      calendarFeedUrls,
      setCalendarFeedUrls: setCalendarFeedUrlsSetting,
      defaultStartPage,
      setDefaultStartPage: setDefaultStartPageSetting,
      serverReady,
    }),
    [
      colors,
      setTypeColor,
      resetAllTypeColors,
      similarNotesMinChars,
      similarNotesLimitResultsToMinChars,
      similarNotesMinDefault,
      setSimilarNotesMinCharsSetting,
      setSimilarNotesLimitResultsSetting,
      inboxThreadRootId,
      setInboxThreadRootIdSetting,
      spaztickApiUrl,
      setSpaztickApiUrlSetting,
      spaztickApiKeySet,
      saveSpaztickApiKey,
      spaztickReady,
      calendarFeedUrls,
      setCalendarFeedUrlsSetting,
      defaultStartPage,
      setDefaultStartPageSetting,
      serverReady,
    ]
  );

  return <NoteTypeColorContext.Provider value={value}>{children}</NoteTypeColorContext.Provider>;
}

export function useNoteTypeColors() {
  const ctx = useContext(NoteTypeColorContext);
  if (!ctx) {
    throw new Error('useNoteTypeColors must be used within NoteTypeColorProvider');
  }
  return ctx;
}
