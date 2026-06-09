// ============================================================================
//  HALAVELI GUEST DOCUMENT MANAGEMENT SYSTEM — server
// ============================================================================
const express = require("express");
const cookieParser = require("cookie-parser");
const path = require("path");
const fs = require("fs");
const os = require("os");

const { db, bcrypt, newToken, getTemplate, listTemplates, getSignatories, safeParse: dbSafeParse } = require("./db");
const P = require("./opera-parser");
const { generateDocx, convertToPdf } = require("./doc-generator");

const app = express();
const PORT = process.env.PORT || 3000;
const OUT_DIR = process.env.OUT_DIR || path.join(__dirname, "..", "data", "generated");
fs.mkdirSync(OUT_DIR, { recursive: true });

app.use(express.json({ limit: "20mb" }));
app.use(express.text({ limit: "20mb", type: ["text/plain", "text/tab-separated-values"] }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "..", "public")));

// ---- Auth middleware ------------------------------------------------------
function auth(req, res, next) {
  const token = req.cookies.sid;
  if (!token) return res.status(401).json({ error: "Not logged in" });
  const session = db.prepare("SELECT * FROM sessions WHERE token=?").get(token);
  if (!session) return res.status(401).json({ error: "Session expired" });
  req.user = db.prepare("SELECT id,username,display_name,role,can_manage_templates FROM users WHERE id=?").get(session.user_id);
  if (!req.user) return res.status(401).json({ error: "User gone" });
  req.user.can_manage_templates = !!req.user.can_manage_templates;
  next();
}
function adminOnly(req, res, next) {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });
  next();
}
function canManageTemplates(req, res, next) {
  if (req.user.role === "admin" || req.user.can_manage_templates) return next();
  return res.status(403).json({ error: "Not allowed to manage templates" });
}

// ============================================================================
//  AUTH
// ============================================================================
app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE username=?").get(String(username || "").trim());
  if (!user || !bcrypt.compareSync(String(password || ""), user.password_hash)) {
    return res.status(401).json({ error: "Invalid username or password" });
  }
  const token = newToken();
  db.prepare("INSERT INTO sessions (token,user_id) VALUES (?,?)").run(token, user.id);
  res.cookie("sid", token, { httpOnly: true, sameSite: "lax", maxAge: 1000 * 60 * 60 * 24 * 7 });
  res.json({ user: { username: user.username, display_name: user.display_name, role: user.role } });
});

app.post("/api/logout", auth, (req, res) => {
  db.prepare("DELETE FROM sessions WHERE token=?").run(req.cookies.sid);
  res.clearCookie("sid");
  res.json({ ok: true });
});

app.get("/api/me", auth, (req, res) => res.json({ user: req.user }));

// ---- User management (admin) ---------------------------------------------
app.get("/api/users", auth, adminOnly, (req, res) => {
  res.json(db.prepare("SELECT id,username,display_name,role,can_manage_templates,created_at FROM users ORDER BY id").all()
    .map((u) => ({ ...u, can_manage_templates: !!u.can_manage_templates })));
});
app.post("/api/users", auth, adminOnly, (req, res) => {
  const { username, password, display_name, role, can_manage_templates } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "username & password required" });
  try {
    const hash = bcrypt.hashSync(String(password), 10);
    const info = db.prepare(
      "INSERT INTO users (username,password_hash,display_name,role,can_manage_templates) VALUES (?,?,?,?,?)"
    ).run(String(username).trim(), hash, display_name || username,
      role === "admin" ? "admin" : "staff", can_manage_templates ? 1 : 0);
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: "Username already exists" });
  }
});
app.post("/api/users/:id/password", auth, adminOnly, (req, res) => {
  const hash = bcrypt.hashSync(String(req.body.password || ""), 10);
  db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(hash, req.params.id);
  res.json({ ok: true });
});
app.post("/api/users/:id/capabilities", auth, adminOnly, (req, res) => {
  const can = req.body.can_manage_templates ? 1 : 0;
  db.prepare("UPDATE users SET can_manage_templates=? WHERE id=?").run(can, req.params.id);
  res.json({ ok: true });
});
app.delete("/api/users/:id", auth, adminOnly, (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: "Can't delete yourself" });
  db.prepare("DELETE FROM users WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// ============================================================================
//  TEMPLATES  (now DB-backed + Template Builder)
// ============================================================================
// List templates for the guest panel / pickers (English by default).
app.get("/api/templates", auth, (req, res) => {
  const lang = req.query.lang || "en";
  res.json({
    templates: listTemplates(lang).map((t) => ({
      id: t.id, category: t.category, label: t.label, hasDate: t.hasDate,
      dateLabel: t.dateLabel || null, signatory: t.signatory,
    })),
    signatories: getSignatories(),
    canManage: req.user.role === "admin" || req.user.can_manage_templates,
  });
});

// Full template detail for the builder (includes body + all fields).
app.get("/api/templates/:key", auth, (req, res) => {
  const lang = req.query.lang || "en";
  const t = getTemplate(req.params.key, lang);
  if (!t) return res.status(404).json({ error: "Template not found" });
  res.json(t);
});

// Admin/manager list including archived + which languages exist per key.
app.get("/api/manage/templates", auth, canManageTemplates, (req, res) => {
  const lang = req.query.lang || "en";
  const rows = listTemplates(lang, true);
  // attach available languages per template_key
  const langs = {};
  db.prepare("SELECT template_key, lang FROM templates").all().forEach((r) => {
    (langs[r.template_key] = langs[r.template_key] || []).push(r.lang);
  });
  res.json({
    templates: rows.map((t) => ({ ...t, languages: langs[t.id] || ["en"] })),
    signatories: getSignatories(),
    categories: [...new Set(listTemplates(lang, true).map((t) => t.category))],
  });
});

function slugify(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40)
    || "tpl_" + Date.now();
}

// Create a new template (English base). Body fields validated lightly.
app.post("/api/manage/templates", auth, canManageTemplates, (req, res) => {
  const b = req.body || {};
  if (!b.label) return res.status(400).json({ error: "Label is required" });
  let key = b.template_key ? slugify(b.template_key) : slugify(b.label);
  // ensure uniqueness of key
  let base = key, n = 1;
  while (db.prepare("SELECT 1 FROM templates WHERE template_key=? AND lang='en'").get(key)) {
    key = base + "_" + (++n);
  }
  const maxOrder = db.prepare("SELECT COALESCE(MAX(sort_order),0) m FROM templates").get().m;
  db.prepare(`INSERT INTO templates
    (template_key,lang,category,label,intro,lead,body_json,closing,contact,note,
     signoff,signatory,has_date,date_label,top_date,sort_order,created_by)
    VALUES (@k,'en',@category,@label,@intro,@lead,@body,@closing,@contact,@note,
     @signoff,@signatory,@has_date,@date_label,@top_date,@order,@by)`).run({
    k: key, category: b.category || "General", label: b.label,
    intro: b.intro || "", lead: b.lead || "", body: JSON.stringify(b.body || []),
    closing: b.closing || "", contact: b.contact || "", note: b.note || "",
    signoff: b.signoff || "Warmest regards,", signatory: b.signatory || "silvia",
    has_date: b.hasDate ? 1 : 0, date_label: b.dateLabel || "",
    top_date: b.topDate ? 1 : 0, order: maxOrder + 1, by: req.user.id,
  });
  res.json({ template_key: key });
});

// Update an existing template (specific language row).
app.put("/api/manage/templates/:key", auth, canManageTemplates, (req, res) => {
  const lang = req.query.lang || "en";
  const b = req.body || {};
  const existing = db.prepare("SELECT * FROM templates WHERE template_key=? AND lang=?").get(req.params.key, lang);
  if (!existing) {
    // creating a translation row for an existing key
    const en = db.prepare("SELECT * FROM templates WHERE template_key=? AND lang='en'").get(req.params.key);
    if (!en) return res.status(404).json({ error: "Template not found" });
    db.prepare(`INSERT INTO templates
      (template_key,lang,category,label,intro,lead,body_json,closing,contact,note,
       signoff,signatory,has_date,date_label,top_date,sort_order,created_by)
      VALUES (@k,@lang,@category,@label,@intro,@lead,@body,@closing,@contact,@note,
       @signoff,@signatory,@has_date,@date_label,@top_date,@order,@by)`).run({
      k: req.params.key, lang, category: b.category || en.category, label: b.label || en.label,
      intro: b.intro || "", lead: b.lead || "", body: JSON.stringify(b.body || []),
      closing: b.closing || "", contact: b.contact || "", note: b.note || "",
      signoff: b.signoff || en.signoff, signatory: b.signatory || en.signatory,
      has_date: b.hasDate ? 1 : 0, date_label: b.dateLabel || "",
      top_date: b.topDate ? 1 : 0, order: en.sort_order, by: req.user.id,
    });
    return res.json({ ok: true, created: true });
  }
  db.prepare(`UPDATE templates SET
    category=@category,label=@label,intro=@intro,lead=@lead,body_json=@body,
    closing=@closing,contact=@contact,note=@note,signoff=@signoff,signatory=@signatory,
    has_date=@has_date,date_label=@date_label,top_date=@top_date,updated_at=datetime('now')
    WHERE template_key=@k AND lang=@lang`).run({
    k: req.params.key, lang, category: b.category ?? existing.category, label: b.label ?? existing.label,
    intro: b.intro ?? existing.intro, lead: b.lead ?? existing.lead,
    body: JSON.stringify(b.body ?? safeJSON(existing.body_json)),
    closing: b.closing ?? existing.closing, contact: b.contact ?? existing.contact,
    note: b.note ?? existing.note, signoff: b.signoff ?? existing.signoff,
    signatory: b.signatory ?? existing.signatory,
    has_date: (b.hasDate ?? existing.has_date) ? 1 : 0, date_label: b.dateLabel ?? existing.date_label,
    top_date: (b.topDate ?? existing.top_date) ? 1 : 0,
  });
  res.json({ ok: true });
});

// Duplicate a template into a brand new key.
app.post("/api/manage/templates/:key/duplicate", auth, canManageTemplates, (req, res) => {
  const en = db.prepare("SELECT * FROM templates WHERE template_key=? AND lang='en'").get(req.params.key);
  if (!en) return res.status(404).json({ error: "Template not found" });
  let key = slugify((en.label || "copy") + " copy"), base = key, n = 1;
  while (db.prepare("SELECT 1 FROM templates WHERE template_key=? AND lang='en'").get(key)) key = base + "_" + (++n);
  const maxOrder = db.prepare("SELECT COALESCE(MAX(sort_order),0) m FROM templates").get().m;
  db.prepare(`INSERT INTO templates
    (template_key,lang,category,label,intro,lead,body_json,closing,contact,note,
     signoff,signatory,has_date,date_label,top_date,sort_order,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    key, "en", en.category, en.label + " (copy)", en.intro, en.lead, en.body_json,
    en.closing, en.contact, en.note, en.signoff, en.signatory, en.has_date,
    en.date_label, en.top_date, maxOrder + 1, req.user.id);
  res.json({ template_key: key });
});

// Archive / unarchive (keeps history; existing documents still export).
app.post("/api/manage/templates/:key/archive", auth, canManageTemplates, (req, res) => {
  const v = req.body.archived ? 1 : 0;
  db.prepare("UPDATE templates SET archived=?, updated_at=datetime('now') WHERE template_key=?").run(v, req.params.key);
  res.json({ ok: true });
});

// Reorder (accepts array of template_keys in desired order).
app.post("/api/manage/templates/reorder", auth, canManageTemplates, (req, res) => {
  const order = req.body.order || [];
  const upd = db.prepare("UPDATE templates SET sort_order=? WHERE template_key=?");
  const tx = db.transaction((arr) => arr.forEach((k, i) => upd.run(i, k)));
  tx(order);
  res.json({ ok: true });
});

// Signatory management
app.get("/api/manage/signatories", auth, canManageTemplates, (req, res) => res.json(getSignatories()));
app.post("/api/manage/signatories", auth, canManageTemplates, (req, res) => {
  const { key, name, title } = req.body || {};
  if (!key || !name) return res.status(400).json({ error: "key & name required" });
  const max = db.prepare("SELECT COALESCE(MAX(sort_order),0) m FROM signatories").get().m;
  db.prepare("INSERT OR REPLACE INTO signatories (key,name,title,sort_order) VALUES (?,?,?,?)")
    .run(slugify(key), name, title || "", max + 1);
  res.json({ ok: true });
});
app.delete("/api/manage/signatories/:key", auth, canManageTemplates, (req, res) => {
  db.prepare("DELETE FROM signatories WHERE key=?").run(req.params.key);
  res.json({ ok: true });
});

function safeJSON(s) { try { return JSON.parse(s); } catch { return []; } }

// ============================================================================
//  BUSINESS DAYS
// ============================================================================
app.get("/api/days", auth, (req, res) => {
  res.json(db.prepare("SELECT * FROM business_days ORDER BY the_date DESC").all());
});
app.post("/api/days", auth, (req, res) => {
  const date = String(req.body.date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
  try {
    const info = db.prepare("INSERT INTO business_days (the_date) VALUES (?)").run(date);
    res.json({ id: info.lastInsertRowid, the_date: date, status: "open" });
  } catch {
    const existing = db.prepare("SELECT * FROM business_days WHERE the_date=?").get(date);
    res.json(existing);
  }
});
app.post("/api/days/:id/close", auth, (req, res) => {
  db.prepare("UPDATE business_days SET status='closed' WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// ============================================================================
//  IMPORT  (tab-delimited Opera exports)
// ============================================================================
function rowToGuestInsert(g, dayId, listType) {
  return db.prepare(`INSERT INTO guests
    (day_id,list_type,villa,villa_type,arrival,departure,meal_plan,nationality,
     confirmation,name,guests_json,adults,children,hm,anniversary,repeater,
     special_requests,suggested_vouchers,remarks)
    VALUES (@day_id,@list_type,@villa,@villa_type,@arrival,@departure,@meal_plan,
     @nationality,@confirmation,@name,@guests_json,@adults,@children,@hm,
     @anniversary,@repeater,@special_requests,@suggested_vouchers,@remarks)`)
    .run({
      day_id: dayId, list_type: listType,
      villa: g.villa || "", villa_type: g.villaType || "",
      arrival: g.arrival || "", departure: g.departure || "",
      meal_plan: g.mealPlan || "", nationality: g.nationality || "",
      confirmation: g.confirmation || "", name: g.name || "",
      guests_json: JSON.stringify(g.guests || []),
      adults: g.adults || 1, children: g.children || 0,
      hm: g.hm ? 1 : 0, anniversary: g.anniversary ? 1 : 0, repeater: g.repeater ? 1 : 0,
      special_requests: g.specialRequests || "",
      suggested_vouchers: JSON.stringify(g.suggestedVouchers || []),
      remarks: "",
    });
}

app.post("/api/import", auth, (req, res) => {
  const { dayId, text } = req.body || {};
  if (!dayId || !text) return res.status(400).json({ error: "dayId & text required" });
  const day = db.prepare("SELECT * FROM business_days WHERE id=?").get(dayId);
  if (!day) return res.status(404).json({ error: "Day not found" });

  // Arrivals only. Departures are now derived automatically from the
  // departure date of in-house guests, so there's no departure import.
  const parsed = P.parseArrivals(text);
  const listType = "arrival";

  const insertMany = db.transaction((items) => {
    let n = 0;
    for (const g of items) {
      const exists = db.prepare(
        "SELECT id FROM guests WHERE day_id=? AND list_type=? AND confirmation=?"
      ).get(dayId, listType, g.confirmation);
      if (exists) continue;
      rowToGuestInsert(g, dayId, listType);
      n++;
    }
    return n;
  });
  const added = insertMany(parsed);
  res.json({ parsed: parsed.length, added, listType });
});

// ============================================================================
//  GUESTS
// ============================================================================
// Convert a stored display date (e.g. "18-Mar-2026") to a YYYY-MM-DD for compare
function toISO(d) {
  if (!d) return "";
  const m = String(d).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return "";
  const months = { jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12" };
  const mm = months[m[2].toLowerCase()]; if (!mm) return "";
  return `${m[3]}-${mm}-${m[1].padStart(2,"0")}`;
}
// Resort timezone offset in hours (Maldives = UTC+5). Override with TZ_OFFSET
// env var if ever needed. This keeps "today"/"tomorrow" correct no matter
// what timezone the server runs in (e.g. Render runs UTC).
const TZ_OFFSET_HOURS = process.env.TZ_OFFSET ? Number(process.env.TZ_OFFSET) : 5;
function localNow() { return new Date(Date.now() + TZ_OFFSET_HOURS * 3600000); }
function todayISO() { return localNow().toISOString().slice(0, 10); }
function tomorrowISO() { return new Date(localNow().getTime() + 86400000).toISOString().slice(0, 10); }
// Add N days to a YYYY-MM-DD string
function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  return new Date(d.getTime() + n * 86400000).toISOString().slice(0, 10);
}
// The reference "today" for all date logic is the SELECTED BUSINESS DAY, not
// the real clock. Resolve it from the dayId; fall back to the real local date.
function refDateForDay(dayId) {
  if (dayId) {
    const d = db.prepare("SELECT the_date FROM business_days WHERE id=?").get(dayId);
    if (d && d.the_date) return d.the_date;
  }
  return todayISO();
}

app.get("/api/guests", auth, (req, res) => {
  const { dayId, listType, q } = req.query;
  const today = refDateForDay(dayId);
  const tomorrow = addDays(today, 1);

  // Base query — we post-filter the in-house/departure/active split in JS using
  // the departure date, so guests flow automatically without manual moves.
  let sql = "SELECT * FROM guests WHERE 1=1";
  const params = [];
  if (dayId && listType === "arrival") { sql += " AND day_id=?"; params.push(dayId); }
  if (q) { sql += " AND (name LIKE ? OR villa LIKE ? OR confirmation LIKE ?)";
    params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  sql += " ORDER BY CAST(villa AS INTEGER), villa";
  let rows = db.prepare(sql).all(...params).map(hydrateGuest);

  rows = rows.filter((g) => {
    const depISO = toISO(g.departure);
    const isCheckedOut = g.status === "departed";
    if (listType === "arrival") {
      return g.list_type === "arrival" && !isCheckedOut;
    }
    if (listType === "inhouse") {
      // everyone currently in-house and not yet checked out
      return g.list_type === "inhouse" && !isCheckedOut;
    }
    if (listType === "departure") {
      // due out relative to the SELECTED BUSINESS DAY
      if (g.list_type !== "inhouse" || isCheckedOut) return false;
      if (!depISO) return false;
      if (depISO < today) g.dueGroup = "overdue";
      else if (depISO === today) g.dueGroup = "today";
      else if (depISO === tomorrow) g.dueGroup = "tomorrow";
      else return false;
      return true;
    }
    if (listType === "checkedout") {
      return isCheckedOut;
    }
    return true;
  });
  res.json(rows);
});

app.get("/api/guests/:id", auth, (req, res) => {
  const g = db.prepare("SELECT * FROM guests WHERE id=?").get(req.params.id);
  if (!g) return res.status(404).json({ error: "Not found" });
  const docs = db.prepare("SELECT * FROM documents WHERE guest_id=? ORDER BY id").all(g.id);
  res.json({ guest: hydrateGuest(g), documents: docs.map(hydrateDoc) });
});

app.put("/api/guests/:id", auth, (req, res) => {
  const g = db.prepare("SELECT * FROM guests WHERE id=?").get(req.params.id);
  if (!g) return res.status(404).json({ error: "Not found" });
  const isAdmin = req.user.role === "admin";

  // Per-field ownership (no blanket lock). These structural fields are
  // admin-only; everything else (name, meal plan, nationality, remarks, flags)
  // is editable by any logged-in staff member, including on in-house bookings.
  const adminOnlyFields = ["arrival","departure","arrival_flight","departure_flight","villa","confirmation"];
  const allowed = ["villa","villa_type","arrival","departure","arrival_flight","departure_flight",
    "meal_plan","nationality","confirmation","name","adults","children","hm","anniversary",
    "repeater","repeater_count","remarks","list_type"];

  const sets = [], vals = [];
  for (const k of allowed) {
    if (k in req.body) {
      if (adminOnlyFields.includes(k) && !isAdmin) continue; // staff can't touch admin fields
      sets.push(`${k}=?`);
      vals.push(typeof req.body[k] === "boolean" ? (req.body[k] ? 1 : 0) : req.body[k]);
    }
  }
  if (req.body.guests) { sets.push("guests_json=?"); vals.push(JSON.stringify(req.body.guests)); }
  if (!sets.length) return res.json({ ok: true });
  vals.push(req.params.id);
  db.prepare(`UPDATE guests SET ${sets.join(",")} WHERE id=?`).run(...vals);
  res.json({ ok: true });
});

// Recompute formatted name from edited guest objects (name is staff-editable)
app.post("/api/guests/:id/rebuild-name", auth, (req, res) => {
  const guests = req.body.guests || [];
  const childCount = guests.filter((x) => x.role === "child").length;
  const name = P.buildName(guests, childCount);
  db.prepare("UPDATE guests SET name=?, guests_json=? WHERE id=?")
    .run(name, JSON.stringify(guests), req.params.id);
  res.json({ name });
});

app.delete("/api/guests/:id", auth, (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });
  db.prepare("DELETE FROM documents WHERE guest_id=?").run(req.params.id);
  db.prepare("DELETE FROM guests WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// ---- Check in an arrival -> moves to in-house ----------------------------
// Staff can check in only on the actual arrival date; admin can override.
app.post("/api/guests/:id/checkin", auth, (req, res) => {
  const g = db.prepare("SELECT * FROM guests WHERE id=?").get(req.params.id);
  if (!g) return res.status(404).json({ error: "Not found" });
  if (g.list_type === "inhouse") return res.json({ ok: true, already: true });

  const isAdmin = req.user.role === "admin";
  const arrISO = toISO(g.arrival);
  const ref = refDateForDay(req.body.dayId);
  if (!isAdmin && arrISO && arrISO !== ref) {
    return res.status(403).json({ error: `Check-in is only allowed on the arrival date (${g.arrival}). Switch the business day to that date, or ask an admin.` });
  }
  db.prepare("UPDATE guests SET list_type='inhouse', checked_in_at=datetime('now') WHERE id=?").run(g.id);
  res.json({ ok: true });
});

// ---- Check out a guest -> ends the stay (staff + admin) ------------------
// Works any day: handles on-time, early, and overdue departures alike.
app.post("/api/guests/:id/checkout", auth, (req, res) => {
  const g = db.prepare("SELECT * FROM guests WHERE id=?").get(req.params.id);
  if (!g) return res.status(404).json({ error: "Not found" });
  const isAdmin = req.user.role === "admin";
  const depISO = toISO(g.departure);
  const ref = refDateForDay(req.body.dayId);
  if (!isAdmin && depISO && depISO !== ref) {
    return res.status(403).json({ error: `Check-out is only allowed on the departure date (${g.departure}). Switch the business day to that date, or ask an admin.` });
  }
  db.prepare("UPDATE guests SET status='departed', checked_out_at=datetime('now') WHERE id=?").run(g.id);
  res.json({ ok: true });
});

// ---- Undo a check-out (admin only) — restores to in-house ----------------
app.post("/api/guests/:id/undo-checkout", auth, adminOnly, (req, res) => {
  db.prepare("UPDATE guests SET status='active', checked_out_at=NULL WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// ---- Admin: create a booking from scratch --------------------------------
app.post("/api/guests", auth, adminOnly, (req, res) => {
  const b = req.body || {};
  const dayId = b.day_id || (db.prepare("SELECT id FROM business_days ORDER BY the_date DESC LIMIT 1").get() || {}).id;
  const guests = b.guests || [{ title: "Mr", last: "", first: "", role: "adult" }];
  const name = b.name || P.buildName(guests, guests.filter((x) => x.role === "child").length);
  const info = db.prepare(`INSERT INTO guests
    (day_id,list_type,villa,villa_type,arrival,departure,arrival_flight,departure_flight,
     meal_plan,nationality,confirmation,name,guests_json,adults,children,
     hm,anniversary,repeater,repeater_count,special_requests,suggested_vouchers,remarks,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'active')`).run(
    dayId, b.list_type || "arrival", b.villa || "", b.villa_type || "",
    b.arrival || "", b.departure || "", b.arrival_flight || "", b.departure_flight || "",
    b.meal_plan || "", b.nationality || "", b.confirmation || "", name,
    JSON.stringify(guests), b.adults || 1, b.children || 0,
    b.hm ? 1 : 0, b.anniversary ? 1 : 0, b.repeater ? 1 : 0, b.repeater_count || "",
    "", JSON.stringify([]), b.remarks || "");
  res.json({ id: info.lastInsertRowid });
});

function hydrateGuest(g) {
  return {
    ...g,
    hm: !!g.hm, anniversary: !!g.anniversary, repeater: !!g.repeater,
    guests: safeParse(g.guests_json, []),
    suggested_vouchers: safeParse(g.suggested_vouchers, []),
  };
}
function hydrateDoc(d) { return { ...d, fields: safeParse(d.fields_json, {}) }; }
function safeParse(s, fallback) { try { return JSON.parse(s); } catch { return fallback; } }

// ============================================================================
//  DOCUMENTS  (vouchers etc.)
// ============================================================================
app.post("/api/documents", auth, (req, res) => {
  const { guest_id, template_id, signatory, fields, lang } = req.body || {};
  const guest = db.prepare("SELECT * FROM guests WHERE id=?").get(guest_id);
  const template = getTemplate(template_id, lang || "en");
  if (!guest || !template) return res.status(400).json({ error: "Bad guest or template" });
  const f = Object.assign({
    name: guest.name,
    confirmation: guest.confirmation,
    date: "",
  }, fields || {});
  const info = db.prepare(`INSERT INTO documents
    (guest_id,template_id,lang,signatory,fields_json,created_by)
    VALUES (?,?,?,?,?,?)`)
    .run(guest_id, template_id, lang || "en", signatory || template.signatory, JSON.stringify(f), req.user.id);
  res.json({ id: info.lastInsertRowid });
});

app.put("/api/documents/:id", auth, (req, res) => {
  const doc = db.prepare("SELECT * FROM documents WHERE id=?").get(req.params.id);
  if (!doc) return res.status(404).json({ error: "Not found" });
  const fields = req.body.fields || safeParse(doc.fields_json, {});
  const signatory = req.body.signatory || doc.signatory;
  const lang = req.body.lang || doc.lang;
  db.prepare("UPDATE documents SET fields_json=?, signatory=?, lang=?, updated_at=datetime('now') WHERE id=?")
    .run(JSON.stringify(fields), signatory, lang, req.params.id);
  res.json({ ok: true });
});

app.delete("/api/documents/:id", auth, (req, res) => {
  db.prepare("DELETE FROM documents WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

app.get("/api/documents", auth, (req, res) => {
  const rows = db.prepare(`
    SELECT d.*, g.name guest_name, g.villa, g.confirmation conf
    FROM documents d JOIN guests g ON g.id=d.guest_id
    ORDER BY d.updated_at DESC`).all();
  res.json(rows.map(hydrateDoc));
});

// ---- Export a document to docx or pdf ------------------------------------
app.get("/api/documents/:id/export", auth, async (req, res) => {
  const format = (req.query.format || "pdf").toLowerCase();
  const doc = db.prepare("SELECT * FROM documents WHERE id=?").get(req.params.id);
  if (!doc) return res.status(404).json({ error: "Not found" });
  const template = getTemplate(doc.template_id, doc.lang || "en");
  if (!template) return res.status(404).json({ error: "Template no longer exists" });
  const fields = safeParse(doc.fields_json, {});
  const data = { ...fields, signatoryKey: doc.signatory, signatories: getSignatories() };

  const safe = (fields.name || "voucher").replace(/[^a-z0-9]+/gi, "_").slice(0, 40);
  const base = `${template.id}_${safe}_${doc.id}`;
  const docxPath = path.join(OUT_DIR, base + ".docx");

  try {
    await generateDocx(template, data, docxPath);
    db.prepare("UPDATE documents SET status='exported', updated_at=datetime('now') WHERE id=?").run(doc.id);
    if (format === "docx") return res.download(docxPath, base + ".docx");
    const pdfPath = await convertToPdf(docxPath, OUT_DIR);
    return res.download(pdfPath, base + ".pdf");
  } catch (e) {
    console.error("export error", e);
    res.status(500).json({ error: "Export failed: " + e.message });
  }
});

// Live preview (returns plain text rendering of the filled letter)
app.post("/api/preview", auth, (req, res) => {
  const { template_id, fields, lang, template: inlineTpl } = req.body || {};
  // allow previewing an unsaved builder draft via inlineTpl
  const t = inlineTpl || getTemplate(template_id, lang || "en");
  if (!t) return res.status(400).json({ error: "Bad template" });
  const f = fields || {};
  const sigs = getSignatories();
  const lines = [];
  if (t.topDate && f.date) lines.push(f.date);
  lines.push(`Dear ${f.name || "[name]"},`);
  if (t.intro) lines.push(t.intro);
  if (t.lead) lines.push(t.lead);
  for (const b of t.body || []) {
    let line = b;
    if (line.includes("{{date}}")) {
      line = line.replace("{{date}}", f.date ? `${t.dateLabel ? t.dateLabel + " " : ""}${f.date}` : "");
      if (!line.trim()) continue;
    }
    line = line.replace("{{name}}", f.name || "").replace("{{confirmation}}", f.confirmation || "").replace("{{villa}}", f.villa || "");
    lines.push(line.replace(/\*\*/g, "").replace(/_/g, ""));
  }
  if (t.closing) lines.push(t.closing);
  if (t.contact) lines.push(t.contact);
  if (t.note) lines.push(t.note);
  const sig = sigs[f.signatory || t.signatory] || Object.values(sigs)[0] || { name: "", title: "" };
  lines.push(t.signoff || "Warmest regards,", sig.name, sig.title);
  if (f.confirmation) lines.push(f.confirmation);
  res.json({ text: lines.join("\n\n") });
});

// SPA fallback
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));

app.listen(PORT, () => {
  console.log(`\n  Halaveli GDMS running on http://localhost:${PORT}`);
  console.log(`  Generated files: ${OUT_DIR}\n`);
});
