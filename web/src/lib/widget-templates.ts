// Starter widgets for the custom flag's editor: working examples written against the widget API,
// meant to be read, copied and changed. Each runs in the sandboxed frame (web/src/widget-host.ts).

/** The widget API in a few lines, shown above the editor and at the top of a new widget. */
export const WIDGET_API_HELP = `Write a function render(api). It runs in a sandboxed frame with:
  api.data      { columns: [{ key, label, type, role, format, grain }], rows: [{ <key>: value }], selections }
  api.el        the element to draw into
  api.chart()   an ECharts chart on api.el (made once per render; api.echarts is the full library)
  api.theme     { colors, ink, ink2, ink3, panel, line, accent, good, warn, bad, font, dark }
  api.size      { width, height } of the frame, kept up to date
  api.select(key, value)   filter the page by a value of one of this flag's fields
  api.format(n, format)    a number as the page shows it ("number", "currency", "percent")
  api.label(value, column) a field value as the page shows it (dates by their period)
  api.onResize(fn)         call fn when the frame changes size (charts from api.chart() resize themselves)`;

export interface WidgetTemplate {
  id: string;
  name: string;
  description: string;
  code: string;
  css: string;
}

const BULLET = `// Bullet chart: each value of the first field (a region, a ship class) against its target, over
// bands for poor, fair and good. Actual is the first measure. Target is the second measure when the
// flag has one (say "labor cost and budget by region"), else TARGET below, else the fleet average.
// Click a bar to filter the page by that value.
const TARGET = null; // a fixed target, e.g. 250000; null uses the second measure or the average
const BANDS = [0.7, 0.9, 1.1]; // poor below 70% of target, fair to 90%, good to 110%
const HIGHER_IS_BETTER = true; // false for days open, cost overruns, backlog
const MAX_ROWS = 30;

function render(api) {
  const { data, theme } = api;
  const dim = data.columns.find((c) => c.role === 'dimension');
  const [actual, target] = data.columns.filter((c) => c.role === 'measure');
  if (!dim || !actual) {
    api.el.innerHTML = '<p class="note">A bullet chart needs one field and one or two measures, for example "labor cost by region".</p>';
    return;
  }
  const rows = data.rows.filter((r) => typeof r[actual.key] === 'number').slice(0, MAX_ROWS).reverse();
  if (rows.length === 0) {
    api.el.innerHTML = '<p class="note">No rows match the current selections.</p>';
    return;
  }
  const average = rows.reduce((s, r) => s + r[actual.key], 0) / rows.length;
  const targetOf = (r) => (target && typeof r[target.key] === 'number' ? r[target.key] : TARGET ?? average);
  const names = rows.map((r) => api.label(r[dim.key], dim));
  const picked = data.selections[dim.key];
  const dimmed = (r) => (picked && !picked.some((v) => String(v) === String(r[dim.key])) ? 0.35 : 1);
  const band = (r) => {
    const share = r[actual.key] / (targetOf(r) || 1);
    const rank = share < BANDS[0] ? 0 : share < BANDS[1] ? 1 : 2;
    return HIGHER_IS_BETTER ? rank : 2 - rank;
  };
  const BAND_NAMES = ['poor', 'fair', 'good'];
  const BAND_COLORS = [theme.bad, theme.warn, theme.good];
  const greys = [0.32, 0.2, 0.1];
  const bandSeries = [0, 1, 2].map((i) => ({
    name: ['Poor', 'Fair', 'Good'][HIGHER_IS_BETTER ? i : 2 - i] + ' band',
    type: 'bar',
    stack: 'bands',
    yAxisIndex: 0,
    barWidth: '70%',
    silent: true,
    itemStyle: { color: theme.ink3, opacity: greys[i] },
    data: rows.map((r) => targetOf(r) * (BANDS[i] - (i ? BANDS[i - 1] : 0))),
  }));
  const chart = api.chart();
  chart.setOption({
    textStyle: { fontFamily: theme.font, color: theme.ink2 },
    grid: { left: 8, right: 24, top: 8, bottom: 24, containLabel: true },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (items) => {
        const r = rows[items[0].dataIndex];
        const t = targetOf(r);
        return \`<b>\${names[items[0].dataIndex]}</b><br>\${actual.label}: \${api.format(r[actual.key], actual.format)}<br>Target: \${api.format(t, actual.format)} (\${Math.round((r[actual.key] / (t || 1)) * 100)}%, \${BAND_NAMES[band(r)]})\`;
      },
    },
    xAxis: { type: 'value', splitNumber: 4, axisLabel: { hideOverlap: true, formatter: (v) => api.format(v, actual.format) }, splitLine: { lineStyle: { color: theme.line } } },
    yAxis: [
      { type: 'category', data: names, axisTick: { show: false }, axisLine: { show: false } },
      { type: 'category', data: names, show: false },
    ],
    series: [
      ...bandSeries,
      {
        name: actual.label,
        type: 'bar',
        yAxisIndex: 1,
        barWidth: '28%',
        data: rows.map((r) => ({ value: r[actual.key], itemStyle: { color: BAND_COLORS[band(r)], opacity: dimmed(r) } })),
      },
      {
        name: 'Target',
        type: 'scatter',
        yAxisIndex: 1,
        symbol: 'rect',
        symbolSize: [3, 22],
        itemStyle: { color: theme.ink },
        data: rows.map((r, i) => [targetOf(r), i]),
        z: 5,
      },
    ],
  });
  chart.on('click', (p) => {
    const r = rows[p.dataIndex];
    if (r) api.select(dim.key, r[dim.key]);
  });
}
`;

const GANTT = `// Gantt timeline: one bar per row from its start date to its end date, one line per item (a hull,
// a job, a part). Start is the first date field. End is the second date field, or the start plus
// the first measure in days (say "average days open by hull and opened date"). A second text
// field colours the bars (status, region). Click a bar to filter the page by that item.
const MAX_ITEMS = 40;
const DAY = 86400000;

function render(api) {
  const { data, theme } = api;
  const dims = data.columns.filter((c) => c.role === 'dimension');
  const item = dims.find((c) => c.type !== 'date');
  const dates = dims.filter((c) => c.type === 'date');
  const colourBy = dims.filter((c) => c.type !== 'date')[1];
  const days = data.columns.find((c) => c.role === 'measure');
  if (!item || dates.length === 0 || (dates.length < 2 && !days)) {
    api.el.innerHTML = '<p class="note">A timeline needs an item field, a start date, and an end date or a measure in days, for example "average days open by hull and opened date".</p>';
    return;
  }
  const time = (v) => (typeof v === 'string' ? Date.parse(v.slice(0, 10) + 'T00:00:00Z') : typeof v === 'number' ? v : NaN);
  const bars = data.rows
    .map((r) => {
      const start = time(r[dates[0].key]);
      const end = dates[1] ? time(r[dates[1].key]) : start + (Number(r[days.key]) || 0) * DAY;
      return { row: r, item: r[item.key], name: api.label(r[item.key], item), start, end: Math.max(end, start + DAY / 4), group: colourBy ? api.label(r[colourBy.key], colourBy) : '' };
    })
    .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end))
    .sort((a, b) => a.start - b.start);
  const names = [...new Set(bars.map((b) => b.name))].slice(0, MAX_ITEMS);
  const shown = bars.filter((b) => names.includes(b.name));
  if (shown.length === 0) {
    api.el.innerHTML = '<p class="note">No rows with dates match the current selections.</p>';
    return;
  }
  const groups = [...new Set(shown.map((b) => b.group))];
  const picked = data.selections[item.key];
  const chart = api.chart();
  chart.setOption({
    textStyle: { fontFamily: theme.font, color: theme.ink2 },
    grid: { left: 8, right: 24, top: groups.length > 1 ? 28 : 8, bottom: 24, containLabel: true },
    legend: groups.length > 1 ? { top: 0, data: groups, textStyle: { color: theme.ink2 } } : undefined,
    tooltip: {
      formatter: (p) => {
        const b = shown[p.value[3]];
        const fmt = (t) => new Date(t).toISOString().slice(0, 10);
        return \`<b>\${b.name}</b>\${b.group ? ' · ' + b.group : ''}<br>\${fmt(b.start)} to \${fmt(b.end)} (\${Math.round((b.end - b.start) / DAY)} days)\`;
      },
    },
    xAxis: { type: 'time', splitLine: { lineStyle: { color: theme.line } } },
    yAxis: { type: 'category', data: names, inverse: true, axisTick: { show: false } },
    series: groups.map((g, gi) => ({
      name: g || 'Items',
      type: 'custom',
      renderItem: (params, x) => {
        const line = x.value(0);
        const from = x.coord([x.value(1), line]);
        const to = x.coord([x.value(2), line]);
        const h = x.size([0, 1])[1] * 0.6;
        const box = api.echarts.graphic.clipRectByRect(
          { x: from[0], y: from[1] - h / 2, width: Math.max(2, to[0] - from[0]), height: h },
          { x: params.coordSys.x, y: params.coordSys.y, width: params.coordSys.width, height: params.coordSys.height },
        );
        return box && { type: 'rect', shape: { ...box, r: 2 }, style: x.style() };
      },
      encode: { x: [1, 2], y: 0 },
      itemStyle: { color: theme.colors[gi % theme.colors.length] },
      // The fourth value is the bar's place in shown, for the tooltip and the click.
      data: shown
        .map((b, i) => ({ b, i }))
        .filter(({ b }) => b.group === g)
        .map(({ b, i }) => ({
          value: [names.indexOf(b.name), b.start, b.end, i],
          itemStyle: { opacity: picked && !picked.some((v) => String(v) === String(b.item)) ? 0.3 : 1 },
        })),
    })),
  });
  chart.on('click', (p) => {
    const b = shown[p.value[3]];
    if (b) api.select(item.key, b.item);
  });
}
`;

const SMALL_MULTIPLES = `// Small multiples: one small chart per value of a field (a region, a ship class), all on the same
// scale so they compare honestly. Say "work orders by month by region": the text field makes the
// panels, the date (or other) field runs along each one, the first measure goes up.
// Click a point to filter the page by that panel's value.
const KIND = 'line'; // or 'bar'
const MAX_PANELS = 12;

function render(api) {
  const { data, theme } = api;
  const dims = data.columns.filter((c) => c.role === 'dimension');
  const measure = data.columns.find((c) => c.role === 'measure');
  const split = dims.find((c) => c.type !== 'date') ?? dims[0];
  const along = dims.find((c) => c !== split);
  if (!split || !along || !measure) {
    api.el.innerHTML = '<p class="note">Small multiples need two fields and a measure: one field to split by and one to draw along, for example "work orders by month by region".</p>';
    return;
  }
  const totals = new Map();
  for (const r of data.rows) totals.set(r[split.key], (totals.get(r[split.key]) ?? 0) + (Number(r[measure.key]) || 0));
  const panels = [...totals.keys()].sort((a, b) => totals.get(b) - totals.get(a)).slice(0, MAX_PANELS);
  const xs = [...new Set(data.rows.map((r) => r[along.key]))].sort((a, b) => String(a).localeCompare(String(b), 'en', { numeric: true }));
  const value = (p, x) => {
    const r = data.rows.find((row) => row[split.key] === p && row[along.key] === x);
    return r && typeof r[measure.key] === 'number' ? r[measure.key] : null;
  };
  const top = Math.max(0, ...data.rows.map((r) => Number(r[measure.key]) || 0));
  const picked = data.selections[split.key];
  const chart = api.chart();

  const draw = () => {
    const { width, height } = api.size;
    const n = panels.length;
    const cols = Math.max(1, Math.min(n, Math.round(Math.sqrt((n * width) / Math.max(1, height)))));
    const rowsOf = Math.ceil(n / cols);
    const cw = width / cols;
    const ch = height / rowsOf;
    const at = (i) => ({ x: (i % cols) * cw, y: Math.floor(i / cols) * ch });
    chart.setOption(
      {
        textStyle: { fontFamily: theme.font, color: theme.ink2 },
        tooltip: { trigger: 'item', formatter: (p) => \`<b>\${api.label(panels[p.seriesIndex], split)}</b><br>\${api.label(xs[p.dataIndex], along)}: \${api.format(p.value, measure.format)}\` },
        title: panels.map((p, i) => ({ text: api.label(p, split), left: at(i).x + 6, top: at(i).y + 2, textStyle: { fontSize: 11, fontWeight: 600, color: theme.ink } })),
        grid: panels.map((p, i) => ({ left: at(i).x + 34, top: at(i).y + 22, width: Math.max(10, cw - 44), height: Math.max(10, ch - 40) })),
        xAxis: panels.map((p, i) => ({ type: 'category', gridIndex: i, data: xs.map((x) => api.label(x, along)), axisLabel: { show: Math.floor(i / cols) === rowsOf - 1, fontSize: 9, color: theme.ink3 }, axisTick: { show: false }, axisLine: { lineStyle: { color: theme.line } } })),
        yAxis: panels.map((p, i) => ({ type: 'value', gridIndex: i, max: top, splitNumber: 2, axisLabel: { show: i % cols === 0, fontSize: 9, color: theme.ink3, formatter: (v) => api.format(v, measure.format) }, splitLine: { lineStyle: { color: theme.line } } })),
        series: panels.map((p, i) => ({
          name: api.label(p, split),
          type: KIND,
          xAxisIndex: i,
          yAxisIndex: i,
          showSymbol: false,
          data: xs.map((x) => value(p, x)),
          itemStyle: { color: theme.colors[0], opacity: picked && !picked.some((v) => String(v) === String(p)) ? 0.3 : 1 },
          lineStyle: { width: 1.5 },
          areaStyle: KIND === 'line' ? { opacity: 0.12 } : undefined,
        })),
      },
      true,
    );
  };
  draw();
  api.onResize(draw);
  chart.on('click', (p) => api.select(split.key, panels[p.seriesIndex]));
}
`;

const NOTE_CSS = `.note {
  margin: 12px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ink-2);
}
`;

export const WIDGET_TEMPLATES: readonly WidgetTemplate[] = [
  { id: 'bullet', name: 'Bullet chart', description: 'Actual against target, over poor, fair and good bands', code: BULLET, css: NOTE_CSS },
  { id: 'gantt', name: 'Gantt timeline', description: 'Items from their start date to their end date', code: GANTT, css: NOTE_CSS },
  { id: 'multiples', name: 'Small multiples', description: 'One small chart per value of a field, on one scale', code: SMALL_MULTIPLES, css: NOTE_CSS },
];

/** The code a new custom flag starts with: the API in a comment, and a first chart that works on any data. */
export const STARTER_CODE = `// ${WIDGET_API_HELP.split('\n').join('\n// ')}

function render(api) {
  const { data, theme } = api;
  const dim = data.columns.find((c) => c.role === 'dimension');
  const measure = data.columns.find((c) => c.role === 'measure');
  if (!dim || !measure) {
    api.el.innerHTML = '<p class="note">Describe the data in the brief first, for example "work orders by region". Or start from a template.</p>';
    return;
  }
  const chart = api.chart();
  chart.setOption({
    textStyle: { fontFamily: theme.font, color: theme.ink2 },
    grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
    tooltip: {},
    xAxis: { type: 'category', data: data.rows.map((r) => api.label(r[dim.key], dim)) },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: theme.line } } },
    series: [{ type: 'bar', name: measure.label, data: data.rows.map((r) => r[measure.key]), itemStyle: { color: theme.colors[0] } }],
  });
  chart.on('click', (p) => api.select(dim.key, data.rows[p.dataIndex][dim.key]));
}
`;

export const STARTER_CSS = NOTE_CSS;
