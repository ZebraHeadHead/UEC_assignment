# System Notes Review

A single-page tool for reviewing NetSuite-style **System Notes** (audit-log) exports. It groups the log into events, rates every event High / Medium / Low with editable rules, and lets a reviewer approve, deny and comment, then export the result to Excel.

Everything runs in the browser. There is no server, no build step and no AI or other network calls; the log never leaves your computer.

## Running it

1. Open `index.html` in a current browser (Chrome, Edge or Firefox).
2. Drop a System Notes file on the page, or click **Choose file**. Both `.xlsx` and `.csv` work.

The file must have these columns (names are matched, order doesn't matter):

```
Date, Name, Role, Context, Record Type, Record ID, Record, Type, Field, Old Value, New Value, Line Id, Line Transaction Id
```

A 100,000-row file loads in about a second.

## How the log is organised

- **Event:** one save of one record by one user (Name + Record ID + timestamp). Opening an event shows its field changes.
- **Month › Week:** the sidebar lists months and weeks. A week shows its events under day headings.
- **All activity:** the start page, with every event sorted by risk.

## Risk rules

Every event gets a level from two rules (see `design_process.md`):

| | High | Medium | Low |
|---|---|---|---|
| **Manual** (a person; context UI / Other) | Role / access or financial changes | Edits to scripts / workflows | Anything else |
| **Automated** (scripts, CSV, Mass Update, bulk, blank context) | The automation's pattern changed: a new job, or a job changing a field it never changed before | Its usual fields in a new combination, or a script / workflow edit | **Routine:** the exact pattern has run before |

- A **job** is user + context + record type, and its **pattern** is the set of fields one save changes.
- "Reverted later", "edited again later" and "20+ fields in one save" are shown as reasons and sort an event higher within its level; they don't change the level.
- **Risk Rules** (header button) is where you edit the keyword lists: manual contexts, role / access record types and fields, financial record types and fields, automation record types, and the many-fields threshold.
  - An entry matches any word that **starts with** it, not case-sensitive ("approv" matches "Approver 2").
  - **Preview** shows what would change; **Save & re-rate** applies it. Approvals and comments are kept.
- **Edit rule** next to an event's reason opens the panel at the list and entry that matched.

The same file with the same rules always gives the same levels.

## Finding events

- **Views:** Manual High, Pattern changes, Routine to approve, Everything.
- **Risk chips:** show or hide High / Medium / Low.
- **Rule chips:** Manual, Automated, Routine, New automation, Pattern change, Role / access, Financial, Script / workflow edit.
- **Search box:** free text (all columns or one column), plus tokens:

| Token | Meaning |
|---|---|
| `rule:manual` | events with that rule label (a prefix works: `rule:auto`) |
| `rule:a,b` | label a **or** b |
| `rule:a rule:b` | labels a **and** b |
| `status:open` | not yet approved or denied (also `approved`, `denied`, `mixed`) |

Labels: `manual`, `automated`, `routine`, `new-automation`, `pattern-change`, `role`, `financial`, `script`, `reverted`, `edited-later`, `many-fields`.

Example: `bank rule:manual` finds manual changes mentioning "bank".

## Reviewing

- **Per event:** Approve, Deny, Comment. Single field changes can be approved or denied in the open event.
- **In bulk:** Approve day / week / month / shown, and **✓ Approve routine automated**. The routine button approves only automated events whose exact pattern has run before; new automations, pattern changes, script / workflow edits and denied events are left for you.
- **Keyboard:** `U` up a level, `[` / `]` previous / next, `N` next to review. In the sidebar: arrow keys, Home, Enter.
- **Saving:** progress, comments and edited rules are saved in this browser's localStorage. Progress is saved per file content, so reloading the same file (as .xlsx or .csv) restores it.

## Export

**Export .xlsx** writes the rows with a review-status column, filtered by date range, user and status. A "Review Comments" column is optional.

## Files

| File | Contents |
|---|---|
| `index.html` | Page layout and dialogs |
| `app.js` | `ReviewStore` (review state), `RiskRules` (editable standard), `RiskEngine` (rule-based levels), file readers, `XlsxWriter`, the UI |
| `styles.css` | Styles |
| `design_process.md` | My design notes and requirements |
| `ai_history/` | Logs of the AI-assisted sessions |

## Data

Sample and client data files (`*.xlsx`, `*.csv`) are ignored by git and aren't part of the repository. Put your own export next to `index.html`, or anywhere, and load it with the file picker.
