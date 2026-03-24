import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { ALL_NOTE_TYPES } from './noteTypeFilter';

const SearchNoteTypeFilterContext = createContext(null);

/** Independent note-type toggles for the Search page only (header uses NoteTypeFilterContext). */
export function SearchNoteTypeFilterProvider({ children }) {
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

  return (
    <SearchNoteTypeFilterContext.Provider value={value}>{children}</SearchNoteTypeFilterContext.Provider>
  );
}

export function useSearchNoteTypeFilter() {
  const ctx = useContext(SearchNoteTypeFilterContext);
  if (!ctx) {
    throw new Error('useSearchNoteTypeFilter must be used within SearchNoteTypeFilterProvider');
  }
  return ctx;
}
