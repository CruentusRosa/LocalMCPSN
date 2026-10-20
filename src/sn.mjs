// The single choke point for every REST call to the instance.

const TIMEOUT_MS = Number(process.env.SN_TIMEOUT_MS ?? 15000);

export const ME = "javascript:gs.getUserID()";

export function config() {
  const url = (process.env.SN_URL ?? "").replace(/\/+$/, "");
  const user = process.env.SN_USER ?? "";
  const password = process.env.SN_PASSWORD ?? "";
  const missing = [!url && "SN_URL", !user && "SN_USER", !password && "SN_PASSWORD"].filter(Boolean);
  return { url, user, password, missing, readOnly: /^(1|true|yes)$/i.test(process.env.SN_READ_ONLY ?? "") };
}

export function instanceName() {
  try {
    return new URL(config().url).hostname;
  } catch {
    return config().url || "(SN_URL not set)";
  }
}

export async function snRequest(method, apiPath, { query, body, timeoutMs } = {}) {
  const cfg = config();
  if (cfg.missing.length) return { ok: false, status: 0, message: `Missing environment: ${cfg.missing.join(", ")}` };

  let url;
  try {
    url = new URL(`${cfg.url}/${apiPath.replace(/^\/+/, "")}`);
  } catch {
    return { ok: false, status: 0, message: `SN_URL is not a valid URL: ${cfg.url}` };
  }
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  const auth = "Basic " + Buffer.from(`${cfg.user}:${cfg.password}`).toString("base64");
  const ctrl = new AbortController();
  const limit = timeoutMs ?? TIMEOUT_MS;
  const timer = setTimeout(() => ctrl.abort(), limit);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: auth,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const raw = await res.text();
    let json = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      /* HTML error page or empty body */
    }
    if (!res.ok) {
      if (res.status === 401) return { ok: false, status: 401, message: "ServiceNow authentication failed (401). Check SN_USER / SN_PASSWORD, and that the user has snc_basic_auth_api_access on newer releases." };
      if (res.status === 403) {
        const detail = json?.error?.message ? ` Instance says: ${json.error.message}` : "";
        return { ok: false, status: 403, message: `ServiceNow authorization denied (403). The account lacks the required role or ACL for ${method} ${apiPath}.${detail}` };
      }
      const msg = json?.error?.message ?? json?.error?.detail ?? (raw ? raw.slice(0, 400) : res.statusText);
      return { ok: false, status: res.status, message: `HTTP ${res.status}: ${msg}` };
    }
    return { ok: true, status: res.status, data: json };
  } catch (e) {
    if (e?.name === "AbortError") return { ok: false, status: 0, message: `Timed out after ${limit / 1000}s calling ${method} ${apiPath}.` };
    return { ok: false, status: 0, message: `Request failed: ${e?.message ?? String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}

// ---- Table API conveniences -------------------------------------------------

export function displayParam(display) {
  return display === "value" ? "false" : display === "display" ? "true" : "all";
}

function withOrder(query, orderBy) {
  if (!orderBy) return query ?? "";
  const clause = orderBy.startsWith("-") ? `ORDERBYDESC${orderBy.slice(1)}` : `ORDERBY${orderBy}`;
  return query ? `${query}^${clause}` : clause;
}

export async function tableQuery(table, { query, fields, limit = 20, offset, orderBy, display = "both" } = {}) {
  const res = await snRequest("GET", `/api/now/table/${encodeURIComponent(table)}`, {
    query: {
      sysparm_query: withOrder(query, orderBy),
      sysparm_fields: Array.isArray(fields) ? fields.join(",") : fields,
      sysparm_limit: limit,
      sysparm_offset: offset,
      sysparm_display_value: displayParam(display),
      sysparm_exclude_reference_link: "true",
    },
  });
  if (!res.ok) return res;
  return { ok: true, status: res.status, data: res.data?.result ?? [] };
}

export async function getRecord(table, sysId, { fields, display = "both" } = {}) {
  const res = await snRequest("GET", `/api/now/table/${encodeURIComponent(table)}/${encodeURIComponent(sysId)}`, {
    query: {
      sysparm_fields: Array.isArray(fields) ? fields.join(",") : fields,
      sysparm_display_value: displayParam(display),
      sysparm_exclude_reference_link: "true",
    },
  });
  if (!res.ok) return res;
  return { ok: true, status: res.status, data: res.data?.result ?? null };
}

export async function createRecord(table, data) {
  const res = await snRequest("POST", `/api/now/table/${encodeURIComponent(table)}`, {
    body: data,
    query: { sysparm_display_value: "all", sysparm_exclude_reference_link: "true" },
  });
  if (!res.ok) return res;
  return { ok: true, status: res.status, data: res.data?.result ?? null };
}

export async function updateRecord(table, sysId, data) {
  const res = await snRequest("PATCH", `/api/now/table/${encodeURIComponent(table)}/${encodeURIComponent(sysId)}`, {
    body: data,
    query: { sysparm_display_value: "all", sysparm_exclude_reference_link: "true" },
  });
  if (!res.ok) return res;
  return { ok: true, status: res.status, data: res.data?.result ?? null };
}

export async function deleteRecord(table, sysId) {
  return snRequest("DELETE", `/api/now/table/${encodeURIComponent(table)}/${encodeURIComponent(sysId)}`);
}

// Resolve "name or sys_id" style inputs to a single record, or explain why not.
export async function resolveOne(table, input, { nameField = "name", fields = [], extraQuery = "" } = {}) {
  const want = [...new Set(["sys_id", nameField, ...fields])];
  const isSysId = /^[0-9a-f]{32}$/i.test(input);
  const q = (isSysId ? `sys_id=${input}` : `${nameField}=${input}`) + (extraQuery ? `^${extraQuery}` : "");
  const res = await tableQuery(table, { query: q, fields: want, limit: 5, display: "value" });
  if (!res.ok) return res;
  if (res.data.length === 1) return { ok: true, data: res.data[0] };
  if (res.data.length === 0) return { ok: false, status: 404, message: `No ${table} record matches "${input}" (looked up by ${isSysId ? "sys_id" : nameField}).` };
  return { ok: false, status: 300, message: `"${input}" matches ${res.data.length} ${table} records; pass a sys_id instead: ${res.data.map((r) => r.sys_id).join(", ")}` };
}

// ---- Current user ---------------------------------------------------------

let cachedUserId = null;
export async function currentUserId() {
  if (cachedUserId) return { ok: true, data: cachedUserId };
  const res = await tableQuery("sys_user", { query: `sys_id=${ME}`, fields: ["sys_id"], limit: 1, display: "value" });
  if (!res.ok) return res;
  if (!res.data[0]?.sys_id) return { ok: false, status: 404, message: "Could not resolve the authenticated user's sys_id." };
  cachedUserId = res.data[0].sys_id;
  return { ok: true, data: cachedUserId };
}

// ---- User preferences (scope and update set live here for REST users) ------

export async function getPreference(name) {
  const res = await tableQuery("sys_user_preference", {
    query: `user=${ME}^name=${name}`,
    fields: ["sys_id", "name", "value"],
    limit: 1,
    display: "value",
  });
  if (!res.ok) return res;
  return { ok: true, data: res.data[0] ?? null };
}

export async function setPreference(name, value) {
  const existing = await getPreference(name);
  if (!existing.ok) return existing;
  if (existing.data) return updateRecord("sys_user_preference", existing.data.sys_id, { value });
  const me = await currentUserId();
  if (!me.ok) return me;
  return createRecord("sys_user_preference", { user: me.data, name, value });
}
