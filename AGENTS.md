# AGENTS.md

Instructions for Codex (and any other agent) working in this repository or using the
`servicenow` MCP server it contains.

## Working on this repo

- Node 20+. `npm install`, then `npm test` runs an end-to-end smoke test against an in-process
  mock instance (`test/mock-instance.mjs`); no ServiceNow credentials needed. Keep it green.
- `server.mjs` is the entry point. `src/sn.mjs` is the only place that talks HTTP. Tools live in
  `src/tools/*.mjs`, one module per tool group. `src/format.mjs` owns response trimming.
- Never write to stdout except through the MCP transport. Use `console.error` for logs.
- Do not add tools casually: every tool's name, description and schema is sent to the model on
  every turn. Prefer a `mode`/`action` argument on an existing tool. The smoke test fails if the
  tool count grows past 26.
- Every tool that changes the instance takes `confirm: boolean` defaulting to `false` and must
  return a preview without side effects when it is false. The smoke test checks the default.
- Secrets come from the environment only. Never commit `.env` or put credentials in examples.

## Using the ServiceNow MCP server (`servicenow`)

Codex's sandbox and approval modes do not gate MCP tool calls: a write reaches the instance in
read-only sandbox mode too. These rules are the safety net.

- Run `whoami` once at the start of a task and state the instance, user, scope and update set
  before changing anything.
- Read before you write: `query_table`, `get_record`, `describe_table`, `aggregate`. Never guess
  sys_ids or field names.
- Every write tool (`create_record`, `update_record`, `delete_record`, the role tools, `set_scope`,
  `set_update_set`, `plugin`, `app`, `batch_install`, `order_item`, `cart`) is called first with
  `confirm: false`. Show the preview and wait for an explicit go-ahead before calling again with
  `confirm: true`. Never bundle several writes behind one approval.
- Prefer one `batch` call over several reads. Prefer `aggregate` over pulling rows to count them.
- Keep `limit` at 20 or lower unless asked, and pass `fields` whenever you know them.
- A 403 is an answer, not a bug: report which role or ACL is missing and stop. Do not try other
  tables or accounts to get around it. ACL changes cannot be made over REST at all.
- Deleting from any `sys_*` table, and any change to `sys_user_has_role`, needs an explicit
  instruction naming the record.
- Before configuration changes, confirm the update set belongs to the current scope (the server
  refuses a mismatch; `whoami` shows both).
- Asynchronous operations (`plugin`, `app`, `batch_install`) return a progress id. Poll
  `get_progress`; do not report completion until it says Successful.
- Never print `SN_PASSWORD` or an Authorization header, and never write credentials into files.
