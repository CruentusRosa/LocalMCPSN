# Local ServiceNow MCP server (for Codex)

A single Node process that gives OpenAI Codex (CLI or IDE extension), or any MCP client, full
control of one ServiceNow instance. Runs locally over stdio with your own credentials. No hosting,
no database, no OAuth.

```
Codex  <--stdio-->  server.mjs  <--HTTPS Basic auth-->  https://<instance>.service-now.com
```

The instance is the privilege boundary: the server exposes the full tool set and lets ServiceNow's
roles and ACLs decide. A tool the account may not use returns a clean 403.

The design is documented in [`local-servicenow-mcp-codex.md`](local-servicenow-mcp-codex.md)
(Codex edition) and [`local-servicenow-mcp.md`](local-servicenow-mcp.md) (Claude edition). This
README is the setup guide.

## 1. ServiceNow side, once

Create an integration user rather than reusing your own login.

| Setting | Value |
| --- | --- |
| User ID | e.g. `mcp_local` |
| Web service access only | true |
| Internal Integration User | true, if your release has it |
| Password | long and random |
| Roles | `admin` for full control, or `snc_read_only` plus specific roles for least privilege |

Two gotchas:

- Newer releases need the **`snc_basic_auth_api_access`** role for Basic auth REST, or every call is 401.
- `admin` over REST cannot elevate to `security_admin`, so ACL writes return 403 even as admin. Change ACLs in the UI.

## 2. Install

```bash
git clone https://github.com/CruentusRosa/LocalMCPSN.git
cd LocalMCPSN
npm install
cp .env.example .env     # fill in SN_URL, SN_USER, SN_PASSWORD
npm test                 # smoke test against a built-in mock instance, no credentials needed
```

Quick manual check against the real instance:

```bash
set -a; . ./.env; set +a
node -e 'import("./src/sn.mjs").then(async m => console.log(await m.tableQuery("sys_user",{query:"sys_id="+m.ME,fields:["user_name"],limit:1,display:"value"})))'
```

## 3. Register with Codex

Option A, credentials inline:

```bash
codex mcp add servicenow \
  --env SN_URL=https://<instance>.service-now.com \
  --env SN_USER=mcp_local \
  --env SN_PASSWORD='...' \
  -- node /absolute/path/to/LocalMCPSN/server.mjs
```

Option B, no secret in `config.toml`. The wrapper sources `<repo>/.env` and starts node:

```bash
codex mcp add servicenow -- /absolute/path/to/LocalMCPSN/bin/run-with-env.sh
```

Then raise the timeouts in `~/.codex/config.toml` (see [`codex-config.example.toml`](codex-config.example.toml)):

```toml
[mcp_servers.servicenow]
startup_timeout_sec = 20
tool_timeout_sec = 120
```

Verify:

```bash
codex mcp list
codex mcp get servicenow
```

Inside a Codex session, `/mcp` lists the server and its tools. If it is missing, start the server by
hand (`node server.mjs`) and read stderr; a crash on startup is the usual cause.

Copy the "Using the ServiceNow MCP server" section of [`AGENTS.md`](AGENTS.md) into the `AGENTS.md`
of any project where Codex will use the server. Codex's sandbox does not gate MCP calls, so those
rules plus the server's `confirm` gate are what stands between the model and the instance.

## 4. Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `SN_URL` | required | `https://<instance>.service-now.com` |
| `SN_USER`, `SN_PASSWORD` | required | Integration user credentials |
| `SN_TIMEOUT_MS` | 15000 | Per REST call. Keep well under Codex's `tool_timeout_sec`. |
| `SN_READ_ONLY` | false | Register read tools only. Writes, admin, context, ops and ordering disappear from the tool list. |
| `SN_TOOLSETS` | `core,admin,context,ops,catalog` | Which tool groups to expose |
| `SN_MAX_RESPONSE_CHARS` | 24000 | Hard cap per tool result |
| `SN_MAX_FIELD_CHARS` | 1200 | Cap per text field |
| `SN_MAX_BATCH_SUB_CHARS` | 6000 | Cap per batch sub-response |

Codex can also trim per project with `enabled_tools` / `disabled_tools` in `config.toml`.

## 5. Tools

| Group | Tools |
| --- | --- |
| core | `whoami`, `query_table`, `get_record`, `aggregate`, `batch`, `describe_table`, `describe_acls`, `create_record`, `update_record`, `delete_record` |
| admin | `create_user`, `create_role`, `assign_role`, `remove_role` |
| context | `set_scope`, `set_update_set` |
| ops | `plugin` (activate/rollback), `app` (install/rollback), `batch_install`, `get_progress` |
| catalog | `list_catalogs`, `search_catalog`, `describe_catalog_item`, `order_item`, `cart` |

Every tool that changes the instance takes `confirm` (default `false`) and only previews the change
until it is `true`. `batch` requires `confirm` when any sub-request is not a GET.

What the server does to keep tokens down: drops empty fields, collapses reference objects to
`Display [sys_id]`, strips HTML, truncates long text with a visible marker, counts inherited roles
instead of listing them, and caps every batch sub-response.

## 6. Scope and update set

A REST user has no session, so there is no application picker. `set_scope` and `set_update_set`
write the two user preferences the platform reads instead (`apps.current_app`, `sys_update_set`).
`set_update_set` refuses a set from another scope than the current one, because the platform would
silently ignore it, and disambiguates the many sets named "Default" by the current scope.

## 7. Troubleshooting

| Symptom | Cause |
| --- | --- |
| Every call 401 | Wrong credentials, or missing `snc_basic_auth_api_access` |
| 403 on a write as admin | ACL or `security_admin` needed; REST cannot elevate |
| 403 on `cart` | A `web_service_access_only` account has no cart; order as a person |
| Server missing from `/mcp` | Crashed on start. Run `node server.mjs` and read stderr. Something wrote to stdout? |
| Generic tool failure in Codex, no 401/403 text | REST call outlived `tool_timeout_sec`; raise it or lower `SN_TIMEOUT_MS` |
| `describe_table` lacks inherited fields | `sys_db_object` not readable; the output says so |
