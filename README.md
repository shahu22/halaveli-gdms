# Halaveli — Guest Document Management System

A self-hosted web app for your front-office team. Import Opera Cloud arrival
and departure exports, get an auto-built name list (with your exact name
formatting and Honeymoon/Anniversary/Repeater flags), select vouchers per
booking, and export filled **Word + PDF** documents. Guests roll into a
persistent in-house list you can revisit any time.

This is **Phase 1**. Phase 2 (multi-language translations + tone admin panel)
plugs into the same foundation.

---

## What it does

- **Login-gated.** Only an admin (you) can create staff accounts and set passwords.
- **Business days.** Work a day, then "Close & Roll to Next Day" — arrivals move
  into the In-House list and stay accessible; a new day is created.
- **Import.** Paste a tab-delimited Opera export (arrival `res_detail` or the
  departure report). The parser handles Opera's embedded-newline quirk,
  reconstructs rows, formats names per your rules, and auto-flags HMOON / GWANN
  (anniversary) / RPGUEST (repeater).
- **Name rule.** 1 adult → `Mr Last`; 2 adults → `Mrs Last and Mr Last`
  (female first; same surname collapses to `Mrs and Mr Last`); children appended
  by first name. Fully editable in the guest panel — change titles, add/remove
  adults and children, and the formatted name rebuilds live.
- **Vouchers.** 18 templates wired in. Select them per guest, edit name/date/
  signatory, and export Word or PDF. Documents persist and can be re-edited and
  re-exported any time from the guest panel or the Documents tab.
- **Signatory selectable** per document (Silvia / Amelie / Tangi, or whatever you
  add in `server/templates-catalog.js`).

---

## Creating & editing documents yourself (Template Builder)

Templates now live in the database, and admins (or staff you grant the
**Manage templates** capability) can create and edit them from the **Templates**
tab — no code changes needed.

- **New Template** opens an editor: name it, pick a category, type the opening,
  lead-in, body lines, closing, contact line, footnote, sign-off and default
  signatory. Toggle whether it asks for a date.
- Insert **`{{name}}`**, **`{{date}}`**, **`{{confirmation}}`**, **`{{villa}}`**
  anywhere and they fill from the guest automatically. Wrap text in `**bold**`
  or `_italic_`, and start a line with `•` for a bullet.
- A **live preview** shows the finished letter as you type.
- **Duplicate** an existing template to start from a close match (great for
  variants), **Archive** ones you no longer use (existing documents made from
  them still export fine), and manage the list of **Signatories** from the same
  tab.

This is how you'll add water-villa disclaimers, paid-upgrade letters, meal-plan
upgrades, and anything else going forward. The 18 original vouchers are loaded
into the database automatically on first run and edit the same way.

> Granting access: in **Admin**, tick **Manage templates** on any staff account,
> or set it when creating the account. Admins always have it.

---

## Requirements (on your VPS)

- **Node.js 18+** (20 LTS recommended)
- **LibreOffice** (headless) — used to convert Word → PDF
- A few build tools for `better-sqlite3` native module

### Install system dependencies (Ubuntu/Debian)

```bash
# Node 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# LibreOffice (headless) + build tools for better-sqlite3
sudo apt-get install -y libreoffice-writer build-essential python3
```

---

## Run it

```bash
cd halaveli-gdms
npm install          # installs express, better-sqlite3, bcryptjs, docx, cookie-parser
npm start            # starts on http://localhost:3000
```

On first start it seeds an admin account and prints the credentials.
**Defaults:** username `admin`, password `changeme123`.
Override before first run with environment variables (see below), and change
the password from the Admin tab immediately.

### Environment variables (optional)

| Variable      | Default                  | Purpose                               |
|---------------|--------------------------|---------------------------------------|
| `PORT`        | `3000`                   | HTTP port                             |
| `ADMIN_USER`  | `admin`                  | seeded admin username (first run only)|
| `ADMIN_PASS`  | `changeme123`            | seeded admin password (first run only)|
| `DB_PATH`     | `data/gdms.db`           | SQLite database file                  |
| `OUT_DIR`     | `data/generated`         | where exported docx/pdf are written   |
| `SOFFICE_BIN` | `soffice`                | LibreOffice binary, if not on PATH    |

Example first run with your own admin password:

```bash
ADMIN_USER=hassan ADMIN_PASS='a-strong-password' npm start
```

---

## Keep it running (systemd)

Create `/etc/systemd/system/halaveli.service`:

```ini
[Unit]
Description=Halaveli GDMS
After=network.target

[Service]
WorkingDirectory=/opt/halaveli-gdms
ExecStart=/usr/bin/node server/index.js
Restart=always
Environment=PORT=3000
Environment=NODE_ENV=production
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now halaveli
sudo systemctl status halaveli
```

---

## Put it behind HTTPS (nginx)

Minimal reverse proxy (`/etc/nginx/sites-available/halaveli`):

```nginx
server {
    server_name vouchers.yourdomain.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    client_max_body_size 25M;
}
```

```bash
sudo ln -s /etc/nginx/sites-available/halaveli /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d vouchers.yourdomain.com   # free HTTPS
```

> When served over HTTPS, harden the session cookie: in `server/index.js`
> find `res.cookie("sid", ...)` and add `secure: true` to the options.

---

## Daily workflow for your team

1. Sign in. The current business day is selected (or create one).
2. **Import Opera Export** → paste the tab-delimited arrivals export → Import.
   Repeat with the departures export if needed (toggle to "Departures").
3. Review the list. Fix flags (♡ ⚭ ★), enter nationality, open any guest to
   correct the formatted name.
4. In a guest's panel, tick the vouchers that apply. For each created document,
   set the date (if it asks) and signatory, **Save**, then export **Word** or **PDF**.
5. When the day is done, **Close & Roll to Next Day**. Today's guests move to
   **In-House** and stay searchable; tomorrow starts fresh. You can still open
   any in-house guest and generate documents later.

---

## How to back up

Everything lives in the `data/` folder: `gdms.db` (all users, guests, documents)
and `generated/` (exported files). Stop the service, copy `data/`, done.

```bash
sudo systemctl stop halaveli
cp -r /opt/halaveli-gdms/data /backups/halaveli-$(date +%F)
sudo systemctl start halaveli
```

---

## Project layout

```
halaveli-gdms/
├── server/
│   ├── index.js              # Express app, all API routes, auth
│   ├── db.js                 # SQLite schema + admin seeding
│   ├── opera-parser.js       # Opera export parsing + name formatting engine
│   ├── doc-generator.js      # Word build + PDF conversion
│   └── templates-catalog.js  # The 18 voucher definitions (edit here)
├── public/
│   └── index.html            # The whole front-end (single-page app)
├── data/                     # created at runtime: DB + generated files
├── package.json
└── README.md
```

---

## Adding new document types later (disclaimers, upgrades, etc.)

Use the **Template Builder** in the Templates tab (see above) — create the
document in the UI, no code required. The `server/templates-catalog.js` file is
now only the *initial seed* for a fresh database; once the app has run once,
templates live in the database and are edited through the builder.

---

## Notes & known limits (Phase 1)

- **Nationality** is intentionally left blank for manual entry — the Opera
  export doesn't carry a clean country code.
- **Meal plan** is derived from `PRODUCTS` codes with sensible heuristics; verify
  and correct in the panel where needed. The mapping lives in
  `opera-parser.js → deriveMealPlan()` if you want to tune it.
- **Voucher "suggested" tags** come from product/special-request hints; they are
  only suggestions — staff confirm by ticking.
- The vouchers are designed to print on the resort's pre-printed letterhead
  stationery (matching your existing Word templates, which carry no embedded logo).
```
