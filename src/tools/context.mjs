import { z } from "zod";
import { tableQuery, getPreference, setPreference } from "../sn.mjs";
import { ok, fail, preview, toTable } from "../format.mjs";

export async function currentScopeId() {
  const p = await getPreference("apps.current_app");
  if (!p.ok) return p;
  return { ok: true, data: p.data?.value || "global" };
}

export function registerContext(server) {
  server.registerTool(
    "set_scope",
    {
      title: "Set current application scope",
      description: "Switch the application scope the integration user works in (REST users have no picker; this writes the apps.current_app preference). Accepts scope name (x_acme_app), app name, sys_id, or 'global'. Preview unless confirm is true.",
      inputSchema: z.object({
        scope: z.string(),
        confirm: z.boolean().default(false),
      }),
    },
    async ({ scope, confirm }) => {
      let target;
      if (scope.toLowerCase() === "global") target = { sys_id: "global", name: "Global", scope: "global" };
      else {
        const isId = /^[0-9a-f]{32}$/i.test(scope);
        const r = await tableQuery("sys_scope", { query: isId ? `sys_id=${scope}` : `scope=${scope}^ORname=${scope}`, fields: ["sys_id", "name", "scope"], limit: 5, display: "value" });
        if (!r.ok) return fail(r.message);
        if (!r.data.length) return fail(`No application scope matches "${scope}".`);
        if (r.data.length > 1) return fail(`"${scope}" is ambiguous:\n${toTable(r.data, ["name", "scope", "sys_id"])}`);
        target = r.data[0];
      }
      const cur = await currentScopeId();
      const curId = cur.ok ? cur.data : "(unknown)";
      if (curId === target.sys_id) return ok(`Already in scope ${target.name} (${target.scope}).`);
      if (!confirm) return preview("Would switch scope:", [`from: ${curId}`, `to: ${target.name} (${target.scope}) [${target.sys_id}]`, "Note: the current update set may belong to another scope; check with whoami and set_update_set afterwards."]);
      const w = await setPreference("apps.current_app", target.sys_id);
      if (!w.ok) return fail(w.message);
      return ok(`Scope is now ${target.name} (${target.scope}) [${target.sys_id}]. Verify the update set matches this scope.`);
    }
  );

  server.registerTool(
    "set_update_set",
    {
      title: "Set current update set",
      description: "Select the in-progress update set changes are captured in (writes the sys_update_set preference). Accepts a name or sys_id. Refuses a set from another scope than the current one, because the platform would silently ignore it. Preview unless confirm is true.",
      inputSchema: z.object({
        update_set: z.string(),
        confirm: z.boolean().default(false),
      }),
    },
    async ({ update_set, confirm }) => {
      const cur = await currentScopeId();
      if (!cur.ok) return fail(cur.message);
      const scopeId = cur.data;
      const fields = ["sys_id", "name", "state", "application", "application.name", "application.scope"];
      const isId = /^[0-9a-f]{32}$/i.test(update_set);
      let cands = await tableQuery("sys_update_set", { query: isId ? `sys_id=${update_set}` : `name=${update_set}^state=in progress`, fields, limit: 100, display: "value" });
      if (!cands.ok) return fail(cands.message);
      if (!cands.data.length && !isId) {
        cands = await tableQuery("sys_update_set", { query: `nameLIKE${update_set}^state=in progress`, fields, limit: 100, display: "value" });
        if (!cands.ok) return fail(cands.message);
      }
      if (!cands.data.length) return fail(`No in-progress update set matches "${update_set}".`);
      let pick = cands.data;
      if (pick.length > 1) {
        const inScope = pick.filter((u) => (u.application || "global") === scopeId);
        if (inScope.length === 1) pick = inScope;
        else return fail(`"${update_set}" matches ${pick.length} update sets; pass a sys_id:\n${toTable(pick.map((u) => ({ name: u.name, application: u["application.name"] || u.application, state: u.state, sys_id: u.sys_id })))}`);
      }
      const u = pick[0];
      const setScope = u.application || "global";
      if (u.state && u.state !== "in progress") return fail(`Update set ${u.name} is in state "${u.state}", not in progress.`);
      if (setScope !== scopeId) return fail(`Update set ${u.name} belongs to scope ${u["application.name"] || setScope} [${setScope}] but the current scope is [${scopeId}]. The platform would silently ignore it. Run set_scope first or pick a set in the current scope.`);
      if (!confirm) return preview("Would select update set:", [`${u.name} (${u["application.name"] || setScope}) [${u.sys_id}]`]);
      const w = await setPreference("sys_update_set", u.sys_id);
      if (!w.ok) return fail(w.message);
      return ok(`Current update set is now ${u.name} [${u.sys_id}] in scope ${u["application.name"] || setScope}.`);
    }
  );
}
