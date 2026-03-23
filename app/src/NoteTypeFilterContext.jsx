import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { ALL_NOTE_TYPES } from './noteTypeFilter';

const NoteTypeFilterContext = createContext(null);

export function NoteTypeFilterProvider({ children }) {
  const [visibleNoteTypes, setVisibleNoteTypes] = useState(() => new Set(ALL_NOTE_TYPES));

  const toggleNoteType = useCallback((type) => {
    setVisibleNoteTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        if (next.size <= 1) return prev;
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ visibleNoteTypes, toggleNoteType }),
    [visibleNoteTypes, toggleNoteType]
  );

  return <NoteTypeFilterContext.Provider value={value}>{children}</NoteTypeFilterContext.Provider>;
}

export function useNoteTypeFilter() {
  const ctx = useContext(NoteTypeFilterContext);
  if (!ctx) {
    throw new Error('useNoteTypeFilter must be used within NoteTypeFilterProvider');
  }
  return ctx;
}
