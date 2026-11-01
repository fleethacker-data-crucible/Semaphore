# Demo walkthrough: a five-minute video

A shot-by-shot script for a short demo of Semaphore. It uses only the synthetic "Fleet maintenance" example that ships with the app (`examples/fleet-maintenance/`): invented ships, regions and costs, no personal information, no real database, no network, no AI model. Steps 1 to 7 were checked against the built app on 2026-10-31 in a browser (the numbers and wording are the ones it showed); steps 8 to 10 were not walked through and rest on the button names and the README.

**Setup (not filmed).** Build once with `npm ci` and `npm run build`, then start with `Launch-Semaphore.bat` on a Windows PC with Edge or Chrome. Use a fresh browser profile (or clear this site's saved data) so the welcome page appears. Pick the Night watch (dark) or Chart room (light) theme before recording and keep it for the whole video. Window about 1280 by 720. Do not set a Fairlead key: the demo shows that Semaphore works with no model, and the AI button stays off.

**Say it plainly.** Semaphore replaces Qlik on thin clients. Analysts describe what they want to see in plain English; leadership asks questions that are answered from the analysts' reviewed work; it covers for an analyst who is away. Everything here runs on this computer.

## Shot list

| # | Time | On screen | What to say | What to show |
|---|---|---|---|---|
| 1 | 0:00 | The welcome page: "Run up the signal." | "Semaphore is a dashboard builder that runs on this computer. You describe the page you want; it wires the data." | The four ways in: Continue "Fleet maintenance overview", New hoist, Add data, Leadership view. Click **Continue**. |
| 2 | 0:20 | The example page: three KPIs (Work orders 3,300, Labor cost $13M, Hulls affected 180), a Ship class picker, Labor cost by region, Work orders per month. | "A page is called a hoist and each tile is a flag. This one answers: what did maintenance cost the fleet in the last twelve months?" | Point at the brief across the top: the words Semaphore understood are highlighted by type (measure, field, time, behaviour). Say that the page window, "last 12 months of Opened date", came from the sentence. |
| 3 | 1:00 | Click the **Gulf** bar in Labor cost by region. | "Click a bar and the whole page filters." | Work orders drops to 506, Labor cost to $3.25M, Hulls affected to 170. Say the monthly trend ignores the region filter on purpose: the brief says leadership always sees the fleet-wide trend. The selection shows under the brief as "Selected: Region: Gulf"; clear it with **Clear all**. |
| 4 | 1:30 | Flip the **Labor cost** flag (its "Flip over: what this shows and the SQL" button). | "Every number shows its work." | "What it shows" in plain English ("A KPI showing Labor cost (total). Last 12 months of Opened date (page). Turns red when Labor cost is over $5M."), then the exact SQL with its parameters and the language name (PostgreSQL). Say the sample data is answered in this browser and the card says so: "Reference SQL; results calculated in this browser." Flip it back. |
| 5 | 2:00 | The empty **Untitled flag** at the bottom. | "Adding a flag is saying what you want." | Click it: the inspector opens on the right with "What should this flag show?". Click in the box, type "top 10 hulls by labor cost" and press Enter. A bar chart "Labor cost by hull number" appears, labelled Draft with a confidence figure (80% when checked); the typed words are highlighted as measure and field. Say it chose a bar chart from the question and the data, with no model. Click **Accept**. Clear any bar you selected first (step 3), or the new chart will show only that region. |
| 6 | 2:45 | **Brief me** (header button: "Brief me: what this page says, as leadership would read it"). | "Semaphore can say what the page shows, in a few sentences, each linked to its flag." | The briefing lists sentences built from the facts it computed, such as "September 2026 is the highest month shown." Say that with an AI model on, it may only rephrase these facts and every number is checked. Close it. |
| 7 | 3:15 | **Leadership view** (header, or the button on the welcome page). | "Leadership never sees the builder. They ask." | The Ask page: suggested questions drawn from the reviewed flags ("Total work orders", "Labor cost by region", "Monthly work orders"), the headline numbers, and "What changed". Click "Labor cost by region": the answer card says "Reviewed · analyst" with a date and "Data as of", a sentence on how it was built ("Bars of Labor cost (total) by Region. Sorted by Labor cost, highest first. Last 12 months of Opened date (page)."), a **Why this answer?** link and follow-up chips (by status, by ship class, per month, vs last year). Click **Builder** (top right) to go back. |
| 8 | 3:50 | **Share as a report** (header). | "One HTML file, no server." | The dialog explains what goes into the file. Optionally type a passphrase of at least 12 characters to show encryption; do not save a real file on camera, or save one and open it from the desktop to show the filters still work. |
| 9 | 4:20 | **Data** (header): the catalog, then Add data. | "The catalog is the vocabulary: measures and fields with plain names and synonyms. You can add a CSV, import from Qlik, or connect a database through ODBC, OLE DB, Athena, Redshift, Synapse or Foundry." | Open **Data**, show Measures and Fields, then close. Say the database and lake connectors are described in the README and are not part of this demo. |
| 10 | 4:45 | Back to the page, filter cleared. | "Plain English in, reviewed answers out, nothing leaves the computer." | End on the page, then the welcome page. |

## Voice-over notes

- Say "flag", "hoist" and "catalog" once each, with a clause that explains them, then use them.
- Do not claim anything the shots do not show. Not shown, so not said: database connections, the AI drafting, the vault, shared-report encryption working end to end, the leadership view learning from analysts over time.
- Numbers on screen: 3,300 work orders, $13M labor cost, 180 hulls; after clicking Gulf: 506, $3.25M, 170. If a number differs, the data changed: say what the screen says.
- Keep the mouse still while talking. The focus ring on a control (a 2px brass outline) is part of the design; leave it visible when tabbing.

## Retakes and risks

- **Welcome page missing:** the browser kept a saved page. Clear this site's data, or use a private window.
- **Slow first click:** the first chart draw loads the chart library; click once and wait.
- **Step 5** is the one live typing step. Rehearse it: type the sentence at a steady pace, and if the draft is not what you want, undo (Ctrl+Z) and retry rather than editing on camera.
- Use only the example data shown here. Real data, real server names and real people never go in a demo recording.
