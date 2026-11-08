// The chart forms only some looks use. Loaded the first time a chart needs one, so a page that draws
// plain bars, lines and pies never pays for them (web/size-budget.json). These are direct paths, not
// the echarts/charts index: the page imports that index, which would pull all of this into its start.

import 'echarts/lib/chart/funnel';
import 'echarts/lib/chart/gauge';
import 'echarts/lib/chart/treemap';
import 'echarts/lib/component/dataZoom';
import 'echarts/lib/chart/radar';
import 'echarts/lib/chart/scatter';
import 'echarts/lib/chart/heatmap';
import 'echarts/lib/chart/sankey';
import 'echarts/lib/chart/sunburst';
import 'echarts/lib/chart/themeRiver';
import 'echarts/lib/component/radar';
import 'echarts/lib/component/visualMap';
import 'echarts/lib/component/calendar';
import 'echarts/lib/component/singleAxis';
import { use } from 'echarts/core';
import { LabelLayout } from 'echarts/features';
import { setRichBuilder } from '../lib/chart-option.ts';
import { richChartOption } from '../lib/chart-kinds.ts';

// The richer kinds (src/core/kinds.ts) are drawn by chart-kinds.ts, which comes with these forms.
setRichBuilder(richChartOption);
// Lets labels that would sit on top of each other (a scatter's names) hide instead.
use([LabelLayout]);
