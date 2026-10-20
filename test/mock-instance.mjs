// A tiny in-memory imitation of the ServiceNow REST surface this server uses.
// Enough to exercise every code path without an instance. Not a faithful emulator.
import http from "node:http";

export const USER = "mcp_local";
export const PASSWORD = "secret";
const ME_ID = "6816f79cc0a8016401c5a33be04be441";
// Deterministic, hex-only sys_ids from a short tag.
export const ID = (tag) => Buffer.from(tag).toString("hex").padEnd(32, "0");

const db = {
  sys_user: [
    { sys_id: ME_ID, user_name: USER, name: "MCP Local", email: "mcp@example.com", active: "true", web_service_access_only: "true", locked_out: "false" },
    { sys_id: "a".repeat(32), user_name: "abel.tuter", name: "Abel Tuter", email: "abel@example.com", active: "true", web_service_access_only: "false", locked_out: "false" },
  ],
  sys_user_role: [
    { sys_id: ID("r1"), name: "admin", description: "Administrator" },
    { sys_id: ID("r2"), name: "itil", description: "ITIL" },
    { sys_id: ID("r3"), name: "snc_read_only", description: "Read only" },
  ],
  sys_user_has_role: [
    { sys_id: ID("h1"), user: ME_ID, role: ID("r1"), inherited: "false" },
    { sys_id: ID("h2"), user: ME_ID, role: ID("r2"), inherited: "true", included_in_role: ID("r1") },
    { sys_id: ID("h3"), user: ME_ID, role: ID("r3"), inherited: "true", included_in_role: ID("r1") },
  ],
  sys_user_role_contains: [],
  sys_user_preference: [],
  sys_scope: [
    { sys_id: "global", name: "Global", scope: "global" },
    { sys_id: ID("s1"), name: "Acme App", scope: "x_acme_app" },
  ],
  sys_update_set: [
    { sys_id: ID("u1"), name: "Default", state: "in progress", application: "global" },
    { sys_id: ID("u2"), name: "Default", state: "in progress", application: ID("s1") },
    { sys_id: ID("u3"), name: "ACME feature", state: "in progress", application: ID("s1") },
  ],
  sys_db_object: [
    { sys_id: ID("t1"), name: "incident", label: "Incident", super_class: ID("t2") },
    { sys_id: ID("t2"), name: "task", label: "Task", super_class: "" },
    { sys_id: ID("t3"), name: "sys_user", label: "User", super_class: "" },
  ],
  sys_dictionary: [
    { sys_id: ID("d1"), name: "task", element: "number", column_label: "Number", internal_type: "string", reference: "", mandatory: "false", read_only: "true", max_length: "40", default_value: "" },
    { sys_id: ID("d2"), name: "task", element: "short_description", column_label: "Short description", internal_type: "string", reference: "", mandatory: "true", read_only: "false", max_length: "160", default_value: "" },
    { sys_id: ID("d3"), name: "task", element: "assigned_to", column_label: "Assigned to", internal_type: "reference", reference: "sys_user", mandatory: "false", read_only: "false", max_length: "32", default_value: "" },
    { sys_id: ID("d4"), name: "incident", element: "priority", column_label: "Priority", internal_type: "integer", reference: "", mandatory: "false", read_only: "false", max_length: "40", default_value: "4" },
    { sys_id: ID("d5"), name: "incident", element: "caller_id", column_label: "Caller", internal_type: "reference", reference: "sys_user", mandatory: "false", read_only: "false", max_length: "32", default_value: "" },
    { sys_id: ID("d6"), name: "task", element: "", column_label: "Task", internal_type: "collection", reference: "", mandatory: "false", read_only: "false", max_length: "40", default_value: "" },
  ],
  sys_choice: [
    { sys_id: ID("c1"), name: "incident", element: "priority", value: "1", label: "1 - Critical", inactive: "false", language: "en", sequence: "1", dependent_value: "" },
    { sys_id: ID("c2"), name: "incident", element: "priority", value: "4", label: "4 - Low", inactive: "false", language: "en", sequence: "4", dependent_value: "" },
  ],
  sys_security_acl: [
    { sys_id: ID("acl1"), name: "incident", operation: "write", type: "record", active: "true", admin_overrides: "true", condition: "", script: "", description: "" },
    { sys_id: ID("acl2"), name: "incident.*", operation: "read", type: "record", active: "true", admin_overrides: "true", condition: "", script: "answer = true;", description: "" },
  ],
  sys_security_acl_role: [
    { sys_id: ID("ar1"), sys_security_acl: ID("acl1"), sys_user_role: ID("r2") },
  ],
  incident: [
    { sys_id: ID("i1"), number: "INC0010001", short_description: "Email down", description: "<p>Mail &amp; calendar <b>broken</b></p>", priority: "1", state: "2", active: "true", caller_id: "a".repeat(32), assigned_to: "", comments_and_work_notes: "x".repeat(5000), sys_updated_on: "2026-10-01 10:00:00" },
    { sys_id: ID("i2"), number: "INC0010002", short_description: "Printer jam", description: "", priority: "4", state: "1", active: "true", caller_id: "", assigned_to: "", comments_and_work_notes: "", sys_updated_on: "2026-10-02 10:00:00" },
    { sys_id: ID("i3"), number: "INC0010003", short_description: "VPN slow", description: "", priority: "4", state: "7", active: "false", caller_id: "", assigned_to: "", comments_and_work_notes: "", sys_updated_on: "2026-10-03 10:00:00" },
  ],
};

const REFS = { "incident.caller_id": "sys_user", "incident.assigned_to": "sys_user", "sys_user_has_role.role": "sys_user_role", "sys_user_has_role.user": "sys_user", "sys_user_has_role.included_in_role": "sys_user_role", "sys_update_set.application": "sys_scope", "sys_db_object.super_class": "sys_db_object", "sys_security_acl_role.sys_user_role": "sys_user_role", "sys_security_acl_role.sys_security_acl": "sys_security_acl", "sys_user_preference.user": "sys_user" };
const DISPLAY_FIELD = { sys_user: "name", sys_user_role: "name", sys_scope: "name", sys_db_object: "name", sys_security_acl: "name", sys_update_set: "name" };

export const forbidden = new Set(); // tables that return 403, togglable from tests
let idCounter = 0;
const newId = () => (++idCounter).toString(16).padStart(32, "f");

function resolve(table, rec, path) {
  // dot-walk: a.b.c
  const parts = path.split(".");
  let t = table, r = rec;
  for (let i = 0; i < parts.length; i++) {
    const f = parts[i];
    if (i === parts.length - 1) return { value: r?.[f] ?? "", table: t, field: f };
    const refT = REFS[`${t}.${f}`];
    if (!refT) return { value: "", table: t, field: f };
    r = db[refT].find((x) => x.sys_id === r?.[f]);
    t = refT;
    if (!r) return { value: "", table: t, field: f };
  }
}

function display(table, field, value) {
  const refT = REFS[`${table}.${field}`];
  if (refT && value) {
    const r = db[refT].find((x) => x.sys_id === value);
    return r ? r[DISPLAY_FIELD[refT] ?? "name"] ?? value : value;
  }
  return value;
}

function matchTerm(table, rec, term, meId) {
  term = term.replace(/javascript:gs\.getUserID\(\)/g, meId);
  const m = term.match(/^([a-z0-9_.]+)(ISNOTEMPTY|ISEMPTY|STARTSWITH|LIKE|IN|!=|=)(.*)$/s);
  if (!m) return true;
  const [, field, op, x] = m;
  const v = String(resolve(table, rec, field).value ?? "");
  switch (op) {
    case "ISNOTEMPTY": return v !== "";
    case "ISEMPTY": return v === "";
    case "STARTSWITH": return v.startsWith(x);
    case "LIKE": return v.toLowerCase().includes(x.toLowerCase());
    case "IN": return x.split(",").includes(v);
    case "!=": return v !== x;
    default: return v === x;
  }
}

function runQuery(table, q, meId) {
  let rows = db[table];
  if (!rows) return null;
  const terms = (q ?? "").split("^").filter(Boolean);
  const orderBy = [];
  const groups = [[]];
  for (const t of terms) {
    if (t.startsWith("ORDERBYDESC")) orderBy.push([t.slice(11), -1]);
    else if (t.startsWith("ORDERBY")) orderBy.push([t.slice(7), 1]);
    else if (t.startsWith("OR")) groups[groups.length - 1].push({ or: true, term: t.slice(2) });
    else groups[groups.length - 1].push({ or: false, term: t });
  }
  const conds = groups[0];
  rows = rows.filter((r) => {
    // naive: AND chain, but an OR term ORs with the previous term
    let result = true;
    for (let i = 0; i < conds.length; i++) {
      const m = matchTerm(table, r, conds[i].term, meId);
      if (conds[i].or) result = result || m;
      else result = result && m;
    }
    return result;
  });
  for (const [f, dir] of orderBy.reverse()) rows = [...rows].sort((a, b) => (String(a[f]) < String(b[f]) ? -dir : String(a[f]) > String(b[f]) ? dir : 0));
  return rows;
}

function project(table, rec, fields, dv) {
  const keys = fields ? fields.split(",") : Object.keys(rec);
  const out = {};
  for (const k of keys) {
    const { value, table: t, field } = resolve(table, rec, k);
    const disp = display(t, field, value);
    out[k] = dv === "all" ? { display_value: disp, value } : dv === "true" ? disp : value;
  }
  return out;
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

export const state = { progress: {} };

async function handle(method, pathname, params, body, meId) {
  const seg = pathname.split("/").filter(Boolean);
  // Table API
  if (seg[0] === "api" && seg[1] === "now" && seg[2] === "table") {
    const table = seg[3];
    const sysId = seg[4];
    if (forbidden.has(table)) return [403, { error: { message: "Insufficient rights to query records", detail: "" } }];
    if (!db[table]) return [400, { error: { message: `Invalid table ${table}` } }];
    const dv = params.get("sysparm_display_value") ?? "false";
    const fields = params.get("sysparm_fields") || undefined;
    if (method === "GET" && !sysId) {
      const rows = runQuery(table, params.get("sysparm_query"), meId);
      const limit = Number(params.get("sysparm_limit") ?? 10000);
      const offset = Number(params.get("sysparm_offset") ?? 0);
      return [200, { result: rows.slice(offset, offset + limit).map((r) => project(table, r, fields, dv)) }];
    }
    if (method === "GET" && sysId) {
      const r = db[table].find((x) => x.sys_id === sysId);
      return r ? [200, { result: project(table, r, fields, dv) }] : [404, { error: { message: "No Record found" } }];
    }
    if (method === "POST") {
      const rec = { sys_id: newId(), ...Object.fromEntries(Object.entries(body ?? {}).map(([k, v]) => [k, String(v)])) };
      if (table === "incident") rec.number = `INC00100${db.incident.length + 1}`;
      db[table].push(rec);
      return [201, { result: project(table, rec, undefined, dv) }];
    }
    if (method === "PATCH" || method === "PUT") {
      const r = db[table].find((x) => x.sys_id === sysId);
      if (!r) return [404, { error: { message: "No Record found" } }];
      for (const [k, v] of Object.entries(body ?? {})) r[k] = String(v);
      r.sys_updated_on = "2026-10-20 12:00:00";
      return [200, { result: project(table, r, undefined, dv) }];
    }
    if (method === "DELETE") {
      const i = db[table].findIndex((x) => x.sys_id === sysId);
      if (i < 0) return [404, { error: { message: "No Record found" } }];
      db[table].splice(i, 1);
      return [204, undefined];
    }
  }
  // Aggregate API
  if (seg[0] === "api" && seg[1] === "now" && seg[2] === "stats") {
    const table = seg[3];
    if (!db[table]) return [400, { error: { message: `Invalid table ${table}` } }];
    const rows = runQuery(table, params.get("sysparm_query"), meId);
    const groupBy = params.get("sysparm_group_by");
    const entry = (rs, gvals) => ({ groupby_fields: gvals, stats: { count: String(rs.length) } });
    if (!groupBy) return [200, { result: entry(rows, []) }];
    const buckets = new Map();
    for (const r of rows) {
      const k = groupBy.split(",").map((f) => r[f] ?? "").join("|");
      (buckets.get(k) ?? buckets.set(k, []).get(k)).push(r);
    }
    return [200, { result: [...buckets.entries()].map(([k, rs]) => entry(rs, groupBy.split(",").map((f, i) => ({ field: f, value: k.split("|")[i] })))) }];
  }
  // Batch API
  if (pathname === "/api/now/v1/batch" && method === "POST") {
    const serviced = [];
    for (const r of body.rest_requests) {
      const u = new URL(r.url, "http://x");
      const subBody = r.body ? JSON.parse(Buffer.from(r.body, "base64").toString("utf8")) : undefined;
      const [status, out] = await handle(r.method, u.pathname, u.searchParams, subBody, meId);
      serviced.push({ id: r.id, status_code: status, status_text: status < 300 ? "OK" : "Error", execution_time: 3, body: Buffer.from(JSON.stringify(out ?? {})).toString("base64"), headers: [] });
    }
    return [200, { batch_request_id: body.batch_request_id, serviced_requests: serviced, unserviced_requests: [] }];
  }
  // CICD
  if (seg[0] === "api" && seg[1] === "sn_cicd") {
    if (seg[2] === "progress") {
      const p = state.progress[seg[3]];
      return p ? [200, { result: p }] : [404, { error: { message: "Progress not found" } }];
    }
    const id = newId();
    state.progress[id] = { status: "2", status_label: "Successful", status_message: "done", percent_complete: 100, links: { progress: { id } } };
    return [202, { result: { status: "0", status_label: "Pending", status_message: "queued", percent_complete: 0, links: { progress: { id } } } }];
  }
  // Service Catalog
  if (seg[0] === "api" && seg[1] === "sn_sc") {
    if (seg[3] === "catalogs" && !seg[4]) return [200, { result: [{ sys_id: ID("cat1"), title: "Service Catalog", description: "<p>Main</p>" }] }];
    if (seg[3] === "catalogs" && seg[5] === "categories") return [200, { result: [{ sys_id: ID("cg1"), title: "Hardware", description: "", item_count: 1 }] }];
    if (seg[3] === "items" && !seg[4]) return [200, { result: [{ sys_id: ID("it1"), name: "Laptop", sys_class_name: "sc_cat_item", price: "$1,000.00", category: { title: "Hardware" }, short_description: "<b>A laptop</b>" }] }];
    if (seg[3] === "items" && seg[4] && !seg[5]) return [200, { result: { sys_id: seg[4], name: "Laptop", price: "$1,000.00", description: "<p>Big</p>", short_description: "A laptop", variables: [{ name: "model", label: "Model", type: 3, friendly_type: "select", mandatory: true, choices: [{ label: "Pro", value: "pro" }] }] } }];
    if (seg[3] === "items" && seg[5] === "order_now") return [200, { result: { request_number: "REQ0010001", request_id: newId(), table: "sc_request" } }];
    if (seg[3] === "items" && seg[5] === "add_to_cart") return [200, { result: { cart_id: ID("crt1"), items: [{ name: "Laptop", quantity: 1 }], subtotal: "$1,000.00" } }];
    if (seg[3] === "cart" && !seg[4]) return [403, { error: { message: "User Not Authorized" } }];
  }
  if (pathname === "/api/global/user_role_inheritance") {
    return [200, { result: { huge: "y".repeat(200000) } }];
  }
  return [404, { error: { message: `mock: no route for ${method} ${pathname}` } }];
}

export function startMock(port = 0) {
  const server = http.createServer(async (req, res) => {
    const auth = req.headers.authorization ?? "";
    const expected = "Basic " + Buffer.from(`${USER}:${PASSWORD}`).toString("base64");
    if (auth !== expected) return send(res, 401, { error: { message: "User Not Authenticated", detail: "Required to provide Auth information" } });
    const url = new URL(req.url, "http://localhost");
    try {
      const body = await readBody(req);
      const [status, out] = await handle(req.method, url.pathname, url.searchParams, body, ME_ID);
      send(res, status, out);
    } catch (e) {
      send(res, 500, { error: { message: String(e?.message ?? e) } });
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { url } = await startMock(Number(process.env.PORT ?? 18080));
  console.log(`mock instance on ${url}  (user ${USER} / ${PASSWORD})`);
}
