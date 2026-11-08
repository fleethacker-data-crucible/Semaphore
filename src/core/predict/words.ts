// Words in a brief that ask for a predictive model, read by local drafting (local-rules.ts). Kept
// apart from models.ts so the page's start carries only these patterns, not the model list.

import type { ModelType } from './types.ts';

/** First match wins, so specific names come before the general "forecast". */
export const MODEL_WORDS: Array<[RegExp, ModelType]> = [
  [/\bmonte ?carlo\b|\bsimulat\w*|\bchance (?:of|that)\b|\bodds of\b|\bp(?:10|50|90)\b|\bprobability (?:of|that)\b/, 'montecarlo'],
  [/\bbacklog (?:forecast|burn\w*|clear\w*)|\bwhen will\b[^.]*\b(?:backlog|clear|finish)\b/, 'backlog'],
  [/\btornado\b|\bsensitivity\b|\bwhat[- ]if\b/, 'sensitivity'],
  [/\bbootstrap\w*|\berror bars?\b|\bconfidence interval\b/, 'bootstrap'],
  [/\bbayes\w*|\bcredible interval\b/, 'bayes'],
  [/\bcontrol chart\b|\bspc\b|\bshewhart\b|\bcusum\b|\bewma\b|\bout of control\b/, 'spc'],
  [/\banomal\w*|\boutliers?\b/, 'anomaly'],
  [/\barima\b|\bbox[- ]jenkins\b/, 'arima'],
  [/\bholt\b|\bwinters\b|\bexponential smoothing\b|\bmoving average\b/, 'smoothing'],
  [/\bdecompos\w*|\bseasonality\b/, 'decompose'],
  [/\blstm\b|\bneural\b/, 'lstm'],
  [/\blogistic\b/, 'logistic'],
  [/\bdecision tree\b/, 'tree'],
  [/\brandom forest\b/, 'forest'],
  [/\bgradient boost\w*|\bxgboost\b/, 'boosting'],
  [/\bk-?means\b|\bclusters? (?:of|analysis)\b|\bgroups? of similar\b/, 'kmeans'],
  [/\bkaplan\b|\bsurvival\b|\btime to close\b/, 'survival'],
  [/\bweibull\b|\breliability\b|\bmtbf\b|\btime to failure\b/, 'weibull'],
  [/\breorder point\b|\bsafety stock\b|\bcroston\b|\beoq\b/, 'demand'],
  [/\bmarkov\b|\bstatus transitions?\b/, 'markov'],
  [/\bwhat drives\b|\bkey drivers\b|\bregression\b/, 'regression'],
  [/\btrend ?line\b|\bline of best fit\b/, 'trend'],
  [/\bforecast\w*|\bpredict\w*|\bproject(?:ion|ed)\b/, 'smoothing'],
];

/** Models that read a series over time: drafting adds a date by month when the brief names none. */
export const DATE_MODELS: readonly ModelType[] = ['trend', 'smoothing', 'arima', 'decompose', 'lstm', 'backlog', 'demand'];
