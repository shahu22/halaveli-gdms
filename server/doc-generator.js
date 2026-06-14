// ============================================================================
//  DOCUMENT GENERATOR
//  Builds a branded Word voucher from a template definition + guest data,
//  then converts to PDF via LibreOffice headless.
// ============================================================================
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const {
  Document, Packer, Paragraph, TextRun, AlignmentType,
} = require("docx");
const { SIGNATORIES: FALLBACK_SIGNATORIES } = require("./templates-catalog");

const PAGE = {
  size: { width: 11906, height: 16838 }, // A4 (matches resort stationery)
  margin: { top: 1700, right: 1440, bottom: 1440, left: 1440 },
};

const { getLang } = require("./languages");

// Render context for the current document (font + direction), set in buildDoc.
let RENDER = { font: null, rtl: false };

// Parse a line that may contain **bold** and _italic_ spans into TextRuns.
function inlineRuns(line, baseOpts = {}) {
  const fontOpt = RENDER.font ? { font: RENDER.font } : {};
  const rtlOpt = RENDER.rtl ? { rightToLeft: true } : {};
  const merged = { ...fontOpt, ...rtlOpt, ...baseOpts };
  const runs = [];
  const regex = /(\*\*[^*]+\*\*|_[^_]+_)/g;
  let last = 0, m;
  while ((m = regex.exec(line)) !== null) {
    if (m.index > last) runs.push(new TextRun({ text: line.slice(last, m.index), ...merged }));
    const token = m[0];
    if (token.startsWith("**")) {
      runs.push(new TextRun({ text: token.slice(2, -2), bold: true, ...merged }));
    } else {
      runs.push(new TextRun({ text: token.slice(1, -1), italics: true, ...merged }));
    }
    last = regex.lastIndex;
  }
  if (last < line.length) runs.push(new TextRun({ text: line.slice(last), ...merged }));
  return runs.length ? runs : [new TextRun({ text: line, ...merged })];
}

function para(line, opts = {}) {
  let { align = AlignmentType.CENTER, spacingAfter = 200, bold, size = 22 } = opts;
  // For RTL languages, flip default centre stays centre but left/right swap.
  if (RENDER.rtl) {
    if (align === AlignmentType.LEFT) align = AlignmentType.RIGHT;
    else if (align === AlignmentType.RIGHT) align = AlignmentType.LEFT;
  }
  return new Paragraph({
    alignment: align,
    bidirectional: RENDER.rtl || undefined,
    spacing: { after: spacingAfter, line: 276 },
    children: inlineRuns(line, { size, ...(bold ? { bold: true } : {}) }),
  });
}

function blank(spacingAfter = 160) {
  return new Paragraph({ spacing: { after: spacingAfter }, children: [new TextRun("")] });
}

// data: { name, confirmation, date, signatoryKey, signatories?, lang? }
function buildDocChildren(template, data) {
  const lang = getLang(data.lang || template.lang || "en");
  RENDER = { font: lang.font, rtl: !!lang.rtl };
  const children = [];
  const sigMap = data.signatories || FALLBACK_SIGNATORIES;
  const sig = sigMap[data.signatoryKey || template.signatory] || Object.values(sigMap)[0] || { name: "", title: "" };

  // Default alignment for this document (vouchers center; letters left-align)
  const baseAlign = template.align === "left" ? AlignmentType.LEFT : AlignmentType.CENTER;

  // Optional top date. topDateText is an exact pre-formatted string (departure
  // letters); otherwise fall back to data.date (certificates).
  const topDateStr = template.topDateText || (template.topDate ? data.date : "");
  if (topDateStr) {
    children.push(para(topDateStr, { align: AlignmentType.RIGHT, spacingAfter: 360 }));
  }

  // Salutation
  children.push(para(`Dear ${data.name},`, { align: baseAlign, spacingAfter: 300, size: 24 }));
  children.push(blank());

  // Intro
  if (template.intro) { children.push(para(template.intro, { align: baseAlign, spacingAfter: 260 })); }

  // Lead-in sentence
  if (template.lead) { children.push(para(template.lead, { align: baseAlign, spacingAfter: 260 })); }

  // Body lines (substitute {{date}} where present)
  for (const raw of template.body || []) {
    let line = raw;
    if (line.includes("{{date}}")) {
      const dateText = data.date
        ? `${template.dateLabel ? template.dateLabel + " " : ""}${data.date}`
        : "";
      line = line.replace("{{date}}", dateText);
      if (!line.trim()) continue;
    }
    const isBullet = line.startsWith("•");
    children.push(para(line, {
      align: isBullet ? AlignmentType.LEFT : baseAlign,
      spacingAfter: isBullet ? 90 : 220,
    }));
  }
  children.push(blank());

  // Closing
  if (template.closing) { children.push(para(template.closing, { align: baseAlign, spacingAfter: 240 })); }
  if (template.contact) { children.push(para(template.contact, { align: baseAlign, spacingAfter: 300 })); }

  // Optional note
  if (template.note) {
    children.push(para(`_${template.note}_`, { align: baseAlign, spacingAfter: 240, size: 18 }));
  }

  // Sign-off block
  children.push(blank(120));
  children.push(para(template.signoff || "Warmest regards,", { align: baseAlign, spacingAfter: 360 }));
  children.push(para(sig.name, { align: baseAlign, spacingAfter: 40 }));
  children.push(para(sig.title, { align: baseAlign, spacingAfter: template.resortLine ? 40 : 400 }));
  if (template.resortLine) {
    children.push(para(template.resortLine, { align: baseAlign, spacingAfter: 400 }));
  }

  // Confirmation number, right-aligned at the foot
  if (data.confirmation) {
    children.push(new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { before: 600 },
      children: [new TextRun({ text: data.confirmation, size: 20, color: "555555" })],
    }));
  }
  return children;
}

function buildDoc(template, data) {
  const children = buildDocChildren(template, data);
  return new Document({
    styles: { default: { document: { run: { font: RENDER.font || "Calibri", size: 22 } } } },
    sections: [{ properties: { page: PAGE }, children }],
  });
}

async function generateDocx(template, data, outPath) {
  const doc = buildDoc(template, data);
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outPath, buffer);
  return outPath;
}

// Build a single Document containing many letters, each on its own page.
// items: [{ template, data }]
async function generateMultiDocx(items, outPath) {
  const docSections = items.map(({ template, data }) => ({
    properties: { page: PAGE },
    children: buildDocChildren(template, data),
  }));
  const doc = new Document({
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    sections: docSections.length ? docSections : [{ properties: { page: PAGE }, children: [] }],
  });
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outPath, buffer);
  return outPath;
}

// Convert a docx to pdf using LibreOffice headless.
function convertToPdf(docxPath, outDir) {
  return new Promise((resolve, reject) => {
    const soffice = process.env.SOFFICE_BIN || "soffice";
    execFile(
      soffice,
      ["--headless", "--convert-to", "pdf", "--outdir", outDir, docxPath],
      { timeout: 60000 },
      (err) => {
        if (err) return reject(err);
        const pdf = path.join(outDir, path.basename(docxPath).replace(/\.docx$/i, ".pdf"));
        if (fs.existsSync(pdf)) resolve(pdf);
        else reject(new Error("PDF not produced"));
      }
    );
  });
}

module.exports = { generateDocx, generateMultiDocx, convertToPdf, buildDoc, buildDocChildren };
