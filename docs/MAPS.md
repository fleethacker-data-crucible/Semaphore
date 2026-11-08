# Combo charts and maps

Two chart kinds under **More charts** in the palette and in the inspector's **Show as**. Both draw with ECharts on this computer and need nothing from the internet: there are no map tiles, no map service and no downloaded map data. They load with the other richer kinds (`web/src/components/chart-extras.ts`), never with the page's start.

## Combo: bars and a line

A combo needs one field along the axis and two or more measures. The first measures are bars on the left scale; the last is a line on a scale of its own on the right, so "labor cost" in dollars and "days open" in days can share one chart without one flattening the other.

- **Look > Bars and line** sets each measure to **Bars** or **Line**, and to the **Left** or **Right** scale. Only a choice that differs from the default is saved (`style.combo` in [FLAG_SPEC.md](FLAG_SPEC.md)). When every measure is on one side, the chart has one scale. Several bar measures go side by side, or **Stacked**.
- The usual Look applies: palette, gradient fill, rounded bars, values on the marks, legend, grid lines, line shape, thickness and points, hover dimming, zoom slider. The **target** and **average** lines go on the bars' scale (the first bar measure on the left).
- Colour rules (red under 500, say) colour the bar and add its pattern, as on any bar. A click on a bar or a point filters the page or drills by its value; a drill stays a combo one level down.
- Drafting: "bars and a line", "combo", "cost as bars and days open as a line", "cost by region with a line for days open". The measures keep the brief's order, so the one named last is the line.
- Exports: the picture and the table in every format, and in **Excel** an editable chart: a bar chart and a line chart in one plot, the right-hand measures on a secondary axis, reading the sheet's own columns. PowerPoint, Word and PDF carry the picture and the table, as for every chart.

With one measure, a combo is drawn as bars and the inspector says why.

## Maps

A map needs one field and one measure. The field's values are matched to the map's regions, each region is shaded by the measure on a scale from the panel colour to the look's first colour (as the heatmap and calendar are), and hovering a region shows its name and value. **Look > Map** picks what to draw on and whether region names are shown.

### US states, built in

The default map is a tile map: each of the 50 states and DC is the same square at a fixed place on a 12 by 8 grid, so Rhode Island reads as well as Texas. The positions are Semaphore's own (`src/core/geo.ts`), not map data.

Values are matched as state names (`Virginia`), USPS codes (`VA`), common abbreviations (`Calif.`, `Mass.`, `N.H.`, `W. Va.`, `D.C.`, `Washington, D.C.`) and `US-VA`, in any case. Several spellings of one state are one state: their values are added up (or, for an average, lowest or highest measure, averaged or taken the same way). Values that are no state (territories, blanks, typing slips) are listed under the chart: *Not on the map: Guam, (blank).*

### Your own regions

**Settings > Maps** adds a region map from a GeoJSON or TopoJSON file: fleet regions, port areas, bases, districts.

1. Choose the file. Semaphore reads it in the page and keeps only what a map needs: each polygon's outline (to five decimals, about a metre) and its name, from the `name` property (or `NAME`, `region`, `label`, `title`, `id`, `code`). Points and lines are left out with a note; a region with no name is left out with a note. A TopoJSON file is turned into GeoJSON first (its arcs stitched and its positions decoded).
2. Check the name, and add **other names** if the data writes a region differently, one per line: `Pacific Northwest = Pacific NW`.
3. **Add the map**. It is saved in the Semaphore folder (`<home>\maps\<id>.json` says what it is, `<home>\maps\shapes\<id>.json` is the GeoJSON), so every page on the team can use it. **Other names** changes the list later; the bin removes the map to `.trash`.

Limits: the cut-down GeoJSON at most 2 MB, 2000 regions, 250,000 points, names of 80 characters, 500 other names, 50 maps. A larger file says so: simplify its shapes or split it. The server checks the shapes again (a FeatureCollection of named Polygons and MultiPolygons) before saving.

Pick the map in a map flag's **Look > Map > Draw on**. Field values are matched to region names ignoring case, accents and dots, then through the other names. A map that cannot be read (removed, say) draws as bars with a note saying why.

### Points

When a map flag's field holds positions written as `36.85, -76.29` (latitude first) or `POINT(-76.29 36.85)` (WKT, longitude first), in four values out of five, or the flag has two fields named latitude and longitude (`lat`, `latitude`, `lon`, `lng`, `long`, `longitude`), it draws points instead of regions: sized and shaded by the measure. On a region map whose positions are longitude and latitude the points sit on its shapes; otherwise (the state tile map, or a map in projected coordinates) they go on a plain frame, longitude across and latitude up. Rows with no position are counted under the chart.

## Where the code is

| Part | File |
|---|---|
| What each kind needs, the fallback, drafting words | `src/core/kinds.ts` |
| The combo's roles per measure | `src/core/combo.ts` |
| States, tiles, matching, region files, points | `src/core/geo.ts` |
| The ECharts options | `web/src/lib/chart-kinds.ts` |
| Map registration (lazy) | `web/src/components/chart-extras.ts`, `web/src/lib/map-registry.ts` |
| Settings > Maps | `web/src/components/MapsCard.tsx`, `web/src/lib/maps.ts` |
| Server routes | `server/Routes.ps1` (`Invoke-SemMapRoute`), tests in `tests/server/Maps.Tests.ps1` |
| Excel combo chart | `src/core/export/xlsx.ts` |
