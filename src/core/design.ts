// How a dashboard looks. A hoist's design sets the page (palette, cards, backdrop, font, motion) and
// the defaults for its charts; a flag's style overrides those for one flag. Neither changes what a
// flag means: style never touches the binding, a reviewed flag stays reviewed, and the colour rules
// (good, warn, bad) always win over a palette, so a status cannot be restyled away.
//
// Both come from shared files, so every value is checked against a fixed list or range when read.
// Colours must be plain #rrggbb; nothing here can carry CSS or markup into the page.

export type PaletteId = 'skin' | 'signal' | 'ember' | 'meadow' | 'dusk' | 'mono' | 'custom';
export type BarLayout = 'auto' | 'stacked' | 'grouped' | 'percent';
export type Orientation = 'auto' | 'horizontal' | 'vertical';
export type Curve = 'smooth' | 'straight' | 'step';
export type Markers = 'auto' | 'on' | 'off';
export type PieForm = 'donut' | 'pie' | 'rose' | 'funnel' | 'treemap';
export type KpiForm = 'number' | 'gauge';
export type KpiSize = 'small' | 'medium' | 'large' | 'huge';
export type Fill = 'solid' | 'gradient';
export type Labels = 'auto' | 'on' | 'off';
export type LegendPlace = 'auto' | 'top' | 'bottom' | 'right' | 'off';
export type Motion = 'none' | 'calm' | 'lively';
export type CardLook = 'raised' | 'outline' | 'flat' | 'glass';
export type Backdrop = 'plain' | 'tide' | 'dawn' | 'grid';
export type FontChoice = 'system' | 'serif' | 'mono' | 'condensed';
export type Align = 'left' | 'center';

/** The chart settings a page can default and a flag can override. Every field is optional. */
export interface ChartLook {
  palette?: PaletteId;
  /** Used when the palette is 'custom'. */
  colors?: string[];
  fill?: Fill;
  /** Bar corner radius in pixels. */
  corners?: number;
  glow?: boolean;
  curve?: Curve;
  lineWidth?: number;
  markers?: Markers;
  labels?: Labels;
  legend?: LegendPlace;
  gridLines?: boolean;
  /** Hovering a mark dims the others. */
  focus?: boolean;
  motion?: Motion;
  striped?: boolean;
  tableBars?: boolean;
  titleAlign?: Align;
}

export interface FlagStyle extends ChartLook {
  barLayout?: BarLayout;
  orientation?: Orientation;
  pieForm?: PieForm;
  kpiForm?: KpiForm;
  /** The top of the gauge. */
  gaugeMax?: number;
  kpiSize?: KpiSize;
  /** False lets a line start above zero; bars always start at zero. */
  zeroBase?: boolean;
  target?: { value: number; label: string };
  average?: boolean;
  /** A slider and Ctrl+wheel zoom along the chart. */
  zoom?: boolean;
  /** A coloured strip along the top of the card. */
  accent?: string;
  hideTitle?: boolean;
  /** Combo flags: per measure key, bars or a line and which scale (src/core/combo.ts comboRoles). */
  combo?: Record<string, { as?: 'bar' | 'line'; axis?: 'left' | 'right' }>;
  /** Map flags: 'us-states' (the built-in tile map, the default) or the id of a region map in the Semaphore folder. */
  map?: string;
}

export interface HoistDesign {
  look?: string;
  card?: CardLook;
  radius?: number;
  backdrop?: Backdrop;
  font?: FontChoice;
  charts?: ChartLook;
}

type Pair = { light: readonly string[]; dark: readonly string[] };

/**
 * Validated palettes: each order passes the adjacent colour-blind and normal-vision checks in both
 * modes (docs/DESIGN.md). The order is what makes them safe, so never re-sort one. Mono is a
 * single-hue ramp for ordered values.
 */
export const PALETTES: Record<Exclude<PaletteId, 'skin' | 'custom'>, Pair & { label: string }> = {
  signal: { label: 'Signal', light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'], dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'] },
  ember: { label: 'Ember', light: ['#eb6834', '#6250d6', '#eda100', '#2a78d6', '#1baf7a', '#e34948', '#008300', '#e87ba4'], dark: ['#d95926', '#9085e9', '#c98500', '#3987e5', '#199e70', '#e66767', '#008300', '#d55181'] },
  meadow: { label: 'Meadow', light: ['#008300', '#eda100', '#2a78d6', '#eb6834', '#1baf7a', '#e34948', '#6250d6', '#e87ba4'], dark: ['#008300', '#c98500', '#3987e5', '#d95926', '#199e70', '#e66767', '#9085e9', '#d55181'] },
  dusk: { label: 'Dusk', light: ['#6250d6', '#e87ba4', '#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#008300', '#e34948'], dark: ['#9085e9', '#d55181', '#3987e5', '#d95926', '#199e70', '#c98500', '#008300', '#e66767'] },
  mono: { label: 'One blue', light: ['#104281', '#1c5cab', '#2a78d6', '#5598e7', '#86b6ef'], dark: ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf'] },
};

export const MAX_COLORS = 8;
export const MAX_RADIUS = 24;
export const MAX_CORNERS = 16;
/** The largest target line a shared file may set, either side of zero. */
export const MAX_TARGET = 1e15;

export const FONT_STACK: Record<FontChoice, string> = {
  system: "'Segoe UI', system-ui, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "Consolas, 'Courier New', monospace",
  condensed: "Bahnschrift, 'Segoe UI', system-ui, sans-serif",
};

/** One click sets the whole page. The analyst can change any part afterwards. */
export const LOOKS: ReadonlyArray<{ id: string; label: string; detail: string; design: HoistDesign }> = [
  { id: 'standard', label: 'Standard', detail: 'The skin as it comes: quiet and familiar.', design: {} },
  { id: 'bridge', label: 'Bridge', detail: 'Glass cards, glowing marks, a lively start.', design: { card: 'glass', radius: 14, backdrop: 'tide', charts: { palette: 'signal', fill: 'gradient', glow: true, corners: 6, focus: true, motion: 'lively', lineWidth: 3 } } },
  { id: 'broadsheet', label: 'Broadsheet', detail: 'Serif type, flat cards, labels on the marks.', design: { card: 'flat', radius: 0, font: 'serif', charts: { palette: 'meadow', labels: 'on', gridLines: false, corners: 0, curve: 'straight', titleAlign: 'left' } } },
  { id: 'beacon', label: 'Beacon', detail: 'Warm colours, raised cards, rounded bars.', design: { card: 'raised', radius: 18, backdrop: 'dawn', charts: { palette: 'ember', fill: 'gradient', corners: 10, focus: true, motion: 'lively', tableBars: true } } },
  { id: 'chartroom', label: 'Chart room', detail: 'Outlined cards on a ruled page, straight lines.', design: { card: 'outline', radius: 4, backdrop: 'grid', font: 'condensed', charts: { palette: 'dusk', curve: 'straight', markers: 'on', corners: 2, striped: true } } },
];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const HEX = /^#[0-9a-f]{6}$/i;
export const isHex = (v: unknown): v is string => typeof v === 'string' && HEX.test(v);
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | undefined => (list.includes(v as T) ? (v as T) : undefined);
const intIn = (v: unknown, lo: number, hi: number): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

/** Drops undefined keys, so a parsed look holds only what was set. */
function kept<T extends object>(o: T): T {
  for (const k of Object.keys(o) as Array<keyof T>) if (o[k] === undefined) delete o[k];
  return o;
}

const PALETTE_IDS: readonly PaletteId[] = ['skin', 'signal', 'ember', 'meadow', 'dusk', 'mono', 'custom'];

function parseChartLook(raw: Record<string, unknown>): ChartLook {
  const colors = Array.isArray(raw.colors) ? raw.colors.filter(isHex).slice(0, MAX_COLORS) : [];
  return kept({
    palette: oneOf(raw.palette, PALETTE_IDS),
    colors: colors.length ? colors : undefined,
    fill: oneOf<Fill>(raw.fill, ['solid', 'gradient']),
    corners: intIn(raw.corners, 0, MAX_CORNERS),
    glow: bool(raw.glow),
    curve: oneOf<Curve>(raw.curve, ['smooth', 'straight', 'step']),
    lineWidth: intIn(raw.lineWidth, 1, 6),
    markers: oneOf<Markers>(raw.markers, ['auto', 'on', 'off']),
    labels: oneOf<Labels>(raw.labels, ['auto', 'on', 'off']),
    legend: oneOf<LegendPlace>(raw.legend, ['auto', 'top', 'bottom', 'right', 'off']),
    gridLines: bool(raw.gridLines),
    focus: bool(raw.focus),
    motion: oneOf<Motion>(raw.motion, ['none', 'calm', 'lively']),
    striped: bool(raw.striped),
    tableBars: bool(raw.tableBars),
    titleAlign: oneOf<Align>(raw.titleAlign, ['left', 'center']),
  }) as ChartLook;
}

function parseCombo(raw: unknown): FlagStyle['combo'] {
  if (!isObj(raw)) return undefined;
  const out: NonNullable<FlagStyle['combo']> = {};
  for (const [k, v] of Object.entries(raw).slice(0, 50)) {
    if (k.length > 128 || k === '__proto__' || !isObj(v)) continue;
    const one = kept({ as: oneOf<'bar' | 'line'>(v.as, ['bar', 'line']), axis: oneOf<'left' | 'right'>(v.axis, ['left', 'right']) });
    if (Object.keys(one).length) out[k] = one;
  }
  return Object.keys(out).length ? out : undefined;
}

export function parseFlagStyle(raw: unknown): FlagStyle | undefined {
  if (!isObj(raw)) return undefined;
  const t = raw.target;
  // A target past 1e15 is no goal anyone reads; it would only stretch the axis until the bars vanish.
  const value = isObj(t) && typeof t.value === 'number' && Number.isFinite(t.value) && Math.abs(t.value) <= MAX_TARGET ? t.value : undefined;
  const gaugeMax = typeof raw.gaugeMax === 'number' && Number.isFinite(raw.gaugeMax) && raw.gaugeMax > 0 ? raw.gaugeMax : undefined;
  const style = kept({
    ...parseChartLook(raw),
    barLayout: oneOf<BarLayout>(raw.barLayout, ['auto', 'stacked', 'grouped', 'percent']),
    orientation: oneOf<Orientation>(raw.orientation, ['auto', 'horizontal', 'vertical']),
    pieForm: oneOf<PieForm>(raw.pieForm, ['donut', 'pie', 'rose', 'funnel', 'treemap']),
    kpiForm: oneOf<KpiForm>(raw.kpiForm, ['number', 'gauge']),
    gaugeMax,
    kpiSize: oneOf<KpiSize>(raw.kpiSize, ['small', 'medium', 'large', 'huge']),
    zeroBase: bool(raw.zeroBase),
    target: value === undefined ? undefined : { value, label: isObj(t) && typeof t.label === 'string' ? t.label.slice(0, 40) : '' },
    average: bool(raw.average),
    zoom: bool(raw.zoom),
    accent: isHex(raw.accent) ? raw.accent : undefined,
    hideTitle: bool(raw.hideTitle),
    combo: parseCombo(raw.combo),
    map: typeof raw.map === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw.map) ? raw.map : undefined,
  }) as FlagStyle;
  return Object.keys(style).length ? style : undefined;
}

export function parseDesign(raw: unknown): HoistDesign | undefined {
  if (!isObj(raw)) return undefined;
  const charts = isObj(raw.charts) ? parseChartLook(raw.charts) : undefined;
  const design = kept({
    look: LOOKS.some((l) => l.id === raw.look) ? (raw.look as string) : undefined,
    card: oneOf<CardLook>(raw.card, ['raised', 'outline', 'flat', 'glass']),
    radius: intIn(raw.radius, 0, MAX_RADIUS),
    backdrop: oneOf<Backdrop>(raw.backdrop, ['plain', 'tide', 'dawn', 'grid']),
    font: oneOf<FontChoice>(raw.font, ['system', 'serif', 'mono', 'condensed']),
    charts: charts && Object.keys(charts).length ? charts : undefined,
  }) as HoistDesign;
  return Object.keys(design).length ? design : undefined;
}

/** The look a flag is drawn with: the page's chart defaults, then the flag's own settings. */
export function resolveStyle(design: HoistDesign | undefined, style: FlagStyle | undefined): FlagStyle {
  return { ...design?.charts, ...style };
}

/** Series colours for a look. `skinSeries` is what the skin gives; it is also the fallback. */
export function paletteColors(style: Pick<ChartLook, 'palette' | 'colors'>, mode: 'light' | 'dark', skinSeries: readonly string[]): string[] {
  const id = style.palette ?? 'skin';
  if (id === 'custom') return style.colors?.length ? [...style.colors] : [...skinSeries];
  if (id === 'skin') return [...skinSeries];
  return [...PALETTES[id][mode]];
}

/** Settings a whole page can take from one flag: its look, not what belongs to that flag's numbers. */
export function chartLookOf(style: FlagStyle | undefined): ChartLook {
  return style ? parseChartLook(style as Record<string, unknown>) : {};
}

/** The flag's style with every page-wide setting removed, or undefined when nothing is left. */
export function withoutChartLook(style: FlagStyle | undefined): FlagStyle | undefined {
  if (!style) return undefined;
  const out = { ...style };
  for (const k of Object.keys(chartLookOf(style)) as Array<keyof ChartLook>) delete out[k];
  return Object.keys(out).length ? out : undefined;
}

/** The page attributes the stylesheet reads (styles.css, "Design"). */
export function designAttrs(design: HoistDesign | undefined): Record<string, string> {
  return {
    'data-design-card': design?.card ?? 'standard',
    'data-design-backdrop': design?.backdrop ?? 'plain',
    'data-design-motion': design?.charts?.motion ?? 'calm',
  };
}

/** Custom properties for the page, as a React style object. */
export function designVars(design: HoistDesign | undefined): Record<string, string> {
  const vars: Record<string, string> = {};
  if (design?.radius !== undefined) vars['--design-radius'] = `${design.radius}px`;
  if (design?.font && design.font !== 'system') vars['--design-font'] = FONT_STACK[design.font];
  return vars;
}

// Colour checks for palettes an analyst picks by hand. The built-in ones were validated in full;
// these two catch what matters most, and warn rather than forbid.

const linear = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];

function oklab(hex: string): [number, number, number] {
  const [r, g, b] = linear(hex);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** Difference between two colours, OKLab x 100. */
export function colorDistance(a: string, b: string): number {
  const [x, y] = [oklab(a), oklab(b)];
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, b2] = linear(hex);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Sentences about a hand-picked palette, in the order the colours are used. Empty when it reads well. */
export function colorWarnings(colors: readonly string[], surface: string): string[] {
  const out: string[] = [];
  colors.forEach((c, i) => {
    const next = colors[i + 1];
    if (next && colorDistance(c, next) < 15) out.push(`Colours ${i + 1} and ${i + 2} are hard to tell apart.`);
    if (isHex(surface) && contrastRatio(c, surface) < 2) out.push(`Colour ${i + 1} is faint against the card.`);
  });
  return out;
}
