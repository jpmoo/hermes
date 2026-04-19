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
import { deleteUserBackground, fetchUserSettings, patchUserSettings, uploadUserBackground } from './api';
import {
  NOTE_TYPE_COLOR_KEYS,
  loadNoteTypeColorsFromStorage,
  saveNoteTypeColorsToStorage,
  applyNoteTypeColorVars,
  normalizeNoteTypeHex,
  parseNoteTypeColorsObject,
} from './noteTypeColorSettings';
import { normalizeDefaultStartPage } from './defaultStartPage';
import { normalizeCalendarFeedsFromApi } from './calendarFeedsFromApi';
import { normalizeCalendarLookoutDays } from './calendarLookoutDays';
import { NOTE_TYPE_FILTER_ORDER } from './noteTypeFilter';
import {
  defaultHoverInsightForAccount,
  defaultRagdollContext,
  readHoverInsightLocalSeed,
  readThemeFromLocalStorage,
} from './hoverInsightLocalSeed';

const NoteTypeColorContext = createContext(null);

const THEME_META = {
  light: '#f4f3f0',
  dark: '#15181c',
};

function clampInsightPct(n, fallback) {
  const x = Math.round(Number(n));
  if (!Number.isFinite(x)) return fallback;
  return Math.min(95, Math.max(5, x));
}

function normalizeHoverInsightFromApi(h) {
  const fallback = defaultHoverInsightForAccount();
  if (!h || typeof h !== 'object') return fallback;
  const types = Array.isArray(h.similarVisibleTypes)
    ? h.similarVisibleTypes.filter((t) => typeof t === 'string' && NOTE_TYPE_FILTER_ORDER.includes(t))
    : [];
  return {
    ragdollContext: {
      ...defaultRagdollContext,
      ...(h.ragdollContext && typeof h.ragdollContext === 'object' ? h.ragdollContext : {}),
    },
    ragdollQuerySimilarityMinPct: clampInsightPct(
      h.ragdollQuerySimilarityMinPct,
      fallback.ragdollQuerySimilarityMinPct
    ),
    similarMinPct: clampInsightPct(h.similarMinPct, fallback.similarMinPct),
    similarVisibleTypes: types.length > 0 ? types : [...fallback.similarVisibleTypes],
  };
}

export function NoteTypeColorProvider({ children }) {
  const { user } = useAuth();
  const [colors, setColors] = useState(() => loadNoteTypeColorsFromStorage());
  const [similarNotesMinChars, setSimilarNotesMinChars] = useState(null);
  const [similarNotesLimitResultsToMinChars, setSimilarNotesLimitResultsToMinChars] = useState(false);
  const [similarNotesMinDefault, setSimilarNotesMinDefault] = useState(48);
  const [inboxThreadRootId, setInboxThreadRootId] = useState('');
  const [spaztickApiUrl, setSpaztickApiUrl] = useState('');
  const [spaztickApiKeySet, setSpaztickApiKeySet] = useState(false);
  const [ingestApiKeySet, setIngestApiKeySet] = useState(false);
  const [calendarFeeds, setCalendarFeeds] = useState([]);
  const [calendarLookoutDays, setCalendarLookoutDays] = useState(0);
  const [defaultStartPage, setDefaultStartPage] = useState('stream');
  const [defaultStartPagePhone, setDefaultStartPagePhone] = useState('stream');
  const [markdownListAlternatingShades, setMarkdownListAlternatingShades] = useState(true);
  const [streamThreadImageBgEnabled, setStreamThreadImageBgEnabled] = useState(false);
  const [streamThreadImageBgOpacity, setStreamThreadImageBgOpacity] = useState(0.28);
  const [streamBackgroundAnimate, setStreamBackgroundAnimate] = useState(true);
  const [streamBackgroundCrtEffect, setStreamBackgroundCrtEffect] = useState(false);
  const [streamRootBackgroundPresent, setStreamRootBackgroundPresent] = useState(false);
  const [streamRootBackgroundOpacity, setStreamRootBackgroundOpacity] = useState(0.28);
  const [canvasUseStreamRootBackground, setCanvasUseStreamRootBackground] = useState(false);
  /** Bust HTTP cache for GET /api/user/background (new value after load, upload, or remove). */
  const [userBackgroundFetchRevision, setUserBackgroundFetchRevision] = useState(0);
  const [theme, setTheme] = useState(() => readThemeFromLocalStorage());
  const [hoverInsight, setHoverInsightState] = useState(() => readHoverInsightLocalSeed());
  const [serverReady, setServerReady] = useState(false);
  const skipNoteTypeColorsSave = useRef(false);
  const skipSimilarNotesSave = useRef(false);
  const skipInboxSave = useRef(false);
  const skipSpaztickSave = useRef(false);
  const skipCalendarFeedsSave = useRef(false);
  const skipCalendarLookoutDaysSave = useRef(false);
  const skipDefaultStartPageSave = useRef(false);
  const skipDefaultStartPagePhoneSave = useRef(false);
  const skipMarkdownListAlternatingShadesSave = useRef(false);
  const skipStreamThreadImageBgSave = useRef(false);
  const skipStreamRootBackgroundMetaSave = useRef(false);
  const skipThemeSave = useRef(false);
  const skipHoverInsightSave = useRef(false);
  const saveTimer = useRef(null);
  const similarSaveTimer = useRef(null);
  const inboxSaveTimer = useRef(null);
  const spaztickSaveTimer = useRef(null);
  const calendarFeedsSaveTimer = useRef(null);
  const calendarLookoutDaysSaveTimer = useRef(null);
  const defaultStartPageSaveTimer = useRef(null);
  const defaultStartPagePhoneSaveTimer = useRef(null);
  const markdownListAlternatingShadesSaveTimer = useRef(null);
  const streamThreadImageBgSaveTimer = useRef(null);
  const streamRootBackgroundMetaSaveTimer = useRef(null);
  const themeSaveTimer = useRef(null);
  const hoverInsightSaveTimer = useRef(null);
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
        setIngestApiKeySet(data.ingestApiKeySet === true);
        setCalendarFeeds(normalizeCalendarFeedsFromApi(data));
        setCalendarLookoutDays(normalizeCalendarLookoutDays(data.calendarLookoutDays));
        setDefaultStartPage(normalizeDefaultStartPage(data.defaultStartPage));
        setDefaultStartPagePhone(normalizeDefaultStartPage(data.defaultStartPagePhone));
        setMarkdownListAlternatingShades(data.markdownListAlternatingShades !== false);
        setStreamThreadImageBgEnabled(data.streamThreadImageBgEnabled === true);
        {
          const op = data.streamThreadImageBgOpacity;
          setStreamThreadImageBgOpacity(
            typeof op === 'number' && Number.isFinite(op) ? Math.min(1, Math.max(0, op)) : 0.28
          );
        }
        setStreamBackgroundAnimate(data.streamBackgroundAnimate !== false);
        setStreamBackgroundCrtEffect(data.streamBackgroundCrtEffect === true);
        setStreamRootBackgroundPresent(data.streamRootBackgroundPresent === true);
        {
          const op = data.streamRootBackgroundOpacity;
          setStreamRootBackgroundOpacity(
            typeof op === 'number' && Number.isFinite(op) ? Math.min(1, Math.max(0, op)) : 0.28
          );
        }
        setCanvasUseStreamRootBackground(data.canvasUseStreamRootBackground === true);
        setUserBackgroundFetchRevision(data.streamRootBackgroundPresent === true ? Date.now() : 0);

        const themeFromServer = data.theme === 'dark' ? 'dark' : 'light';
        if (data.settingsThemeWasSet === true) {
          setTheme(themeFromServer);
          skipThemeSave.current = true;
        } else {
          const localT = readThemeFromLocalStorage();
          setTheme(localT);
          skipThemeSave.current = true;
          try {
            await patchUserSettings({ theme: localT });
          } catch (e) {
            console.error(e);
          }
        }

        if (data.settingsHoverInsightWasSet === true) {
          setHoverInsightState(normalizeHoverInsightFromApi(data.hoverInsight));
          skipHoverInsightSave.current = true;
        } else {
          const seed = readHoverInsightLocalSeed();
          setHoverInsightState(seed);
          skipHoverInsightSave.current = true;
          try {
            await patchUserSettings({ hoverInsight: seed });
          } catch (e) {
            console.error(e);
          }
        }

        if (Object.keys(serverParsed).length === 0 && Object.keys(local).length > 0) {
          setColors(local);
          skipNoteTypeColorsSave.current = true;
          skipSimilarNotesSave.current = true;
          skipInboxSave.current = true;
          skipSpaztickSave.current = true;
          skipCalendarFeedsSave.current = true;
          skipCalendarLookoutDaysSave.current = true;
          skipDefaultStartPageSave.current = true;
          skipDefaultStartPagePhoneSave.current = true;
          skipMarkdownListAlternatingShadesSave.current = true;
          skipStreamThreadImageBgSave.current = true;
          skipStreamRootBackgroundMetaSave.current = true;
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
          skipCalendarLookoutDaysSave.current = true;
          skipDefaultStartPageSave.current = true;
          skipDefaultStartPagePhoneSave.current = true;
          skipMarkdownListAlternatingShadesSave.current = true;
          skipStreamThreadImageBgSave.current = true;
          skipStreamRootBackgroundMetaSave.current = true;
        }
      } catch (e) {
        console.error(e);
        skipNoteTypeColorsSave.current = true;
        skipSimilarNotesSave.current = true;
        skipInboxSave.current = true;
        skipSpaztickSave.current = true;
        skipCalendarFeedsSave.current = true;
        skipCalendarLookoutDaysSave.current = true;
        skipDefaultStartPageSave.current = true;
        skipDefaultStartPagePhoneSave.current = true;
        skipMarkdownListAlternatingShadesSave.current = true;
        skipStreamThreadImageBgSave.current = true;
        skipStreamRootBackgroundMetaSave.current = true;
        skipThemeSave.current = true;
        skipHoverInsightSave.current = true;
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
      setIngestApiKeySet(false);
      setCalendarFeeds([]);
      setCalendarLookoutDays(0);
      setDefaultStartPage('stream');
      setDefaultStartPagePhone('stream');
      setMarkdownListAlternatingShades(true);
      setStreamThreadImageBgEnabled(false);
      setStreamThreadImageBgOpacity(0.28);
      setStreamBackgroundAnimate(true);
      setStreamBackgroundCrtEffect(false);
      setStreamRootBackgroundPresent(false);
      setStreamRootBackgroundOpacity(0.28);
      setCanvasUseStreamRootBackground(false);
      setUserBackgroundFetchRevision(0);
      setTheme('light');
      setHoverInsightState(defaultHoverInsightForAccount());
      skipNoteTypeColorsSave.current = true;
      skipSimilarNotesSave.current = true;
      skipInboxSave.current = true;
      skipSpaztickSave.current = true;
      skipCalendarFeedsSave.current = true;
      skipCalendarLookoutDaysSave.current = true;
      skipDefaultStartPageSave.current = true;
      skipDefaultStartPagePhoneSave.current = true;
      skipMarkdownListAlternatingShadesSave.current = true;
      skipStreamThreadImageBgSave.current = true;
      skipStreamRootBackgroundMetaSave.current = true;
      skipThemeSave.current = true;
      skipHoverInsightSave.current = true;
    }
  }, [user]);

  useLayoutEffect(() => {
    document.documentElement.classList.toggle(
      'hermes-list-alternating-shades',
      markdownListAlternatingShades
    );
  }, [markdownListAlternatingShades]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('hermes.theme', theme);
    } catch {
      /* ignore */
    }
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_META[theme]);
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
  }, [theme]);

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
        calendarFeeds: calendarFeeds.length > 0 ? calendarFeeds : null,
      }).catch((e) => console.error(e));
    }, 450);
    return () => {
      if (calendarFeedsSaveTimer.current) clearTimeout(calendarFeedsSaveTimer.current);
    };
  }, [calendarFeeds, user?.id, serverReady]);

  useEffect(() => {
    if (!user?.id || !serverReady) return;
    if (skipCalendarLookoutDaysSave.current) {
      skipCalendarLookoutDaysSave.current = false;
      return;
    }
    if (calendarLookoutDaysSaveTimer.current) clearTimeout(calendarLookoutDaysSaveTimer.current);
    calendarLookoutDaysSaveTimer.current = setTimeout(() => {
      calendarLookoutDaysSaveTimer.current = null;
      patchUserSettings({ calendarLookoutDays }).catch((e) => console.error(e));
    }, 450);
    return () => {
      if (calendarLookoutDaysSaveTimer.current) clearTimeout(calendarLookoutDaysSaveTimer.current);
    };
  }, [calendarLookoutDays, user?.id, serverReady]);

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

  useEffect(() => {
    if (!user?.id || !serverReady) return;
    if (skipDefaultStartPagePhoneSave.current) {
      skipDefaultStartPagePhoneSave.current = false;
      return;
    }
    if (defaultStartPagePhoneSaveTimer.current) clearTimeout(defaultStartPagePhoneSaveTimer.current);
    defaultStartPagePhoneSaveTimer.current = setTimeout(() => {
      defaultStartPagePhoneSaveTimer.current = null;
      patchUserSettings({ defaultStartPagePhone }).catch((e) => console.error(e));
    }, 450);
    return () => {
      if (defaultStartPagePhoneSaveTimer.current) clearTimeout(defaultStartPagePhoneSaveTimer.current);
    };
  }, [defaultStartPagePhone, user?.id, serverReady]);

  useEffect(() => {
    if (!user?.id || !serverReady) return;
    if (skipMarkdownListAlternatingShadesSave.current) {
      skipMarkdownListAlternatingShadesSave.current = false;
      return;
    }
    if (markdownListAlternatingShadesSaveTimer.current) {
      clearTimeout(markdownListAlternatingShadesSaveTimer.current);
    }
    markdownListAlternatingShadesSaveTimer.current = setTimeout(() => {
      markdownListAlternatingShadesSaveTimer.current = null;
      patchUserSettings({ markdownListAlternatingShades }).catch((e) => console.error(e));
    }, 450);
    return () => {
      if (markdownListAlternatingShadesSaveTimer.current) {
        clearTimeout(markdownListAlternatingShadesSaveTimer.current);
      }
    };
  }, [markdownListAlternatingShades, user?.id, serverReady]);

  useEffect(() => {
    if (!user?.id || !serverReady) return;
    if (skipStreamThreadImageBgSave.current) {
      skipStreamThreadImageBgSave.current = false;
      return;
    }
    if (streamThreadImageBgSaveTimer.current) clearTimeout(streamThreadImageBgSaveTimer.current);
    streamThreadImageBgSaveTimer.current = setTimeout(() => {
      streamThreadImageBgSaveTimer.current = null;
      patchUserSettings({
        streamThreadImageBgEnabled,
        streamThreadImageBgOpacity,
        streamBackgroundAnimate,
        streamBackgroundCrtEffect,
      }).catch((e) => console.error(e));
    }, 450);
    return () => {
      if (streamThreadImageBgSaveTimer.current) clearTimeout(streamThreadImageBgSaveTimer.current);
    };
  }, [
    streamThreadImageBgEnabled,
    streamThreadImageBgOpacity,
    streamBackgroundAnimate,
    streamBackgroundCrtEffect,
    user?.id,
    serverReady,
  ]);

  useEffect(() => {
    if (!user?.id || !serverReady) return;
    if (skipStreamRootBackgroundMetaSave.current) {
      skipStreamRootBackgroundMetaSave.current = false;
      return;
    }
    if (streamRootBackgroundMetaSaveTimer.current) {
      clearTimeout(streamRootBackgroundMetaSaveTimer.current);
    }
    streamRootBackgroundMetaSaveTimer.current = setTimeout(() => {
      streamRootBackgroundMetaSaveTimer.current = null;
      patchUserSettings({
        streamRootBackgroundOpacity,
        canvasUseStreamRootBackground,
      }).catch((e) => console.error(e));
    }, 450);
    return () => {
      if (streamRootBackgroundMetaSaveTimer.current) {
        clearTimeout(streamRootBackgroundMetaSaveTimer.current);
      }
    };
  }, [streamRootBackgroundOpacity, canvasUseStreamRootBackground, user?.id, serverReady]);

  useEffect(() => {
    if (!user?.id || !serverReady) return;
    if (skipThemeSave.current) {
      skipThemeSave.current = false;
      return;
    }
    if (themeSaveTimer.current) clearTimeout(themeSaveTimer.current);
    themeSaveTimer.current = setTimeout(() => {
      themeSaveTimer.current = null;
      patchUserSettings({ theme }).catch((e) => console.error(e));
    }, 450);
    return () => {
      if (themeSaveTimer.current) clearTimeout(themeSaveTimer.current);
    };
  }, [theme, user?.id, serverReady]);

  useEffect(() => {
    if (!user?.id || !serverReady) return;
    if (skipHoverInsightSave.current) {
      skipHoverInsightSave.current = false;
      return;
    }
    if (hoverInsightSaveTimer.current) clearTimeout(hoverInsightSaveTimer.current);
    hoverInsightSaveTimer.current = setTimeout(() => {
      hoverInsightSaveTimer.current = null;
      patchUserSettings({ hoverInsight }).catch((e) => console.error(e));
    }, 450);
    return () => {
      if (hoverInsightSaveTimer.current) clearTimeout(hoverInsightSaveTimer.current);
    };
  }, [hoverInsight, user?.id, serverReady]);

  const setDefaultStartPageSetting = useCallback((id) => {
    setDefaultStartPage(normalizeDefaultStartPage(id));
  }, []);

  const setDefaultStartPagePhoneSetting = useCallback((id) => {
    setDefaultStartPagePhone(normalizeDefaultStartPage(id));
  }, []);

  const setCalendarLookoutDaysSetting = useCallback((n) => {
    setCalendarLookoutDays(normalizeCalendarLookoutDays(n));
  }, []);

  const setThemeSetting = useCallback((t) => {
    setTheme(t === 'dark' ? 'dark' : 'light');
  }, []);

  const patchHoverInsight = useCallback((partial) => {
    if (!partial || typeof partial !== 'object') return;
    setHoverInsightState((prev) => ({
      ...prev,
      ...partial,
      ragdollContext:
        partial.ragdollContext != null && typeof partial.ragdollContext === 'object'
          ? { ...prev.ragdollContext, ...partial.ragdollContext }
          : prev.ragdollContext,
    }));
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

  const setMarkdownListAlternatingShadesSetting = useCallback((on) => {
    setMarkdownListAlternatingShades(Boolean(on));
  }, []);

  const setStreamThreadImageBgEnabledSetting = useCallback((on) => {
    setStreamThreadImageBgEnabled(Boolean(on));
  }, []);

  const setStreamThreadImageBgOpacitySetting = useCallback((n) => {
    const x = Number(n);
    if (!Number.isFinite(x)) return;
    setStreamThreadImageBgOpacity(Math.min(1, Math.max(0, x)));
  }, []);

  const setStreamBackgroundAnimateSetting = useCallback((on) => {
    setStreamBackgroundAnimate(Boolean(on));
  }, []);

  const setStreamBackgroundCrtEffectSetting = useCallback((on) => {
    setStreamBackgroundCrtEffect(Boolean(on));
  }, []);

  const setStreamRootBackgroundOpacitySetting = useCallback((n) => {
    const x = Number(n);
    if (!Number.isFinite(x)) return;
    setStreamRootBackgroundOpacity(Math.min(1, Math.max(0, x)));
  }, []);

  const setCanvasUseStreamRootBackgroundSetting = useCallback((on) => {
    setCanvasUseStreamRootBackground(Boolean(on));
  }, []);

  const uploadStreamRootBackgroundFile = useCallback(async (file) => {
    await uploadUserBackground(file);
    setStreamRootBackgroundPresent(true);
    setUserBackgroundFetchRevision(Date.now());
    skipStreamRootBackgroundMetaSave.current = true;
    skipStreamThreadImageBgSave.current = true;
    try {
      await patchUserSettings({
        streamThreadImageBgEnabled,
        streamThreadImageBgOpacity,
        streamBackgroundAnimate,
        streamBackgroundCrtEffect,
        streamRootBackgroundOpacity,
        canvasUseStreamRootBackground,
      });
    } catch (e) {
      console.error(e);
    }
  }, [
    streamThreadImageBgEnabled,
    streamThreadImageBgOpacity,
    streamBackgroundAnimate,
    streamBackgroundCrtEffect,
    streamRootBackgroundOpacity,
    canvasUseStreamRootBackground,
  ]);

  const removeStreamRootBackgroundFile = useCallback(async () => {
    await deleteUserBackground();
    setStreamRootBackgroundPresent(false);
    setUserBackgroundFetchRevision(Date.now());
    skipStreamRootBackgroundMetaSave.current = true;
    skipStreamThreadImageBgSave.current = true;
    try {
      await patchUserSettings({
        streamThreadImageBgEnabled,
        streamThreadImageBgOpacity,
        streamBackgroundAnimate,
        streamBackgroundCrtEffect,
        streamRootBackgroundOpacity,
        canvasUseStreamRootBackground,
      });
    } catch (e) {
      console.error(e);
    }
  }, [
    streamThreadImageBgEnabled,
    streamThreadImageBgOpacity,
    streamBackgroundAnimate,
    streamBackgroundCrtEffect,
    streamRootBackgroundOpacity,
    canvasUseStreamRootBackground,
  ]);

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

  const saveIngestApiKey = useCallback(async (secretOrNull) => {
    const data = await patchUserSettings({
      ingestApiKey: secretOrNull == null || secretOrNull === '' ? null : String(secretOrNull),
    });
    setIngestApiKeySet(data.ingestApiKeySet === true);
  }, []);

  const setCalendarFeedsSetting = useCallback((feeds) => {
    if (!Array.isArray(feeds)) {
      setCalendarFeeds([]);
      return;
    }
    setCalendarFeeds(feeds);
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
      ingestApiKeySet,
      saveIngestApiKey,
      calendarFeeds,
      setCalendarFeeds: setCalendarFeedsSetting,
      calendarLookoutDays,
      setCalendarLookoutDays: setCalendarLookoutDaysSetting,
      defaultStartPage,
      setDefaultStartPage: setDefaultStartPageSetting,
      defaultStartPagePhone,
      setDefaultStartPagePhone: setDefaultStartPagePhoneSetting,
      markdownListAlternatingShades,
      setMarkdownListAlternatingShades: setMarkdownListAlternatingShadesSetting,
      streamThreadImageBgEnabled,
      setStreamThreadImageBgEnabled: setStreamThreadImageBgEnabledSetting,
      streamThreadImageBgOpacity,
      setStreamThreadImageBgOpacity: setStreamThreadImageBgOpacitySetting,
      streamBackgroundAnimate,
      setStreamBackgroundAnimate: setStreamBackgroundAnimateSetting,
      streamBackgroundCrtEffect,
      setStreamBackgroundCrtEffect: setStreamBackgroundCrtEffectSetting,
      streamRootBackgroundPresent,
      streamRootBackgroundOpacity,
      setStreamRootBackgroundOpacity: setStreamRootBackgroundOpacitySetting,
      canvasUseStreamRootBackground,
      setCanvasUseStreamRootBackground: setCanvasUseStreamRootBackgroundSetting,
      userBackgroundFetchRevision,
      uploadStreamRootBackgroundFile,
      removeStreamRootBackgroundFile,
      theme,
      setTheme: setThemeSetting,
      hoverInsight,
      patchHoverInsight,
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
      ingestApiKeySet,
      saveIngestApiKey,
      calendarFeeds,
      setCalendarFeedsSetting,
      calendarLookoutDays,
      setCalendarLookoutDaysSetting,
      defaultStartPage,
      setDefaultStartPageSetting,
      defaultStartPagePhone,
      setDefaultStartPagePhoneSetting,
      markdownListAlternatingShades,
      setMarkdownListAlternatingShadesSetting,
      streamThreadImageBgEnabled,
      setStreamThreadImageBgEnabledSetting,
      streamThreadImageBgOpacity,
      setStreamThreadImageBgOpacitySetting,
      streamBackgroundAnimate,
      setStreamBackgroundAnimateSetting,
      streamBackgroundCrtEffect,
      setStreamBackgroundCrtEffectSetting,
      streamRootBackgroundPresent,
      streamRootBackgroundOpacity,
      setStreamRootBackgroundOpacitySetting,
      canvasUseStreamRootBackground,
      setCanvasUseStreamRootBackgroundSetting,
      userBackgroundFetchRevision,
      uploadStreamRootBackgroundFile,
      removeStreamRootBackgroundFile,
      theme,
      setThemeSetting,
      hoverInsight,
      patchHoverInsight,
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
