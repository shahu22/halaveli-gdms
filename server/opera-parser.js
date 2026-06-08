// ============================================================================
//  OPERA PARSER + NAME ENGINE
//  Parses tab-delimited Opera Cloud exports (arrival res_detail + departure)
//  and applies the resort's exact name-formatting rules.
// ============================================================================

// ---- Name formatting rules ----------------------------------------------
//  1 adult   -> "Mr <Last>"  /  "Mrs <Last>"
//  2 adults  -> "Mrs <Last> and Mr <Last>"          (female first)
//  same last -> "Mrs and Mr <Last>"                  (collapse duplicate)
//  + children-> append ", <ChildFirst>, <ChildFirst>"
// --------------------------------------------------------------------------

function titleRank(t) {
  // female titles sort first
  return /^(mrs|ms|miss)/i.test(t) ? 0 : 1;
}

function normTitle(raw) {
  const t = String(raw || "").toLowerCase().replace(/\./g, "").trim();
  if (t === "mrs") return "Mrs";
  if (t === "ms") return "Ms";
  if (t === "miss") return "Miss";
  if (t === "dr") return "Dr";
  if (t === "master" || t === "mstr") return "Master";
  return "Mr";
}

function titleCase(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\b([a-z])/g, (m, c) => c.toUpperCase())
    .replace(/\b(Da|De|Van|Von|Della|Di|La|Le)\b/gi, (m) => m.toLowerCase());
}

// Parse a single Opera name token "LASTNAME,Firstname,Title." -> guest object
function parseOperaName(raw) {
  if (!raw) return null;
  const parts = String(raw).split(",").map((s) => s.trim());
  // Format is usually LAST, First, Title.   (title optional)
  let last = parts[0] || "";
  let first = parts[1] || "";
  let title = parts[2] || "";
  return {
    title: title ? normTitle(title) : "",
    last: titleCase(last),
    first: titleCase(first),
    role: "adult",
  };
}

// Accompanying names come like "KIMURA, RISA" or
// "JOOSTE, HAMISH PETER INNES / JOOSTE, STELLA ROSE / JOOSTE, SIENA ROSE"
function parseAccompanying(raw) {
  if (!raw) return [];
  return String(raw)
    .split("/")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [last, ...rest] = chunk.split(",").map((s) => s.trim());
      return {
        title: "",
        last: titleCase(last),
        first: titleCase(rest.join(" ")),
        role: "adult", // refined later using adult/child counts
      };
    });
}

// Build the formatted display name from a set of guests + child count.
function buildName(guests, childCount = 0) {
  if (!guests || !guests.length) return "";
  const adults = guests.filter((g) => g.role !== "child");
  const kids = guests.filter((g) => g.role === "child");

  // assign default titles where missing (lead female/male heuristics)
  adults.forEach((a, i) => {
    if (!a.title) a.title = i === 0 ? "Mr" : "Mrs";
  });

  // sort female-first for the 2-adult case
  const sorted = [...adults].sort((a, b) => titleRank(a.title) - titleRank(b.title));

  let base = "";
  if (sorted.length === 1) {
    const a = sorted[0];
    base = `${a.title} ${a.last || a.first}`.trim();
  } else if (sorted.length >= 2) {
    const a = sorted[0], b = sorted[1];
    if (a.last && b.last && a.last.toLowerCase() === b.last.toLowerCase()) {
      // same surname -> collapse: "Mrs and Mr Smith"
      base = `${a.title} and ${b.title} ${a.last}`;
    } else {
      base = `${a.title} ${a.last || a.first} and ${b.title} ${b.last || b.first}`;
    }
    // any further adults appended
    for (let i = 2; i < sorted.length; i++) {
      base += ` and ${sorted[i].title} ${sorted[i].last || sorted[i].first}`;
    }
  }

  const kidNames = kids.map((k) => k.first || k.last).filter(Boolean);
  if (kidNames.length) base += `, ${kidNames.join(", ")}`;
  return base.trim();
}

// ---- Tab-delimited table parsing -----------------------------------------
//  Opera exports embed newlines inside some fields (e.g. BILL_TO_ADDRESS,
//  COMPANY_NAME), so a logical row spans several physical lines and the tab
//  count per physical line is unreliable.
//
//  Strategy: detect a "row anchor" = the first cell of the header's first
//  column repeats a stable pattern at the start of every real record. We
//  sample the first data row's leading token shape and use it to find where
//  each subsequent record begins; everything between anchors is one record.
function parseDelimited(text) {
  const physical = String(text).replace(/\r/g, "").split("\n");
  if (physical.length < 2) return { headers: [], rows: [] };

  const headers = physical[0].split("\t").map((h) => h.trim());
  const expectedTabs = headers.length - 1;

  // Determine the anchor pattern from the first non-header physical line's
  // first field. Common Opera anchors: an 8-digit group key (YYYYMMDD) or a
  // date like 14-MAR-26. We build a regex that matches that *shape*.
  const firstCell = (physical[1].split("\t")[0] || "").trim();
  let anchorRx;
  if (/^\d{8}$/.test(firstCell)) anchorRx = /^\d{8}$/;
  else if (/^\d{1,2}-[A-Za-z]{3}-\d{2,4}$/.test(firstCell)) anchorRx = /^\d{1,2}-[A-Za-z]{3}-\d{2,4}$/;
  else if (/^\d{1,2}-\d{1,2}-\d{2,4}$/.test(firstCell)) anchorRx = /^\d{1,2}-\d{1,2}-\d{2,4}$/;
  else anchorRx = null;

  // Footer/summary tokens that mark the end of real data.
  const FOOTER = /^(RMS_REPORT|SUMBALANCEPERREPORT|SUM_|LOGO$)/i;

  const records = [];
  let buffer = [];
  const flush = () => {
    if (!buffer.length) return;
    const joined = buffer.join(" ");
    records.push(joined);
    buffer = [];
  };

  for (let i = 1; i < physical.length; i++) {
    const line = physical[i];
    const lead = (line.split("\t")[0] || "").trim();
    if (FOOTER.test(lead)) { flush(); break; }

    const isAnchor = anchorRx ? anchorRx.test(lead) : ((line.match(/\t/g) || []).length >= expectedTabs);
    if (isAnchor && buffer.length) flush();
    buffer.push(line);
  }
  flush();

  const rows = records.map((rec) => {
    const cells = rec.split("\t");
    const obj = {};
    headers.forEach((h, idx) => (obj[h] = (cells[idx] || "").trim()));
    return obj;
  });
  return { headers, rows };
}

// ---- Date normalisation: 18-MAR-26 / 18-03-26 -> 18-Mar-2026 --------------
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function normDate(raw) {
  if (!raw) return "";
  const s = String(raw).trim();
  let m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (m) {
    const yr = m[3].length === 2 ? "20" + m[3] : m[3];
    const mon = m[2].charAt(0).toUpperCase() + m[2].slice(1, 3).toLowerCase();
    return `${m[1].padStart(2, "0")}-${mon}-${yr}`;
  }
  m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})$/);
  if (m) {
    const yr = m[3].length === 2 ? "20" + m[3] : m[3];
    const mon = MONTHS[parseInt(m[2], 10) - 1] || m[2];
    return `${m[1].padStart(2, "0")}-${mon}-${yr}`;
  }
  return s;
}

// ---- Meal-plan derivation -------------------------------------------------
// CHM uses product codes. We only return a plan when the codes clearly imply
// one. FB is intentionally NEVER auto-assigned (it's used only for management
// / fam-trip guests and isn't a standard guest plan) — staff set it manually
// if needed. When nothing is clearly identifiable we return "" (shown as "-").
function deriveMealPlan(products, rateCode) {
  const p = (products || "").toUpperCase();
  // All-inclusive: needs the all-inclusive beverage/minibar marker alongside meals
  if (/MINBAW|JBVB|JBVR/.test(p) && /JDIN|JLUN|JBKF|DIAUS|LUAUS|BFAUS/.test(p)) return "AIP";
  // Half board: explicit HB product codes
  if (/MSAUSBBHB|MSCUSBBHB|\bHB\b/.test(p)) return "HB";
  // Bed & breakfast: breakfast present, no dinner/lunch products
  if (/BFAUS|BFCUS/.test(p) && !/JDIN|JLUN|DIAUS|LUAUS|DICUS|LUCUS/.test(p)) return "BB";
  // All-inclusive via core Jahaz meal codes (breakfast+lunch+dinner)
  if (/JBKF/.test(p) && /JLUN/.test(p) && /JDIN/.test(p)) return "AIP";
  return "";
}

// ---- HM / Repeater detection ---------------------------------------------
function detectHM(specialRequests, products) {
  const s = (specialRequests || "") + " " + (products || "");
  return /HMOON|GWANN|HONEYMOON|ANNIVERS/i.test(s);
}
function detectAnniversary(specialRequests) {
  return /GWANN|ANNIVERS/i.test(specialRequests || "");
}
function detectRepeater(specialRequests, totalStays) {
  if (/RPGUEST|RPGST|REPEAT/i.test(specialRequests || "")) return true;
  return false; // strict: only the code counts, per the resort's rule
}

// ---- Voucher hints from PRODUCTS / SPECIAL_REQUESTS -----------------------
// Suggests which templates likely apply (staff confirm via selection).
const PRODUCT_HINTS = [
  { rx: /JCELAW|CELAW/i, ids: ["romantic_dinner"] },
  { rx: /HMOON/i, ids: ["hm"] },
  { rx: /GWANN/i, ids: ["gwann"] },
  { rx: /RMECI/i, ids: ["in_villa_breakfast"] },
  { rx: /SPTGM|SPTAG/i, ids: ["massage_30"] },
  { rx: /JDINAW|JDINAN/i, ids: ["romantic_dinner"] },
];
function suggestVouchers(specialRequests, products) {
  const blob = (specialRequests || "") + "," + (products || "");
  const ids = new Set();
  PRODUCT_HINTS.forEach((h) => { if (h.rx.test(blob)) h.ids.forEach((i) => ids.add(i)); });
  return [...ids];
}

// ---- Country guess from BILL_TO_ADDRESS -----------------------------------
function guessCountry(address) {
  if (!address) return "";
  const lines = String(address).split(/,|\n/).map((s) => s.trim()).filter(Boolean);
  // Opera addresses often end with a country or a postal token; leave blank by rule.
  return "";
}

// ============================================================================
//  MAIN: parse arrival report into normalized guest records
// ============================================================================
function parseArrivals(text) {
  const { rows } = parseDelimited(text);
  const out = [];
  for (const r of rows) {
    // skip summary / footer rows (no confirmation no.)
    const conf = r.CONFIRMATION_NO || r.confirmation_no;
    if (!conf || !/^\d{6,}$/.test(conf)) continue;

    const lead = parseOperaName(r.FULL_NAME || r.FULL_NAME_NO_SHR_IND);
    const accompanying = parseAccompanying(r.ACCOMPANYING_NAMES);
    const adultCount = parseInt(r.ADULTS || "1", 10) || 1;
    const childCount = parseInt(r.CHILDREN || "0", 10) || 0;

    // Build guest list: lead + accompanying.
    let guests = [lead, ...accompanying].filter(Boolean);

    // Mark trailing guests as children based on the child count.
    if (childCount > 0 && guests.length > adultCount) {
      for (let i = guests.length - childCount; i < guests.length; i++) {
        if (guests[i]) guests[i].role = "child";
      }
    }

    // Infer titles for adult accompanying guests with no title.
    // In a 2-adult couple, the partner takes the opposite title to the lead.
    const adultGuests = guests.filter((g) => g.role !== "child");
    if (adultGuests.length === 2) {
      const [a, b] = adultGuests;
      if (a.title && !b.title) b.title = a.title === "Mr" ? "Mrs" : "Mr";
      else if (!a.title && b.title) a.title = b.title === "Mr" ? "Mrs" : "Mr";
    }
    adultGuests.forEach((g) => { if (!g.title) g.title = "Mr"; });

    out.push({
      villa: r.ROOM_NO || r.DISP_ROOM_NO || "",
      villaType: r.ROOM_CATEGORY_LABEL || "",
      arrival: normDate(r.ARRIVAL),
      departure: normDate(r.DEPARTURE),
      mealPlan: deriveMealPlan(r.PRODUCTS, r.RATE_CODE),
      products: r.PRODUCTS || "",
      rateCode: r.RATE_CODE || "",
      confirmation: conf,
      nationality: guessCountry(r.BILL_TO_ADDRESS),
      adults: adultCount,
      children: childCount,
      guests,
      name: buildName(guests, childCount),
      hm: detectHM(r.SPECIAL_REQUESTS, r.PRODUCTS),
      anniversary: detectAnniversary(r.SPECIAL_REQUESTS),
      repeater: detectRepeater(r.SPECIAL_REQUESTS, r.TOTAL_STAYS_ACROSS_CHAIN),
      specialRequests: r.SPECIAL_REQUESTS || "",
      suggestedVouchers: suggestVouchers(r.SPECIAL_REQUESTS, r.PRODUCTS),
      arrivalTime: r.ARRIVAL_TIME1 || r.ARRIVAL_TIME || "",
      flightCode: r.ARRIVAL_CARRIER_CODE || "",
      source: "arrival",
    });
  }
  return out;
}

// Departure report uses different headers (GUEST_NAME like "MA,JINSEOK,Mr.")
function parseDepartures(text) {
  const { rows } = parseDelimited(text);
  const out = [];
  for (const r of rows) {
    const conf = r.EXTERNAL_REFERENCE || r.RESV_NAME_ID;
    const nameRaw = r.GUEST_NAME;
    if (!nameRaw || !/,/.test(nameRaw)) continue;
    const lead = parseOperaName(nameRaw);
    const shareNames = parseAccompanying(r.SHARE_NAMES);
    const guests = [lead, ...shareNames].filter(Boolean);
    out.push({
      villa: r.ROOM || "",
      villaType: r.ROOM_CATEGORY_LABEL || "",
      departure: normDate(r.CHAR_DEPART || r.DEPARTURE),
      departureTime: r.DEPARTURE_TIME || "",
      confirmation: r.RESV_NAME_ID || "",
      adults: parseInt(r.ADULTS || "1", 10) || 1,
      children: parseInt(r.CHILDREN || "0", 10) || 0,
      guests,
      name: buildName(guests, parseInt(r.CHILDREN || "0", 10) || 0),
      specialRequests: r.SPECIAL_REQUESTS || "",
      hm: detectHM(r.SPECIAL_REQUESTS, ""),
      source: "departure",
    });
  }
  return out;
}

module.exports = {
  parseArrivals,
  parseDepartures,
  parseDelimited,
  buildName,
  parseOperaName,
  parseAccompanying,
  normDate,
  normTitle,
  titleCase,
};
