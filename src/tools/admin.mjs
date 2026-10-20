import { z } from "zod";
import { tableQuery, createRecord, deleteRecord, resolveOne } from "../sn.mjs";
import { ok, fail, preview, json } from "../format.mjs";

async function resolveUser(input) {
  return resolveOne("sys_user", input, { nameField: "user_name", fields: ["name"] });
}
async function resolveRole(input) {
  return resolveOne("sys_user_role", input, { nameField: "name" });
}

export function registerAdmin(server) {
  server.registerTool(
    "create_user",
    {
      title: "Create a user",
      description: "Create a sys_user, optionally as a web-service-only integration account, and grant roles by name. Preview unless confirm is true.",
      inputSchema: z.object({
        user_name: z.string(),
        first_name: z.string().optional(),
        last_name: z.string().optional(),
        email: z.string().optional(),
        password: z.string().optional().describe("Set the initial password (stored hashed by the platform)"),
        web_service_access_only: z.boolean().default(false),
        roles: z.array(z.string()).default([]).describe("Role names to grant directly"),
        confirm: z.boolean().default(false),
      }),
    },
    async (a) => {
      const existing = await tableQuery("sys_user", { query: `user_name=${a.user_name}`, fields: ["sys_id"], limit: 1, display: "value" });
      if (!existing.ok) return fail(existing.message);
      if (existing.data.length) return fail(`A user named ${a.user_name} already exists (sys_id ${existing.data[0].sys_id}).`);
      const roleRecs = [];
      for (const r of a.roles) {
        const rr = await resolveRole(r);
        if (!rr.ok) return fail(rr.message);
        roleRecs.push(rr.data);
      }
      const body = { user_name: a.user_name, first_name: a.first_name, last_name: a.last_name, email: a.email, web_service_access_only: a.web_service_access_only, active: true };
      if (a.password) body.user_password = a.password;
      const shown = { ...body, user_password: a.password ? "(set, hidden)" : undefined };
      if (!a.confirm) return preview("Would create sys_user and grant roles:", [json(shown), `roles: ${roleRecs.map((r) => r.name).join(", ") || "none"}`]);
      const created = await createRecord("sys_user", body);
      if (!created.ok) return fail(created.message);
      const sysId = created.data?.sys_id?.value ?? created.data?.sys_id;
      const granted = [];
      for (const r of roleRecs) {
        const g = await createRecord("sys_user_has_role", { user: sysId, role: r.sys_id });
        granted.push(g.ok ? `${r.name}: granted` : `${r.name}: FAILED (${g.message})`);
      }
      return ok(`Created user ${a.user_name} sys_id ${sysId}\n${granted.join("\n")}`);
    }
  );

  server.registerTool(
    "create_role",
    {
      title: "Create a role",
      description: "Create a sys_user_role, optionally containing other roles. Preview unless confirm is true.",
      inputSchema: z.object({
        name: z.string(),
        description: z.string().optional(),
        contains_roles: z.array(z.string()).default([]),
        confirm: z.boolean().default(false),
      }),
    },
    async (a) => {
      const existing = await tableQuery("sys_user_role", { query: `name=${a.name}`, fields: ["sys_id"], limit: 1, display: "value" });
      if (!existing.ok) return fail(existing.message);
      if (existing.data.length) return fail(`Role ${a.name} already exists (sys_id ${existing.data[0].sys_id}).`);
      const contains = [];
      for (const r of a.contains_roles) {
        const rr = await resolveRole(r);
        if (!rr.ok) return fail(rr.message);
        contains.push(rr.data);
      }
      if (!a.confirm) return preview("Would create role:", [`name: ${a.name}`, `description: ${a.description ?? ""}`, `contains: ${contains.map((c) => c.name).join(", ") || "none"}`]);
      const created = await createRecord("sys_user_role", { name: a.name, description: a.description });
      if (!created.ok) return fail(created.message);
      const sysId = created.data?.sys_id?.value ?? created.data?.sys_id;
      const lines = [`Created role ${a.name} sys_id ${sysId}`];
      for (const c of contains) {
        const g = await createRecord("sys_user_role_contains", { role: sysId, contains: c.sys_id });
        lines.push(g.ok ? `contains ${c.name}: added` : `contains ${c.name}: FAILED (${g.message})`);
      }
      return ok(lines.join("\n"));
    }
  );

  server.registerTool(
    "assign_role",
    {
      title: "Assign a role to a user",
      description: "Grant a role directly. Both user and role accept a name or sys_id. Preview unless confirm is true.",
      inputSchema: z.object({
        user: z.string().describe("user_name or sys_id"),
        role: z.string().describe("role name or sys_id"),
        confirm: z.boolean().default(false),
      }),
    },
    async ({ user, role, confirm }) => {
      const [u, r] = await Promise.all([resolveUser(user), resolveRole(role)]);
      if (!u.ok) return fail(u.message);
      if (!r.ok) return fail(r.message);
      const has = await tableQuery("sys_user_has_role", { query: `user=${u.data.sys_id}^role=${r.data.sys_id}`, fields: ["sys_id", "inherited"], limit: 1, display: "value" });
      if (!has.ok) return fail(has.message);
      if (has.data.length) return ok(`${u.data.user_name} already has ${r.data.name} (${has.data[0].inherited === "true" ? "inherited" : "direct"}). Nothing to do.`);
      if (!confirm) return preview("Would grant role:", [`user: ${u.data.user_name} (${u.data.name}) [${u.data.sys_id}]`, `role: ${r.data.name} [${r.data.sys_id}]`]);
      const g = await createRecord("sys_user_has_role", { user: u.data.sys_id, role: r.data.sys_id });
      if (!g.ok) return fail(g.message);
      return ok(`Granted ${r.data.name} to ${u.data.user_name}.`);
    }
  );

  server.registerTool(
    "remove_role",
    {
      title: "Remove a role from a user",
      description: "Remove a DIRECT grant. An inherited role cannot be removed here; the tool tells you which role grants it. Preview unless confirm is true.",
      inputSchema: z.object({
        user: z.string(),
        role: z.string(),
        confirm: z.boolean().default(false),
      }),
    },
    async ({ user, role, confirm }) => {
      const [u, r] = await Promise.all([resolveUser(user), resolveRole(role)]);
      if (!u.ok) return fail(u.message);
      if (!r.ok) return fail(r.message);
      const has = await tableQuery("sys_user_has_role", { query: `user=${u.data.sys_id}^role=${r.data.sys_id}`, fields: ["sys_id", "inherited", "included_in_role.name", "granted_by.name"], limit: 5, display: "value" });
      if (!has.ok) return fail(has.message);
      const direct = has.data.filter((h) => h.inherited !== "true");
      const inherited = has.data.filter((h) => h.inherited === "true");
      if (!has.data.length) return ok(`${u.data.user_name} does not have ${r.data.name}. Nothing to do.`);
      if (!direct.length) {
        const via = inherited.map((h) => h["included_in_role.name"] || h["granted_by.name"] || "another role or group").join(", ");
        return fail(`${r.data.name} is inherited for ${u.data.user_name} via ${via}; remove it from the containing role or group instead.`);
      }
      if (!confirm) return preview("Would remove direct grant:", [`user: ${u.data.user_name} [${u.data.sys_id}]`, `role: ${r.data.name} [${r.data.sys_id}]`, inherited.length ? `Note: the user will STILL hold the role through inheritance (${inherited.length} path(s)).` : ""].filter(Boolean));
      const d = await deleteRecord("sys_user_has_role", direct[0].sys_id);
      if (!d.ok) return fail(d.message);
      return ok(`Removed direct grant of ${r.data.name} from ${u.data.user_name}.${inherited.length ? " The role is still inherited." : ""}`);
    }
  );
}
