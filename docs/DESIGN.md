# Page design, flag looks and exports

Analysts decide how a page looks and how it leaves Semaphore. Neither changes what a flag means: a look never touches a flag's binding, and a reviewed flag stays reviewed.

## Page design

The paintbrush in the header (or Hoist > Page design, or Ctrl+K) opens **Page design**. Changes show on the page as you make them, and Ctrl+Z undoes them.

- **Looks** set everything at once: Standard, Bridge, Broadsheet, Beacon and Chart room. Change any part afterwards.
- **Page**: card style, card corners, backdrop and type. Type uses fonts that ship with Windows, so nothing is downloaded.
- **Every chart**: palette, fill, rounded bars, glow, hover and motion.

## A flag's Look

Select a flag and open **Look** in the inspector. It shows only what applies to that kind of flag, and a setting there overrides the page.

| Flag | Settings |
|---|---|
| All charts | Palette or your own colours, glow, values on marks, legend position, motion, hover dimming |
| Bar | Fill, rounded corners, stacked, side by side or 100%, direction |
| Line and area | Smooth, straight or steps, thickness, points, scale start |
| Pie | Donut, pie, rose, funnel or treemap |
| Bar, line, area | Grid lines, average line, target line with a label, zoom slider |
| KPI | Number or gauge, size |
| Table | Stripes, bars behind the numbers |
| Any card | Title alignment, hidden title, coloured strip |

**Use on every flag** moves a flag's look to the page. Targets, gauge scales and other settings tied to that flag's numbers stay with it.

## What a look cannot change

- Colour rules keep their colours and patterns in every palette, so a status cannot be styled away.
- Bars always start at zero. Only a line may start above it.
- Text stays in the skin's ink colours, not the series colours.
- Anyone whose system asks for less motion sees none, whatever the page sets.
- No single mark moves for more than 200 ms (UNIFIED-UI section 7). **Lively** lets marks arrive one after another, so the whole page can take longer than that.

## Palettes

Signal, Ember, Meadow and Dusk use eight hues in orders that pass the adjacent colour-blind and normal-vision checks in light and dark. The order is what makes them safe, so do not re-sort them. One blue is a single-hue ramp for ordered values, and has five steps.

With four or more series, some colours that are not neighbours can still look alike, so keep labels or the table view available. In light mode a few colours sit below 3:1 against white for the same reason.

**Your own** colours are allowed. Semaphore warns when neighbours are hard to tell apart or a colour is faint against the card, and does not refuse them.

Looks come from shared files, so each value is checked against a fixed list or range when read, and colours must be plain `#rrggbb`.

## Exports

**Export or share** in the header (or Hoist > Export or share) makes the file in this browser. Nothing is sent anywhere, and the server is not involved.

| Format | What you get |
|---|---|
| PDF report | Charts, numbers and findings, with bookmarks and selectable text |
| Excel workbook | A summary sheet, then a sheet per flag with real numbers and native charts you can edit |
| Interactive HTML | One file with working filters and drill. The only format that can be locked with a passphrase |
| PowerPoint | A title slide and a slide per flag |
| Word report | Real headings, charts and tables |
| CSV (zip) | One table per flag |
| JSON | The answers as structured data, without images |

A single flag can also be saved from the inspector as PNG, SVG or CSV.

An export holds the summarised answers on the page, never source rows. Files other than locked HTML are not encrypted. With selections on the page, the dialog offers to export only what is selected, and lists those selections in the file.

Charts in a file are redrawn in light colours for paper, whatever the screen's theme, using the page's palette and finish. Picker flags are left out, because they are controls rather than answers.

Known limits: PDF uses the standard fonts, so text outside Western European characters shows as "?", and the file says so. PDF lists up to 50 rows per flag and Word up to 500, each with a line saying how many more there are; use Excel or CSV for everything. PowerPoint charts are pictures. Only Excel's charts can be edited. Times in a file are UTC.

CSV text that a spreadsheet would run as a formula is prefixed with an apostrophe. Numbers stay numbers.
