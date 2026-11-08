// Types for the ECharts files the page imports by path rather than through echarts/core
// (components/Chart.tsx says why). They are the same functions echarts/core exports.

declare module 'echarts/lib/core/echarts.js' {
  export { init, registerMap } from 'echarts/core';
}
declare module 'echarts/lib/extension.js' {
  export { use } from 'echarts/core';
}
