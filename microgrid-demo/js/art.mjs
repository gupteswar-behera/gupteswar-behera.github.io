// Pictures of each microgrid component on a 64 by 64 grid, with no text elements. Solar, grid and
// BESS use the icons from the user's Qualifiers 2 deck (site/assets). The rest are drawn here,
// because that deck has no pictures of them.

const picture = (file) => `<image href="assets/${file}" x="0" y="0" width="64" height="64" preserveAspectRatio="xMidYMid meet"/>`;

const NAVY = "#1f3864";
const BLUE = "#2f5ca4";
const SKY = "#7089b8";
const SUN = "#f4b731";
const GREEN = "#2e7d32";
const STEEL = "#6b7280";
const TEAL = "#0e7c86";

const line = (d, color, width = 2) => `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
const windows = (xs, ys, colors) => xs.flatMap((x, i) => ys.map((y, j) => `<rect x="${x}" y="${y}" width="3" height="3" fill="${colors[(i + j) % 2]}"/>`)).join("");

const SOLAR = picture("solar.png");
const GRID = picture("grid.png");
const BESS = picture("bess.png");

const LOAD = `
  <rect x="5" y="26" width="16" height="33" fill="${SKY}" stroke="${NAVY}" stroke-width="1.500"/>
  <rect x="23" y="6" width="18" height="53" fill="${BLUE}" stroke="${NAVY}" stroke-width="1.500"/>
  <rect x="43" y="32" width="16" height="27" fill="${NAVY}"/>
  ${windows([8.500, 14.500], [31, 38, 45, 52], ["#ffffff", SUN])}
  ${windows([27, 34], [11, 18, 25, 32, 39, 46], [SUN, "#ffffff"])}
  ${windows([46.500, 52.500], [37, 44, 51], ["#ffffff", SUN])}
  ${line("M2 60h60", NAVY, 2.500)}
`;

const PHES = `
  <path d="M1 60V22h27l17 27h18v11z" fill="#8bc34a" stroke="#558b2f" stroke-width="1.500" stroke-linejoin="round"/>
  <path d="M3 12h27l-3 10H6z" fill="#64b5f6" stroke="${BLUE}" stroke-width="1.500" stroke-linejoin="round"/>
  ${line("M6 16.500h6M16 16.500h9", "#e3f2fd", 1.500)}
  ${line("M26 22 44 45", STEEL, 3.400)}
  <rect x="38" y="41" width="15" height="11" rx="2" fill="#546e7a"/>
  <circle cx="45.500" cy="46.500" r="3.800" fill="${SUN}"/>
  ${line("M45.500 43.500v6M42.500 46.500h6", "#37474f", 1.300)}
  <path d="M44 53h19v7H47z" fill="#42a5f5" stroke="${BLUE}" stroke-width="1.500" stroke-linejoin="round"/>
  ${line("M51 57h6", "#e3f2fd", 1.500)}
`;

const CAES = `
  <rect x="4" y="30" width="56" height="27" rx="13.500" fill="#90a4ae" stroke="#455a64" stroke-width="2"/>
  ${line("M18 31v25M46 31v25", "#607d8b", 2)}
  ${line("M11 39c4-3 7 3 11 0s7 3 11 0 7 3 11 0 6 3 9 1M11 48c4-3 7 3 11 0s7 3 11 0 7 3 11 0 6 3 9 1", "#eceff1", 2)}
  <rect x="36" y="20" width="5" height="11" fill="#546e7a"/>
  <circle cx="38.500" cy="13" r="10.500" fill="#ffffff" stroke="#455a64" stroke-width="2.200"/>
  ${line("M38.500 13 44 7.500", "#d32f2f", 2.200)}
  ${line("M31.500 15.500h1M38 5.500v1M45 15.500h1", "#455a64", 1.600)}
  ${line("M5 24c3-3 6-3 9 0s6 3 9 0M5 15c3-3 6-3 9 0s6 3 9 0", "#64b5f6", 2.400)}
`;

const FCES = `
  <rect x="4" y="8" width="23" height="51" rx="11.500" fill="#c8e6c9" stroke="${GREEN}" stroke-width="2.200"/>
  <rect x="11" y="3" width="9" height="6" rx="1" fill="${GREEN}"/>
  ${line("M9.500 26v16M19 26v16M9.500 34H19", GREEN, 2.600)}
  ${line("M21.500 39.500a2.200 2.200 0 1 1 3.700 1.800l-3.700 3.700h4.300", GREEN, 1.800)}
  ${line("M27 34h9", STEEL, 3.200)}
  <rect x="36" y="18" width="25" height="35" rx="3" fill="${TEAL}" stroke="${NAVY}" stroke-width="1.500"/>
  ${line("M41 22v27M46 22v27M51 22v27M56 22v27", "#b2dfdb", 1.700)}
  <path d="M51 3 42 16h6l-2.500 9L55 12h-6l2-9z" fill="${SUN}" stroke="#ffffff" stroke-width="1.500" stroke-linejoin="round"/>
`;

const EMPTY = `
  <rect x="6" y="6" width="52" height="52" rx="9" fill="none" stroke="#9ca3af" stroke-width="2.200" stroke-dasharray="6 5"/>
  ${line("M26 21v9M38 21v9M21 30h22v6a11 11 0 0 1-22 0zM32 47v7", "#9ca3af", 2.400)}
`;

const DIESEL = `
  <rect x="3" y="52" width="58" height="7" rx="1.500" fill="${STEEL}"/>
  <rect x="7" y="24" width="32" height="28" rx="2" fill="#e0a030" stroke="${NAVY}" stroke-width="1.500"/>
  ${line("M13 30v16M19 30v16M25 30v16M31 30v16", NAVY, 1.600)}
  <rect x="39" y="28" width="20" height="24" rx="4" fill="${BLUE}" stroke="${NAVY}" stroke-width="1.500"/>
  <path d="M51 31 44 41h5l-2 8 8-11h-5l1-7z" fill="${SUN}"/>
  <rect x="14" y="12" width="6" height="12" fill="#546e7a"/>
  ${line("M17 9c-3-2 3-4 0-6M26 13c-3-2 3-4 0-6", "#9ca3af", 2)}
`;

export const ART = { solar: SOLAR, grid: GRID, load: LOAD, diesel: DIESEL, BESS, PHES, CAES, FCES, NONE: EMPTY };

// A standalone picture for HTML, or a positioned one inside the diagram's SVG.
export const art = (kind, cls = "art") => `<svg class="${cls}" viewBox="0 0 64 64" aria-hidden="true" focusable="false">${ART[kind]}</svg>`;
export const artAt = (kind, x, y, size, opacity = 1) => `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true" opacity="${opacity}">${ART[kind]}</svg>`;
