import { z } from "zod";
import { snRequest, tableQuery, getRecord, createRecord, updateRecord, deleteRecord, getPreference, instanceName, config, ME } from "../sn.mjs";
import { ok, fail, preview, json, toTable, compactRecord, compactRecords, truncate, LIMITS } from "../format.mjs";

const SYS_ID = z.string().regex(/^[0-9a-f]{32}$/i, "sys_id must be 32 hex characters");
const DISPLAY = z.enum(["both", "value", "display"]).default("both").describe("both = 'Display [sys_id]' for references, value = raw values only, display = display values only");

async function resolveScopeName(value) {
  if (!value) return "(not set)";
  if (value === "global") return "Global [global]";
  const r = await tableQuery("sys_scope", { query: `sys_id=${value}`, fields: ["name", "scope"], limit: 1, display: "value" });
  if (!r.ok || !r.data[0]) return `unknown scope [${value}]`;
  return `${r.data[0].name} (${r.data[0].scope}) [${value}]`;
}

async function resolveUpdateSetName(value) {
  if (!value) return "(not set)";
  const r = await tableQuery("sys_update_set", { query: `sys_id=${value}`, fields: ["name", "state", "application.name", "application"], limit: 1, display: "value" });
  if (!r.ok || !r.data[0]) return `unknown update set [${value}]`;
  const u = r.data[0];
  return `${u.name} (state ${u.state}, application ${u["application.name"] || u.application}) [${value}]`;
}

export function registerCore(server, { readOnly }) {
  server.registerTool(
    "whoami",
    {
      title: "Who am I on ServiceNow",
      description: "Instance, authenticated user, direct roles (inherited roles are counted, not listed), current application scope and update set. Call once at the start of a task.",
      inputSchema: z.object({}),
    },
    async () => {
      const cfg = config();
      if (cfg.missing.length) return fail(`Missing environment: ${cfg.missing.join(", ")}`);
      const user = await tableQuery("sys_user", { query: `sys_id=${ME}`, fields: ["sys_id", "user_name", "name", "email", "web_service_access_only", "locked_out", "active"], limit: 1, display: "value" });
      if (!user.ok) return fail(user.message);
      const u = user.data[0];
      if (!u) return fail("Authenticated, but could not read own sys_user record (ACL on sys_user?).");

      const [direct, all, prefs] = await Promise.all([
        tableQuery("sys_user_has_role", { query: `user=${ME}^inherited=false`, fields: ["role.name"], limit: 300, display: "value" }),
        snRequest("GET", "/api/now/stats/sys_user_has_role", { query: { sysparm_query: `user=${ME}`, sysparm_count: "true" } }),
        tableQuery("sys_user_preference", { query: `user=${ME}^nameINapps.current_app,sys_update_set`, fields: ["name", "value"], limit: 5, display: "value" }),
      ]);
      const directRoles = direct.ok ? direct.data.map((r) => r["role.name"]).filter(Boolean).sort() : [];
      const total = all.ok ? Number(all.data?.result?.stats?.count ?? NaN) : NaN;
      const prefMap = Object.fromEntries((prefs.ok ? prefs.data : []).map((p) => [p.name, p.value]));
      const [scope, updateSet] = await Promise.all([resolveScopeName(prefMap["apps.current_app"]), resolveUpdateSetName(prefMap["sys_update_set"])]);

      const lines = [
        `Instance: ${instanceName()}${readOnly ? "  (server in READ-ONLY mode)" : ""}`,
        `User: ${u.user_name} (${u.name}${u.email ? ", " + u.email : ""}) sys_id ${u.sys_id}`,
        `Flags: active=${u.active} web_service_access_only=${u.web_service_access_only} locked_out=${u.locked_out}`,
        `Direct roles (${directRoles.length}): ${directRoles.join(", ") || (direct.ok ? "none" : "unreadable: " + direct.message)}`,
        `Total roles incl. inherited: ${Number.isNaN(total) ? "unknown" : total}`,
        `Current scope: ${scope}`,
        `Current update set: ${updateSet}`,
      ];
      return ok(lines.join("\n"));
    }
  );

  server.registerTool(
    "query_table",
    {
      title: "Query a table",
      description: "Run an encoded query against any table. Returns a markdown table when fields are given, otherwise compact JSON with empty fields removed. Keep limit small and always pass fields when you know them.",
      inputSchema: z.object({
        table: z.string().describe("Table name, e.g. incident"),
        query: z.string().optional().describe("Encoded query, e.g. active=true^priority=1. ORDERBY/ORDERBYDESC allowed."),
        fields: z.array(z.string()).optional().describe("Fields to return. Dot-walking allowed (assigned_to.email)."),
        limit: z.number().int().min(1).max(200).default(20),
        offset: z.number().int().min(0).optional(),
        order_by: z.string().optional().describe("Field to sort by; prefix with - for descending"),
        display: DISPLAY,
      }),
    },
    async ({ table, query, fields, limit, offset, order_by, display }) => {
      const res = await tableQuery(table, { query, fields, limit, offset, orderBy: order_by, display });
      if (!res.ok) return fail(res.message);
      const rows = compactRecords(res.data, { maxField: fields?.length ? 300 : LIMITS.field });
      const head = `${table}: ${rows.length} row(s)${rows.length === limit ? " (limit reached, there may be more; use offset)" : ""}${query ? ` for query \`${query}\`` : ""}`;
      if (fields?.length) return ok(`${head}\n\n${toTable(rows, fields)}`);
      return ok(`${head}\n\n${json(rows)}`);
    }
  );

  server.registerTool(
    "get_record",
    {
      title: "Get one record",
      description: "Read a single record by sys_id. Empty fields are dropped, HTML stripped, long text truncated.",
      inputSchema: z.object({
        table: z.string(),
        sys_id: SYS_ID,
        fields: z.array(z.string()).optional(),
        display: DISPLAY,
      }),
    },
    async ({ table, sys_id, fields, display }) => {
      const res = await getRecord(table, sys_id, { fields, display });
      if (!res.ok) return fail(res.message);
      if (!res.data) return fail(`No ${table} record with sys_id ${sys_id}`);
      return ok(json(compactRecord(res.data)));
    }
  );

  server.registerTool(
    "aggregate",
    {
      title: "Aggregate (count / avg / min / max / sum)",
      description: "Let the instance do the arithmetic via the Aggregate API. Use instead of pulling rows to count them.",
      inputSchema: z.object({
        table: z.string(),
        query: z.string().optional(),
        count: z.boolean().default(true),
        avg_fields: z.array(z.string()).optional(),
        min_fields: z.array(z.string()).optional(),
        max_fields: z.array(z.string()).optional(),
        sum_fields: z.array(z.string()).optional(),
        group_by: z.array(z.string()).optional(),
        having: z.string().optional().describe("e.g. count^>^5 or avg^reassignment_count^>^2"),
        order_by: z.string().optional(),
        display: z.boolean().default(true).describe("Return display values for group-by fields"),
      }),
    },
    async (a) => {
      const res = await snRequest("GET", `/api/now/stats/${encodeURIComponent(a.table)}`, {
        query: {
          sysparm_query: a.query,
          sysparm_count: a.count ? "true" : undefined,
          sysparm_avg_fields: a.avg_fields?.join(","),
          sysparm_min_fields: a.min_fields?.join(","),
          sysparm_max_fields: a.max_fields?.join(","),
          sysparm_sum_fields: a.sum_fields?.join(","),
          sysparm_group_by: a.group_by?.join(","),
          sysparm_having: a.having,
          sysparm_order_by: a.order_by,
          sysparm_display_value: a.display ? "true" : "false",
        },
      });
      if (!res.ok) return fail(res.message);
      const result = res.data?.result;
      const flatten = (entry) => {
        const row = {};
        for (const g of entry.groupby_fields ?? []) row[g.field] = g.value;
        const st = entry.stats ?? {};
        if (st.count !== undefined) row.count = st.count;
        for (const kind of ["avg", "min", "max", "sum"]) for (const [f, v] of Object.entries(st[kind] ?? {})) row[`${kind}(${f})`] = v;
        return row;
      };
      const rows = Array.isArray(result) ? result.map(flatten) : [flatten(result ?? {})];
      return ok(`${a.table} aggregate${a.query ? ` for \`${a.query}\`` : ""}:\n\n${toTable(rows)}`);
    }
  );

  server.registerTool(
    "batch",
    {
      title: "Batch REST calls",
      description: "Up to 25 REST sub-requests in one round trip via /api/now/v1/batch. Paths are relative (/api/now/table/incident?sysparm_limit=1). Non-GET sub-requests require confirm: true. Each sub-response is capped.",
      inputSchema: z.object({
        requests: z.array(z.object({
          id: z.string().optional(),
          method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]).default("GET"),
          path: z.string().describe("Relative API path including query string"),
          body: z.record(z.string(), z.unknown()).optional(),
        })).min(1).max(25),
        confirm: z.boolean().default(false).describe("Required when any sub-request writes"),
      }),
    },
    async ({ requests, confirm }) => {
      const writes = requests.filter((r) => r.method !== "GET");
      if (writes.length && readOnly) return fail("Server is in read-only mode; batch may only contain GET requests.");
      if (writes.length && !confirm) {
        return preview(`Batch contains ${writes.length} write request(s):`, writes.map((r) => `- ${r.method} ${r.path}${r.body ? " " + truncate(JSON.stringify(r.body), 300) : ""}`));
      }
      const rest_requests = requests.map((r, i) => ({
        id: r.id ?? `r${i + 1}`,
        method: r.method,
        url: r.path.startsWith("/") ? r.path : `/${r.path}`,
        exclude_response_headers: true,
        headers: [{ name: "Accept", value: "application/json" }, ...(r.body !== undefined ? [{ name: "Content-Type", value: "application/json" }] : [])],
        ...(r.body !== undefined ? { body: Buffer.from(JSON.stringify(r.body)).toString("base64") } : {}),
      }));
      const res = await snRequest("POST", "/api/now/v1/batch", { body: { batch_request_id: String(Date.now()), rest_requests }, timeoutMs: 60000 });
      if (!res.ok) return fail(res.message);
      const out = [];
      for (const s of res.data?.serviced_requests ?? []) {
        let body = s.body ? Buffer.from(s.body, "base64").toString("utf8") : "";
        try {
          const parsed = JSON.parse(body);
          const r = parsed?.result ?? parsed;
          body = json(Array.isArray(r) ? compactRecords(r) : typeof r === "object" && r ? compactRecord(r) : r);
        } catch { /* keep raw */ }
        out.push(`### ${s.id}: HTTP ${s.status_code} ${s.status_text ?? ""} (${s.execution_time ?? "?"} ms)\n${truncate(body, LIMITS.batchSub)}`);
      }
      for (const u of res.data?.unserviced_requests ?? []) out.push(`### ${u.id ?? u}: NOT SERVICED`);
      return ok(out.join("\n\n"));
    }
  );

  server.registerTool(
    "describe_table",
    {
      title: "Describe a table",
      description: "Fields with type, reference target, mandatory and read-only flags, built dictionary-first (works with modest rights). Includes inherited fields when the table hierarchy is readable, and which other tables reference this one. Optionally the choice list for one field.",
      inputSchema: z.object({
        table: z.string(),
        choices_for: z.string().optional().describe("Field name whose choice list you want"),
        include_referencing: z.boolean().default(true),
      }),
    },
    async ({ table, choices_for, include_referencing }) => {
      const notes = [];
      // Walk the hierarchy via sys_db_object; best effort.
      const chain = [table];
      let label = null;
      let cur = table;
      for (let i = 0; i < 8 && cur; i++) {
        const r = await tableQuery("sys_db_object", { query: `name=${cur}`, fields: ["name", "label", "super_class.name"], limit: 1, display: "value" });
        if (!r.ok) {
          notes.push(`sys_db_object not readable (${r.status}); table label and inherited fields unavailable, showing fields defined directly on ${table} only.`);
          break;
        }
        if (!r.data[0]) {
          if (i === 0) notes.push(`No sys_db_object row named ${table}; the table may not exist.`);
          break;
        }
        if (i === 0) label = r.data[0].label;
        cur = r.data[0]["super_class.name"] || null;
        if (cur) chain.push(cur);
      }
      const dict = await tableQuery("sys_dictionary", {
        query: `nameIN${chain.join(",")}^elementISNOTEMPTY^ORDERBYname^ORDERBYelement`,
        fields: ["name", "element", "column_label", "internal_type", "reference", "mandatory", "read_only", "max_length", "default_value"],
        limit: 1000,
        display: "value",
      });
      if (!dict.ok) return fail(dict.message);
      const rows = dict.data.map((d) => ({
        field: d.element,
        label: d.column_label,
        type: d.internal_type,
        reference: d.reference || "",
        mandatory: d.mandatory === "true" ? "yes" : "",
        read_only: d.read_only === "true" ? "yes" : "",
        max: d.max_length || "",
        on: d.name === table ? "" : d.name,
      }));
      const out = [`${table}${label ? ` ("${label}")` : ""}${chain.length > 1 ? `, extends ${chain.slice(1).join(" > ")}` : ""}: ${rows.length} fields`, ...notes.map((n) => `Note: ${n}`), "", toTable(rows, ["field", "label", "type", "reference", "mandatory", "read_only", "max", "on"])];

      if (include_referencing) {
        const refs = await tableQuery("sys_dictionary", { query: `reference=${table}^internal_type=reference`, fields: ["name", "element"], limit: 60, display: "value" });
        if (refs.ok) out.push("", `Referenced by (${refs.data.length}${refs.data.length === 60 ? "+" : ""}): ${refs.data.map((r) => `${r.name}.${r.element}`).join(", ") || "none"}`);
      }
      if (choices_for) {
        const ch = await tableQuery("sys_choice", { query: `nameIN${chain.join(",")}^element=${choices_for}^inactive=false^language=en^ORDERBYsequence`, fields: ["value", "label", "dependent_value"], limit: 200, display: "value" });
        out.push("", ch.ok ? `Choices for ${choices_for}:\n${toTable(ch.data, ["value", "label", "dependent_value"])}` : `Choices for ${choices_for}: ${ch.message}`);
      }
      return ok(out.join("\n"));
    }
  );

  server.registerTool(
    "describe_acls",
    {
      title: "Describe ACLs on a table",
      description: "Active record ACLs whose name starts with the table, with the roles attached. Use it to find which native role already grants an operation before inventing a new one. Needs rights to read sys_security_acl.",
      inputSchema: z.object({
        table: z.string(),
        operation: z.enum(["read", "write", "create", "delete"]).optional(),
      }),
    },
    async ({ table, operation }) => {
      const acls = await tableQuery("sys_security_acl", {
        query: `nameSTARTSWITH${table}^active=true^type=record${operation ? `^operation=${operation}` : ""}^ORDERBYname`,
        fields: ["sys_id", "name", "operation", "admin_overrides", "condition", "script", "description"],
        limit: 200,
        display: "value",
      });
      if (!acls.ok) return fail(acls.message);
      if (!acls.data.length) return ok(`No active record ACLs starting with "${table}"${operation ? ` for ${operation}` : ""}.`);
      const ids = acls.data.map((a) => a.sys_id);
      const roleRows = await tableQuery("sys_security_acl_role", { query: `sys_security_aclIN${ids.join(",")}`, fields: ["sys_security_acl", "sys_user_role.name"], limit: 1000, display: "value" });
      const rolesByAcl = {};
      for (const r of roleRows.ok ? roleRows.data : []) (rolesByAcl[r.sys_security_acl] ??= []).push(r["sys_user_role.name"]);
      const rows = acls.data.map((a) => ({
        name: a.name,
        op: a.operation,
        roles: (rolesByAcl[a.sys_id] ?? []).sort().join(", ") || "(none)",
        condition: truncate(a.condition ?? "", 80),
        script: a.script ? "yes" : "",
        admin_overrides: a.admin_overrides === "true" ? "yes" : "",
      }));
      return ok(`${rows.length} ACL(s) on ${table}${roleRows.ok ? "" : ` (roles unreadable: ${roleRows.message})`}:\n\n${toTable(rows, ["name", "op", "roles", "condition", "script", "admin_overrides"])}`);
    }
  );

  if (readOnly) return;

  server.registerTool(
    "create_record",
    {
      title: "Create a record",
      description: "Insert a record. With confirm false (default) it only previews the insert.",
      inputSchema: z.object({
        table: z.string(),
        data: z.record(z.string(), z.unknown()).describe("Field values. References take sys_ids."),
        confirm: z.boolean().default(false),
      }),
    },
    async ({ table, data, confirm }) => {
      if (!confirm) return preview(`Would INSERT into ${table}:`, [json(data)]);
      const res = await createRecord(table, data);
      if (!res.ok) return fail(res.message);
      const rec = compactRecord(res.data ?? {});
      return ok(`Created ${table} ${rec.number ? rec.number + " " : ""}sys_id ${rec.sys_id}\n\n${json(rec)}`);
    }
  );

  server.registerTool(
    "update_record",
    {
      title: "Update a record",
      description: "Reads the record first and shows before/after per field. With confirm false (default) it only previews.",
      inputSchema: z.object({
        table: z.string(),
        sys_id: SYS_ID,
        data: z.record(z.string(), z.unknown()),
        confirm: z.boolean().default(false),
      }),
    },
    async ({ table, sys_id, data, confirm }) => {
      const fields = ["sys_id", "number", "sys_updated_on", ...Object.keys(data)];
      const before = await getRecord(table, sys_id, { fields, display: "both" });
      if (!before.ok) return fail(before.message);
      if (!before.data) return fail(`No ${table} record with sys_id ${sys_id}`);
      const b = compactRecord(before.data);
      const diff = Object.keys(data).map((k) => `- ${k}: ${JSON.stringify(b[k] ?? "")} -> ${JSON.stringify(data[k])}`);
      const ident = `${table} ${b.number ? b.number + " " : ""}${sys_id}`;
      if (!confirm) return preview(`Would UPDATE ${ident}:`, diff);
      const res = await updateRecord(table, sys_id, data);
      if (!res.ok) return fail(res.message);
      const after = compactRecord(res.data ?? {});
      const result = Object.keys(data).map((k) => `- ${k}: ${JSON.stringify(b[k] ?? "")} -> ${JSON.stringify(after[k] ?? "")}`);
      return ok(`Updated ${ident}\n${result.join("\n")}`);
    }
  );

  server.registerTool(
    "delete_record",
    {
      title: "Delete a record",
      description: "Previews the record, then deletes it when confirm is true.",
      inputSchema: z.object({
        table: z.string(),
        sys_id: SYS_ID,
        confirm: z.boolean().default(false),
      }),
    },
    async ({ table, sys_id, confirm }) => {
      const before = await getRecord(table, sys_id, { display: "both" });
      if (!before.ok) return fail(before.message);
      if (!before.data) return fail(`No ${table} record with sys_id ${sys_id}`);
      const b = compactRecord(before.data, { maxField: 200 });
      if (!confirm) return preview(`Would DELETE ${table} ${sys_id}:`, [json(b)]);
      const res = await deleteRecord(table, sys_id);
      if (!res.ok) return fail(res.message);
      return ok(`Deleted ${table} ${b.number ? b.number + " " : ""}${sys_id}`);
    }
  );
}

export { getPreference };
