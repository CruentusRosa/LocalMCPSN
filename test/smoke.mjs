// End-to-end smoke test: starts the mock instance, launches server.mjs over stdio
// as an MCP client would, and walks the checklist from the spec.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { startMock, USER, PASSWORD, forbidden, ID } from "./mock-instance.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "..", "server.mjs");

async function connect(env) {
  const client = new Client({ name: "smoke", version: "0.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { ...process.env, ...env }, stderr: "pipe" });
  await client.connect(transport);
  return client;
}

const text = (r) => r.content.map((c) => c.text).join("\n");
let passed = 0;
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}

const { server: mock, url } = await startMock();
const base = { SN_URL: url, SN_USER: USER, SN_PASSWORD: PASSWORD };
console.log(`mock instance at ${url}`);

// ---- full server -----------------------------------------------------------
const client = await connect(base);
const tools = (await client.listTools()).tools;
const names = tools.map((t) => t.name);
const call = (name, args = {}) => client.callTool({ name, arguments: args });

await step(`tool list (${names.length} tools)`, () => {
  for (const n of ["whoami", "query_table", "get_record", "aggregate", "batch", "describe_table", "describe_acls", "create_record", "update_record", "delete_record", "create_user", "create_role", "assign_role", "remove_role", "set_scope", "set_update_set", "plugin", "app", "batch_install", "get_progress", "list_catalogs", "search_catalog", "describe_catalog_item", "order_item", "cart"]) assert.ok(names.includes(n), `missing tool ${n}`);
  assert.ok(names.length <= 26, "tool list grew; every tool is a permanent token tax");
  const confirmTools = tools.filter((t) => t.inputSchema?.properties?.confirm);
  for (const t of confirmTools) assert.equal(t.inputSchema.properties.confirm.default, false, `${t.name}: confirm must default to false`);
});

await step("whoami returns user, direct roles only, scope and update set", async () => {
  const t = text(await call("whoami"));
  assert.match(t, /User: mcp_local/);
  assert.match(t, /Direct roles \(1\): admin/);
  assert.match(t, /Total roles incl\. inherited: 3/);
  assert.match(t, /Current scope: \(not set\)/);
});

await step("query_table with fields returns a markdown table", async () => {
  const t = text(await call("query_table", { table: "incident", query: "active=true", fields: ["number", "short_description", "caller_id"], limit: 5 }));
  assert.match(t, /\| number \| short_description \| caller_id \|/);
  assert.match(t, /INC0010001/);
  assert.match(t, /Abel Tuter \[a{32}\]/, "reference should render as Display [sys_id]");
  assert.doesNotMatch(t, /INC0010003/);
});

await step("query_table without fields strips empties, HTML and long text", async () => {
  const t = text(await call("query_table", { table: "incident", query: "number=INC0010001" }));
  assert.match(t, /Mail & calendar broken/);
  assert.doesNotMatch(t, /<p>/);
  assert.doesNotMatch(t, /"assigned_to"/, "empty field must be dropped");
  assert.match(t, /truncated \d+ chars/);
});

await step("get_record", async () => {
  const t = text(await call("get_record", { table: "incident", sys_id: ID("i2"), fields: ["number", "priority"] }));
  assert.match(t, /INC0010002/);
});

await step("get_record rejects a malformed sys_id", async () => {
  const r = await call("get_record", { table: "incident", sys_id: "nope" });
  assert.ok(r.isError, "expected isError");
});

await step("aggregate grouped by priority", async () => {
  const t = text(await call("aggregate", { table: "incident", group_by: ["priority"] }));
  assert.match(t, /\| priority \| count \|/);
  assert.match(t, /\| 4 \| 2 \|/);
});

await step("batch with three reads returns three results with status codes", async () => {
  const t = text(await call("batch", { requests: [
    { id: "a", path: "/api/now/table/incident?sysparm_limit=1&sysparm_fields=number" },
    { id: "b", path: "/api/now/table/sys_user?sysparm_limit=1&sysparm_fields=user_name" },
    { id: "c", path: "/api/now/table/nope" },
  ] }));
  assert.match(t, /### a: HTTP 200/);
  assert.match(t, /### b: HTTP 200/);
  assert.match(t, /### c: HTTP 400/);
});

await step("batch caps a huge sub-response", async () => {
  const t = text(await call("batch", { requests: [{ id: "big", path: "/api/global/user_role_inheritance?user_sysid=x" }] }));
  assert.ok(t.length < 10000, `response too large: ${t.length}`);
  assert.match(t, /truncated/);
});

await step("batch with a write needs confirm", async () => {
  const r = await call("batch", { requests: [{ method: "POST", path: "/api/now/table/incident", body: { short_description: "x" } }] });
  assert.match(text(r), /PREVIEW ONLY/);
});

await step("describe_table walks the hierarchy and shows choices", async () => {
  const t = text(await call("describe_table", { table: "incident", choices_for: "priority" }));
  assert.match(t, /incident \("Incident"\), extends task: 5 fields/);
  assert.match(t, /\| short_description \| Short description \| string \|  \| yes \|  \| 160 \| task \|/);
  assert.match(t, /Referenced by \(0\)/);
  assert.match(t, /1 - Critical/);
});

await step("describe_table still works when sys_db_object is 403", async () => {
  forbidden.add("sys_db_object");
  const t = text(await call("describe_table", { table: "incident", include_referencing: false }));
  forbidden.delete("sys_db_object");
  assert.match(t, /Note: sys_db_object not readable \(403\)/);
  assert.match(t, /\| priority \|/);
  assert.doesNotMatch(t, /short_description/, "inherited fields cannot be known without the hierarchy");
});

await step("describe_acls lists roles per ACL", async () => {
  const t = text(await call("describe_acls", { table: "incident" }));
  assert.match(t, /\| incident \| write \| itil \|/);
  assert.match(t, /\| incident\.\* \| read \| \(none\) \|/);
});

await step("update_record without confirm previews and changes nothing", async () => {
  const t = text(await call("update_record", { table: "incident", sys_id: ID("i2"), data: { priority: 1 } }));
  assert.match(t, /PREVIEW ONLY/);
  assert.match(t, /- priority: "4" -> 1/);
  const after = text(await call("get_record", { table: "incident", sys_id: ID("i2"), fields: ["priority"] }));
  assert.match(after, /"priority": "4"/);
});

await step("update_record with confirm changes the record", async () => {
  const t = text(await call("update_record", { table: "incident", sys_id: ID("i2"), data: { priority: 1 }, confirm: true }));
  assert.match(t, /Updated incident INC0010002/);
  assert.match(t, /- priority: "4" -> "1"/);
});

await step("create_record and delete_record round trip", async () => {
  const c = text(await call("create_record", { table: "incident", data: { short_description: "from test" }, confirm: true }));
  const id = c.match(/sys_id ([0-9a-f]{32})/)[1];
  const p = text(await call("delete_record", { table: "incident", sys_id: id }));
  assert.match(p, /PREVIEW ONLY/);
  const d = text(await call("delete_record", { table: "incident", sys_id: id, confirm: true }));
  assert.match(d, /Deleted incident/);
});

await step("write tools return a clean 403, not a stack trace", async () => {
  forbidden.add("incident");
  const r = await call("create_record", { table: "incident", data: { short_description: "x" }, confirm: true });
  forbidden.delete("incident");
  assert.ok(r.isError);
  assert.match(text(r), /authorization denied \(403\)/);
  assert.doesNotMatch(text(r), /at .*\.mjs/);
});

await step("assign_role / remove_role, including the inherited case", async () => {
  const p = text(await call("assign_role", { user: "abel.tuter", role: "itil" }));
  assert.match(p, /PREVIEW ONLY/);
  const g = text(await call("assign_role", { user: "abel.tuter", role: "itil", confirm: true }));
  assert.match(g, /Granted itil to abel.tuter/);
  const rm = text(await call("remove_role", { user: "abel.tuter", role: "itil", confirm: true }));
  assert.match(rm, /Removed direct grant/);
  const inh = await call("remove_role", { user: "mcp_local", role: "itil", confirm: true });
  assert.ok(inh.isError);
  assert.match(text(inh), /inherited .* via admin/);
});

await step("create_role and create_user", async () => {
  const r = text(await call("create_role", { name: "x_test_role", contains_roles: ["itil"], confirm: true }));
  assert.match(r, /Created role x_test_role/);
  assert.match(r, /contains itil: added/);
  const u = text(await call("create_user", { user_name: "svc.test", password: "pw", roles: ["x_test_role"], confirm: true }));
  assert.match(u, /Created user svc.test/);
  assert.match(u, /x_test_role: granted/);
  const dup = await call("create_user", { user_name: "svc.test" });
  assert.ok(dup.isError);
});

await step("set_scope then whoami shows the new scope", async () => {
  const t = text(await call("set_scope", { scope: "x_acme_app", confirm: true }));
  assert.match(t, /Scope is now Acme App/);
  const w = text(await call("whoami"));
  assert.match(w, /Current scope: Acme App \(x_acme_app\)/);
});

await step("set_update_set refuses a set from another scope and disambiguates Default", async () => {
  const wrong = await call("set_update_set", { update_set: ID("u1"), confirm: true });
  assert.ok(wrong.isError);
  assert.match(text(wrong), /belongs to scope Global/);
  const def = text(await call("set_update_set", { update_set: "Default", confirm: true }));
  assert.match(def, new RegExp(`Current update set is now Default \\[${ID("u2")}\\] in scope Acme App`));
  const w = text(await call("whoami"));
  assert.match(w, /Current update set: Default \(state in progress, application Acme App\)/);
});

await step("ops are async and pollable", async () => {
  const p = text(await call("plugin", { action: "activate", plugin_id: "com.snc.x", confirm: true }));
  const id = p.match(/progress_id: ([0-9a-f]{32})/)[1];
  const g = text(await call("get_progress", { progress_id: id }));
  assert.match(g, /status: Successful \(100%\)/);
  const b = text(await call("batch_install", { name: "b", packages: [{ id: "x", type: "plugin" }] }));
  assert.match(b, /PREVIEW ONLY/);
});

await step("catalog tools strip HTML and surface variable names", async () => {
  const s = text(await call("search_catalog", { text: "laptop" }));
  assert.match(s, /\| Laptop \|/);
  assert.doesNotMatch(s, /<b>/);
  const d = text(await call("describe_catalog_item", { sys_id: ID("it1") }));
  assert.match(d, /"name": "model"/);
  assert.match(d, /Pro=pro/);
  const c = await call("cart");
  assert.ok(c.isError);
  assert.match(text(c), /403/);
  const o = text(await call("order_item", { sys_id: ID("it1"), variables: { model: "pro" }, confirm: true }));
  assert.match(o, /Request REQ0010001/);
});

await client.close();

// ---- wrong password ---------------------------------------------------------
await step("401 is reported as a credentials problem", async () => {
  const c = await connect({ ...base, SN_PASSWORD: "wrong" });
  const r = await c.callTool({ name: "whoami", arguments: {} });
  assert.ok(r.isError);
  assert.match(text(r), /authentication failed \(401\)/);
  await c.close();
});

// ---- read-only mode ---------------------------------------------------------
await step("SN_READ_ONLY exposes no write tools", async () => {
  const c = await connect({ ...base, SN_READ_ONLY: "true" });
  const ro = (await c.listTools()).tools.map((t) => t.name);
  for (const n of ["create_record", "update_record", "delete_record", "assign_role", "set_scope", "plugin", "order_item", "cart"]) assert.ok(!ro.includes(n), `${n} should be hidden`);
  for (const n of ["whoami", "query_table", "describe_table", "search_catalog"]) assert.ok(ro.includes(n), `${n} should be present`);
  const w = text(await c.callTool({ name: "whoami", arguments: {} }));
  assert.match(w, /READ-ONLY/);
  await c.close();
});

await step("SN_TOOLSETS trims tool groups", async () => {
  const c = await connect({ ...base, SN_TOOLSETS: "core" });
  const n = (await c.listTools()).tools.map((t) => t.name);
  assert.ok(n.includes("query_table") && !n.includes("search_catalog") && !n.includes("set_scope"));
  await c.close();
});

mock.close();
console.log(`\n${passed} step(s) passed${process.exitCode ? ", some FAILED" : ""}`);
