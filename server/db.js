// ============================================================================
//  DATABASE  (better-sqlite3)
//  Single-file SQLite DB.
//  Tables: users, sessions, business_days, guests, documents, templates.
//  Templates now live in the DB (Template Builder) instead of code, and the
//  same table carries language variants for Phase 2 translations.
// ============================================================================
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { TEMPLATES, SIGNATORIES } = require("./templates-catalog");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "gdms.db");
// Make sure the folder for the database exists (it may be empty and absent
// after a fresh checkout, since git/uploads don't preserve empty folders).
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'staff',
  can_manage_templates INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS business_days (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  the_date TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS guests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_id INTEGER,
  list_type TEXT NOT NULL DEFAULT 'arrival',
  villa TEXT, villa_type TEXT, arrival TEXT, departure TEXT,
  arrival_flight TEXT, departure_flight TEXT,
  checked_in_at TEXT, checked_out_at TEXT, status TEXT NOT NULL DEFAULT 'active',
  meal_plan TEXT, nationality TEXT, confirmation TEXT,
  name TEXT, guests_json TEXT,
  adults INTEGER DEFAULT 1, children INTEGER DEFAULT 0,
  hm INTEGER DEFAULT 0, anniversary INTEGER DEFAULT 0, repeater INTEGER DEFAULT 0,
  repeater_count TEXT,
  special_requests TEXT, suggested_vouchers TEXT, remarks TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (day_id) REFERENCES business_days(id)
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guest_id INTEGER NOT NULL,
  template_id TEXT NOT NULL,
  lang TEXT NOT NULL DEFAULT 'en',
  signatory TEXT,
  fields_json TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (guest_id) REFERENCES guests(id)
);

CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_key TEXT NOT NULL,
  lang TEXT NOT NULL DEFAULT 'en',
  category TEXT NOT NULL DEFAULT 'General',
  label TEXT NOT NULL,
  intro TEXT, lead TEXT,
  body_json TEXT,
  closing TEXT, contact TEXT, note TEXT,
  signoff TEXT DEFAULT 'Warmest regards,',
  signatory TEXT DEFAULT 'silvia',
  has_date INTEGER DEFAULT 0,
  date_label TEXT,
  top_date INTEGER DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER DEFAULT 100,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(template_key, lang)
);

CREATE TABLE IF NOT EXISTS signatories (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  sort_order INTEGER DEFAULT 100
);
`);

// ---- Lightweight migrations for existing installs -------------------------
try {
  const cols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!cols.includes("can_manage_templates"))
    db.exec("ALTER TABLE users ADD COLUMN can_manage_templates INTEGER NOT NULL DEFAULT 0");
} catch (e) {}
try {
  const cols = db.prepare("PRAGMA table_info(documents)").all().map((c) => c.name);
  if (!cols.includes("lang"))
    db.exec("ALTER TABLE documents ADD COLUMN lang TEXT NOT NULL DEFAULT 'en'");
} catch (e) {}
try {
  const cols = db.prepare("PRAGMA table_info(guests)").all().map((c) => c.name);
  if (!cols.includes("repeater_count"))
    db.exec("ALTER TABLE guests ADD COLUMN repeater_count TEXT");
  if (!cols.includes("arrival_flight"))
    db.exec("ALTER TABLE guests ADD COLUMN arrival_flight TEXT");
  if (!cols.includes("departure_flight"))
    db.exec("ALTER TABLE guests ADD COLUMN departure_flight TEXT");
  if (!cols.includes("checked_in_at"))
    db.exec("ALTER TABLE guests ADD COLUMN checked_in_at TEXT");
  if (!cols.includes("checked_out_at"))
    db.exec("ALTER TABLE guests ADD COLUMN checked_out_at TEXT");
  if (!cols.includes("status"))
    db.exec("ALTER TABLE guests ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
} catch (e) {}

// ---- Seed admin on first run ---------------------------------------------
function ensureAdmin() {
  const row = db.prepare("SELECT COUNT(*) c FROM users").get();
  if (row.c === 0) {
    const username = process.env.ADMIN_USER || "admin";
    const password = process.env.ADMIN_PASS || "changeme123";
    const hash = bcrypt.hashSync(password, 10);
    db.prepare(
      "INSERT INTO users (username,password_hash,display_name,role,can_manage_templates) VALUES (?,?,?,?,1)"
    ).run(username, hash, "Administrator", "admin");
    console.log(`[db] Seeded admin "${username}". CHANGE THE PASSWORD after first login.`);
  }
}
ensureAdmin();

// ---- Seed signatories + 18 built-in templates on first run ---------------
function seedTemplates() {
  if (db.prepare("SELECT COUNT(*) c FROM signatories").get().c === 0) {
    const ins = db.prepare("INSERT INTO signatories (key,name,title,sort_order) VALUES (?,?,?,?)");
    let i = 0;
    for (const [key, v] of Object.entries(SIGNATORIES)) ins.run(key, v.name, v.title, i++);
  }
  if (db.prepare("SELECT COUNT(*) c FROM templates").get().c === 0) {
    const ins = db.prepare(`INSERT INTO templates
      (template_key,lang,category,label,intro,lead,body_json,closing,contact,note,
       signoff,signatory,has_date,date_label,top_date,sort_order)
      VALUES (@template_key,'en',@category,@label,@intro,@lead,@body_json,@closing,@contact,@note,
       @signoff,@signatory,@has_date,@date_label,@top_date,@sort_order)`);
    TEMPLATES.forEach((t, idx) => ins.run({
      template_key: t.id, category: t.category, label: t.label,
      intro: t.intro || "", lead: t.lead || "",
      body_json: JSON.stringify(t.body || []),
      closing: t.closing || "", contact: t.contact || "", note: t.note || "",
      signoff: t.signoff || "Warmest regards,", signatory: t.signatory || "silvia",
      has_date: t.hasDate ? 1 : 0, date_label: t.dateLabel || "",
      top_date: t.topDate ? 1 : 0, sort_order: idx,
    }));
    console.log(`[db] Seeded ${TEMPLATES.length} built-in templates into DB.`);
  }
}
seedTemplates();

// ---- Template helpers -----------------------------------------------------
function safeParse(s, fb) { try { return JSON.parse(s); } catch { return fb; } }
function rowToTemplate(r) {
  if (!r) return null;
  return {
    id: r.template_key, dbId: r.id, lang: r.lang, category: r.category, label: r.label,
    intro: r.intro, lead: r.lead, body: safeParse(r.body_json, []),
    closing: r.closing, contact: r.contact, note: r.note,
    signoff: r.signoff, signatory: r.signatory,
    hasDate: !!r.has_date, dateLabel: r.date_label, topDate: !!r.top_date,
    archived: !!r.archived, sortOrder: r.sort_order,
  };
}
function getTemplate(key, lang = "en") {
  let r = db.prepare("SELECT * FROM templates WHERE template_key=? AND lang=?").get(key, lang);
  if (!r && lang !== "en") r = db.prepare("SELECT * FROM templates WHERE template_key=? AND lang='en'").get(key);
  return rowToTemplate(r);
}
function listTemplates(lang = "en", includeArchived = false) {
  return db.prepare(
    `SELECT * FROM templates WHERE lang=? ${includeArchived ? "" : "AND archived=0"} ORDER BY sort_order, label`
  ).all(lang).map(rowToTemplate);
}
function getSignatories() {
  const map = {};
  db.prepare("SELECT * FROM signatories ORDER BY sort_order, name").all()
    .forEach((r) => (map[r.key] = { name: r.name, title: r.title }));
  return map;
}

const newToken = () => crypto.randomBytes(32).toString("hex");

module.exports = {
  db, bcrypt, newToken,
  getTemplate, listTemplates, getSignatories, rowToTemplate, safeParse,
};
