import { z } from "zod";
import { snRequest } from "../sn.mjs";
import { ok, fail, preview, json, toTable, stripHtml, truncate } from "../format.mjs";

const SC = "/api/sn_sc/servicecatalog";

function trimVariable(v) {
  const out = { name: v.name, label: v.label, type: v.friendly_type ?? v.type, mandatory: v.mandatory ? "yes" : "" };
  if (v.choices?.length) out.choices = v.choices.slice(0, 30).map((c) => `${c.label}=${c.value}`).join(" | ") + (v.choices.length > 30 ? ` …(+${v.choices.length - 30})` : "");
  if (v.reference) out.reference = v.reference;
  if (v.children?.length) out.children = v.children.map(trimVariable);
  return out;
}

export function registerCatalog(server, { readOnly }) {
  server.registerTool(
    "list_catalogs",
    {
      title: "List catalogs or categories",
      description: "Without catalog_id: all catalogs. With it: the categories of that catalog.",
      inputSchema: z.object({ catalog_id: z.string().optional() }),
    },
    async ({ catalog_id }) => {
      const res = await snRequest("GET", catalog_id ? `${SC}/catalogs/${encodeURIComponent(catalog_id)}/categories` : `${SC}/catalogs`, { query: { sysparm_limit: 100 } });
      if (!res.ok) return fail(res.message);
      const rows = (res.data?.result ?? []).map((c) => ({ sys_id: c.sys_id, title: c.title, description: truncate(stripHtml(c.description ?? ""), 120), ...(catalog_id ? { items: c.item_count } : {}) }));
      return ok(toTable(rows));
    }
  );

  server.registerTool(
    "search_catalog",
    {
      title: "Search catalog items",
      description: "Full-text search of orderable catalog items, optionally within a catalog or category.",
      inputSchema: z.object({
        text: z.string().optional(),
        catalog: z.string().optional().describe("Catalog sys_id"),
        category: z.string().optional().describe("Category sys_id"),
        limit: z.number().int().min(1).max(50).default(10),
      }),
    },
    async ({ text, catalog, category, limit }) => {
      const res = await snRequest("GET", `${SC}/items`, { query: { sysparm_text: text, sysparm_catalog: catalog, sysparm_category: category, sysparm_limit: limit } });
      if (!res.ok) return fail(res.message);
      const rows = (res.data?.result ?? []).map((i) => ({ sys_id: i.sys_id, name: i.name, type: i.sys_class_name ?? i.type, price: i.price, category: i.category?.title, short_description: truncate(stripHtml(i.short_description ?? ""), 100) }));
      return ok(rows.length ? toTable(rows, ["sys_id", "name", "type", "price", "category", "short_description"]) : "No items found.");
    }
  );

  server.registerTool(
    "describe_catalog_item",
    {
      title: "Describe a catalog item",
      description: "Name, description (HTML stripped), price and the variable tree with names, types, mandatory flags and choices. Use the variable names as keys when ordering.",
      inputSchema: z.object({ sys_id: z.string() }),
    },
    async ({ sys_id }) => {
      const res = await snRequest("GET", `${SC}/items/${encodeURIComponent(sys_id)}`);
      if (!res.ok) return fail(res.message);
      const i = res.data?.result ?? {};
      const out = {
        sys_id: i.sys_id,
        name: i.name,
        type: i.sys_class_name ?? i.type,
        category: i.category?.title,
        price: i.price,
        recurring_price: i.recurring_price,
        short_description: stripHtml(i.short_description ?? ""),
        description: truncate(stripHtml(i.description ?? ""), 800),
        variables: (i.variables ?? []).map(trimVariable),
      };
      return ok(json(out));
    }
  );

  if (readOnly) return;

  server.registerTool(
    "order_item",
    {
      title: "Order a catalog item",
      description: "Order now (creates the request immediately) or add to cart. Variables are keyed by variable name. The request is created in the name of the authenticated user; a web_service_access_only account usually cannot order. Preview unless confirm is true.",
      inputSchema: z.object({
        sys_id: z.string(),
        mode: z.enum(["now", "cart"]).default("now"),
        quantity: z.number().int().min(1).default(1),
        variables: z.record(z.string(), z.unknown()).default({}),
        requested_for: z.string().optional().describe("sys_user sys_id; only for mode now"),
        confirm: z.boolean().default(false),
      }),
    },
    async (a) => {
      if (!a.confirm) return preview(`Would ${a.mode === "now" ? "order now" : "add to cart"} item ${a.sys_id} x${a.quantity}:`, [json(a.variables), a.requested_for ? `requested_for: ${a.requested_for}` : ""].filter(Boolean));
      const body = { sysparm_quantity: String(a.quantity), variables: a.variables };
      if (a.requested_for && a.mode === "now") body.sysparm_requested_for = a.requested_for;
      const res = await snRequest("POST", `${SC}/items/${encodeURIComponent(a.sys_id)}/${a.mode === "now" ? "order_now" : "add_to_cart"}`, { body });
      if (!res.ok) return fail(res.message);
      const r = res.data?.result ?? {};
      if (a.mode === "now") return ok(`Ordered. Request ${r.request_number ?? "?"} (sys_id ${r.request_id ?? "?"}, table ${r.table ?? "sc_request"}).`);
      return ok(`Added to cart.\n${json({ cart_id: r.cart_id, items: (r.items ?? []).length, subtotal: r.subtotal ?? r.subtotal_price })}`);
    }
  );

  server.registerTool(
    "cart",
    {
      title: "View, submit or empty the cart",
      description: "The cart of the authenticated user. submit and empty require confirm.",
      inputSchema: z.object({
        action: z.enum(["view", "submit", "empty"]).default("view"),
        confirm: z.boolean().default(false),
      }),
    },
    async ({ action, confirm }) => {
      const view = await snRequest("GET", `${SC}/cart`);
      if (!view.ok) return fail(view.message);
      const c = view.data?.result ?? {};
      const items = (c.items ?? []).map((i) => ({ name: i.name ?? i.catalog_item?.name, quantity: i.quantity, price: i.price, cart_item_id: i.cart_item_id }));
      const summary = `Cart ${c.cart_id ?? "?"}: ${items.length} item(s), subtotal ${c.subtotal ?? c.subtotal_price ?? "?"}\n${toTable(items)}`;
      if (action === "view") return ok(summary);
      if (!items.length) return ok(`Cart is already empty.\n${summary}`);
      if (!confirm) return preview(`Would ${action} this cart:`, [summary]);
      if (action === "submit") {
        const res = await snRequest("POST", `${SC}/cart/submit_order`, { body: {} });
        if (!res.ok) return fail(res.message);
        return ok(`Submitted. Request ${res.data?.result?.request_number ?? "?"} (sys_id ${res.data?.result?.request_id ?? "?"}).`);
      }
      const res = await snRequest("DELETE", `${SC}/cart/${encodeURIComponent(c.cart_id)}/empty`);
      if (!res.ok) return fail(res.message);
      return ok("Cart emptied.");
    }
  );
}
