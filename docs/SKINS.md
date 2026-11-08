# Skins

Semaphore draws every colour from a small set of tokens (`--bg`, `--panel`, `--ink`, `--accent`,
`--good`, `--series-1` ...). Components never name a colour, so a **skin**, one set of token values,
changes the whole app: the builder, the leadership view and the charts.

| Skin | Look |
| --- | --- |
| `fleet` (default) | [Fleet Unified UI](https://github.com/fleethacker-data-crucible/Fairlead/blob/main/docs/UNIFIED-UI.md) v0.2: the `--fl-*` tokens from `web/vendor/fleet/fleet.css`, Night watch (dark) and Chart room (light), Semaphore's sea-blue signature accent |
| `classic` | Semaphore's palette before Fleet UI, from its brand mark |

Light and dark are separate from the skin: every skin has both, and **Settings > Appearance** switches
between Night watch (dark) and Chart room (light).

## Choosing the skin

1. **`settings.json` `"skin"`** (`config\settings.json`): the deployment's choice. When set, every
   browser uses it and the skin list in Settings says so. `""` (the default) leaves the choice to the analyst.
2. **Settings > Appearance > Skin**, saved per browser (`semaphore.skin`). (The paintbrush in the
   header is Page design, which styles the page and its charts, not the skin: [DESIGN.md](DESIGN.md).)
3. Otherwise `fleet`.

## Changing the look at the last minute, without a rebuild

Put a stylesheet at **`config\skin.css`** in the Semaphore folder. The server serves it as `/skin.css`,
loaded after the app's own styles, so its values win. Reload the page; no restart or build is needed.
At most 256 KB.

Change a few tokens in every skin:

```css
:root:root { --accent: #b8382b; --accent-soft: #fbe5e2; }
```

`:root:root` is deliberate: it outranks the skin rules, which use `:root[data-skin=...]`.

Or define a whole new skin and select it with `"skin": "event"` in `settings.json`:

```css
:root[data-skin='event'] {
  --bg: #fbfaf2; --panel: #ffffff; --panel-2: #f3efe2; --line: #dcd3bd;
  --ink: #132633; --ink-2: #4f5d66; --ink-3: #4f5d66;
  --accent: #8a1c7c; --accent-soft: #f6e3f2; --brass: #8a6b45; --brass-soft: #f3ead9;
  --good: #2f7d57; --warn: #9a6412; --bad: #b8382b;
  --good-soft: #e3f3e9; --warn-soft: #fbf0dc; --bad-soft: #fbe5e2; --focus: #8a6b45;
  --hl-metric: #d9ecf3; --hl-field: #f3ead9; --hl-time: #f1e3f0; --hl-behaviour: #e3f3e9; --hl-unknown: #fbe5e2;
  --series-1: #8a1c7c; --series-2: #8a6b45; --series-3: #2f7d57; --series-4: #b8382b;
  --series-5: #1f5fa3; --series-6: #9a6412; --series-7: #4b45b8; --series-8: #0f766e;
}
:root[data-skin='event'][data-theme='dark'] { /* the same tokens for dark */ }
```

Rules for a skin:

- **Chart series (`--series-1` to `--series-8`) must be plain colours** (`#hex` or `rgb()`); charts draw
  on a canvas, which cannot read `color-mix()` or `var()`. A token it cannot use falls back to the
  built-in palette.
- Keep text at 4.5:1 contrast against `--bg`, `--panel` and `--panel-2` in both light and dark.
- `--ink-2` and `--ink-3` are secondary text, so they need the same 4.5:1.

## Building a skin into the app

Add a block to `web/src/styles.css` next to `classic`, add it to `SKINS` in `web/src/app.tsx` so the
Settings skin list offers it, and rebuild. Skins in `config\skin.css` need no build but are not offered
in Settings; select them with `settings.json`.

## Themes

On top of the skin, each person can choose a theme in Settings > Appearance, the same ten presets and "Make it yours" controls as Lazarette (web/src/lib/theme.ts, web/src/lib/theme-presets.ts). A theme writes the Fleet tokens (--fl-accent, --fl-background, --fl-card and the rest) at run time, so on the Fleet skin it changes every colour. The Classic and Colour-blind safe skins keep their own colours and take the theme's shape, density, type, motion, pattern and glow. Themes are kept in this browser under , and the old light or dark choice () becomes the theme's mode once. A theme file exported from Semaphore imports into Lazarette and the other way round.
