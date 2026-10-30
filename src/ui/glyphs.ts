/**
 * Extra glyphs for the setup, check and stats screens, drawn in the same style as icons.ts (white
 * with an ink outline, sized by the font size of whatever holds them via `.gk-icon`) for the few
 * things the shared set has no picture for: a runner, a lock, a hand, a flame.
 *
 * Fixed markup only, no dynamic data, so it is safe to assign with innerHTML.
 */

const INK = '#3a1f12';
const OPEN = '<svg class="gk-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">';

/** A filled shape with the outline painted outside the fill. */
const solid = (d: string, fill = '#fff', evenodd = false): string =>
  `<path d="${d}" fill="${fill}" stroke="${INK}" stroke-width="2.4" stroke-linejoin="round" paint-order="stroke"${evenodd ? ' fill-rule="evenodd"' : ''}/>`;

/** A thick line: an ink stroke with a white one on top. */
const line = (d: string, w = 3.2): string =>
  `<path d="${d}" fill="none" stroke="${INK}" stroke-width="${w + 2.6}" stroke-linecap="round" stroke-linejoin="round"/>` +
  `<path d="${d}" fill="none" stroke="#fff" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;

export const GLYPHS = {
  /** A stick runner mid-stride. */
  run: `${OPEN}${line('M13.6 9.2l-2.4 5.6 3.6 2.6-1 3.8M11.2 14.8L7.4 17l-2 3.2M13.6 9.4l4.6 2.2 1.4-2.8M13.2 10.2l-4 1.2-1.4 3', 2.6)}${solid('M15.6 2.6a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8z')}</svg>`,
  jump: `${OPEN}${solid('M12 2.6l8 8.6h-4.8V21H8.8v-9.8H4z')}</svg>`,
  duck: `${OPEN}${solid('M12 21.4l-8-8.6h4.8V3h6.4v9.8H20z')}</svg>`,
  step: `${OPEN}${solid('M1.8 12l6.2-6.4v4h8v-4l6.2 6.4-6.2 6.4v-4H8v4z')}</svg>`,
  lock: `${OPEN}${line('M7.6 11V8a4.4 4.4 0 0 1 8.8 0v3', 2.6)}${solid('M5.4 10.6h13.2a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1H5.4a1 1 0 0 1-1-1v-8.4a1 1 0 0 1 1-1z', '#ffd43b')}</svg>`,
  keyboard: `${OPEN}${solid('M3.4 6h17.2a1.4 1.4 0 0 1 1.4 1.4v9.2a1.4 1.4 0 0 1-1.4 1.4H3.4A1.4 1.4 0 0 1 2 16.6V7.4A1.4 1.4 0 0 1 3.4 6z')}${line('M6 9.6h.1M9.4 9.6h.1M12.8 9.6h.1M16.2 9.6h.1M6 12.4h.1M9.4 12.4h.1M12.8 12.4h.1M16.2 12.4h.1', 2.2)}${line('M8 15.2h8', 2)}</svg>`,
  hand: `${OPEN}${solid('M8.2 13V6.9Q8.2 5.6 9.4 5.6Q10.6 5.6 10.6 6.9V4.9Q10.6 3.6 11.8 3.6Q13 3.6 13 4.9V5.9Q13 4.7 14.2 4.7Q15.4 4.7 15.4 5.9V8Q15.4 6.9 16.6 6.9Q17.8 6.9 17.8 8.2V14Q17.8 18.2 15.4 20.4Q14.4 21.4 13 21.4H11.4Q9.4 21.4 8.2 19.6L5 14.6Q4.3 13.6 5.2 12.9Q6.2 12.2 7 13.2L8.2 14.8Z', '#fff')}<path d="M10.6 8.4V12.6M13 7.8V12.6M15.4 9.4V12.6" fill="none" stroke="${INK}" stroke-width="1.1" stroke-linecap="round"/></svg>`,
  redo: `${OPEN}${line('M18.6 12.4a6.6 6.6 0 1 1-2-5', 3)}${solid('M20.6 3.6v6.4h-6.4z')}</svg>`,
  flame: `${OPEN}${solid('M12.4 2c.5 3-1.2 4.4-2.8 6.2C8 10 6.4 11.8 6.4 14.6A5.6 5.6 0 0 0 12 20.4a5.6 5.6 0 0 0 5.6-5.8c0-2.4-1.2-3.6-2.2-5 0 1.4-.6 2.4-1.4 2.8.4-3.2-.2-7.2-1.6-9.4z', '#ffb42e')}${solid('M12 20.4a3 3 0 0 1-3-3c0-2 1.8-2.8 2.4-4.6 1.2 1.2 3.6 2.4 3.6 4.6a3 3 0 0 1-3 3z', '#ffe873')}</svg>`,
  /** A pointing arrow-free "tick" ring for the checklist's pending state. */
  dots: `${OPEN}${line('M6 12h.1M12 12h.1M18 12h.1', 3.6)}</svg>`,
} as const;

export type GlyphName = keyof typeof GLYPHS;

/** The markup for one glyph. */
export const glyph = (name: GlyphName): string => GLYPHS[name];
