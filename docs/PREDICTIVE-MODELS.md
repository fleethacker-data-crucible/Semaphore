# Predictive models

A **Predict** flag runs a predictive model on the rows the flag returns: a forecast, a Monte Carlo simulation, a control chart, drivers, clusters, reliability and more. Each answers in a sentence, a few headline numbers, a chart, a table, and the model's own notes.

All 22 models are written in TypeScript in `src/core/predict` and run in the browser. They need no Python, R, cloud service or install, so they work on locked-down workstations (Nautilus) as the rest of Semaphore does. The database still does the filtering and totalling (SQL); the model reads the totals that come back, so no raw rows are moved and nothing leaves the machine.

## Using one

1. Drag **Predict** from the palette (or write a brief: "forecast work orders for the next 6 months", "Monte Carlo of labor cost by region, chance of staying under $24M", "control chart of cost by week").
2. In the inspector, pick the model under **Model**, set the fields and measures the model needs (it says which), and adjust its settings.
3. For Monte Carlo and sensitivity, type the uncertain inputs (low, likely, high), or leave them empty to use each row as an input spread by the low and high percentages.

The card shows the answer, its headline numbers and the chart; the table and the model's notes are a click away. Exports (PDF, Word, PowerPoint, Excel, HTML) carry the chart picture, the table and the words. Shared reports run the model in the report itself.

## The models

| Group | Model | Answers | Needs |
|---|---|---|---|
| Forecasting | Trend line | Where the line is heading (straight, curve, S-curve), with a prediction interval | A date field, one measure |
| | Exponential smoothing | Next periods: moving average, simple, Holt, damped, Holt-Winters (additive or multiplicative); "best fit" picks by AICc | A date field, one measure |
| | ARIMA | A forecast from the series' own pattern; picks the order by AICc and the differencing by the KPSS test | A date field, one measure (24+ periods is best) |
| | Seasonal decomposition | Trend, season and noise apart (STL or classical) and how strong the season is | A date field, one measure, two seasons |
| | Neural network (LSTM) | A learned forecast for long series | A date field, one measure (60+ periods is best) |
| Simulation and risk | Monte Carlo | The odds of a total: P10, P50, P90 and the chance of staying under a target; which input drives the spread | Typed-in inputs, or one field and one measure |
| | Backlog forecast | When a backlog clears, with odds, from past throughput | A date field, the number finished each period |
| | Sensitivity (tornado) | Which input moves the answer most | Typed-in inputs, or one field and one measure |
| | Bootstrap interval | Honest error bars on an average, median, total or spread (BCa) | One field, one measure |
| | Bayesian rate | Fair rates from small samples (beta-binomial or gamma-Poisson, empirical Bayes) | One field; events, then trials or exposure |
| Quality | Control chart | Real change or noise: individuals, EWMA, CUSUM, Western Electric rules | An ordered field, one measure |
| | Anomaly detection | Which values are unusual (robust distance, z-score or box-plot fences) | One field, one measure |
| Drivers and machine learning | Regression | What drives a measure and by how much, with intervals, p-values and collinearity checks | One field; the measure to explain, then drivers |
| | Logistic regression | The chance of an outcome, as odds ratios; AUC | One field; the outcome (0–1 share, or a value over a threshold), then drivers |
| | Decision tree | Rules that split high from low, cross-validated | One field; what to predict, then drivers |
| | Random forest | A steadier prediction; out-of-bag accuracy and permutation importance | As above |
| | Gradient boosting | Trees that correct each other; held-out accuracy with early stopping | As above |
| | Clusters (k-means) | Groups of similar items; picks the number by silhouette | One field (the items), two or more measures |
| Reliability and inventory | Survival (Kaplan-Meier) | How long until something ends, counting the ones still open; groups compared by log-rank | One field (each item), its duration, optionally a 1/0 finished measure |
| | Weibull reliability | Time to failure, MTBF, B10 life, early failure versus wear-out | One field (each item), time to failure, optionally 1/0 failed |
| | Spare-parts demand | Reorder point, safety stock and order quantity for steady or intermittent demand (Croston, SBA, TSB, Poisson) | A date field, quantity used each period |
| | Status transitions (Markov) | Where items go next and how long they take to finish | Two fields (from, to) and a count of moves |

## How it runs

- **In its own worker.** Models run in a separate background worker (`web/src/predict-worker.ts`, built as `assets/predict.<hash>.js`), started the first time a model flag is drawn. The page never freezes, and pages without models never load it. Answers are kept, so a redraw or an export does not run a model twice. Where workers are not available (a report opened from disk) the model runs on the page.
- **Repeatable.** Every random step (Monte Carlo, bootstrap, forests, LSTM weights) uses a seed taken from the flag, so the same flag on the same data gives the same numbers every time.
- **Bounded.** Heavy models cap their work (trials, trees, training passes) to stay responsive on thin clients and say so in a note when they do.
- **A period still under way is left out** of series models (a month that is a week old would look like a fall), with a note.
- **Cautions are shown**, not hidden: rows left out for blank measures, short histories, settings changed to fit the data, independence assumptions.

## How the maths was checked

No R or Python is installed on the workstations, and none was used. Each model has tests in `tests/predict-*.test.ts` that check it against:

- hand-worked answers on small inputs (Kaplan-Meier fractions, Greenwood variance, OLS standard errors, Croston, Markov absorption times);
- closed-form results (triangular and PERT means, Irwin–Hall percentiles, the FPP3 ETS variance factors, AR(1) forecasts and standard errors, Weibull MTBF, exact Poisson reorder points);
- recovery of known parameters from seeded synthetic data (ARIMA φ and θ, Weibull shape and scale with censoring, logistic coefficients, seasonal patterns, k-means clusters, forest accuracy on a known function);
- finite-difference checks of the LSTM's gradients.

`tests/predict-integration.test.ts` runs all 22 through the worker's entry point on realistic data, checks the same seed gives the same answer, and that every chart draws.
