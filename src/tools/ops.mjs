import { z } from "zod";
import { snRequest } from "../sn.mjs";
import { ok, fail, preview, json } from "../format.mjs";

function progressSummary(result) {
  if (!result) return "(empty result)";
  const r = result;
  const lines = [
    `status: ${r.status_label ?? r.status ?? "?"}${r.percent_complete !== undefined ? ` (${r.percent_complete}%)` : ""}`,
    r.status_message ? `message: ${r.status_message}` : null,
    r.status_detail ? `detail: ${r.status_detail}` : null,
    r.error ? `error: ${r.error}` : null,
    r.rollback_version ? `rollback_version: ${r.rollback_version}` : null,
    r.links?.progress?.id ? `progress_id: ${r.links.progress.id}` : null,
    r.links?.results?.id ? `results_id: ${r.links.results.id}` : null,
  ].filter(Boolean);
  return lines.join("\n");
}

const ASYNC_NOTE = "This is asynchronous: poll get_progress with the progress_id until status is Successful or Failed. Do not assume completion.";

export function registerOps(server) {
  server.registerTool(
    "plugin",
    {
      title: "Activate or roll back a plugin",
      description: "CICD API plugin activation / rollback. Returns a progress id to poll with get_progress. Preview unless confirm is true.",
      inputSchema: z.object({
        action: z.enum(["activate", "rollback"]),
        plugin_id: z.string().describe("e.g. com.snc.incident"),
        confirm: z.boolean().default(false),
      }),
    },
    async ({ action, plugin_id, confirm }) => {
      if (!confirm) return preview(`Would ${action} plugin ${plugin_id} on this instance.`, []);
      const res = await snRequest("POST", `/api/sn_cicd/plugin/${encodeURIComponent(plugin_id)}/${action}`, { body: {} });
      if (!res.ok) return fail(res.message);
      return ok(`Plugin ${action} requested for ${plugin_id}.\n${progressSummary(res.data?.result)}\n\n${ASYNC_NOTE}`);
    }
  );

  server.registerTool(
    "app",
    {
      title: "Install or roll back an application",
      description: "CICD API app_repo install / rollback for apps from the app repository or store. Identify by scope or sys_id. Returns a progress id. Preview unless confirm is true.",
      inputSchema: z.object({
        action: z.enum(["install", "rollback"]),
        scope: z.string().optional(),
        sys_id: z.string().optional(),
        version: z.string().optional().describe("Required for rollback; optional (latest) for install"),
        auto_upgrade_base_app: z.boolean().optional(),
        confirm: z.boolean().default(false),
      }),
    },
    async (a) => {
      if (!a.scope && !a.sys_id) return fail("Pass scope or sys_id.");
      if (a.action === "rollback" && !a.version) return fail("rollback needs the version to roll back to.");
      const target = a.scope ?? a.sys_id;
      if (!a.confirm) return preview(`Would ${a.action} application ${target}${a.version ? " version " + a.version : ""}.`, []);
      const res = await snRequest("POST", `/api/sn_cicd/app_repo/${a.action}`, {
        query: { scope: a.scope, sys_id: a.sys_id, version: a.version, auto_upgrade_base_app: a.auto_upgrade_base_app },
        body: {},
      });
      if (!res.ok) return fail(res.message);
      return ok(`Application ${a.action} requested for ${target}.\n${progressSummary(res.data?.result)}\n\n${ASYNC_NOTE}`);
    }
  );

  server.registerTool(
    "batch_install",
    {
      title: "Batch install apps and plugins",
      description: "CICD batch install of several packages in one request. Returns a progress id. Preview unless confirm is true.",
      inputSchema: z.object({
        name: z.string().describe("Batch name shown on the instance"),
        notes: z.string().optional(),
        packages: z.array(z.object({
          id: z.string().describe("Plugin id or app sys_id/scope"),
          type: z.enum(["application", "plugin"]),
          requested_version: z.string().optional(),
          load_demo_data: z.boolean().optional(),
          notes: z.string().optional(),
        })).min(1).max(50),
        confirm: z.boolean().default(false),
      }),
    },
    async (a) => {
      if (!a.confirm) return preview(`Would batch-install ${a.packages.length} package(s) as "${a.name}":`, a.packages.map((p) => `- ${p.type} ${p.id}${p.requested_version ? " @" + p.requested_version : ""}${p.load_demo_data ? " (+demo data)" : ""}`));
      const res = await snRequest("POST", "/api/sn_cicd/app/batch/install", { body: { name: a.name, notes: a.notes, packages: a.packages } });
      if (!res.ok) return fail(res.message);
      return ok(`Batch install "${a.name}" requested.\n${progressSummary(res.data?.result)}\n\n${ASYNC_NOTE}`);
    }
  );

  server.registerTool(
    "get_progress",
    {
      title: "Poll CICD progress",
      description: "Status of an asynchronous plugin/app operation by progress id.",
      inputSchema: z.object({ progress_id: z.string() }),
    },
    async ({ progress_id }) => {
      const res = await snRequest("GET", `/api/sn_cicd/progress/${encodeURIComponent(progress_id)}`);
      if (!res.ok) return fail(res.message);
      const r = res.data?.result;
      return ok(`${progressSummary(r)}${r?.status_detail || r?.links ? "" : "\n\n" + json(r)}`);
    }
  );
}
