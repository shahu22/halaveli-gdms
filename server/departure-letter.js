// ============================================================================
//  DEPARTURE LETTER
//  Builds the departure-letter content for a guest, applying the conditional
//  logic for transport (seaplane/speedboat) and destination (international/local).
//  Returns a template-shaped object the existing doc-generator can render
//  (left-aligned, date at top).
// ============================================================================

// Format a JS date as "Sunday, June 14, 2026"
function longDate(d) {
  const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const months = ["January","February","March","April","May","June","July","August",
    "September","October","November","December"];
  return `${days[d.getDay()]}, ${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

// Build the departure-details bullet lines from the guest's fields.
function detailLines(g) {
  const transport = (g.transport_type || "seaplane").toLowerCase();
  const dest = (g.destination_type || "international").toLowerCase();
  const transferLabel = transport === "speedboat" ? "Speedboat departure" : "Seaplane departure";
  const lines = [
    `• Luggage collection: ${g.luggage_time || "__:__"} hrs – Halaveli time`,
    `• Checkout time: ${g.checkout_time || "__:__"} hrs – Halaveli time`,
    `• ${transferLabel}: ${g.transfer_time || "__:__"} hrs – Halaveli time`,
  ];
  if (dest === "local") {
    lines.push(`• Your Next Destination: ${g.next_destination || "________"}`);
  } else {
    lines.push(`• International Flight: ${g.departure_flight || "_____"} at ${g.intl_flight_time || "__:__"} hrs – Male' time`);
  }
  return lines;
}

// Returns a template-shaped object for the doc-generator.
// data carries name/date/signatory; g is the guest booking (for the detail logic).
function buildDepartureTemplate(g, printDateISO) {
  const transport = (g.transport_type || "seaplane").toLowerCase();
  const printed = printDateISO ? new Date(printDateISO + "T00:00:00") : new Date();

  const body = [
    "As your stay with us comes to an end, we would like to sincerely thank you for choosing Constance Halaveli Maldives. It has been a true pleasure to have you with us, and we hope your time here has been filled with relaxation and beautiful memories.",
    "We are pleased to share your departure details below:",
    ...detailLines(g),
    "A copy of your invoice has been enclosed for your review. Should you have any questions, please feel free to contact our Front Office team at any time.",
  ];

  if (transport !== "speedboat") {
    body.push("Your Halaveli journey will not end there, as our airport team will welcome you after your seaplane ride, offer you access to the Constance Lounge, and then drive you to the international terminal.");
  }
  body.push("We look forward to welcoming you back again very soon.");

  const note = transport !== "speedboat"
    ? "Kindly be informed that the Seaplane Company is a third-party operator. In case of any passenger delays, the seaplane will leave on time and the resort shall not be held any responsibility."
    : "";

  return {
    id: "departure_letter",
    category: "Departure",
    label: "Departure Letter",
    lang: "en",
    topDateText: longDate(printed),   // exact printed date string at the top
    align: "left",                    // departure letters are left-aligned
    letterheadSpace: 1400,            // top gap for the printed letterhead logo
    intro: "",
    lead: "",
    body,
    closing: "",
    contact: "",
    note,
    signoff: "Warm regards,",
    signatory: g.departure_signatory || "silvia",
    resortLine: "Constance Halaveli Maldives",
    hasDate: false,
    dateLabel: "",
    topDate: true,
  };
}

module.exports = { buildDepartureTemplate, longDate, detailLines };
