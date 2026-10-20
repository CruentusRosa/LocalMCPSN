#!/usr/bin/env node
// Local ServiceNow MCP server. Speaks MCP over stdio; log to stderr only.
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { config, instanceName } from "./src/sn.mjs";
import { registerCore } from "./src/tools/core.mjs";
import { registerAdmin } from "./src/tools/admin.mjs";
import { registerContext } from "./src/tools/context.mjs";
import { registerOps } from "./src/tools/ops.mjs";
import { registerCatalog } from "./src/tools/catalog.mjs";

const log = (...a) => console.error("[servicenow-mcp]", ...a);

// Anything on stdout that is not an MCP message corrupts the protocol, so route console.log to stderr.
console.log = (...a) => console.error(...a);

const cfg = config();
const toolsets = new Set((process.env.SN_TOOLSETS ?? "core,admin,context,ops,catalog").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
const readOnly = cfg.readOnly;

const server = new McpServer({ name: "servicenow", version: "1.0.0" });

if (toolsets.has("core")) registerCore(server, { readOnly });
if (!readOnly && toolsets.has("admin")) registerAdmin(server);
if (!readOnly && toolsets.has("context")) registerContext(server);
if (!readOnly && toolsets.has("ops")) registerOps(server);
if (toolsets.has("catalog")) registerCatalog(server, { readOnly });

if (cfg.missing.length) log(`WARNING: missing environment ${cfg.missing.join(", ")}; every tool will fail until set.`);
log(`starting for ${instanceName()} as ${cfg.user || "(no user)"}; read-only=${readOnly}; toolsets=${[...toolsets].join(",")}`);

await server.connect(new StdioServerTransport());
