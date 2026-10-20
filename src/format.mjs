// Response shaping. Everything here exists to keep tokens down: ServiceNow
// records are mostly empty strings, HTML and repeated reference objects.

export const LIMITS = {
  field: Number(process.env.SN_MAX_FIELD_CHARS ?? 1200),
  response: Number(process.env.SN_MAX_RESPONSE_CHARS ?? 24000),
  batchSub: Number(process.env.SN_MAX_BATCH_SUB_CHARS ?? 6000),
};

const HTML_RE = /<\/?[a-z][^>]*>/i;

export function looksHtml(s) {
  return typeof s === "string" && HTML_RE.test(s);
}

export function stripHtml(s) {
  return String(s)
    .replace(/<\s*(br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function truncate(s, max) {
  if (typeof s !== "string" || s.length <= max) return s;
  return `${s.slice(0, max)} …[truncated ${s.length - max} chars]`;
}

// A field as returned with sysparm_display_value=all is {display_value, value, link?}.
// Collapse it to one string: the value when display equals it, "Display [value]" otherwise.
export function compactValue(v) {
  if (v === null || v === undefined || v === "") return undefined;
  if (typeof v === "object" && !Array.isArray(v) && ("value" in v || "display_value" in v || "link" in v)) {
    const val = v.value == null ? "" : String(v.value);
    const disp = v.display_value == null ? "" : String(v.display_value);
    if (!val && !disp) return undefined;
    if (!disp || disp === val) return val;
    if (!val) return disp;
    return `${disp} [${val}]`;
  }
  return v;
}

export function compactRecord(rec, { maxField = LIMITS.field } = {}) {
  const out = {};
  for (const [k, raw] of Object.entries(rec ?? {})) {
    let v = compactValue(raw);
    if (v === undefined) continue;
    if (typeof v === "string") {
      if (looksHtml(v)) v = stripHtml(v);
      v = truncate(v, maxField);
    }
    out[k] = v;
  }
  return out;
}

export function compactRecords(recs, opts) {
  return (recs ?? []).map((r) => compactRecord(r, opts));
}

function cell(v) {
  if (v === undefined || v === null) return "";
  return String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

export function toTable(rows, columns) {
  if (!rows?.length) return "_no rows_";
  const cols = columns?.length ? columns : [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const head = `| ${cols.join(" | ")} |\n| ${cols.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${cols.map((c) => cell(r[c])).join(" | ")} |`).join("\n");
  return `${head}\n${body}`;
}

export function json(obj) {
  return JSON.stringify(obj, null, 1);
}

export function capResponse(text) {
  return truncate(text, LIMITS.response);
}

// MCP result helpers
export function ok(text) {
  return { content: [{ type: "text", text: capResponse(text) }] };
}

export function fail(message) {
  return { content: [{ type: "text", text: capResponse(`Error: ${message}`) }], isError: true };
}

export function preview(title, lines) {
  return ok([`PREVIEW ONLY, nothing changed. ${title}`, ...lines, "", "Call again with confirm: true to apply."].join("\n"));
}
