# AI Session Log: Claude Code (2026-11-10)

Tool: Claude Code (CLI), model Claude Opus 5.5
Scope: replacing the Claude-based risk labels with my own rule-based risk logic, removing the API, and simplifying the review interface

Continues from `claude_code_session_2026-11-09.md`.

---

## Prompt 1
> remove the ai recap review part does that break the risk engine and other part of the app

**What the AI did:**
1. Took "AI recap" to mean the **Group Recap** card at the bottom of each Month / Week / Day (the only part called a recap). Removed the card, its digest code, the "↓ Recap" button, and the recap wording in the settings and toasts.
2. **Answer:** this doesn't break anything. The recap only read the risk levels, the Claude review at the top was separate, and the recap was never saved.
3. It also warned that removing the *top* Claude review instead would break the risk engine, because Claude's labels set every event's level at that point.

## Prompt 2
> change the risk engine logic. And add feature to bulk approve automated events.

(I pointed to my design notes in `design_process.md`: manual inputs that involve role changes or financial data are High priority; for automated events, check when the automation pattern changes, since a changed script has the most impact or may mean an unauthorised event.)

**What the AI did:**
1. **Profiled the data first:**
   - **Contexts:** of 17,059 events, about 1,050 are manual (UI), 10,650 clearly automated (scripts, CSV, Mass Update, bulk), and 5,350 have a blank context (mostly system Task Item Status updates).
   - **Patterns:** automated events fall into about 315 patterns (user + context + record type + set of fields).
2. **Asked me two questions:**
   - How should rules and Claude work together? **My choice:** rules set every level; Claude only reviews the High events.
   - What should bulk approve cover? **My choice:** routine automated events only.
3. **New RiskEngine (rule-based):**

   | | High | Medium | Low |
   |---|---|---|---|
   | **Manual** (UI / Other) | Role / access or financial changes | Hand edits to scripts / workflows | Anything else |
   | **Automated** (blank context = system) | Pattern changed: a new job, or the job changes a field it never changed before | Usual fields in a new combination, or a script / workflow edit | Routine: the exact pattern has run before |

   - "Reverted later", "edited again later" and "20+ fields" became reasons that only order events within a level.
4. **Bulk approve:** a "✓ Approve routine automated" button. It skips new automations, pattern changes, script / workflow edits and events with a denial, and asks for confirmation.
5. **Claude's part shrank:** the per-event labelling pass and the Risk Standards chat were removed; Claude only reviewed the week's High events. A read-only "Risk Rules" panel explained the rules.
6. **Result on the sample:** 809 High (523 manual role / financial, 286 pattern changes), 852 Medium, 15,398 Low, 15,189 routine.
7. **Testing:** the engine was run with Node on the sample data, and the page was clicked through in headless Chrome: no errors, and bulk approve approved 18 rows in a test week.

## Prompt 3
> if i was to remove the api aspect from this app. How to make the standards determinstics

(Plan mode. I chose an **editable rules form** and to **remove the Claude review card** entirely.)

**What the AI did:**
1. Wrote a plan, which I approved.
2. **Removed the API completely:**
   - the Claude review module and card, AI Settings and the API key field;
   - the "AI" badges and the "Claude" column.
   - On startup, the app now deletes what older versions saved in the browser, **including any saved API key**.
3. **RiskRules store:** the standard became plain keyword lists plus a threshold, saved in the browser:
   - manual contexts;
   - role / access record types and fields;
   - financial record types and fields;
   - automation record types;
   - the "many fields" threshold.

   An entry matches any word that starts with it, not case-sensitive. The default lists reproduce the previous results exactly (all 17,059 events identical).
4. **Risk Rules panel became a form:** Preview (shows before → after counts without saving), Save & re-rate, Reset to default. Approvals and comments are kept when rules change.
5. **Testing:**
   - **Node comparison:** old vs new engine had 0 differences. Removing "bank" from the financial fields moved exactly 1 event from High to Low.
   - **Headless Chrome, two page loads:** no external requests; an edit persisted after reload; Reset restored the defaults; the old AI keys were wiped.
   - **Export dialog:** it shared CSS with the removed AI Settings dialog, so those styles were restored.

## Prompt 4
> clear the preload files commit

**What the AI did:**
1. Asked what to do with the sample data committed in the repo. **My choice:** stop tracking it and make a new commit.
2. Untracked `system_notes_sample.xlsx` (the file stays on disk) and added a `.gitignore` for `*.xlsx` / `*.csv`.
3. Committed everything as `a5bb087`. The history still contained the data at this point.

## Prompt 5
> review the interface as it apperas to be too many levels, how would claude make it easier to edit and search. all to search by "Risk Rule" labels for example automaute, manual etc.

**What the AI did:**
1. **Built search by Risk Rule labels:**
   - `rule:<label>` in the search box. A prefix works (`rule:auto`), labels can be mixed with text (`bank rule:automated`), and several labels must all match. An unknown label shows an error listing the valid ones.
   - A **Rules** chip row toggles those tokens; the search box is the single source of the filter.
   - Clicking a Manual / Auto tag or a reason tag on an event filters by it.
   - The risk chips, sidebar, table view and approve buttons all follow the labels.
   - Fixed `rule:routine` to count exactly the 15,189 bulk-approvable events.
2. **Reviewed the interface** from headless-Chrome screenshots:
   - the same navigation appeared four times on a day page;
   - it took three clicks to reach any event;
   - the levels follow dates, while reviewing follows risk.
3. **Proposed:** two levels, a work-list start page with one-click views, "Edit rule" from an event, and event rows that stay on one line.

## Prompt 6
> build these

**What the AI did:**
1. **Two levels (Month › Week):**
   - The sidebar has no days. A week lists its events under day headings, each with "✓ Approve day".
   - The day tabs and the shortcut line were removed; the shortcuts moved to a tooltip.
   - Day links now open the week and scroll to that day.
2. **Work list:**
   - The app opens on All activity, highest risk first.
   - **Views:** Manual High (523), Pattern changes (476), Routine to approve (15,189), Everything.
   - New search tokens: `rule:a,b` (a **or** b) and `status:open|approved|denied|mixed`.
3. **Edit rule:** reasons that come from an editable list link to the Risk Rules panel, opened at that list with the matched entry selected and explained.
4. **One-line rows:** long names are cut with "…" (full text on hover). Rows wrap only when the list is narrow, e.g. with the Risk Rules panel open; the first version cut the buttons off there, which was fixed.
5. **Testing (headless Chrome):** views, day links, shortcuts, Edit rule, status tokens and row heights all checked; no errors.

## Prompt 7
> push the changes

**What the AI did:**
1. Committed Prompt 6.
2. Found the GitHub repo is **public** and empty, while old commits still contained the sample data. It asked first; **my choice:** strip the data from history, then push.
3. Kept a local backup branch, removed the xlsx / csv from all six commits, checked that no commit contains an `.xlsx` or `.csv`, and pushed `group_by_month` (`e32947d`).
4. Local `main` and the backup branch still contain the data and were not pushed.

## Prompt 8
> there's a lot on number of events when changing filters. Remove unneccsasrry ones. Simplied the UI

**What the AI did:**
1. **Kept one count per job:**
   - the risk chips (the filter);
   - the page heading ("1,052 of 17,059 events" when filtered);
   - the sidebar counts with the red "High not approved" badge.
2. **Removed or moved to tooltips:**
   - the toolbar "events shown" line;
   - the rows / load-time part of the header;
   - the row counts in the progress line (now "12% reviewed");
   - the counts on the rule chips;
   - the counts on the approve buttons (the routine one only appears when needed);
   - the event counts in the day headings;
   - the sidebar "%";
   - the history chips (still typeable).
3. **Simpler month table:** Week · Events · High open · Reviewed %. The Medium / Low / Routine columns and the day links are gone.
4. **Bug fixed:** approving in a week re-drew the whole list and closed the open event; now only the headings refresh.
5. **Testing (headless Chrome):** no errors, and an open event stayed open after approving.

## Prompt 9
> commit these changes, also create another md file in ai_history for todays session. In the main folder create a README.md

**What the AI did:** Wrote this log and `README.md`, then committed them with Prompt 8's changes.

---

## Notes on what I used / did not use
- The risk logic follows my own design notes in `design_process.md` (manual role / financial = High; automated = watch for pattern changes). The AI implemented it and chose the keyword lists, which I can now edit in the app.
- The app no longer sends anything to an AI service; every level comes from the rules.
- TODO: note which of the AI's interface suggestions I agree with, and anything I changed afterwards.
