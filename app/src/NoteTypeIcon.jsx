import React from 'react';

const TYPES = new Set(['note', 'organization', 'person', 'event']);

/**
 * Themed stroke icons (currentColor + --note-type-icon-* CSS variables).
 * Paths mirror assets/note.svg, organization.svg, person.svg, event.svg.
 */
export default function NoteTypeIcon({ type = 'note', className = '' }) {
  const t = TYPES.has(type) ? type : 'note';

  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg',
    className: `note-type-icon note-type-icon--${t}${className ? ` ${className}` : ''}`,
    'aria-hidden': true,
    focusable: false,
  };

  if (t === 'note') {
    return (
      <svg {...common}>
        <path
          d="M4 4V20C4 21.1046 4.89543 22 6 22L18 22C19.1046 22 20 21.1046 20 20V8.34162C20 7.8034 19.7831 7.28789 19.3982 6.91161L14.9579 2.56999C14.5842 2.20459 14.0824 2 13.5597 2L6 2C4.89543 2 4 2.89543 4 4Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M9 13H15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M9 17H12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path
          d="M14 2V6C14 7.10457 14.8954 8 16 8H20"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (t === 'organization') {
    return (
      <svg {...common}>
        <path
          d="M16.719 19.7519L16.0785 14.6279C15.8908 13.1266 14.6146 12 13.1017 12H12H10.8983C9.38538 12 8.10917 13.1266 7.92151 14.6279L7.28101 19.7519C7.1318 20.9456 8.06257 22 9.26556 22H12H14.7344C15.9374 22 16.8682 20.9456 16.719 19.7519Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="12" cy="5" r="3" stroke="currentColor" strokeWidth="2" />
        <circle cx="4" cy="9" r="2" stroke="currentColor" strokeWidth="2" />
        <circle cx="20" cy="9" r="2" stroke="currentColor" strokeWidth="2" />
        <path
          d="M4 14H3.69425C2.71658 14 1.8822 14.7068 1.72147 15.6712L1.38813 17.6712C1.18496 18.8903 2.12504 20 3.36092 20H7"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M20 14H20.3057C21.2834 14 22.1178 14.7068 22.2785 15.6712L22.6119 17.6712C22.815 18.8903 21.8751 20 20.6392 20C19.4775 20 18.0952 20 17 20"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (t === 'person') {
    return (
      <svg {...common}>
        <circle cx="12" cy="7" r="5" stroke="currentColor" strokeWidth="2" />
        <path
          d="M17 14H17.3517C18.8646 14 20.1408 15.1266 20.3285 16.6279L20.719 19.7519C20.8682 20.9456 19.9374 22 18.7344 22H5.26556C4.06257 22 3.1318 20.9456 3.28101 19.7519L3.67151 16.6279C3.85917 15.1266 5.13538 14 6.64835 14H7"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <svg {...common}>
      <rect
        x="2"
        y="4"
        width="20"
        height="18"
        rx="4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M8 2V6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16 2V6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2 10H22" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
