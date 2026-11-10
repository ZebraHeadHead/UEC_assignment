/* =====================================================================
 * ReviewStore — approve / deny / comment (Scope 2)
 *
 * Deliberately independent of how the UI groups or filters the log.
 * It only knows ROW IDs (the row's position in the loaded file).
 * Events, user-month groups, search results, or any future grouping
 * (e.g. by time or risk level) just pass in the row IDs they contain.
 * Changing the grouping never changes stored decisions.
 * ===================================================================== */
const ReviewStore = (() => {
  "use strict";
  const NONE = 0, APPROVED = 1, DENIED = 2;
  const LABEL = { [NONE]: "Not Reviewed", [APPROVED]: "Approved", [DENIED]: "Denied" };

  let status = new Uint8Array(0);   // status per row
  let comments = [];                // { id, text, at, rows: [rowId...] }
  let byRow = new Map();            // rowId -> Set(commentId)
  let nextId = 1;
  let storageKey = null;
  const listeners = new Set();

  // ---- persistence (localStorage, per file) ----
  let saveTimer = null;
  function scheduleSave() {
    if (!storageKey) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 300);
  }
  function saveNow() {
    if (!storageKey) return;
    try {
      let s = "";
      for (let i = 0; i < status.length; i += 8192) s += String.fromCharCode.apply(null, status.subarray(i, i + 8192).map((v) => v + 48));
      localStorage.setItem(storageKey, JSON.stringify({ v: 1, n: status.length, s, comments }));
    } catch (e) { console.warn("ReviewStore: could not save", e); }
  }
  function indexComments() {
    byRow = new Map();
    for (const c of comments) for (const r of c.rows) {
      if (!byRow.has(r)) byRow.set(r, new Set());
      byRow.get(r).add(c.id);
    }
    nextId = comments.reduce((m, c) => Math.max(m, c.id + 1), 1);
  }

  function emit(rowIds) { for (const fn of listeners) fn(rowIds); }

  return {
    NONE, APPROVED, DENIED, LABEL,

    /** Start a review for a file with `rowCount` rows. `fingerprint` identifies the file so saved work can be restored. */
    init(rowCount, fingerprint) {
      status = new Uint8Array(rowCount);
      comments = [];
      storageKey = fingerprint ? "systemNotesReview:" + fingerprint : null;
      let restored = false;
      if (storageKey) {
        try {
          const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
          if (saved && saved.n === rowCount) {
            for (let i = 0; i < rowCount; i++) status[i] = saved.s.charCodeAt(i) - 48;
            comments = saved.comments || [];
            restored = true;
          }
        } catch (e) { /* ignore corrupt storage */ }
      }
      indexComments();
      emit(null);
      return restored;
    },

    /** Set the status of the given rows. Returns how many rows changed. */
    setStatus(rowIds, value) {
      let changed = 0;
      for (const r of rowIds) if (status[r] !== value) { status[r] = value; changed++; }
      if (changed) { scheduleSave(); emit(rowIds); }
      return changed;
    },

    getStatus(rowId) { return status[rowId]; },

    /** Roll-up for any set of rows: counts and an overall label. */
    summarize(rowIds) {
      let a = 0, d = 0, n = 0;
      for (const r of rowIds) { const s = status[r]; if (s === APPROVED) a++; else if (s === DENIED) d++; else n++; }
      const total = a + d + n;
      let state = "none", label = LABEL[NONE];
      if (total && a === total) { state = "approved"; label = LABEL[APPROVED]; }
      else if (total && d === total) { state = "denied"; label = LABEL[DENIED]; }
      else if (a || d) { state = "mixed"; label = `Partly reviewed (${a + d}/${total})`; }
      return { approved: a, denied: d, pending: n, total, state, label };
    },

    /** Whole-file totals. */
    totals() {
      let a = 0, d = 0;
      for (let i = 0; i < status.length; i++) { if (status[i] === APPROVED) a++; else if (status[i] === DENIED) d++; }
      return { approved: a, denied: d, pending: status.length - a - d, total: status.length };
    },

    /** Attach a comment to a set of rows (e.g. all rows of one event). */
    addComment(rowIds, text) {
      text = String(text || "").trim();
      if (!text) return null;
      const c = { id: nextId++, text, at: new Date().toISOString(), rows: Array.from(rowIds) };
      comments.push(c);
      for (const r of c.rows) { if (!byRow.has(r)) byRow.set(r, new Set()); byRow.get(r).add(c.id); }
      scheduleSave(); emit(c.rows);
      return c;
    },

    deleteComment(id) {
      const i = comments.findIndex((c) => c.id === id);
      if (i < 0) return;
      const [c] = comments.splice(i, 1);
      for (const r of c.rows) byRow.get(r)?.delete(id);
      scheduleSave(); emit(c.rows);
    },

    /** All comments touching any of the given rows, oldest first. */
    commentsFor(rowIds) {
      const ids = new Set();
      for (const r of rowIds) { const s = byRow.get(r); if (s) for (const id of s) ids.add(id); }
      return comments.filter((c) => ids.has(c.id));
    },

    /** Subscribe to changes. Callback receives the affected row IDs (or null = everything). */
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    flush: saveNow,
  };
})();

/* =====================================================================
 * RiskRules — the reviewer's risk standard, as data (editable in "Risk Rules")
 *
 * Plain keyword lists + a threshold; RiskEngine turns them into matchers.
 * A list entry matches, case-insensitively, any word that starts with it
 * ("approv" matches "Approver 2"); manual contexts match exactly.
 * Saved in this browser; the same file + the same rules = the same levels.
 * ===================================================================== */
const RiskRules = (() => {
  "use strict";
  const LS = "systemNotesReview:riskRules:v1";
  const LISTS = ["manualContexts", "roleRecordTypes", "roleFields", "financialRecordTypes", "financialFields", "automationRecordTypes"];
  const DEFAULT = Object.freeze({
    manualContexts: ["UI", "Other"],
    roleRecordTypes: ["Role", "Employee", "User", "Access Token"],
    roleFields: ["role", "permission", "password", "login", "give access", "two-factor", "2fa"],
    financialRecordTypes: ["account", "transaction", "exchange rate", "accounting", "approval matrix", "subsidiary", "bank", "cash", "currency",
      "budget", "invoice", "bill", "payment", "journal", "vendor", "expense", "tax", "period", "bmo"],
    financialFields: ["amount", "debit", "credit", "bank", "iban", "swift", "routing", "payment", "account", "currency", "exchange", "rate",
      "price", "cost", "tax", "approv", "limit", "terms", "posting", "period", "balance"],
    automationRecordTypes: ["Script", "Workflow"],
    manyFields: 20,
  });

  const clean = (x) => {
    const out = {};
    for (const k of LISTS) {
      const src = Array.isArray(x && x[k]) ? x[k] : String((x && x[k]) ?? "").split(/[\n,]/);
      const seen = new Set();
      out[k] = src.map((s) => String(s).trim()).filter((s) => s && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()));
    }
    const n = Math.round(Number(x && x.manyFields));
    out.manyFields = Number.isFinite(n) && n >= 2 ? n : DEFAULT.manyFields;
    return out;
  };
  const same = (a, b) => JSON.stringify(clean(a)) === JSON.stringify(clean(b));

  let current = null;
  function get() {
    if (!current) {
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(LS) || "null"); } catch { /* ignore */ }
      current = saved ? clean(saved) : clean(DEFAULT);
    }
    return clean(current);
  }
  function set(x) {
    current = clean(x);
    try { same(current, DEFAULT) ? localStorage.removeItem(LS) : localStorage.setItem(LS, JSON.stringify(current)); } catch (e) { console.warn("RiskRules: storage", e); }
    return get();
  }
  const reset = () => set(DEFAULT);
  const isDefault = (x = get()) => same(x, DEFAULT);
  function id(x = get()) {
    let h = 5381;
    const str = JSON.stringify(clean(x));
    for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }
  return { DEFAULT, LISTS, get, set, reset, isDefault, id, clean };
})();

/* =====================================================================
 * RiskEngine — rule-based risk levels (two bases, see design_process.md)
 *
 *  1. MANUAL events (a manual context, e.g. UI): a person changed something by hand.
 *       High    role / access changes, or financial records / fields
 *       Medium  hand edits to automation (scripts, deployments, workflows)
 *       Low     other manual changes
 *  2. AUTOMATED events (everything else: scripts, CSV, Mass Update, bulk, web
 *     services; a blank context is treated as system automation): judged against
 *     the job's own history in the file. A "job" is user + context + record type;
 *     its "pattern" is the set of fields one save changes.
 *       High    new job (first run in the file), or the job now changes a
 *               field it never changed before: the script or import changed
 *       Medium  known fields in a new combination, or a job that edits a
 *               script / workflow definition
 *       Low     routine: the exact pattern has run before
 *
 * The keyword lists come from RiskRules (passed in). History facts (reverted
 * later, edited again later, many fields) are shown as reasons and break ties
 * inside a level; they never change the level. Knows nothing about the UI.
 * ===================================================================== */
const RiskEngine = (() => {
  "use strict";

  const LEVELS = ["high", "medium", "low"];
  const LABEL = { high: "High", medium: "Medium", low: "Low" };
  // Rule labels: searchable as rule:<id> (or a prefix of the id / label). Groups only order the chips.
  const TAGS = [
    { id: "manual", label: "Manual", group: "Who" },
    { id: "automated", label: "Automated", group: "Who" },
    { id: "routine", label: "Routine", group: "Pattern" },
    { id: "new-automation", label: "New automation", group: "Pattern" },
    { id: "pattern-change", label: "Pattern change", group: "Pattern" },
    { id: "role", label: "Role / access", group: "What" },
    { id: "financial", label: "Financial", group: "What" },
    { id: "script", label: "Script / workflow edit", group: "What" },
    { id: "reverted", label: "Reverted later", group: "History" },
    { id: "edited-later", label: "Edited again later", group: "History" },
    { id: "many-fields", label: "Many fields", group: "History" },
  ];
  const KIND_TAG = { role: "role", money: "financial", automation: "script", manual: "manual", size: "many-fields" }; // "routine" only from the routine flag (= bulk-approvable)
  const BASE = { high: 300, medium: 200, low: 100 };
  const NEVER = /(?!)/;

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Word-start match for any entry; an empty list matches nothing.
  const matcher = (list) => (list.length ? new RegExp("\\b(?:" + list.map(escapeRe).join("|") + ")", "i") : NEVER);
  const list = (arr, max = 3) => arr.slice(0, max).join(", ") + (arr.length > max ? ` +${arr.length - max} more` : "");

  /**
   * @param units  [{ id, user, contexts:[string], recordType, rowIds }] in chronological order
   * @param rowAt  (rowId) => { recordType, recordId, field, oldValue, newValue, context, date }
   * @param rules  RiskRules.get() shape
   * @returns Map(id -> { level, label, score, origin, routine, pattern, reasons:[{kind,text}], riskyRows:Set })
   */
  function assess(units, rowAt, rules) {
    const MANUAL = new Set(rules.manualContexts.map((c) => c.toLowerCase()));
    const ROLE_RT = matcher(rules.roleRecordTypes), ROLE_FIELD = matcher(rules.roleFields);
    const FIN_RT = matcher(rules.financialRecordTypes), FIN_FIELD = matcher(rules.financialFields);
    const AUTOMATION_RT = matcher(rules.automationRecordTypes);
    // Which entries of a list matched a value (shown by "Edit rule"). Contexts match exactly.
    const hits = (key, value) => rules[key].filter((x) => (key === "manualContexts" ? x.toLowerCase() === String(value).toLowerCase() : matcher([x]).test(value)));
    const source = (rtKey, rtValue, fieldKey, fieldsHit) => {
      const out = [];
      if (rtKey && matcher(rules[rtKey]).test(rtValue)) out.push({ list: rtKey, value: rtValue, entries: hits(rtKey, rtValue) });
      if (fieldKey && fieldsHit.length) out.push({ list: fieldKey, value: list(fieldsHit), entries: [...new Set(fieldsHit.flatMap((f) => hits(fieldKey, f)))] });
      return out;
    };

    // ---- history per record+field (independent of grouping) ----
    const hist = new Map(), cache = new Map();
    const read = (i) => { let r = cache.get(i); if (!r) { r = rowAt(i); cache.set(i, r); } return r; };
    for (const u of units) for (const i of u.rowIds) {
      const r = read(i);
      const k = r.recordType + "\u0001" + r.recordId + "\u0001" + r.field;
      let h = hist.get(k);
      if (!h) { h = { lastChange: "", lastSetTo: new Map() }; hist.set(k, h); }
      if (r.date > h.lastChange) h.lastChange = r.date;
      const prev = h.lastSetTo.get(r.newValue);
      if (!prev || r.date > prev) h.lastSetTo.set(r.newValue, r.date);
    }

    const jobs = new Map(); // job key -> { first, runs, fields:Set(lowercase), patterns:Map(signature -> runs) }
    const out = new Map();
    for (const u of units) {
      // ---- history facts (reasons + tie-breaker only) ----
      const editedLater = new Set(), revertedLater = new Set(), fields = new Set();
      for (const i of u.rowIds) {
        const r = read(i);
        if (r.field) fields.add(String(r.field));
        const h = hist.get(r.recordType + "\u0001" + r.recordId + "\u0001" + r.field);
        if (h && h.lastChange > r.date) {
          editedLater.add(r.field);
          const back = r.oldValue !== "" && h.lastSetTo.get(r.oldValue);
          if (back && back > r.date) revertedLater.add(r.field);
        }
      }
      const many = u.rowIds.length >= rules.manyFields;
      const notes = [];
      if (many) notes.push({ kind: "size", text: `${u.rowIds.length} fields changed in one save` });
      if (revertedLater.size) notes.push({ kind: "history", text: `Reverted later: ${list([...revertedLater])}` });
      const notReverted = [...editedLater].filter((f) => !revertedLater.has(f));
      if (notReverted.length) notes.push({ kind: "history", text: `Edited again later: ${list(notReverted)}` });
      const boost = (many ? 15 : 0) + (editedLater.size ? 10 : 0) + (revertedLater.size ? 20 : 0);

      const rt = String(u.recordType || "");
      const ctxs = u.contexts.length ? u.contexts : ["(blank)"];
      const manual = ctxs.some((c) => MANUAL.has(c.toLowerCase()));
      const fieldList = [...fields];
      const risky = new Set();
      const mark = (test) => { for (const i of u.rowIds) if (test(String(read(i).field || ""))) risky.add(i); };
      const reasons = [];
      let level = "", routine = false, pattern = null;

      if (manual) {
        // Basis 1: what a person changed by hand.
        const roleFields = fieldList.filter((f) => ROLE_FIELD.test(f));
        const finFields = fieldList.filter((f) => FIN_FIELD.test(f));
        if (ROLE_RT.test(rt) || roleFields.length) {
          level = "high"; mark((f) => ROLE_FIELD.test(f));
          reasons.push({ kind: "role", text: `Manual role / access change${roleFields.length ? `: ${list(roleFields)}` : ` on ${rt}`}`, rules: source("roleRecordTypes", rt, "roleFields", roleFields) });
        }
        if (FIN_RT.test(rt) || finFields.length) {
          level = "high"; mark((f) => FIN_FIELD.test(f));
          reasons.push({ kind: "money", text: `Manual financial change${finFields.length ? `: ${list(finFields)}` : ` on ${rt}`}`, rules: source("financialRecordTypes", rt, "financialFields", finFields) });
        }
        if (!level && AUTOMATION_RT.test(rt)) { level = "medium"; reasons.push({ kind: "automation", text: `Manual edit to automation (${rt}): changes how scripts / workflows behave`, rules: source("automationRecordTypes", rt) }); }
        if (!level) {
          level = "low";
          const ctx = ctxs.find((c) => MANUAL.has(c.toLowerCase()));
          reasons.push({ kind: "manual", text: `Manual change (${ctx}), not role / access or financial`, rules: [{ list: "manualContexts", value: ctx, entries: hits("manualContexts", ctx) }] });
        }
      } else {
        // Basis 2: did the automation behave the way it always has?
        const ctxLabel = ctxs.join(" + "), rtLabel = rt || "(no record type)";
        const jk = u.user + "\u0001" + ctxLabel + "\u0001" + rt;
        const sig = fieldList.map((f) => f.toLowerCase()).sort().join("\u0001");
        let job = jobs.get(jk);
        if (!job) {
          level = "high"; pattern = "new-job";
          reasons.push({ kind: "pattern", text: `New automation: first ${ctxLabel} run on ${rtLabel} by ${u.user} in this file` });
          job = { first: read(u.rowIds[0]).date, runs: 0, fields: new Set(), patterns: new Map() };
          jobs.set(jk, job);
        } else if (!job.patterns.has(sig)) {
          const added = fieldList.filter((f) => !job.fields.has(f.toLowerCase()));
          if (added.length) {
            level = "high"; pattern = "new-fields";
            mark((f) => added.includes(f));
            reasons.push({ kind: "pattern", text: `Automation pattern changed: ${ctxLabel} on ${rtLabel} now changes ${list(added)}, never changed in its ${job.runs} earlier run(s)` });
          } else {
            level = "medium"; pattern = "new-combination";
            reasons.push({ kind: "pattern", text: `Automation pattern changed: ${ctxLabel} on ${rtLabel} changes a new combination of its usual fields (${job.runs} earlier run(s))` });
          }
        } else {
          level = "low"; routine = true; pattern = "routine";
          reasons.push({ kind: "routine", text: `Routine automation: the same ${ctxLabel} pattern ran ${job.patterns.get(sig)} time(s) before (first ${job.first})` });
        }
        if (routine && AUTOMATION_RT.test(rt)) {
          level = "medium"; routine = false;
          reasons.push({ kind: "automation", text: `Automated change to a ${rt} definition`, rules: source("automationRecordTypes", rt) });
        }
        job.runs++;
        for (const f of fieldList) job.fields.add(f.toLowerCase());
        job.patterns.set(sig, (job.patterns.get(sig) || 0) + 1);
      }
      const tags = new Set([manual ? "manual" : "automated"]);
      if (routine) tags.add("routine");
      if (pattern === "new-job") tags.add("new-automation");
      if (pattern === "new-fields" || pattern === "new-combination") tags.add("pattern-change");
      for (const r of reasons) if (KIND_TAG[r.kind]) tags.add(KIND_TAG[r.kind]);
      if (many) tags.add("many-fields");
      if (revertedLater.size) tags.add("reverted");
      if (notReverted.length) tags.add("edited-later");
      out.set(u.id, {
        level, label: LABEL[level], score: BASE[level] + boost, origin: manual ? "manual" : "automated", routine, pattern,
        reasons: [...reasons, ...notes], riskyRows: risky, tags,
      });
    }
    return out;
  }

  return { assess, LEVELS, LABEL, TAGS };
})();

/* =====================================================================
 * XlsxWriter — minimal, dependency-free .xlsx writer (Scope 5)
 *
 * build({ sheetName, header, rows, widths, numericCols, statusCol }) -> Promise<Blob>
 *   rows: array of arrays of strings (one per data row)
 * Writes a single worksheet with shared strings, a bold frozen header row,
 * an autofilter, and (optionally) a coloured status column. The ZIP is
 * deflated with the browser's CompressionStream (stored if unavailable).
 * ===================================================================== */
const XlsxWriter = (() => {
  "use strict";
  let encoder = null; // created on first use, so loading this module can never fail
  const enc = { encode: (s) => (encoder || (encoder = new TextEncoder())).encode(s) };

  // ---- XML helpers ----
  const xmlEsc = (s) => String(s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "") // chars not allowed in XML
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const colName = (i) => { let s = ""; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

  // ---- ZIP helpers ----
  const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(bytes) { let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  async function deflate(bytes) {
    if (typeof CompressionStream === "undefined") return null;
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function zip(files) { // files: [{ name, data: Uint8Array }]
    const parts = [], central = [];
    let offset = 0;
    const d = new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    for (const f of files) {
      const name = enc.encode(f.name);
      const crc = crc32(f.data);
      const comp = await deflate(f.data);
      const method = comp ? 8 : 0, body = comp || f.data;
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, method, true);
      lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, body.length, true); lh.setUint32(22, f.data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, body);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, method, true);
      ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, body.length, true); ch.setUint32(24, f.data.length, true); ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + body.length;
    }
    const cdSize = central.reduce((n, p) => n + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  // ---- styles: 0 normal, 1 bold header, 2 Approved, 3 Denied, 4 Pending ----
  const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFC6EFCE"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFC7CE"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFEB9C"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/>
<xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/>
<xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
  const STATUS_STYLE = { Approved: 2, Denied: 3, Pending: 4 };

  async function build({ sheetName = "Sheet1", header, rows, widths = [], numericCols = [], statusCol = -1 }) {
    const nCols = header.length, lastCol = colName(nCols - 1), lastRow = rows.length + 1;
    const numeric = new Set(numericCols);
    const sst = new Map(), sstList = [];
    let sstCount = 0;
    const s = (v) => { sstCount++; let i = sst.get(v); if (i === undefined) { i = sstList.length; sst.set(v, i); sstList.push(v); } return i; };
    const cell = (ref, v, col, styleOverride) => {
      if (v === "" || v == null) return styleOverride ? `<c r="${ref}" s="${styleOverride}"/>` : "";
      v = String(v); if (v.length > 32767) v = v.slice(0, 32767);
      const st = styleOverride ? ` s="${styleOverride}"` : "";
      if (numeric.has(col) && /^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(v)) return `<c r="${ref}"${st}><v>${v}</v></c>`;
      return `<c r="${ref}"${st} t="s"><v>${s(v)}</v></c>`;
    };

    const chunks = [];
    chunks.push(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<dimension ref="A1:${lastCol}${lastRow}"/>
<sheetViews><sheetView tabSelected="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${header.map((_, i) => `<col min="${i + 1}" max="${i + 1}" width="${widths[i] || 14}" customWidth="1"/>`).join("")}</cols>
<sheetData>`);
    chunks.push(`<row r="1">${header.map((h, i) => cell(colName(i) + "1", h, -1, 1)).join("")}</row>`);
    let buf = "";
    for (let r = 0; r < rows.length; r++) {
      const rowNo = r + 2, row = rows[r];
      let x = `<row r="${rowNo}">`;
      for (let c = 0; c < nCols; c++) x += cell(colName(c) + rowNo, row[c], c, c === statusCol ? STATUS_STYLE[row[c]] : 0);
      buf += x + "</row>";
      if (buf.length > 1 << 20) { chunks.push(buf); buf = ""; }
    }
    chunks.push(buf, `</sheetData>\n<autoFilter ref="A1:${lastCol}${lastRow}"/>\n</worksheet>`);
    const sheetXml = enc.encode(chunks.join(""));

    const sstXml = enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sstCount}" uniqueCount="${sstList.length}">${
      sstList.map((v) => `<si><t${/^\s|\s$|\n/.test(v) ? ' xml:space="preserve"' : ""}>${xmlEsc(v)}</t></si>`).join("")}</sst>`);

    const sheetRef = `'${String(sheetName).replace(/'/g, "''")}'!$A$1:$${lastCol}$${lastRow}`;
    const files = [
      { name: "[Content_Types].xml", data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`) },
      { name: "_rels/.rels", data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`) },
      { name: "docProps/core.xml", data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>System Notes Review Export</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</dcterms:created></cp:coreProperties>`) },
      { name: "docProps/app.xml", data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>System Notes Review</Application></Properties>`) },
      { name: "xl/workbook.xml", data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets><sheet name="${xmlEsc(sheetName)}" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">${xmlEsc(sheetRef)}</definedName></definedNames></workbook>`) },
      { name: "xl/_rels/workbook.xml.rels", data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`) },
      { name: "xl/styles.xml", data: enc.encode(STYLES) },
      { name: "xl/sharedStrings.xml", data: sstXml },
      { name: "xl/worksheets/sheet1.xml", data: sheetXml },
    ];
    return zip(files);
  }

  return { build, colName, crc32 };
})();

(() => {
  "use strict";

  // ---------- Constants ----------
  const COLS = ["Date","Name","Role","Context","Record Type","Record ID","Record","Type","Field","Old Value","New Value","Line Id","Line Transaction Id"];
  const C = Object.fromEntries(COLS.map((c, i) => [c, i]));
  const EVENTS_PAGE = 50;
  const TABLE_PAGE = 100;

  // ---------- State ----------
  let rows = [];          // array of arrays (13 cols), in file order
  let rowKey = [];        // sortable "YYYY-MM-DD HH:MM" per row
  let hay = [];           // lowercase search text per row (all columns)
  let events = [];        // {date, month, name, rid, record, rtype, contexts, rows:[idx]}
  let groups = [];        // day scopes: {key:"day:YYYY-MM-DD", day, month, week, events:[eventIdx], rowIds}
  let weeks = [];         // week scopes: {key:"week:YYYY-MM|n", id, month, n, from, to, days:[], events, rowIds}
  let months = [];        // month scopes: {key:"month:YYYY-MM", month, weeks:[], events, rowIds}
  let scopeIndex = new Map(); // scope key -> scope
  let match = null;       // Uint8Array of matched rows, or null when no search
  let query = "";
  let view = "grouped";
  let selectedGroup = null; // group key, or "__all__"
  let eventsShown = EVENTS_PAGE;
  let tablePage = 0;
  let rowEvent = new Int32Array(0);                    // row -> event index
  let riskFilter = new Set(RiskEngine.LEVELS);         // levels currently shown
  let sortMode = "risk";                               // "risk" | "time"

  // ---------- Helpers ----------
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const fmt = (n) => n.toLocaleString();
  const pad = (n) => String(n).padStart(2, "0");

  function highlight(text) {
    const s = String(text ?? "");
    if (!query) return esc(s);
    const lower = s.toLowerCase();
    let out = "", i = 0, j;
    while ((j = lower.indexOf(query, i)) !== -1) {
      out += esc(s.slice(i, j)) + "<mark>" + esc(s.slice(j, j + query.length)) + "</mark>";
      i = j + query.length;
    }
    return out + esc(s.slice(i));
  }

  let toastTimer;
  function toast(html) {
    const t = $("toast");
    t.innerHTML = html;
    const action = !!t.querySelector("[data-act]"); // clickable toasts (e.g. "Next day ›") stay longer
    t.classList.toggle("has-action", action);
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), action ? 6000 : 2600);
  }
  function wip(feature) {
    toast(`<b>${esc(feature)}</b> is in progress — not available yet (Scope 1 is view & search only).`);
  }

  // Parses "2025-08-13 23:16[:ss]" or "8/13/2025 11:16[:ss] [PM]" -> "YYYY-MM-DD HH:MM", or null.
  function normDate(s) {
    s = (s || "").trim();
    // Excel date serial (e.g. 45882.97 from an .xlsx cell stored as a number)
    if (/^\d{5}(\.\d+)?$/.test(s)) {
      const d = new Date(Math.round((+s - 25569) * 86400000));
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    }
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::\d{2})?)?/);
    if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])} ${pad(m[4] || 0)}:${m[5] || "00"}`;
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?)?/i);
    if (m) {
      let h = +(m[4] || 0);
      const ap = (m[6] || "").toUpperCase();
      if (ap === "PM" && h < 12) h += 12;
      if (ap === "AM" && h === 12) h = 0;
      return `${m[3]}-${pad(m[1])}-${pad(m[2])} ${pad(h)}:${m[5] || "00"}`;
    }
    return null;
  }

  // RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF/LF, newlines inside quotes).
  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const out = [];
    let row = [], field = "", i = 0, inQ = false;
    const n = text.length;
    while (i < n) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQ = false; i++; continue;
        }
        field += ch; i++; continue;
      }
      if (ch === '"') { inQ = true; i++; continue; }
      if (ch === ",") { row.push(field); field = ""; i++; continue; }
      if (ch === "\r") { i++; continue; }
      if (ch === "\n") { row.push(field); out.push(row); row = []; field = ""; i++; continue; }
      field += ch; i++;
    }
    if (field !== "" || row.length) { row.push(field); out.push(row); }
    return out;
  }

  // ---------- XLSX reader (no libraries) ----------
  // An .xlsx is a ZIP of XML files. We read the ZIP directory, inflate entries with the
  // browser's built-in DecompressionStream, and pull cell values out of the first worksheet.
  function decodeXml(s) {
    return s
      .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => {
        const k = e.toLowerCase();
        if (k[0] === "#") return String.fromCodePoint(k[1] === "x" ? parseInt(k.slice(2), 16) : +k.slice(1));
        return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[k];
      })
      .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }

  function readZipDirectory(buf) {
    const dv = new DataView(buf), u8 = new Uint8Array(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("This .xlsx file looks damaged (not a valid ZIP archive).");
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    const entries = new Map();
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      entries.set(dec.decode(u8.subarray(p + 46, p + 46 + nlen)), { method, csize, lho });
      p += 46 + nlen + elen + clen;
    }
    async function read(name) {
      const e = entries.get(name.replace(/^\//, ""));
      if (!e) return null;
      const start = e.lho + 30 + dv.getUint16(e.lho + 26, true) + dv.getUint16(e.lho + 28, true);
      const data = u8.subarray(start, start + e.csize);
      if (e.method === 0) return dec.decode(data);
      if (e.method !== 8) throw new Error(`Unsupported compression in .xlsx (method ${e.method}).`);
      if (typeof DecompressionStream === "undefined") throw new Error("This browser can't open .xlsx files. Please use a recent Chrome, Edge, Firefox or Safari, or save the file as CSV.");
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return dec.decode(await new Response(stream).arrayBuffer());
    }
    return { read };
  }

  async function parseXLSX(buf, progress) {
    const zip = readZipDirectory(buf);

    // Locate the first worksheet via workbook.xml + its relationships.
    let sheetPath = "xl/worksheets/sheet1.xml";
    const wb = await zip.read("xl/workbook.xml");
    const rels = await zip.read("xl/_rels/workbook.xml.rels");
    const firstSheet = wb && wb.match(/<sheet\b[^>]*>/);
    const rid = firstSheet && firstSheet[0].match(/\br:id="([^"]+)"/);
    if (rid && rels) {
      const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((r) => r.includes(`Id="${rid[1]}"`));
      const target = rel && rel.match(/Target="([^"]+)"/);
      if (target) sheetPath = target[1].startsWith("/") ? target[1].slice(1) : "xl/" + target[1];
    }

    progress("Reading shared strings…");
    const sstXml = await zip.read("xl/sharedStrings.xml");
    const sst = [];
    if (sstXml) {
      for (const m of sstXml.matchAll(/<si(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/si>)/g)) {
        const inner = (m[1] || "").replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
        let s = "";
        for (const t of inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) s += t[1];
        sst.push(decodeXml(s));
      }
    }

    progress("Unpacking worksheet…");
    const xml = await zip.read(sheetPath);
    if (!xml) throw new Error("Could not find a worksheet in this .xlsx file.");

    progress("Reading cells…");
    await new Promise((r) => setTimeout(r, 20));
    const colIndex = (letters) => { let n = 0; for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
    const out = [];
    const rowRe = /<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g;
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    for (const rm of xml.matchAll(rowRe)) {
      const row = [];
      let next = 0;
      for (const cm of (rm[1] || "").matchAll(cellRe)) {
        const attrs = cm[1], inner = cm[2] || "";
        const ref = attrs.match(/\br="([A-Z]+)\d+"/);
        const ci = ref ? colIndex(ref[1]) : next;
        next = ci + 1;
        const t = (attrs.match(/\bt="(\w+)"/) || [])[1];
        const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        let val = "";
        if (t === "s") val = v != null ? sst[+v] ?? "" : "";
        else if (t === "inlineStr") { for (const tm of inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) val += tm[1]; val = decodeXml(val); }
        else if (t === "b") val = v === "1" ? "TRUE" : "FALSE";
        else if (v != null) val = decodeXml(v);
        while (row.length < ci) row.push("");
        row[ci] = val;
      }
      out.push(row);
    }
    return out;
  }

  // ---------- Loading ----------
  function showError(msg) {
    $("loading").style.display = "none";
    $("error").textContent = msg;
  }

  function setLoading(msg) {
    $("loading").style.display = "block";
    $("loading").textContent = msg;
  }

  async function handleFile(file) {
    if (!file) return;
    $("error").textContent = "";
    const isCsv = /\.csv$/i.test(file.name), isXlsx = /\.xlsx$/i.test(file.name);
    if (!isCsv && !isXlsx) {
      showError(`"${file.name}" is not supported.\nPlease use an .xlsx or .csv file (old .xls files: open in Excel and Save As .xlsx).`);
      return;
    }
    setLoading(`Reading ${file.name}…`);
    await new Promise((r) => setTimeout(r, 20)); // let the message paint before heavy work
    try {
      const t0 = performance.now();
      const table = isCsv
        ? parseCSV(await file.text())
        : await parseXLSX(await file.arrayBuffer(), setLoading);
      setLoading("Grouping events…");
      await new Promise((r) => setTimeout(r, 20));
      load(table);
      const ms = Math.round(performance.now() - t0);
      $("fileInfo").textContent = `${file.name} · ${fmt(events.length)} events`;
      $("fileInfo").title = `${fmt(rows.length)} rows · ${fmt(events.length)} events · ${fmt(groups.length)} days · loaded in ${(ms / 1000).toFixed(1)} s`;
    } catch (e) {
      showError(e.message || String(e));
    }
  }

  function load(data) {
    if (data.length < 2) throw new Error("The file has no data rows.");

    // Map headers by name (order-independent, trimmed, case-insensitive).
    const header = data[0].map((h) => h.trim().toLowerCase());
    const pos = COLS.map((c) => header.indexOf(c.toLowerCase()));
    const missing = COLS.filter((c, i) => pos[i] === -1);
    if (missing.length) throw new Error(`This doesn't look like a System Notes export.\nMissing column(s): ${missing.join(", ")}`);

    rows = []; rowKey = []; hay = [];
    let badDates = 0;
    for (let r = 1; r < data.length; r++) {
      const src = data[r];
      if (src.length === 1 && src[0] === "") continue; // blank line
      const row = pos.map((p) => (src[p] ?? "").replace(/\r\n?/g, "\n").trim());
      const key = normDate(row[C.Date]);
      if (!key) badDates++;
      else if (/^\d{5}(\.\d+)?$/.test(row[C.Date])) row[C.Date] = key; // show Excel serial dates readably
      rows.push(row);
      rowKey.push(key || "");
      hay.push(row.join("\u0001").toLowerCase());
    }
    if (!rows.length) throw new Error("The file has no data rows.");

    buildGroups();
    fileFp = fingerprint();
    $("exportBtn").disabled = false;
    const restored = ReviewStore.init(rows.length, fileFp);
    match = null; query = ""; $("search").value = "";
    expandedMonths = new Set(); expandedWeeks = new Set();
    selectScope("__all__"); // start on the work list: everything, highest risk first
    tablePage = 0;

    $("dropzone").style.display = "none";
    $("app").style.display = "flex";
    $("toolbar").style.display = "flex";
    $("loadAnother").style.display = "";
    $("loading").style.display = "none";
    render();
    if (badDates) toast(`⚠ ${fmt(badDates)} row(s) had an unreadable date and are grouped under “Unknown date”.`);
    else if (restored) {
      const t = ReviewStore.totals();
      toast(`↺ Restored your previous review of this file: ${fmt(t.approved)} approved, ${fmt(t.denied)} denied.`);
    }
  }

  // Identifies the file's content (not its name), so the same log as .csv or .xlsx restores the same review.
  function fingerprint() {
    let h = 5381;
    const take = (i) => { const s = hay[i]; for (let k = 0; k < s.length; k++) h = ((h * 33) ^ s.charCodeAt(k)) >>> 0; };
    for (let i = 0; i < Math.min(500, hay.length); i++) take(i);
    for (let i = Math.max(0, hay.length - 500); i < hay.length; i++) take(i);
    return `${rows.length}-${h.toString(36)}`;
  }

  // Event = same Name + Record ID + timestamp. Hierarchy: month -> week (Mon–Sun, clipped to the month) -> day.
  function buildGroups() {
    const order = rows.map((_, i) => i).sort((a, b) =>
      rowKey[a] < rowKey[b] ? -1 : rowKey[a] > rowKey[b] ? 1 : a - b);
    const evMap = new Map();
    events = [];
    for (const i of order) {
      const r = rows[i];
      const k = r[C.Name] + "\u0001" + r[C["Record ID"]] + "\u0001" + rowKey[i];
      let e = evMap.get(k);
      if (!e) {
        e = {
          date: rowKey[i] || r[C.Date] || "(no date)",
          month: rowKey[i] ? rowKey[i].slice(0, 7) : "Unknown date",
          name: r[C.Name] || "(no name)",
          rid: r[C["Record ID"]], record: r[C.Record], rtype: r[C["Record Type"]],
          contexts: new Set(), roles: new Set(), rows: [],
        };
        evMap.set(k, e);
        events.push(e);
      }
      e.rows.push(i);
      e.contexts.add(r[C.Context] || "(blank)");
      if (r[C.Role]) e.roles.add(r[C.Role]);
    }
    const dayMap = new Map(), weekMap = new Map(), monthMap = new Map();
    groups = []; weeks = []; months = [];
    events.forEach((e, idx) => {   // events are in chronological order
      const day = /^\d{4}-\d{2}-\d{2}/.test(e.date) ? e.date.slice(0, 10) : "Unknown date";
      const wi = weekOf(day);
      e.day = day; e.week = `${e.month}|${wi.n}`;
      let m = monthMap.get(e.month);
      if (!m) { m = { key: MONTH_PREFIX + e.month, month: e.month, weeks: [], events: [], rowIds: [] }; monthMap.set(e.month, m); months.push(m); }
      let w = weekMap.get(e.week);
      if (!w) { w = { key: WEEK_PREFIX + e.week, id: e.week, month: e.month, n: wi.n, from: wi.from, to: wi.to, days: [], events: [], rowIds: [] }; weekMap.set(e.week, w); weeks.push(w); m.weeks.push(w); }
      let d = dayMap.get(day);
      if (!d) { d = { key: DAY_PREFIX + day, day, month: e.month, week: e.week, events: [], rowIds: [] }; dayMap.set(day, d); groups.push(d); w.days.push(d); }
      for (const x of [m, w, d]) { x.events.push(idx); for (const r of e.rows) x.rowIds.push(r); }
    });
    scopeIndex = new Map([...months, ...weeks, ...groups].map((x) => [x.key, x]));

    rowEvent = new Int32Array(rows.length);
    events.forEach((e, i) => { for (const r of e.rows) rowEvent[r] = i; });
    applyRisk();
  }

  // ---------- Risk (rule-based, deterministic): levels per event from RiskRules ----------
  // Grouping-independent; events are in chronological order, which the pattern rules rely on.
  function assessWith(rules) {
    return RiskEngine.assess(
      events.map((e, i) => ({ id: i, user: e.name, contexts: [...e.contexts].filter((c) => c !== "(blank)"), recordType: e.rtype, rowIds: e.rows })),
      (i) => {
        const r = rows[i];
        return { recordType: r[C["Record Type"]], recordId: r[C["Record ID"]], field: r[C.Field], oldValue: r[C["Old Value"]], newValue: r[C["New Value"]], context: r[C.Context], date: rowKey[i] };
      },
      rules);
  }
  function applyRisk(rules = RiskRules.get()) {
    const assessed = assessWith(rules);
    events.forEach((e, i) => { e.risk = assessed.get(i); });
  }
  function riskCounts(get = (i) => events[i].risk) {
    const n = { high: 0, medium: 0, low: 0, manual: 0, routine: 0 };
    for (let i = 0; i < events.length; i++) { const r = get(i); n[r.level]++; if (r.origin === "manual") n.manual++; if (r.routine) n.routine++; }
    return n;
  }

  // ---------- Search ----------
  // "rule:<label>" tokens in the search box filter by Risk Rule labels (all tokens must match);
  // the rest of the text is the normal search. The box is the single source: chips just edit it.
  const RULE_TOKEN = /(^|\s)rule:("[^"]*"|\S*)/gi;
  const STATUS_TOKEN = /(^|\s)status:(\S*)/gi;   // status:open | approved | denied | mixed
  const STATUS_ALIAS = { open: ["none", "mixed"], pending: ["none", "mixed"], notreviewed: ["none"], approved: ["approved"], denied: ["denied"], mixed: ["mixed"], partly: ["mixed"] };
  const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, "");
  let ruleQuery = [], ruleUnknown = [];   // ruleQuery: one array of acceptable tag ids per token (a,b = a or b)
  let statusQuery = null;                 // Set of ReviewStore states allowed, or null
  function resolveRule(v) {
    const q = norm(v.replace(/"/g, ""));
    if (!q) return null;
    const exact = RiskEngine.TAGS.filter((t) => norm(t.id) === q || norm(t.label) === q);
    if (exact.length) return exact.map((t) => t.id);
    const pre = RiskEngine.TAGS.filter((t) => norm(t.id).startsWith(q) || norm(t.label).startsWith(q));
    return pre.length ? pre.map((t) => t.id) : [];
  }
  function runSearch() {
    const raw = $("search").value;
    ruleQuery = []; ruleUnknown = [];
    for (const m of raw.matchAll(RULE_TOKEN)) {
      const alts = new Set();
      for (const part of m[2].split(",")) {
        const ids = resolveRule(part);
        if (ids === null) continue;          // "rule:" still being typed
        if (ids.length) ids.forEach((x) => alts.add(x)); else ruleUnknown.push(part);
      }
      if (alts.size) ruleQuery.push([...alts]);
    }
    statusQuery = null;
    for (const m of raw.matchAll(STATUS_TOKEN)) {
      const v = norm(m[2]);
      if (!v) continue;
      const key = Object.keys(STATUS_ALIAS).find((k) => k.startsWith(v));
      if (!key) { ruleUnknown.push("status:" + m[2]); continue; }
      statusQuery = new Set([...(statusQuery || []), ...STATUS_ALIAS[key]]);
    }
    query = raw.replace(RULE_TOKEN, " ").replace(STATUS_TOKEN, " ").trim().toLowerCase();
    const col = +$("searchCol").value;
    if (!query) { match = null; }
    else {
      match = new Uint8Array(rows.length);
      for (let i = 0; i < rows.length; i++) {
        if (col === -1 ? hay[i].includes(query) : rows[i][col].toLowerCase().includes(query)) match[i] = 1;
      }
    }
    applyFilters();
  }

  // Re-apply search + risk filter: reset paging and keep a sensible group selected.
  function applyFilters() {
    eventsShown = EVENTS_PAGE; tablePage = 0;
    render(); // the selected month / week / day stays selected; counts and lists follow the filters
  }

  const eventHits = (e) => (match ? e.rows.reduce((n, i) => n + match[i], 0) : 0);
  const riskFiltered = () => riskFilter.size < RiskEngine.LEVELS.length;
  const rulesFiltered = () => ruleQuery.length > 0 || ruleUnknown.length > 0 || !!statusQuery;
  const anyFilter = () => !!match || riskFiltered() || rulesFiltered();
  const passesRules = (ei, extra = null) => {
    if (ruleUnknown.length) return false;
    const tags = events[ei].risk.tags;
    if (!ruleQuery.every((alts) => alts.some((t) => tags.has(t))) || (extra && !tags.has(extra))) return false;
    return !statusQuery || statusQuery.has(ReviewStore.summarize(events[ei].rows).state);
  };
  const passesSearch = (ei) => (!match || eventHits(events[ei]) > 0) && passesRules(ei);
  const passes = (ei) => riskFilter.has(events[ei].risk.level) && passesSearch(ei);
  const visibleEvents = (g) => (anyFilter() ? g.events.filter(passes) : g.events);
  const byRisk = (a, b) => events[b].risk.score - events[a].risk.score || a - b; // event index order = chronological

  // Scopes: "__all__" | "month:YYYY-MM" | "week:YYYY-MM|n" | "day:YYYY-MM-DD"
  const MONTH_PREFIX = "month:", WEEK_PREFIX = "week:", DAY_PREFIX = "day:";
  let expandedMonths = new Set(), expandedWeeks = new Set(); // sidebar tree state
  const scope = (key = selectedGroup) => scopeIndex.get(key) || null;
  const scopeKind = (key = selectedGroup) => key === "__all__" ? "all"
    : typeof key !== "string" ? null : key.startsWith(MONTH_PREFIX) ? "month" : key.startsWith(WEEK_PREFIX) ? "week" : key.startsWith(DAY_PREFIX) ? "day" : null;
  // The week that owns the current selection (week itself, or the day's week).
  const weekOfScope = (key = selectedGroup) => { const k = scopeKind(key), x = scope(key); return k === "week" ? x : k === "day" && x ? scope(WEEK_PREFIX + x.week) : null; };
  const visCount = (idx) => (anyFilter() ? idx.reduce((n, ei) => n + (passes(ei) ? 1 : 0), 0) : idx.length);

  let pendingDay = null; // a day asked for: shown as its heading inside the week
  function selectScope(key) {
    if (scopeKind(key) === "day" && scopeIndex.get(key)) { const d = scopeIndex.get(key); pendingDay = d.day; key = WEEK_PREFIX + d.week; }
    const x = scopeIndex.get(key);
    selectedGroup = x || key === "__all__" ? key : "__all__";
    if (x) {
      expandedMonths.add(x.month);
    }
    eventsShown = EVENTS_PAGE;
  }

  // Monday-based week number inside the month (1..6) and its date range clipped to the month.
  function weekOf(day) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
    if (!m) return { n: 0, from: "", to: "" };
    const y = +m[1], mo = +m[2], d = +m[3];
    const fw = (new Date(Date.UTC(y, mo - 1, 1)).getUTCDay() + 6) % 7; // weekday of the 1st, Mon = 0
    const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const n = Math.floor((d - 1 + fw) / 7) + 1;
    const start = Math.max(1, (n - 1) * 7 - fw + 1), end = Math.min(dim, n * 7 - fw);
    return { n, from: `${m[1]}-${m[2]}-${pad(start)}`, to: `${m[1]}-${m[2]}-${pad(end)}` };
  }
  const shortDate = (d) => { const x = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d); return x ? new Date(+x[1], +x[2] - 1, +x[3]).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : d; };
  const weekLabel = (w) => (w.n ? `Week ${w.n} · ${shortDate(w.from)}–${shortDate(w.to).replace(/^[A-Za-z]+\s/, (m) => (shortDate(w.from).startsWith(m) ? "" : m))}` : "Unknown date");
  const weekLabelLong = (w) => (w.n ? `${weekLabel(w)}, ${w.month.slice(0, 4)}` : "Unknown date");
  const dayLabel = (day) => { const x = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day); return x ? new Date(+x[1], +x[2] - 1, +x[3]).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }) : day; };
  const dayLabelLong = (day) => { const x = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day); return x ? new Date(+x[1], +x[2] - 1, +x[3]).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : day; };
  const scopeTitle = (key = selectedGroup) => {
    const k = scopeKind(key), x = scope(key);
    return k === "all" ? "All activity" : k === "month" ? monthLabel(x.month) : k === "week" ? weekLabelLong(x) : k === "day" ? dayLabelLong(x.day) : "";
  };

  // ---------- Level navigation: parent / siblings / next to review ----------
  const shortLabel = (x, k = scopeKind(x.key)) => k === "month" ? monthLabel(x.month) : k === "week" ? weekLabel(x) : k === "day" ? dayLabel(x.day) : "All activity";
  const levelList = (k) => (k === "month" ? months : k === "week" ? weeks : k === "day" ? groups : null);
  function parentKey(key = selectedGroup) {
    const k = scopeKind(key), x = scope(key);
    return k === "day" ? WEEK_PREFIX + x.week : k === "week" ? MONTH_PREFIX + x.month : k === "month" ? "__all__" : null;
  }
  // Previous / next scope on the same level, in date order (crosses week / month boundaries); skips scopes hidden by the filters.
  function siblingOf(key, dir) {
    const arr = levelList(scopeKind(key));
    if (!arr) return null;
    for (let i = arr.indexOf(scope(key)) + dir; i >= 0 && i < arr.length; i += dir) if (!anyFilter() || visCount(arr[i].events)) return arr[i];
    return null;
  }
  // Rows of a scope's events that pass the current filters.
  const scopeRowIds = (x) => { if (!anyFilter()) return x.rowIds; const ids = []; for (const ei of x.events) if (passes(ei)) for (const r of events[ei].rows) ids.push(r); return ids; };
  const scopePending = (x) => { const ids = scopeRowIds(x); return ids.length && ReviewStore.summarize(ids).state !== "approved"; };
  // Next scope on the same level (after `key`) that still has events to review.
  function nextPending(key) {
    for (let s = siblingOf(key, 1); s; s = siblingOf(s.key, 1)) if (scopePending(s)) return s;
    return null;
  }
  function goScope(key) {
    if (!key) return;
    selectScope(key);
    setView("grouped");
    render();
    $("main").scrollTop = 0;
    if (pendingDay) { document.getElementById("dh-" + pendingDay)?.scrollIntoView({ block: "start" }); pendingDay = null; }
  }
  function setView(v) {
    view = v;
    $("tabGrouped").classList.toggle("active", v === "grouped");
    $("tabTable").classList.toggle("active", v === "table");
  }
  const openLink = (x, text = shortLabel(x), cls = "") => `<a class="jump ${cls}" data-act="open-scope" data-g="${esc(x.key)}">${esc(text)}</a>`;

  // ---------- Rendering ----------
  function render() {
    renderStats();
    renderSidebar();
    view === "grouped" ? renderGrouped() : renderTable();
  }

  function renderProgress() {
    const t = ReviewStore.totals();
    const pct = (n) => (t.total ? (n / t.total) * 100 : 0);
    $("progress").innerHTML = `<span class="bar"><i style="width:${pct(t.approved)}%;background:var(--ok)"></i><i style="width:${pct(t.denied)}%;background:var(--bad)"></i></span>
      <span>${Math.floor(pct(t.approved + t.denied))}% reviewed</span>`;
    $("progress").title = `${fmt(t.approved + t.denied)} of ${fmt(t.total)} rows reviewed · ${fmt(t.approved)} approved · ${fmt(t.denied)} denied`;
  }

  function renderRiskChips() {
    // Counts per level among events matching the search and rule labels (ignoring the risk filter itself).
    const counts = { high: 0, medium: 0, low: 0 };
    for (let i = 0; i < events.length; i++) if (passesSearch(i)) counts[events[i].risk.level]++;
    $("riskChips").innerHTML = RiskEngine.LEVELS.map((l) =>
      `<button class="chip risk-${l} ${riskFilter.has(l) ? "on" : ""}" data-risk="${l}" title="${riskFilter.has(l) ? "Hide" : "Show"} ${RiskEngine.LABEL[l]} risk events">● ${RiskEngine.LABEL[l]} <b>${fmt(counts[l])}</b></button>`).join("");
  }

  // Rule chips: count = events that would match if this label were added (search + risk level + current labels).
  const ruleTokenOn = (id) => ruleQuery.some((alts) => alts.length === 1 && alts[0] === id);
  function renderRuleChips() {
    const counts = Object.fromEntries(RiskEngine.TAGS.map((t) => [t.id, 0]));
    for (let i = 0; i < events.length; i++) {
      if (!riskFilter.has(events[i].risk.level) || (match && !eventHits(events[i])) || !passesRules(i)) continue;
      for (const t of events[i].risk.tags) counts[t]++;
    }
    let html = viewsHTML() + `<span class="chips-label" title="Filter by Risk Rule label. Also: type rule:manual, rule:financial, rule:pattern, rule:reverted, rule:edited-later, rule:many-fields … (rule:a,b = a or b; status:open) in the search box">Rules</span>`, group = "";
    for (const t of RiskEngine.TAGS) {
      const on = ruleTokenOn(t.id);
      if (!on && (!counts[t.id] || t.group === "History")) continue;
      if (t.group !== group) { if (group) html += `<span class="chip-sep"></span>`; group = t.group; }
      html += `<button class="chip rule ${on ? "on" : ""}" data-rule="${t.id}" title="${on ? "Remove" : "Show only"} “${esc(t.label)}” events: ${fmt(counts[t.id])} (rule:${t.id})">${esc(t.label)}</button>`;
    }
    if (ruleUnknown.length) html += ` <span class="err">Unknown: ${esc(ruleUnknown.join(", "))}. Rules: ${RiskEngine.TAGS.map((t) => t.id).join(", ")}; status: open, approved, denied, mixed.</span>`;
    else if (rulesFiltered()) html += ` <button class="small" data-rule="__clear__" title="Remove all rule: labels from the search">✕ Clear rules</button>`;
    $("ruleChips").innerHTML = html;
  }
  // One-click work-list views: set the rule / status tokens and the risk levels (free text in the box is kept).
  const VIEWS = [
    { id: "manual-high", label: "Manual High", tokens: "rule:manual", risk: ["high"], tip: "Changes a person made by hand that the rules rate High (roles / access, financial)" },
    { id: "patterns", label: "Pattern changes", tokens: "rule:new-automation,pattern-change", risk: null, tip: "Automations running for the first time, or changing fields they never changed before" },
    { id: "routine-open", label: "Routine to approve", tokens: "rule:routine status:open", risk: null, tip: "Routine automated events nobody has approved or denied yet: check a few, then ✓ Approve routine automated" },
    { id: "all", label: "Everything", tokens: "", risk: null, tip: "No rule, status or risk filter" },
  ];
  const tokensOf = (v) => [...v.matchAll(RULE_TOKEN), ...v.matchAll(STATUS_TOKEN)].map((m) => m[0].trim().toLowerCase()).sort().join(" ");
  const viewOn = (v) => tokensOf($("search").value) === tokensOf(v.tokens)
    && (v.risk ? riskFilter.size === v.risk.length && v.risk.every((l) => riskFilter.has(l)) : !riskFiltered());
  function applyView(id) {
    const v = VIEWS.find((x) => x.id === id);
    const box = $("search");
    box.value = `${box.value.replace(RULE_TOKEN, " ").replace(STATUS_TOKEN, " ")} ${v.tokens}`.replace(/\s+/g, " ").trim();
    riskFilter = new Set(v.risk || RiskEngine.LEVELS);
    runSearch();
  }
  const viewsHTML = () => `<span class="chips-label">Views</span>${VIEWS.map((v) =>
    `<button class="chip view ${viewOn(v) ? "on" : ""}" data-view="${v.id}" title="${esc(v.tip)}${v.tokens ? ` (${esc(v.tokens)}${v.risk ? " + High only" : ""})` : ""}">${esc(v.label)}</button>`).join("")}<span class="chip-sep wide"></span>`;

  // Add / remove a rule:<id> token in the search box, then search.
  function toggleRule(id) {
    const box = $("search");
    if (id === "__clear__") box.value = box.value.replace(RULE_TOKEN, " ").replace(STATUS_TOKEN, " ");
    else if (ruleTokenOn(id)) box.value = box.value.replace(RULE_TOKEN, (m, sp, v) => (norm(v.replace(/"/g, "")) === norm(id) || norm(v) === norm(RiskEngine.TAGS.find((t) => t.id === id).label) ? " " : m));
    else box.value = `${box.value.trim()} rule:${id}`;
    box.value = box.value.replace(/\s+/g, " ").trim();
    runSearch();
  }

  function renderStats() {
    renderProgress();
    renderRiskChips();
    renderRuleChips();
  }

  // Review marks for a scope: ✓ all approved, ● has denials, % partly reviewed; plus unapproved High count.
  function reviewMark(x) {
    const st = ReviewStore.summarize(x.rowIds);
    return st.state === "approved" ? `<span class="done" title="All approved">✓</span>`
      : st.denied ? `<span class="den" title="${fmt(st.denied)} denied rows">●</span>`
      : "";
  }
  function hiMark(idx) {
    let hi = 0;
    for (const ei of idx) if (events[ei].risk.level === "high" && ReviewStore.summarize(events[ei].rows).state !== "approved") hi++;
    return hi ? `<span class="hi" title="${fmt(hi)} High-risk event(s) not yet approved">${fmt(hi)}</span>` : "";
  }

  function renderSidebar() {
    const sel = selectedGroup;
    const item = (cls, key, level, title, inner, expanded) =>
      `<div class="tree ${cls} ${sel === key ? "active" : ""}" data-g="${esc(key)}" role="treeitem" aria-level="${level}" tabindex="${sel === key ? 0 : -1}" aria-selected="${sel === key}"${expanded == null ? "" : ` aria-expanded="${expanded}"`} title="${esc(title)}">${inner}</div>`;
    const caret = (open, what) => `<span class="caret" data-toggle="1" title="${open ? "Collapse" : "Expand"} (shows the ${what} without opening this level)">${open ? "▾" : "▸"}</span>`;
    let html = item("all", "__all__", 1, "All activity", `<span>All activity</span><span class="count">${fmt(visCount(events.map((_, i) => i)))}</span>`);
    let any = false;
    for (const m of months) {
      const mv = visCount(m.events);
      if (!mv && anyFilter()) continue;
      any = true;
      const open = expandedMonths.has(m.month);
      html += item("month", m.key, 1, `${monthLabel(m.month)}: ${fmt(m.events.length)} events`,
        `<span>${caret(open, "weeks")}${esc(monthLabel(m.month))}${reviewMark(m)}</span><span class="count">${fmt(mv)}</span>`, open);
      if (!open) continue;
      for (const w of m.weeks) {
        const wv = visCount(w.events);
        if (!wv && anyFilter()) continue;
        html += item("week", w.key, 2, weekLabelLong(w),
          `<span>${esc(weekLabel(w))}${reviewMark(w)}</span><span>${hiMark(w.events)}<span class="count">${fmt(wv)}</span></span>`);
      }
    }
    if (!any) html += `<div class="empty">No logs match the current search / risk filter.</div>`;
    const sb = $("sidebar");
    sb.setAttribute("role", "tree");
    sb.setAttribute("aria-label", "Months and weeks");
    sb.innerHTML = html;
    // keep the selected level visible in the tree when it was chosen from the main area
    const act = sb.querySelector(".tree.active");
    if (act && (act.offsetTop < sb.scrollTop || act.offsetTop + act.offsetHeight > sb.scrollTop + sb.clientHeight)) act.scrollIntoView({ block: "nearest" });
  }

  function monthLabel(m) {
    const mm = m.match(/^(\d{4})-(\d{2})$/);
    if (!mm) return m;
    return new Date(+mm[1], +mm[2] - 1, 1).toLocaleString(undefined, { month: "long", year: "numeric" });
  }

  // Events of the current scope that pass search + risk filter, in the chosen order.
  function currentEventList() {
    const k = scopeKind();
    const base = k === "all" ? events.map((_, i) => i) : scope() ? scope().events : [];
    const list = anyFilter() ? base.filter(passes) : [...base];
    return sortMode === "risk" ? list.sort(byRisk) : list;
  }

  // Breadcrumb (every ancestor is a link) + Up / Prev / Next on the current level.
  function breadcrumb() {
    const k = scopeKind(), x = scope();
    if (!x) return "";
    const m = scope(MONTH_PREFIX + x.month), w = weekOfScope();
    const parts = [`<a class="jump" data-act="open-scope" data-g="__all__">All activity</a>`,
      k === "month" ? `<span class="here">${esc(monthLabel(x.month))}</span>` : openLink(m)];
    if (k === "week") parts.push(`<span class="here">${esc(weekLabel(w))}</span>`);
    const up = scope(parentKey()), prev = siblingOf(selectedGroup, -1), next = siblingOf(selectedGroup, 1);
    const upName = up ? shortLabel(up) : "All activity";
    return `<div class="levelnav" title="Shortcuts: U = up, [ / ] = previous / next, N = next ${k} to review"><nav class="crumbs" aria-label="Breadcrumb">${parts.join(" › ")}</nav><span class="spacer"></span>
      <button class="small" data-act="open-scope" data-g="${esc(parentKey())}" title="Up to ${esc(upName)} (U)">↑ ${esc(upName)}</button>
      <button class="small" data-act="open-scope" data-g="${prev ? esc(prev.key) : ""}" ${prev ? "" : "disabled"} title="Previous ${k} ([)">‹ ${prev ? esc(shortLabel(prev)) : "Previous"}</button>
      <button class="small" data-act="open-scope" data-g="${next ? esc(next.key) : ""}" ${next ? "" : "disabled"} title="Next ${k} (])">${next ? esc(shortLabel(next)) : "Next"} ›</button>
    </div>`;
  }

  function scopeHeaderHTML(list, noun) {
    const total = scopeKind() === "all" ? events.length : scope() ? scope().events.length : 0;
    const routine = routineOpen(list).length;
    return `<div class="group-head">
      <h2>${esc(scopeTitle())}</h2>
      <span class="meta">${anyFilter() ? `${fmt(list.length)} of ${fmt(total)} events` : `${fmt(list.length)} events`}</span>
      <span class="spacer"></span>
      <button class="small primary" data-act="approve-list" ${list.length ? "" : "disabled"} title="Approve the ${fmt(list.length)} event(s) shown${anyFilter() ? " (matching the current filters)" : ""}">✓ Approve ${anyFilter() ? "shown" : noun}</button>
      ${routine ? `<button class="small" data-act="approve-routine" title="Approve the ${fmt(routine)} automated event(s) here whose exact pattern has run before. New automations, pattern changes, script / workflow edits and denied events are left for you.">✓ Approve routine automated</button>` : ""}
      <button class="small" data-act="reset-list" ${list.length ? "" : "disabled"} title="Set the ${fmt(list.length)} event(s) shown back to Not Reviewed">Reset</button>
    </div>`;
  }

  // Month -> table of weeks; week -> table of days.
  function scopeTableHTML(kind, x) {
    const children = kind === "month" ? x.weeks : x.days, childNoun = kind === "month" ? "week" : "day";
    let html = `<table class="scope-table"><thead><tr><th>${kind === "month" ? "Week" : "Day"}</th><th class="num">Events</th><th class="num" title="High-risk events not yet approved">High open</th><th>Reviewed</th><th></th></tr></thead><tbody>`;
    for (const c of children) {
      const idx = anyFilter() ? c.events.filter(passes) : c.events;
      const n = { high: 0, medium: 0, low: 0, routine: 0 }, rv = { approved: 0, denied: 0 };
      for (const ei of idx) {
        n[events[ei].risk.level]++;
        const st = ReviewStore.summarize(events[ei].rows).state;
        if (st === "approved") rv.approved++; else if (st === "denied") rv.denied++;
        if (events[ei].risk.level === "high" && st !== "approved") n.highOpen = (n.highOpen || 0) + 1;
      }
      const pct = (v) => (idx.length ? (v / idx.length) * 100 : 0);
      const label = kind === "month" ? weekLabel(c) : dayLabel(c.day);
      html += `<tr class="${idx.length ? "" : "empty-row"}">
        <td><a class="jump" data-act="open-scope" data-g="${esc(c.key)}">${esc(label)}</a></td>
        <td class="num">${fmt(idx.length)}</td>
        <td class="num ${n.highOpen ? "c-high" : "muted"}" title="${fmt(n.high)} High · ${fmt(n.medium)} Medium · ${fmt(n.low)} Low">${n.highOpen ? fmt(n.highOpen) : "—"}</td>
        <td><span class="minibar" title="${fmt(rv.approved)} approved · ${fmt(rv.denied)} denied of ${fmt(idx.length)}"><i style="width:${pct(rv.approved)}%;background:var(--ok)"></i><i style="width:${pct(rv.denied)}%;background:var(--bad)"></i></span> ${Math.floor(pct(rv.approved + rv.denied))}%</td>
        <td class="actions-cell"><button class="small" data-act="open-scope" data-g="${esc(c.key)}">Open</button> <button class="small" data-act="approve-scope" data-g="${esc(c.key)}" ${idx.length ? "" : "disabled"}>✓ Approve ${childNoun}</button></td>
      </tr>`;
    }
    return html + `</tbody></table>`;
  }

  function renderGrouped() {
    const kind = scopeKind(), x = scope();
    const list = currentEventList();
    let html = breadcrumb();
    if (kind === "month") {
      html += scopeHeaderHTML(list, kind) + scopeTableHTML(kind, x);
    } else {
      html += scopeHeaderHTML(list, kind === "week" ? "week" : "all");
      if (!list.length) html += `<p class="meta">No events to show.</p>`;
      if (kind === "week") {
        // Days in date order, each with its events (in the chosen sort order inside the day).
        const byDay = new Map(x.days.map((d) => [d.day, []]));
        for (const ei of list) byDay.get(events[ei].day)?.push(ei);
        if (pendingDay) { // make sure the requested day is rendered
          let before = 0;
          for (const [day, evs] of byDay) { if (day === pendingDay) break; before += evs.length; }
          if (before >= eventsShown) eventsShown = before + EVENTS_PAGE;
        }
        let shown = 0;
        for (const d of x.days) {
          const evs = byDay.get(d.day);
          if (!evs.length || shown >= eventsShown) continue;
          html += dayHeadHTML(d, evs);
          for (const ei of evs) { if (shown++ >= eventsShown) break; html += eventHTML(ei); }
        }
      } else for (const ei of list.slice(0, eventsShown)) html += eventHTML(ei);
      if (list.length > eventsShown) {
        html += `<button class="more" id="moreEvents">Show ${fmt(Math.min(EVENTS_PAGE, list.length - eventsShown))} more (${fmt(list.length - eventsShown)} remaining)</button>`;
      }
    }
    $("main").innerHTML = html;
  }

  // A day inside the week view: heading with its counts and its own Approve.
  function dayHeadHTML(d, evs) {
    let hi = 0;
    for (const ei of evs) if (events[ei].risk.level === "high" && ReviewStore.summarize(events[ei].rows).state !== "approved") hi++;
    return `<div class="day-head" id="dh-${esc(d.day)}">
      <b title="${fmt(evs.length)} event(s)">${esc(dayLabelLong(d.day))}</b>${hi ? `<span class="hi" title="${fmt(hi)} High-risk event(s) not yet approved">${fmt(hi)}</span>` : ""}${reviewMark(d)}
      <span class="spacer"></span>
      <button class="small" data-act="approve-scope" data-g="${esc(d.key)}" title="Approve the ${fmt(evs.length)} event(s) of this day${anyFilter() ? " that match the current filters" : ""}">✓ Approve day</button>
    </div>`;
  }

  // Routine automated events (exact pattern seen before) that nobody has approved or denied yet.
  const routineOpen = (list) => list.filter((ei) => {
    if (!events[ei].risk.routine) return false;
    const st = ReviewStore.summarize(events[ei].rows);
    return st.state !== "approved" && !st.denied;
  });
  function approveRoutine() {
    const list = routineOpen(currentEventList());
    if (!list.length) { toast("No routine automated events left to approve here."); return; }
    const ids = [];
    for (const ei of list) for (const r of events[ei].rows) ids.push(r);
    const where = scopeTitle() + (anyFilter() ? " (matching the current search / risk filter)" : "");
    if (!confirm(`Approve ${fmt(list.length)} routine automated event(s) in ${where}? (${fmt(ids.length)} field changes)\n\nOnly automated events whose exact pattern has run before are included. New automations, pattern changes, script / workflow edits and events with a denial are left for you.`)) return;
    ReviewStore.setStatus(ids, ReviewStore.APPROVED);
    toast(`✓ Approved ${fmt(list.length)} routine automated event(s) in ${esc(scopeTitle())}.`);
  }

  function setScopeStatus(key, value) {
    const x = scope(key);
    if (!x) return;
    const idx = anyFilter() ? x.events.filter(passes) : x.events;
    const ids = [];
    for (const ei of idx) for (const r of events[ei].rows) ids.push(r);
    const name = scopeTitle(key) + (anyFilter() ? " (matching the current search / risk filter)" : "");
    if (!confirm(`Approve ${fmt(idx.length)} event(s) in ${name}? (${fmt(ids.length)} field changes)`)) return;
    const changed = ReviewStore.setStatus(ids, value);
    toast(`✓ Approved ${fmt(changed)} row(s) in ${esc(scopeTitle(key))}.${nextLinkHTML(key)}`);
  }

  // "Next day / week / month to review ›" link shown after approving a whole scope.
  function nextLinkHTML(key) {
    const k = scopeKind(key);
    if (k !== "day" && k !== "week" && k !== "month") return "";
    const nx = nextPending(key);
    return nx ? ` <a class="jump" data-act="open-scope" data-g="${esc(nx.key)}">Next ${k} to review: ${esc(shortLabel(nx))} ›</a>` : ` All later ${k}s are approved.`;
  }

  let fileFp = ""; // identifies the loaded file; ReviewStore keys saved review state by it

  // Open the event (expanding the list if needed) and scroll to it.
  function jumpToEvent(ei) {
    if (!passes(ei)) { toast("That event is hidden by the current search / risk filter — clear the filter to see it."); return; }
    let list = view === "grouped" ? currentEventList() : [];
    if (view !== "grouped") setView("grouped");
    if (list.indexOf(ei) < 0 || scopeKind() === "month") { // open the event's week
      selectScope(WEEK_PREFIX + events[ei].week); pendingDay = null; render(); list = currentEventList();
    }
    const idx = list.indexOf(ei);
    if (idx < 0) { toast("That event isn't in the current list."); return; }
    if (idx >= eventsShown) { eventsShown = list.length; renderGrouped(); } // (week view renders by day, so show the whole list)
    const det = document.querySelector(`details.event[data-e="${ei}"]`);
    if (!det) return;
    det.open = true; fillEvent(det);
    det.scrollIntoView({ block: "center" });
    det.classList.add("flash"); setTimeout(() => det.classList.remove("flash"), 1200);
  }

  // ---------- Export (Scope 5) ----------
  const EXPORT_STATUSES = ["Approved", "Pending", "Denied"];
  const EXPORT_WIDTHS = [18, 10, 15, 21, 33, 11, 50, 10, 45, 35, 35, 10, 12, 14, 50]; // like the input file
  const NO_NAME = "(no name)";

  function caseStatus(i) {
    const s = ReviewStore.getStatus(i);
    return s === ReviewStore.APPROVED ? "Approved" : s === ReviewStore.DENIED ? "Denied" : "Pending";
  }

  function openExport() {
    if (!rows.length) return;
    const users = new Map(), status = { Approved: 0, Pending: 0, Denied: 0 };
    let min = "", max = "";
    for (let i = 0; i < rows.length; i++) {
      const u = rows[i][C.Name] || NO_NAME;
      users.set(u, (users.get(u) || 0) + 1);
      status[caseStatus(i)]++;
      const d = rowKey[i].slice(0, 10);
      if (d) { if (!min || d < min) min = d; if (!max || d > max) max = d; }
    }
    $("exFrom").value = min; $("exTo").value = max;
    $("exFrom").dataset.min = min; $("exTo").dataset.max = max;
    $("exUsers").innerHTML = [...users].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([u, n]) => `<label><input type="checkbox" data-user="${esc(u)}" checked> ${esc(u)} <span class="n">${fmt(n)}</span></label>`).join("");
    $("exStatus").innerHTML = EXPORT_STATUSES
      .map((s) => `<label><input type="checkbox" data-status="${s}" checked> ${s}${s === "Pending" ? " (not reviewed)" : ""} <span class="n">${fmt(status[s])}</span></label>`).join("");
    $("exComments").checked = false;
    $("exportPanel").hidden = false;
    updateExportCount();
  }
  function closeExport() { $("exportPanel").hidden = true; }

  // Row indices matching the dialog (original file order).
  function exportSelection() {
    const from = $("exFrom").value, to = $("exTo").value;
    const users = new Set([...$("exUsers").querySelectorAll("input:checked")].map((x) => x.dataset.user));
    const statuses = new Set([...$("exStatus").querySelectorAll("input:checked")].map((x) => x.dataset.status));
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const d = rowKey[i].slice(0, 10);
      if (d) { if ((from && d < from) || (to && d > to)) continue; }
      else if (from || to) continue; // rows without a readable date only when no period is set
      if (!users.has(rows[i][C.Name] || NO_NAME)) continue;
      if (!statuses.has(caseStatus(i))) continue;
      out.push(i);
    }
    return out;
  }

  function updateExportCount() {
    const from = $("exFrom").value, to = $("exTo").value;
    const el = $("exCount");
    if (from && to && from > to) { el.textContent = "“From” is after “To”."; el.className = "meta bad"; $("exGo").disabled = true; return; }
    const n = exportSelection().length;
    el.textContent = n ? `${fmt(n)} row(s) will be exported.` : "No rows match — adjust the filters.";
    el.className = n ? "meta" : "meta bad";
    $("exGo").disabled = !n;
  }

  async function doExport() {
    const idx = exportSelection();
    if (!idx.length) return;
    const withComments = $("exComments").checked;
    const header = [...COLS, "Case Status", ...(withComments ? ["Review Comments"] : [])];
    const data = idx.map((i) => {
      const r = [...rows[i], caseStatus(i)];
      if (withComments) r.push(ReviewStore.commentsFor([i]).map((c) => `${c.text} (${new Date(c.at).toLocaleString()})`).join(" | "));
      return r;
    });
    const btn = $("exGo");
    btn.disabled = true; btn.textContent = "Exporting…";
    await new Promise((r) => setTimeout(r, 20)); // let the button repaint
    try {
      const blob = await XlsxWriter.build({
        sheetName: "System Notes", header, rows: data, widths: EXPORT_WIDTHS,
        numericCols: [C["Record ID"], C["Line Id"], C["Line Transaction Id"]], statusCol: COLS.length,
      });
      const from = $("exFrom").value || "start", to = $("exTo").value || "end";
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `system_notes_review_${from}_to_${to}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      closeExport();
      toast(`Exported ${fmt(idx.length)} row(s) to ${esc(a.download)}`);
    } catch (e) {
      toast(`Export failed: ${esc(e.message || String(e))}`);
    } finally {
      btn.disabled = false; btn.textContent = "Export .xlsx";
    }
  }

  // ---------- Risk Rules panel: the editable, deterministic standard ----------
  const RULE_FIELDS = [
    ["manualContexts", "Manual contexts", "Exact context names that mean a person made the change. Every other context (and a blank one) is automated."],
    ["roleRecordTypes", "Role / access record types → High", "A manual change to one of these is High."],
    ["roleFields", "Role / access fields → High", "A manual change to one of these fields is High, on any record type."],
    ["financialRecordTypes", "Financial record types → High", "A manual change to one of these is High."],
    ["financialFields", "Financial fields → High", "A manual change to one of these fields is High, on any record type."],
    ["automationRecordTypes", "Automation record types → Medium", "Manual edits to these, and routine automated runs that change them, are Medium (not bulk-approvable)."],
  ];
  const RULE_NAME = Object.fromEntries(RULE_FIELDS.map(([k, label]) => [k, label.replace(/ →.*$/, "")]));
  const countsLine = (n) => `${fmt(n.high)} High · ${fmt(n.medium)} Medium · ${fmt(n.low)} Low · ${fmt(n.routine)} routine automated`;
  const arrow = (a, b) => (a === b ? fmt(a) : `${fmt(a)} → <b>${fmt(b)}</b>`);
  const diffLine = (a, b) => `High ${arrow(a.high, b.high)} · Medium ${arrow(a.medium, b.medium)} · Low ${arrow(a.low, b.low)} · routine ${arrow(a.routine, b.routine)}`;

  function openRules(note = "", focus = null) {
    const r = RiskRules.get();
    $("rulesMeta").textContent = RiskRules.isDefault() ? "· default" : `· edited · ${RiskRules.id()}`;
    $("rulesBody").innerHTML = `
      <p>Every event gets a level from two rules (see <i>design_process.md</i>). Same file + same rules = same levels; nothing leaves this page.
      Each list entry matches any word that <b>starts with</b> it, not case-sensitive (“approv” matches “Approver 2”). One entry per line.</p>
      <form id="rulesForm" class="rules-form">
        <h4>1 · Manual events</h4>
        ${RULE_FIELDS.map(([k, label, hint]) => `<label>${esc(label)}<span class="hint">${esc(hint)}</span><textarea data-k="${k}" rows="${Math.min(6, Math.max(2, r[k].length))}" spellcheck="false">${esc(r[k].join("\n"))}</textarea></label>`).join("")}
        <h4>2 · Automated events <span class="meta">(not editable)</span></h4>
        <p class="std-meta">A <b>job</b> is user + context + record type; its <b>pattern</b> is the set of fields one save changes. <b>High</b>: a new job, or the job changes a field it never changed before. <b>Medium</b>: a new combination of its usual fields. <b>Low · routine</b>: the exact pattern has run before (✓ Approve routine automated).</p>
        <h4>Notes</h4>
        <label>“Many fields in one save” threshold<span class="hint">Listed as a reason and sorts the event higher inside its level; doesn't change the level.</span><input type="number" data-k="manyFields" min="2" step="1" value="${r.manyFields}"></label>
        <div class="row">
          <button type="button" class="small" data-act="rules-preview" ${events.length ? "" : "disabled"} title="Show what these rules would change in this file, without saving">Preview</button>
          <button type="submit" class="small primary">Save &amp; re-rate</button>
          <span class="spacer"></span>
          <button type="button" class="small" data-act="rules-reset" ${RiskRules.isDefault() ? "disabled" : ""}>Reset to default</button>
        </div>
        <div id="rulesNote" class="std-meta">${note}</div>
      </form>
      ${events.length ? `<div class="std-meta">This file now: ${countsLine(riskCounts())} · ${fmt(riskCounts().manual)} manual.</div>` : `<div class="std-meta">Load a file to see the counts.</div>`}`;
    $("stdPanel").hidden = false;
    if (focus) focusRule(focus);
  }
  // Open the panel at the list (and entry) that matched an event, so a false positive is one edit away.
  function focusRule({ list: key, entries, value }) {
    const ta = $("rulesForm").querySelector(`textarea[data-k="${key}"]`);
    if (!ta) return;
    const label = ta.closest("label");
    label.classList.add("focus");
    label.scrollIntoView({ block: "center" });
    const lines = ta.value.split("\n"), want = (entries[0] || "").toLowerCase();
    const i = lines.findIndex((l) => l.toLowerCase() === want);
    ta.focus();
    if (i >= 0) { const start = lines.slice(0, i).reduce((n, l) => n + l.length + 1, 0); ta.setSelectionRange(start, start + lines[i].length); }
    $("rulesNote").innerHTML = `This event matched <b>${esc(entries.join(", ") || "—")}</b> in <b>${esc(RULE_NAME[key])}</b> (value: “${esc(value)}”). Remove or reword the entry, then Preview or Save &amp; re-rate.`;
  }
  function closeRules() { $("stdPanel").hidden = true; }

  function rulesFormValues() {
    const x = {};
    $("rulesForm").querySelectorAll("[data-k]").forEach((el) => { x[el.dataset.k] = el.dataset.k === "manyFields" ? el.value : el.value.split("\n"); });
    return RiskRules.clean(x);
  }
  function previewRules() {
    if (!events.length) return;
    const next = assessWith(rulesFormValues());
    $("rulesNote").innerHTML = `Preview (not saved): ${diffLine(riskCounts(), riskCounts((i) => next.get(i)))}`;
  }
  function saveRules(rules) {
    const before = events.length ? riskCounts() : null;
    RiskRules.set(rules);
    if (events.length) { applyRisk(); render(); }
    const note = before ? `Saved and re-rated: ${diffLine(before, riskCounts())}. Approvals and comments are unchanged.` : "Saved. They apply when you load a file.";
    openRules(note);
    toast("Risk rules saved.");
  }

    function eventHTML(ei) {
    const e = events[ei];
    const hits = eventHits(e);
    const ctx = [...e.contexts].map((c) => `<span class="pill ${c === "UI" ? "ctx-ui" : ""}">${highlight(c)}</span>`).join(" ");
    const showName = `<span class="pill">${highlight(e.name)}</span>`;
    const st = ReviewStore.summarize(e.rows);
    return `<details class="event st-${st.state}" data-e="${ei}">
      <summary>
        ${riskBadge(e.risk)}${originPill(e.risk)}
        <span class="time">${esc(e.date)}</span>
        ${scopeKind() === "all" ? `<a class="jump where" data-act="open-scope" data-g="${esc(DAY_PREFIX + e.day)}" title="Open ${esc(dayLabelLong(e.day))} (${esc(weekLabel(scope(WEEK_PREFIX + e.week)))})">${esc(dayLabel(e.day))} ›</a>` : ""}
        ${showName}
        <span class="rtype">${highlight(e.rtype || "(no record type)")}</span>
        <span class="rec" title="${esc(e.record || "")}">${highlight(e.record || "(no name)")}</span>
        <span class="rtype">#${highlight(e.rid)}</span>
        ${ctx}
        <span class="pill">${e.rows.length} change${e.rows.length === 1 ? "" : "s"}</span>
        ${hits ? `<span class="pill hits">${hits} match${hits === 1 ? "" : "es"}</span>` : ""}
        <span class="spacer"></span>
        <span class="actions" data-ctl="${ei}">${eventControlsHTML(ei, st)}</span>
      </summary>
      <div class="changes"></div>
    </details>`;
  }

  // ---------- Risk UI (Scope 3) ----------
  function riskBadge(risk) {
    const tip = risk.reasons.length ? risk.reasons.map((r) => "• " + r.text).join("\n") : "No risk indicators";
    return `<span class="pill risk-${risk.level}" title="${esc(tip)}">${risk.label}</span>`;
  }

  function originPill(risk) {
    const t = risk.origin === "manual" ? "Manual" : risk.routine ? "Auto · routine" : "Auto";
    const tag = risk.routine ? "routine" : risk.origin;
    return ` <span class="pill origin-${risk.origin}${risk.routine ? " routine" : ""} rule-link" data-act="rule-filter" data-tag="${tag}" title="${risk.origin === "manual" ? "Made by a person (UI)" : "Made by an automation (script, import, mass update, system)"}. Click: show only rule:${tag} events">${t}</span>`;
  }

  function riskPanelHTML(risk) {
    if (!risk.reasons.length) return `<div class="why low">No risk indicators.</div>`;
    const icon = { role: "Access", money: "Money", pattern: "Pattern", automation: "Script", manual: "Manual", routine: "Routine", size: "Size", history: "History" };
    const lead = `Why ${esc(risk.label.toLowerCase())} risk:`;
    const tagOf = (r) => r.kind === "pattern" ? (risk.pattern === "new-job" ? "new-automation" : "pattern-change")
      : r.kind === "history" ? (/^Reverted/.test(r.text) ? "reverted" : "edited-later") : { role: "role", money: "financial", automation: "script", routine: risk.routine ? "routine" : null, manual: "manual", size: "many-fields" }[r.kind];
    return `<div class="why ${risk.level}"><b>${lead}</b><ul>${risk.reasons.map((r) => { const t = tagOf(r);
      const edit = (r.rules || []).map((x) => `<a class="jump edit-rule" data-act="edit-rule" data-list="${x.list}" data-entries="${esc(x.entries.join("\u0001"))}" data-value="${esc(x.value)}" title="Open Risk Rules at “${esc(RULE_NAME[x.list])}”, where “${esc(x.entries.join(", "))}” matched">Edit rule</a>`).join(" ");
      return `<li><span class="tag${t ? " rule-link" : ""}"${t ? ` data-act="rule-filter" data-tag="${t}" title="Show only rule:${t} events"` : ""}>${icon[r.kind] || "Note"}</span> ${esc(r.text)} ${edit}</li>`; }).join("")}</ul></div>`;
  }

  // ---------- Review UI (talks to ReviewStore only through row IDs) ----------
  function statusPill(st) {
    return `<span class="pill st-${st.state}">${esc(st.label)}</span>`;
  }

  function eventControlsHTML(ei, st = ReviewStore.summarize(events[ei].rows)) {
    const n = ReviewStore.commentsFor(events[ei].rows).length;
    return `${statusPill(st)}
      <button class="small act-approve ${st.state === "approved" ? "on" : ""}" data-act="approve" data-e="${ei}" title="${st.state === "approved" ? "Click again to undo" : "Approve this event"}">✓ Approve</button>
      <button class="small act-deny ${st.state === "denied" ? "on" : ""}" data-act="deny" data-e="${ei}" title="${st.state === "denied" ? "Click again to undo" : "Deny this event"}">✗ Deny</button>
      <button class="small act-note" data-act="note" data-e="${ei}" title="Comments">Comment${n ? `<span class="n">${n}</span>` : ""}</button>`;
  }

  function reviewPanelHTML(ei) {
    const e = events[ei];
    const list = ReviewStore.commentsFor(e.rows);
    let html = `<h4>Comments (${list.length})</h4>`;
    for (const c of list) {
      const partial = c.rows.length !== e.rows.length || c.rows.some((r) => !e.rows.includes(r));
      html += `<div class="comment">
        <div class="body">${esc(c.text)}${partial ? `<div class="scope">Applies to ${fmt(c.rows.length)} row(s)${c.rows.length > e.rows.length ? " — added on a wider selection" : ""}</div>` : ""}</div>
        <span class="when">${esc(new Date(c.at).toLocaleString())}</span>
        <button class="icon" data-act="del-comment" data-c="${c.id}" title="Delete comment">✕</button>
      </div>`;
    }
    html += `<textarea data-input="${ei}" placeholder="Add a comment — e.g. why this was denied, or what needs follow-up… (Ctrl+Enter to save)"></textarea>
      <div class="row"><button class="small primary" data-act="save-comment" data-e="${ei}">Save comment</button></div>`;
    return html;
  }

  // Refresh only the review bits of what's on screen (keeps expanded events and scroll position).
  function refreshReviewUI() {
    renderProgress();
    renderSidebar();
    if (view === "table") {
      const top = document.querySelector(".rawtable")?.scrollTop || 0;
      renderTable();
      const t = document.querySelector(".rawtable");
      if (t) t.scrollTop = top;
      return;
    }
    const k = scopeKind();
    if (k === "month") { renderGrouped(); return; } // the weeks table shows review progress
    // Week / All activity: refresh the headings in place, so open events stay open.
    const list = currentEventList();
    const gh = document.querySelector(".group-head");
    if (gh) gh.outerHTML = scopeHeaderHTML(list, k === "week" ? "week" : "all");
    if (k === "week") document.querySelectorAll(".day-head").forEach((h) => {
      const d = scope(DAY_PREFIX + h.id.slice(3));
      if (d) h.outerHTML = dayHeadHTML(d, list.filter((ei) => events[ei].day === d.day));
    });
    document.querySelectorAll("details.event").forEach((det) => {
      const ei = +det.dataset.e;
      const st = ReviewStore.summarize(events[ei].rows);
      det.className = `event st-${st.state}`;
      det.querySelector("[data-ctl]").innerHTML = eventControlsHTML(ei, st);
      const panel = det.querySelector(".review");
      if (panel) {
        const draft = panel.querySelector("textarea")?.value || "";
        panel.innerHTML = reviewPanelHTML(ei);
        panel.querySelector("textarea").value = draft;
      }
    });
  }

  function toggleEventStatus(ei, target) {
    const e = events[ei];
    const st = ReviewStore.summarize(e.rows);
    const already = (target === ReviewStore.APPROVED && st.state === "approved") || (target === ReviewStore.DENIED && st.state === "denied");
    ReviewStore.setStatus(e.rows, already ? ReviewStore.NONE : target);
    if (target === ReviewStore.DENIED && !already && !ReviewStore.commentsFor(e.rows).length) {
      openComment(ei, "Denied — please add a reason.");
    }
  }

  function openComment(ei, hint) {
    const det = document.querySelector(`details.event[data-e="${ei}"]`);
    if (!det) return;
    det.open = true;
    fillEvent(det);
    const ta = det.querySelector(`textarea[data-input="${ei}"]`);
    if (ta) { ta.focus(); ta.scrollIntoView({ block: "nearest" }); }
    if (hint) toast(esc(hint));
  }

  function saveComment(ei) {
    const ta = document.querySelector(`textarea[data-input="${ei}"]`);
    if (!ta || !ta.value.trim()) { toast("Write a comment first."); return; }
    const text = ta.value;
    ta.value = "";
    ReviewStore.addComment(events[ei].rows, text);
  }

  function setListStatus(value) {
    const list = currentEventList();
    const ids = [];
    for (const ei of list) for (const r of events[ei].rows) ids.push(r);
    const verb = value === ReviewStore.APPROVED ? "Approve" : "Reset";
    let scope = match ? ` matching “${query}”` : "";
    if (riskFiltered()) scope += ` with ${[...riskFilter].map((l) => RiskEngine.LABEL[l]).join(" / ")} risk`;
    if (ruleQuery.length) scope += ` labelled ${ruleQuery.map((alts) => alts.map((id) => RiskEngine.TAGS.find((t) => t.id === id).label).join(" or ")).join(" + ")}`;
    if (statusQuery) scope += ` (status ${[...statusQuery].join(" / ")})`;
    if (!confirm(`${verb} ${fmt(list.length)} event(s)${scope} (${fmt(ids.length)} field changes)?`)) return;
    const changed = ReviewStore.setStatus(ids, value);
    toast(`${value === ReviewStore.APPROVED ? "✓ Approved" : "↺ Reset"} ${fmt(changed)} row(s).${value === ReviewStore.APPROVED ? nextLinkHTML(selectedGroup) : ""}`);
  }

  // Field-change table is built only when an event is expanded (keeps the DOM small for 100k rows).
  function fillEvent(det) {
    const box = det.querySelector(".changes");
    if (box.dataset.filled) return;
    const e = events[+det.dataset.e];
    const hasLine = e.rows.some((i) => rows[i][C["Line Id"]] || rows[i][C["Line Transaction Id"]]);
    let html = `<table><thead><tr><th>Type</th><th>Field</th><th>Old value</th><th>New value</th>${hasLine ? "<th>Line Id</th><th>Line Txn Id</th>" : ""}<th>Role</th></tr></thead><tbody>`;
    html = riskPanelHTML(e.risk) + html;
    for (const i of e.rows) {
      const r = rows[i];
      const risky = e.risk.riskyRows.has(i);
      html += `<tr class="${match && match[i] ? "hit" : ""} ${risky ? "risky" : ""}">
        <td class="type-${esc(r[C.Type])}">${highlight(r[C.Type])}</td>
        <td>${risky ? `<span title="Field the risk rule flagged">⚠ </span>` : ""}${highlight(r[C.Field])}</td>
        <td class="val old">${highlight(r[C["Old Value"]])}</td>
        <td class="val new">${highlight(r[C["New Value"]])}</td>
        ${hasLine ? `<td>${highlight(r[C["Line Id"]])}</td><td>${highlight(r[C["Line Transaction Id"]])}</td>` : ""}
        <td>${highlight(r[C.Role])}</td>
      </tr>`;
    }
    html += `</tbody></table>
      <div class="review">${reviewPanelHTML(+det.dataset.e)}</div>`;
    box.innerHTML = html;
    box.dataset.filled = "1";
  }

  function renderTable() {
    const idx = [];
    for (let i = 0; i < rows.length; i++) if ((!match || match[i]) && riskFilter.has(events[rowEvent[i]].risk.level) && passesRules(rowEvent[i])) idx.push(i);
    const pages = Math.max(1, Math.ceil(idx.length / TABLE_PAGE));
    tablePage = Math.min(tablePage, pages - 1);
    const start = tablePage * TABLE_PAGE;
    const pager = `<div class="pager">
      <button class="small" data-page="first" ${tablePage === 0 ? "disabled" : ""}>« First</button>
      <button class="small" data-page="prev" ${tablePage === 0 ? "disabled" : ""}>‹ Prev</button>
      <span>Page ${fmt(tablePage + 1)} of ${fmt(pages)} · rows ${fmt(idx.length ? start + 1 : 0)}–${fmt(Math.min(start + TABLE_PAGE, idx.length))} of ${fmt(idx.length)}</span>
      <button class="small" data-page="next" ${tablePage >= pages - 1 ? "disabled" : ""}>Next ›</button>
      <button class="small" data-page="last" ${tablePage >= pages - 1 ? "disabled" : ""}>Last »</button>
    </div>`;
    let html = `<div class="group-head"><h2>All rows</h2><span class="meta">Raw log in file order</span></div>${pager}
      <div class="rawtable"><table><thead><tr><th>#</th><th title="Risk of the event this row belongs to">Risk</th>${COLS.map((c) => `<th>${esc(c)}</th>`).join("")}<th>Status</th></tr></thead><tbody>`;
    for (const i of idx.slice(start, start + TABLE_PAGE)) {
      const st = ReviewStore.summarize([i]);
      const nc = ReviewStore.commentsFor([i]).length;
      const risk = events[rowEvent[i]].risk;
      html += `<tr class="${risk.riskyRows.has(i) ? "risky" : ""}"><td><a class="jump" data-act="jump" data-e="${rowEvent[i]}" title="Open this row's event in its day (Grouped view)">${i + 1}</a></td><td>${riskBadge(risk)}</td>${rows[i].map((v) => `<td title="${esc(v)}">${highlight(v)}</td>`).join("")}
        <td>${statusPill(st)}${nc ? ` <span class="pill" title="${nc} comment(s) — open in Grouped view">Notes ${nc}</span>` : ""}
          <button class="icon act-approve ${st.state === "approved" ? "on" : ""}" data-act="row-approve" data-r="${i}" title="Approve row">✓</button>
          <button class="icon act-deny ${st.state === "denied" ? "on" : ""}" data-act="row-deny" data-r="${i}" title="Deny row">✗</button></td></tr>`;
    }
    html += `</tbody></table></div>${pager}`;
    $("main").innerHTML = html;
  }

  // ---------- Events ----------
  // Search column options
  COLS.forEach((c, i) => $("searchCol").insertAdjacentHTML("beforeend", `<option value="${i}">${esc(c)}</option>`));

  // Drag & drop anywhere on the page
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; document.body.classList.add("dragging"); });
  window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragging"); } });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault(); dragDepth = 0; document.body.classList.remove("dragging");
    const f = e.dataTransfer.files[0];
    if (!f) return;
    if ($("dropzone").style.display === "none") showDropzone();
    handleFile(f);
  });

  $("browse").addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", (e) => { handleFile(e.target.files[0]); e.target.value = ""; });

  function showDropzone() {
    $("app").style.display = "none";
    $("toolbar").style.display = "none";
    $("dropzone").style.display = "flex";
    $("error").textContent = "";
  }
  $("loadAnother").addEventListener("click", showDropzone);

  let searchTimer;
  $("search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 250); });
  $("searchCol").addEventListener("change", runSearch);
  $("clearSearch").addEventListener("click", () => { $("search").value = ""; runSearch(); });
  $("ruleChips").addEventListener("click", (e) => {
    const v = e.target.closest("[data-view]");
    if (v) { applyView(v.dataset.view); return; }
    const c = e.target.closest("[data-rule]");
    if (c) toggleRule(c.dataset.rule);
  });

  // Export (Scope 5)
  $("exportBtn").addEventListener("click", openExport);
  $("exCancel").addEventListener("click", closeExport);
  $("exGo").addEventListener("click", doExport);
  $("exportPanel").addEventListener("click", (e) => {
    if (e.target.id === "exportPanel") { closeExport(); return; }
    const all = e.target.closest("[data-ex-all]"), none = e.target.closest("[data-ex-none]");
    if (all || none) { $("exUsers").querySelectorAll("input").forEach((x) => (x.checked = !!all)); updateExportCount(); }
  });
  $("exportPanel").addEventListener("change", updateExportCount);
  $("exAllDates").addEventListener("click", () => { $("exFrom").value = $("exFrom").dataset.min || ""; $("exTo").value = $("exTo").dataset.max || ""; updateExportCount(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("exportPanel").hidden) closeExport(); });

  // Risk Rules panel
  $("stdBtn").addEventListener("click", () => ($("stdPanel").hidden ? openRules() : closeRules()));
  $("stdClose").addEventListener("click", closeRules);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("stdPanel").hidden) closeRules(); });
  $("stdPanel").addEventListener("submit", (e) => { if (e.target.id === "rulesForm") { e.preventDefault(); saveRules(rulesFormValues()); } });
  // The app no longer calls the Claude API: remove what earlier versions saved (incl. any API key).
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && /^systemNotesReview:(apiKey|aiAuto|riskStandard|monthReview:|labels:)/.test(k)) localStorage.removeItem(k);
    }
  } catch { /* storage unavailable */ }

  // Risk filter chips + sort (Scope 3)
  $("riskChips").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-risk]");
    if (!chip) return;
    const l = chip.dataset.risk;
    if (riskFilter.has(l)) {
      if (riskFilter.size === 1) { toast("At least one risk level must stay selected."); return; }
      riskFilter.delete(l);
    } else riskFilter.add(l);
    applyFilters();
  });
  $("sortMode").addEventListener("change", (e) => { sortMode = e.target.value; eventsShown = EVENTS_PAGE; render(); });

  $("tabGrouped").addEventListener("click", () => { setView("grouped"); render(); });
  $("tabTable").addEventListener("click", () => { setView("table"); render(); });

  $("sidebar").addEventListener("click", (e) => {
    const el = e.target.closest("[data-g]");
    if (!el) return;
    const key = el.dataset.g, kind = scopeKind(key), x = scope(key);
    // The caret only shows / hides the children (peek at weeks or days without opening the level).
    if (e.target.closest("[data-toggle]")) { toggleExpand(key); renderSidebar(); focusTree(key); return; }
    // clicking the already-selected month / week collapses it; otherwise select (and expand) it
    if (kind === "month" && selectedGroup === key && expandedMonths.has(x.month)) { expandedMonths.delete(x.month); renderSidebar(); return; }
    goScope(key);
    focusTree(key);
  });

  function toggleExpand(key, force) {
    const kind = scopeKind(key), x = scope(key);
    const set = kind === "month" ? expandedMonths : null; // weeks are leaves: their days are headings in the week view
    if (!set) return false;
    const id = kind === "month" ? x.month : x.id, open = set.has(id);
    if (force === open) return false;
    open ? set.delete(id) : set.add(id);
    return true;
  }
  function focusTree(key) { [...$("sidebar").querySelectorAll(".tree")].find((t) => t.dataset.g === key)?.focus(); }

  // Tree keyboard: Up/Down move, Right expands / goes to first child, Left collapses / goes to parent, Enter opens.
  $("sidebar").addEventListener("keydown", (e) => {
    const el = e.target.closest(".tree");
    if (!el) return;
    const items = [...$("sidebar").querySelectorAll(".tree")], i = items.indexOf(el), key = el.dataset.g;
    const move = (to) => { if (!to) return; items.forEach((t) => t.tabIndex = -1); to.tabIndex = 0; to.focus(); };
    switch (e.key) {
      case "ArrowDown": move(items[i + 1]); break;
      case "ArrowUp": move(items[i - 1]); break;
      case "Home": move(items[0]); break;
      case "End": move(items[items.length - 1]); break;
      case "ArrowRight":
        if (el.getAttribute("aria-expanded") === "false") { toggleExpand(key, true); renderSidebar(); focusTree(key); }
        else if (el.getAttribute("aria-expanded") === "true") move(items[i + 1]);
        break;
      case "ArrowLeft":
        if (el.getAttribute("aria-expanded") === "true") { toggleExpand(key, false); renderSidebar(); focusTree(key); }
        else { const pk = parentKey(key); if (pk) focusTree(pk); }
        break;
      case "Enter": case " ": goScope(key); focusTree(key); break;
      default: return;
    }
    e.preventDefault();
  });

  // Page shortcuts (not while typing): U = up a level, [ / ] = previous / next on the same level, N = next to review.
  document.addEventListener("keydown", (e) => {
    if (!rows.length || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest?.("input, textarea, select, [contenteditable]") || !$("exportPanel").hidden) return;
    const k = scopeKind();
    if (e.key === "u" || e.key === "U") { if (k && k !== "all") goScope(parentKey()); }
    else if (e.key === "[" || e.key === "]") { const s = siblingOf(selectedGroup, e.key === "[" ? -1 : 1); if (s) goScope(s.key); }
    else if (e.key === "n" || e.key === "N") {
      if (k === "all" || !k) return;
      const s = nextPending(selectedGroup);
      s ? goScope(s.key) : toast(`No later ${k} left to review.`);
    } else return;
    e.preventDefault();
  });

  // Delegated clicks: WIP buttons, "show more", pager
  document.addEventListener("click", (e) => {
    const w = e.target.closest("[data-wip]");
    if (w) { e.preventDefault(); e.stopPropagation(); wip(w.dataset.wip); return; }
    const act = e.target.closest("[data-act]");
    if (act && !act.disabled) {
      e.preventDefault(); e.stopPropagation(); // don't toggle the <details> when clicking buttons in its summary
      const ei = +act.dataset.e, ri = +act.dataset.r;
      switch (act.dataset.act) {
        case "approve": toggleEventStatus(ei, ReviewStore.APPROVED); break;
        case "deny": toggleEventStatus(ei, ReviewStore.DENIED); break;
        case "note": openComment(ei); break;
        case "save-comment": saveComment(ei); break;
        case "del-comment": if (confirm("Delete this comment?")) ReviewStore.deleteComment(+act.dataset.c); break;
        case "approve-list": setListStatus(ReviewStore.APPROVED); break;
        case "approve-routine": approveRoutine(); break;
        case "reset-list": setListStatus(ReviewStore.NONE); break;
        case "row-approve": ReviewStore.setStatus([ri], ReviewStore.getStatus(ri) === ReviewStore.APPROVED ? ReviewStore.NONE : ReviewStore.APPROVED); break;
        case "row-deny": ReviewStore.setStatus([ri], ReviewStore.getStatus(ri) === ReviewStore.DENIED ? ReviewStore.NONE : ReviewStore.DENIED); break;
        case "jump": jumpToEvent(ei); break;
        case "open-scope": goScope(act.dataset.g); break;
        case "approve-scope": setScopeStatus(act.dataset.g, ReviewStore.APPROVED); break;
        case "open-rules": openRules(); break;
        case "rule-filter": if (!ruleTokenOn(act.dataset.tag)) toggleRule(act.dataset.tag); break;
        case "edit-rule": openRules("", { list: act.dataset.list, entries: act.dataset.entries ? act.dataset.entries.split("\u0001") : [], value: act.dataset.value }); break;
        case "rules-preview": previewRules(); break;
        case "rules-reset": if (confirm("Put back the default risk rules and re-rate every event?")) saveRules(RiskRules.DEFAULT); break;
      }
      return;
    }
    if (e.target.id === "moreEvents") { eventsShown += EVENTS_PAGE; renderGrouped(); return; }
    const p = e.target.closest("[data-page]");
    if (p && !p.disabled) {
      const a = p.dataset.page;
      if (a === "first") tablePage = 0;
      if (a === "prev") tablePage--;
      if (a === "next") tablePage++;
      if (a === "last") tablePage = 1e9;
      renderTable();
      document.querySelector(".rawtable").scrollTop = 0;
    }
  }, true);

  // Ctrl/Cmd+Enter saves a comment
  $("main").addEventListener("keydown", (e) => {
    if (e.target.matches("textarea[data-input]") && e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      saveComment(+e.target.dataset.input);
    }
  });

  // Any review change (from any view) refreshes the review parts of the screen.
  // (null = store re-initialised for a new file; load() does a full render itself.)
  ReviewStore.onChange((rowIds) => { if (rowIds && rows.length) refreshReviewUI(); });
  window.addEventListener("beforeunload", () => ReviewStore.flush());

  // Lazily fill an event's change table when it is opened
  $("main").addEventListener("toggle", (e) => {
    if (e.target.matches && e.target.matches("details.event") && e.target.open) fillEvent(e.target);
  }, true);
})();
