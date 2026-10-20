# Local ServiceNow MCP server for Codex

A spec for running your own MCP server that gives OpenAI Codex (CLI and IDE extension) full control
of one ServiceNow instance, locally over stdio with your own credentials. No hosting, no database,
no OAuth.

**The implementation lives in this repository** (`server.mjs`, `src/`, `test/`); see `README.md` for
setup. This document is the design behind it.

This is the Codex edition of `local-servicenow-mcp.md`. The server is identical; what differs is how
Codex is wired to it, how Codex should be told to behave around it, and a few Codex-specific traps.
If you already built the server for Claude, skip to sections 4 and 11.

---

## 1. What you are building

A single Node process that Codex launches on demand. It speaks MCP over stdio, and every tool call
turns into one or more REST calls against your instance using Basic auth.

```
Codex  <--stdio-->  your MCP server  <--HTTPS Basic auth-->  https://<instance>.service-now.com
```

The instance is the privilege boundary. The server does not try to be clever about permissions: it
offers the full tool set and lets ServiceNow's roles and ACLs decide. A tool that the account may not
use simply returns 403, which is the honest answer.

One thing Codex users need to hear up front: **Codex's sandbox and approval modes govern shell
commands and file edits, not MCP tool calls.** A `create_record` call reaches the instance whether
you run in read-only, workspace-write or full-auto. The `confirm` gate inside the server (section 7)
is therefore the safety net, not a nicety.

---

## 2. Prerequisites

- Node 20 or newer.
- Codex CLI 0.40 or newer (`codex --version`). The MCP subcommands below arrived around then.
- A ServiceNow instance you control (a PDI is fine).
- An integration user on that instance (section 3).

---

## 3. ServiceNow side, once

Create a user for the integration rather than reusing your own login.

| Setting | Value |
| --- | --- |
| User ID | e.g. `mcp_local` |
| Web service access only | true (blocks interactive login with these credentials) |
| Internal Integration User | true, if your release has it |
| Password | long and random |

Roles, for a full-control server: `admin`.

If you want least privilege instead, start from `snc_read_only` plus the specific read roles you
need, and expect write tools to 403. That is a feature, not a bug: it is how you verify the role set
is actually tight.

Two gotchas that cost real time:

- On newer releases Basic auth REST access needs the **`snc_basic_auth_api_access`** role in
  addition to everything else. Without it every call is 401 no matter how correct the password is.
- `admin` over REST is **not** the same as `admin` in the browser. You cannot elevate to
  `security_admin` over REST, so writes to `sys_security_acl` return 403 even as admin. ACL changes
  have to be made in the UI. Do not waste a day on this like we did.

---

## 4. Project setup and Codex wiring

```bash
npm init -y
npm install @modelcontextprotocol/server zod
```

`package.json` needs `"type": "module"`.

Credentials come from the environment, never from source:

```
SN_URL=https://<instance>.service-now.com
SN_USER=mcp_local
SN_PASSWORD=...
```

### 4.1 Register the server with Codex

Codex reads MCP servers from `~/.codex/config.toml` under `[mcp_servers.<name>]`. Either edit the
file or let the CLI do it:

```bash
codex mcp add servicenow \
  --env SN_URL=https://<instance>.service-now.com \
  --env SN_USER=mcp_local \
  --env SN_PASSWORD='...' \
  -- node /absolute/path/to/server.mjs
```

Which produces:

```toml
[mcp_servers.servicenow]
command = "node"
args = ["/absolute/path/to/server.mjs"]
env = { SN_URL = "https://<instance>.service-now.com", SN_USER = "mcp_local", SN_PASSWORD = "..." }
startup_timeout_sec = 20   # default is 10; cold Node start plus a whoami probe can exceed it
tool_timeout_sec = 120     # default is 60; plugin and app installs poll longer than that
```

Verify:

```bash
codex mcp list            # server shows as enabled
codex mcp get servicenow  # prints the resolved config
```

Then inside a Codex session type `/mcp`: it lists the server and every tool it exposed. If the
server is missing there, it crashed on startup; run `node /absolute/path/to/server.mjs` by hand and
read stderr.

### 4.2 Keeping the password out of config.toml

`config.toml` is plain text in your home directory. Two ways around literal secrets:

- A wrapper script as `command` that exports the variables from your secret store (1Password CLI,
  macOS Keychain, a `.env` outside any repo) and then `exec`s node. Codex only sees the wrapper.
- Per-project override: Codex also merges a `.codex/config.toml` from a trusted project directory.
  Put instance-specific settings there and keep the password in the user-level file. Never commit
  the project-level file with credentials in it.

Whichever you pick, `chmod 600` the file holding the password.

### 4.3 Trimming the tool list per project

Every tool's name, description and schema is sent to the model on every turn. Codex lets you cut
the list without touching the server:

```toml
[mcp_servers.servicenow]
# ... as above ...
enabled_tools = ["whoami", "query_table", "get_record", "aggregate", "batch", "describe_table"]
```

Use `enabled_tools` for a read-only analysis project and `disabled_tools` to drop just the ops or
catalog tools. `enabled = false` turns the server off entirely without deleting the config.

### 4.4 Server skeleton

```js
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const server = new McpServer({ name: "servicenow", version: "1.0.0" });

server.registerTool(
  "whoami",
  { description: "...", inputSchema: z.object({}) },
  async () => ({ content: [{ type: "text", text: "..." }] })
);

await server.connect(new StdioServerTransport());
```

Anything written to stdout that is not an MCP message corrupts the protocol. Log to stderr only.
Codex is stricter about this than Claude Desktop: a stray `console.log` during startup makes the
server disappear from `/mcp` with no visible error.

---

## 5. One choke point for REST

Put every call through a single function. It is where timeouts, error mapping and auth live, and
having one of them is what makes the tools short.

```js
const TIMEOUT_MS = 15000;

async function snRequest(method, apiPath, { query, body, timeoutMs } = {}) {
  const url = new URL(`${process.env.SN_URL.replace(/\/+$/, "")}/${apiPath.replace(/^\/+/, "")}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }
  const auth = "Basic " + Buffer.from(`${process.env.SN_USER}:${process.env.SN_PASSWORD}`).toString("base64");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: auth, Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const raw = await res.text();
    let json = null;
    try { json = raw ? JSON.parse(raw) : null; } catch { /* HTML error page */ }
    if (!res.ok) {
      if (res.status === 401) return { ok: false, message: "ServiceNow authentication failed (401). Check credentials." };
      if (res.status === 403) return { ok: false, message: "ServiceNow authorization denied (403). The account lacks the required role or ACL." };
      const msg = json?.error?.message ?? json?.error?.detail ?? raw.slice(0, 400) ?? res.statusText;
      return { ok: false, message: `HTTP ${res.status}: ${msg}` };
    }
    return { ok: true, data: json };
  } catch (e) {
    if (e?.name === "AbortError") return { ok: false, message: `Timed out after ${(timeoutMs ?? TIMEOUT_MS) / 1000}s.` };
    return { ok: false, message: `Request failed: ${e?.message ?? String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}
```

Keep the per-request timeout well under Codex's `tool_timeout_sec`. If the REST call outlives the
tool timeout, Codex reports a generic tool failure and the model never sees your 401/403 message.

Distinguishing 401 from 403 in the message matters more than it sounds: 401 means your config is
wrong, 403 means the instance is working exactly as configured. Collapsing them into "error" sends
the model down the wrong path.

---

## 6. The endpoints

Everything below is out of the box. No scripted REST, no plugins, except where noted.

| Purpose | Method and path | Notes |
| --- | --- | --- |
| Query records | `GET /api/now/table/{table}` | `sysparm_query`, `sysparm_fields`, `sysparm_limit`, `sysparm_display_value`, `sysparm_exclude_reference_link` |
| Read one record | `GET /api/now/table/{table}/{sys_id}` | |
| Create | `POST /api/now/table/{table}` | |
| Update | `PATCH /api/now/table/{table}/{sys_id}` | |
| Delete | `DELETE /api/now/table/{table}/{sys_id}` | |
| Aggregates | `GET /api/now/stats/{table}` | `sysparm_count`, `sysparm_avg_fields`, `sysparm_min_fields`, `sysparm_max_fields`, `sysparm_sum_fields`, `sysparm_group_by`, `sysparm_having`, `sysparm_order_by` |
| Many calls at once | `POST /api/now/v1/batch` | Up to 25 sub-requests, one round trip |
| Field structure | `GET /api/now/table/sys_dictionary` | `name={table}^elementISNOTEMPTY` |
| Table label and parent | `GET /api/now/table/sys_db_object` | Often 403 for non-admins; treat as optional |
| Table schema, alternative | `GET /api/now/doc/table/schema/{table}` | One call, but no mandatory/read-only/reference info |
| ACLs on a table | `GET /api/now/table/sys_security_acl` | `nameSTARTSWITH{table}` |
| Roles behind an ACL | `GET /api/now/table/sys_security_acl_role` | |
| Who am I | `GET /api/now/table/sys_user` | `sysparm_query=sys_id=javascript:gs.getUserID()` |
| My roles | `GET /api/now/table/sys_user_has_role` | `user=javascript:gs.getUserID()` |
| Role inheritance paths | `GET /api/global/user_role_inheritance?user_sysid=...` | Shows *why* a role is held. Enormous for admins, filter it |
| Grant or remove a role | `POST` / `DELETE /api/now/table/sys_user_has_role` | |
| Current scope and update set | `GET`/`POST`/`PATCH /api/now/table/sys_user_preference` | See section 8 |
| CMDB class metadata | `GET /api/now/cmdb/meta/{className}` | Attributes, identification and relationship rules in one call |
| CI with relations | `GET /api/now/cmdb/instance/{className}/{sys_id}` | |
| Plugin activate / rollback | `POST /api/sn_cicd/plugin/{id}/activate` and `/rollback` | Async, returns a progress id |
| App install / rollback | `POST /api/sn_cicd/app_repo/install` and `/rollback` | Plain query params, not `sysparm_` |
| Batch install | `POST /api/sn_cicd/app/batch/install` | Supports `load_demo_data` per package |
| Poll progress | `GET /api/sn_cicd/progress/{id}` | `status_label`, `percent_complete` |
| Catalogs and categories | `GET /api/sn_sc/servicecatalog/catalogs[/{id}/categories]` | |
| Find catalog items | `GET /api/sn_sc/servicecatalog/items` | `sysparm_text`, `sysparm_catalog`, `sysparm_category`, `sysparm_limit` |
| Catalog item detail | `GET /api/sn_sc/servicecatalog/items/{sys_id}` | Includes the variable tree |
| Order now | `POST /api/sn_sc/servicecatalog/items/{sys_id}/order_now` | Body: `sysparm_quantity`, `variables`, optional `sysparm_requested_for` |
| Add to cart | `POST /api/sn_sc/servicecatalog/items/{sys_id}/add_to_cart` | |
| Cart, submit, empty | `GET /api/sn_sc/servicecatalog/cart`, `POST .../cart/submit_order`, `DELETE .../cart/{cart_id}/empty` | |
| Performance Analytics | `GET /api/now/pa/scorecards` | Precomputed indicators, cheap |

Two that do **not** exist, so stop looking:

- There is no REST endpoint for ad-hoc server-side script execution. `sys.scripts.do` needs an
  interactive session and a CSRF token. See section 9 for the workaround.
- `sysparm_view` has no effect on the Table API. We tested `sys_ref_list`, `default` and no view on
  the same record and got three byte-identical responses.

---

## 7. Tool set

Twenty-ish tools covers everything above. Resist adding more: **every tool's name, description and
schema is sent to the model on every single request**, so the tool list is a permanent tax. Prefer
one tool with a `mode` or `action` argument over three tools. If you cannot resist, at least make
the extras easy to drop with `enabled_tools` (section 4.3).

**Read and discovery**

| Tool | Does |
| --- | --- |
| `whoami` | Who the server authenticates as, which instance, current scope and update set |
| `query_table` | Encoded query, optional field list, markdown table out |
| `get_record` | One record by sys_id |
| `aggregate` | Count plus avg/min/max/sum, grouped, with `having` |
| `batch` | Up to 25 REST calls in one round trip |
| `describe_table` | Fields, types, references, mandatory, plus what references this table |
| `describe_acls` | ACLs on a table and the roles attached, to find which native role already grants an operation |

**Write**

| Tool | Does |
| --- | --- |
| `create_record` | |
| `update_record` | Reads first, reports before and after per field |
| `delete_record` | Previews the record, then deletes |

All three take `confirm: boolean` and do nothing but describe the intended change when it is false.
Make `confirm` default to `false` in the schema, and say so in the description. Codex follows
schema defaults faithfully, so an omitted `confirm` must mean "preview", never "go".

**Admin**

`create_user`, `create_role`, `assign_role`, `remove_role`. Note `remove_role` only removes a direct
grant; an inherited role cannot be removed without changing the role that grants it.

**Context**

`set_scope` and `set_update_set`. See section 8, this is the non-obvious one.

**Ops (optional)**

`activate_plugin`, `rollback_plugin`, `install_app`, `rollback_app`, `batch_install`, `get_progress`.
All async: return the progress id and let the model poll, never block. Blocking here is what makes
you hit `tool_timeout_sec`.

**Catalog (optional)**

`list_catalogs`, `search_catalog`, `describe_catalog_item`, `order_item` (`mode: now | cart`),
`cart` (`action: view | submit | empty`).

---

## 8. Scope and update set without a session

This one is not in the docs in any obvious place. A REST user has no interactive session, so there is
no "current application" picker. The platform reads two **user preferences** instead:

| Preference name | Holds |
| --- | --- |
| `apps.current_app` | sys_id of the current `sys_scope` (`global` for Global) |
| `sys_update_set` | sys_id of the current `sys_update_set` |

So switching scope is a write to `sys_user_preference`:

1. `GET /api/now/table/sys_user_preference?sysparm_query=user=javascript:gs.getUserID()^name=apps.current_app`
2. PATCH it if it exists, POST it (with `user`, `name`, `value`) if it does not.

Two traps:

- An update set belonging to a different scope than the current one is **silently ignored**; changes
  land in the target scope's Default set instead. Always check that the set's `application` matches
  the current scope, and say so when it does not.
- Every application has an update set literally named "Default". On an instance with many apps,
  looking up by name needs a generous `sysparm_limit` and a tie-break on the current scope, or you
  will pick the wrong one.

---

## 9. Server-side execution, if you need it

Since there is no REST endpoint for running a script, the workable pattern is an event plus a fixed
dispatcher, which also keeps it safe because no arbitrary code crosses the wire:

1. On the instance, register an event `x_mcp.execute` (System Policy > Events > Registry).
2. Create a Script Action on that event that reads `event.parm1` as JSON `{action, params}`, switches
   on a **whitelist** of action names, and logs the result to `syslog` prefixed with
   `[MCP:<event.parm2>]`.
3. The tool inserts a row in `sysevent` with `name=x_mcp.execute`, `parm1=<json>`, `parm2=<uuid>`,
   then polls `syslog` for `messageLIKE[MCP:<uuid>]`.

Asynchronous, runs on the next scheduler cycle, usually a few seconds. No eval anywhere.

---

## 10. The rules that actually matter

These are the lessons that cost the most to learn. They are mostly about tokens, because on a large
instance that is the binding constraint, not functionality.

**Strip empty fields from every response.** A ServiceNow record is mostly empty strings. Dropping
them is the single biggest win and costs five lines.

**Never return raw HTML.** Catalog item descriptions, knowledge articles and anything authored in the
UI are HTML. Strip tags and cap the length. A catalog item is roughly 1800 tokens raw and 150 after
trimming the HTML, `ui_policy`, `client_script` and the four spellings of the same price.

**Cap long text fields.** `comments_and_work_notes` on a busy incident can be kilobytes on its own.
Truncate with a visible marker.

**Summarise inherited roles.** An admin inherits roughly 300 roles. Listing them turned `whoami` into
a multi-thousand-token call. List direct grants in full, count the inherited ones.

**Prefer one batch call over five tool calls.** Each tool result re-enters the context separately,
and the round trips add latency. The Batch API takes 25 sub-requests.

**Let the instance do the arithmetic.** `sysparm_avg_fields` with `sysparm_group_by` and
`sysparm_having` answers in a few hundred characters what would otherwise be hundreds of rows pulled
into context so the model can add them up.

**Put a size cap on your own batch tool.** Ours had none, and a single innocent-looking call to
`/api/global/user_role_inheritance` for an admin returned 1.7 MB and blew the context window. Cap
each sub-response and say when you truncated.

**Build `describe_table` dictionary-first.** `sys_dictionary` is readable with modest rights;
`sys_db_object` often is not. Make the table label and parent a best-effort extra, and return a flag
saying whether you got them, rather than failing the whole tool.

**Gate every write behind `confirm`.** Returning a preview of exactly what would change, and
requiring a second call, catches a surprising number of mistakes before they reach the instance.

**Ordering needs a real user.** A cart belongs to whoever is authenticated. A `web_service_access_only`
service account has no usable cart and the cart endpoints return 403. If you want the model to order
things, authenticate as a person, and accept that the request will be created in that person's name.

---

## 11. Telling Codex how to behave: AGENTS.md

Codex reads `AGENTS.md` from the project root (and `~/.codex/AGENTS.md` globally) at the start of
every session. The server enforces `confirm`; AGENTS.md is where you set the working habits. Drop
this in any repo where Codex will use the server, and adjust the instance name:

```markdown
## ServiceNow (MCP server `servicenow`)

- Target instance: <instance>.service-now.com, authenticated as `mcp_local`. Run `whoami` once at
  the start of a task and state the instance, scope and update set before changing anything.
- Read before you write. Use `query_table`, `get_record`, `describe_table` and `aggregate` to
  establish the current state; never guess sys_ids or field names.
- Every write tool (`create_record`, `update_record`, `delete_record`, role and scope tools) is
  called first with `confirm: false`. Show me the preview and wait for my go-ahead before calling
  it again with `confirm: true`. Never batch write calls behind a single approval.
- Prefer one `batch` call over several reads. Prefer `aggregate` over pulling rows to count them.
- Keep `sysparm_limit` at 20 or lower unless I ask for more, and always pass `sysparm_fields`.
- A 403 is an answer, not a bug: report which role or ACL is missing and stop. Do not try other
  tables or accounts to get around it.
- `delete_record` on any `sys_*` table, and any change to `sys_user_has_role`, needs an explicit
  instruction from me naming the record.
- Scope and update set: check that the update set's `application` matches the current scope before
  any configuration change, and tell me if it does not.
- Never print `SN_PASSWORD` or the Authorization header, and never write credentials into the repo.
```

Why each line is there: Codex is good at following explicit procedural rules and bad at inferring
"this one is dangerous" from context. Say it.

---

## 12. Test checklist

Server:

- `whoami` returns the expected user, and the roles look like what you granted.
- `query_table` on `sys_user` with `sysparm_limit=1` returns a row.
- `describe_table` on `incident` lists fields even if the table label is missing.
- `aggregate` on `incident` grouped by `priority` returns counts.
- `batch` with three reads returns three results with individual status codes.
- A write tool without `confirm` returns a preview and changes nothing.
- A write tool with `confirm` actually changes the record, and `sys_updated_by` is your integration
  user.
- With a least-privilege account, the write tools return a clean 403 rather than a stack trace.
- `set_scope` to a scoped app, then `whoami`, shows the new scope.

Codex wiring:

- `codex mcp list` shows `servicenow` as enabled.
- `/mcp` inside a session lists the server with the expected tool count. Fewer tools than expected
  means `enabled_tools` or `disabled_tools` is filtering; zero tools means the server crashed on
  startup.
- Ask Codex "who are you on ServiceNow?" and check that it calls `whoami` rather than answering
  from memory.
- Ask Codex to close an incident and check that it stops at the `confirm: false` preview.
- Run `codex --sandbox read-only` and confirm the write tools still reach the instance. That is the
  point of section 1, and the reason the AGENTS.md rules exist.
