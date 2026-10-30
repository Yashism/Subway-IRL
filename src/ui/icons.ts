/**
 * The game's icons: white glyphs with an ink outline, drawn inline so they take their size from
 * the font size of whatever holds them (`.gk-icon` in kit.css) and their colour from nothing — a
 * glyph looks the same on a green button as on a blue one.
 *
 * Fixed markup only, no dynamic data, so it is safe to assign with innerHTML. The gear is the
 * Material Design "settings" glyph (Apache-2.0); the rest are drawn here.
 */

const INK = '#3a1f12';
const OPEN = '<svg class="gk-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">';

/** A filled shape with the outline painted outside the fill. */
const solid = (d: string, evenodd = false): string =>
  `<path d="${d}" fill="#fff" stroke="${INK}" stroke-width="2.4" stroke-linejoin="round" paint-order="stroke"${evenodd ? ' fill-rule="evenodd"' : ''}/>`;

/** A thick line: an ink stroke with a white one on top. */
const line = (d: string, w = 3.4): string =>
  `<path d="${d}" fill="none" stroke="${INK}" stroke-width="${w + 2.6}" stroke-linecap="round" stroke-linejoin="round"/>` +
  `<path d="${d}" fill="none" stroke="#fff" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;

const SPEAKER = 'M3 9v6h4l5 4V5L7 9H3z';

export const ICONS = {
  play: `${OPEN}${solid('M7 3.6v16.8c0 .8.9 1.3 1.6.8l13-8.4a1 1 0 0 0 0-1.6L8.6 2.8C7.9 2.3 7 2.8 7 3.6z')}</svg>`,
  pause: `${OPEN}${solid('M6 4h4.2v16H6z')}${solid('M13.8 4H18v16h-4.2z')}</svg>`,
  gear: `${OPEN}${solid(
    'M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
    true,
  )}</svg>`,
  runs: `${OPEN}${solid('M3.5 13h4.5a1 1 0 0 1 1 1v6.5H2.5V14a1 1 0 0 1 1-1z')}${solid('M10.5 4.5h3.8a1 1 0 0 1 1 1v15h-5.8v-15a1 1 0 0 1 1-1z')}${solid('M16.5 9h4a1 1 0 0 1 1 1v10.5h-6V10a1 1 0 0 1 1-1z')}</svg>`,
  shop: `${OPEN}${line('M8.6 8.5V7a3.4 3.4 0 0 1 6.8 0v1.5', 2.6)}${solid('M4.6 8.5h14.8l1.1 12H3.5l1.1-12z')}</svg>`,
  pin: `${OPEN}${solid('M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 4.4a2.7 2.7 0 1 1 0 5.4 2.7 2.7 0 0 1 0-5.4z', true)}</svg>`,
  home: `${OPEN}${solid('M2.8 11.4 12 3.2l9.2 8.2-1.2 1.3-1 0V21h-5.5v-6h-3v6H5.9v-8.3l-1 0z')}</svg>`,
  close: `${OPEN}${line('M5.5 5.5l13 13M18.5 5.5l-13 13', 3.8)}</svg>`,
  check: `${OPEN}${line('M4.8 12.8l4.7 4.7L19.4 7', 3.8)}</svg>`,
  soundOn: `${OPEN}${solid(SPEAKER)}${line('M15.8 8.8a4.6 4.6 0 0 1 0 6.4', 2.2)}${line('M18.4 6.2a8.3 8.3 0 0 1 0 11.6', 2.2)}</svg>`,
  soundOff: `${OPEN}${solid(SPEAKER)}${line('M16 9.4l5 5.2M21 9.4l-5 5.2', 2.4)}</svg>`,
  camera: `${OPEN}${solid('M4 7h3l1.5-2h7L17 7h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zm8 2.2a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2z', true)}</svg>`,
  star: `${OPEN}${solid('M12 2.6l2.9 6.2 6.7.8-5 4.6 1.4 6.7L12 17.5 6 20.9l1.4-6.7-5-4.6 6.7-.8L12 2.6z')}</svg>`,
} as const;

export type IconName = keyof typeof ICONS;

/** The markup for one icon. */
export const icon = (name: IconName): string => ICONS[name];

/** Puts an icon into an element, replacing whatever it held. */
export function setIcon(el: Element, name: IconName): void {
  el.innerHTML = ICONS[name];
}
