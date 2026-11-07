// The chart forms only some looks use. Loaded the first time a chart needs one, so a page that draws
// plain bars, lines and pies never pays for them (web/size-budget.json). These are direct paths, not
// the echarts/charts index: the page imports that index, which would pull all of this into its start.

import 'echarts/lib/chart/funnel';
import 'echarts/lib/chart/gauge';
import 'echarts/lib/chart/treemap';
import 'echarts/lib/component/dataZoom';
