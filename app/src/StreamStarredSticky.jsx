import React, {
  createContext,
  useContext,
  useRef,
  useState,
  useLayoutEffect,
  useMemo,
} from 'react';
import './StreamStarredSticky.css';

const StreamScrollContext = createContext(null);

export function StreamScrollProvider({ scrollRef, children }) {
  const value = useMemo(() => scrollRef, [scrollRef]);
  return <StreamScrollContext.Provider value={value}>{children}</StreamScrollContext.Provider>;
}

export function useStreamScrollRef() {
  return useContext(StreamScrollContext);
}

/**
 * Starred thread/root rows: sticky at top with stacked offsets; compact (one line + star) when
 * scrolled so the card would move above the sticky band.
 */
export function StreamStarredListItem({ note, stackIndex, className, style, children, ...rest }) {
  const scrollRef = useStreamScrollRef();
  const liRef = useRef(null);
  const [compact, setCompact] = useState(false);

  useLayoutEffect(() => {
    const li = liRef.current;
    if (!li || !note?.starred) return undefined;

    let rafId = 0;
    let ro = null;

    const measure = () => {
      const se = scrollRef?.current;
      if (!se) return;
      const sr = se.getBoundingClientRect();
      const lr = li.getBoundingClientRect();
      const topInView = lr.top - sr.top;
      const threshold = 8;
      setCompact(topInView < threshold);
    };

    const attach = () => {
      const scrollEl = scrollRef?.current;
      if (!scrollEl) {
        rafId = requestAnimationFrame(attach);
        return;
      }
      measure();
      scrollEl.addEventListener('scroll', measure, { passive: true });
      window.addEventListener('resize', measure);
      ro = new ResizeObserver(measure);
      ro.observe(scrollEl);
      ro.observe(li);
    };

    attach();

    return () => {
      cancelAnimationFrame(rafId);
      const se = scrollRef?.current;
      if (se) {
        se.removeEventListener('scroll', measure);
      }
      window.removeEventListener('resize', measure);
      ro?.disconnect();
    };
  }, [scrollRef, note?.starred, note?.id]);

  const kids = React.Children.toArray(children);
  const [first, ...restKids] = kids;
  const firstEl =
    React.isValidElement(first)
      ? React.cloneElement(first, { streamCompact: compact })
      : first;

  const stickyTop = `calc(var(--stream-star-sticky-base, 3.15rem) + ${stackIndex} * var(--stream-star-compact-height, 2.65rem))`;

  return (
    <li
      ref={liRef}
      {...rest}
      className={['stream-page-li--starred', compact ? 'stream-page-li--starred-compact' : '', className]
        .filter(Boolean)
        .join(' ')}
      style={{
        ...style,
        position: 'sticky',
        top: stickyTop,
        zIndex: 12 + stackIndex,
      }}
    >
      {firstEl}
      {restKids}
    </li>
  );
}
