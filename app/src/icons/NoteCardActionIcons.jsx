import React from 'react';

const common = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  xmlns: 'http://www.w3.org/2000/svg',
  'aria-hidden': true,
  focusable: false,
};

/** Themed via `color` / `currentColor` on the parent button */
export function NoteCardIconFocus({ className }) {
  return (
    <svg {...common} className={className}>
      <path
        d="M12 20L12 4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5 11L12 4L19 11"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function NoteCardIconInsight({ className }) {
  return (
    <svg {...common} className={className}>
      <path
        d="M5 4V5C5 6.6356 7 9 7.99951 10L8.75075 19.0104C8.89163 20.7003 10.3043 22 11.9999 22V22C13.6957 22 15.1083 20.7002 15.2491 19.0103L16 10C17 9 19 6.63574 19 5V4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 11L12 13"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <ellipse
        cx="12"
        cy="4"
        rx="7"
        ry="2"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function NoteCardIconEdit({ className }) {
  return (
    <svg {...common} className={className}>
      <path
        d="M4.33295 16.048L16.5714 3.80952C17.5708 2.81015 19.1911 2.81015 20.1905 3.80952C21.1898 4.8089 21.1898 6.4292 20.1905 7.42857L7.952 19.667C7.6728 19.9462 7.3172 20.1366 6.93002 20.214L3 21L3.786 17.07C3.86344 16.6828 4.05375 16.3272 4.33295 16.048Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M14.5 6.5L17.5 9.5" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

export function NoteCardIconDelete({ className }) {
  return (
    <svg {...common} className={className}>
      <path
        d="M4 6H20L18.4199 20.2209C18.3074 21.2337 17.4512 22 16.4321 22H7.56786C6.54876 22 5.69264 21.2337 5.5801 20.2209L4 6Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7.34491 3.14716C7.67506 2.44685 8.37973 2 9.15396 2H14.846C15.6203 2 16.3249 2.44685 16.6551 3.14716L18 6H6L7.34491 3.14716Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M2 6H22" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 11V16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 11V16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function NoteCardIconTag({ className }) {
  return (
    <svg {...common} className={className}>
      <path
        d="M9.86873 17.1282C9.86873 17.6947 9.41314 18.1538 8.85114 18.1538C8.28914 18.1538 7.83355 17.6947 7.83355 17.1282C7.83355 16.5618 8.28914 16.1026 8.85114 16.1026C9.41314 16.1026 9.86873 16.5618 9.86873 17.1282Z"
        fill="currentColor"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M5.79837 3.53846C5.09587 3.53846 4.52638 4.11246 4.52638 4.82051V17.2403C4.52638 17.6037 4.67943 17.9501 4.94746 18.1932L7.08522 20.1324C7.31878 20.3443 7.6219 20.4615 7.93613 20.4615H9.76615C10.0804 20.4615 10.3835 20.3443 10.6171 20.1324L13.1759 17.8113V4.82051C13.1759 4.11246 12.6064 3.53846 11.9039 3.53846H5.79837ZM14.7023 16.2968L20.1011 10.8553C20.5978 10.3546 20.5978 9.54284 20.1011 9.04217L15.4346 4.3388C15.2191 4.12157 14.8942 4.08171 14.6386 4.21924C14.6803 4.41299 14.7023 4.61416 14.7023 4.82051V16.2968ZM13.9181 2.86248C13.4091 2.33073 12.6948 2 11.9039 2H5.79837C4.25287 2 3 3.26279 3 4.82051V17.2403C3 18.0399 3.3367 18.8019 3.92636 19.3368L6.06412 21.276C6.57797 21.7421 7.24481 22 7.93613 22H9.76615C10.4575 22 11.1243 21.7421 11.6382 21.276L14.4496 18.7256C14.4596 18.7166 14.4693 18.7073 14.4787 18.6978L21.1804 11.9431C22.2732 10.8416 22.2732 9.05579 21.1804 7.95431L16.5139 3.25094C15.8111 2.54255 14.7514 2.41306 13.9181 2.86248Z"
        fill="currentColor"
      />
    </svg>
  );
}
