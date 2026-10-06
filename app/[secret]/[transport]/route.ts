import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import {
  businessUnitNames,
  campaignNames,
  dateParam,
  jobTypeNames,
  money,
  resolveId,
  stGet,
  stGetAll,
  stPost,
  technicianNames,
} from "../../../lib/st";
import { registerWriteTools } from "../../../lib/writes";

export const maxDuration = 60;

const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

const err = (message: string) => ({
  content: [{ type: "text" as const, text: message }],
  isError: true,
});

// Every tool is read-only; errors come back as text so Claude can adjust.
function safe<A>(fn: (args: A) => Promise<any>) {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e: any) {
      return err(e?.message ?? String(e));
    }
  };
}

const DATE = "Date as YYYY-MM-DD (business-local) or a full ISO timestamp";

function sumBy<T>(rows: T[], key: (r: T) => string, value: (r: T) => number) {
  const out: Record<string, { count: number; total: number }> = {};
  for (const r of rows) {
    const k = key(r) || "(none)";
    out[k] ??= { count: 0, total: 0 };
    out[k].count++;
    out[k].total = money(out[k].total + value(r));
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1].total - a[1].total));
}

const handler = createMcpHandler(
  (server) => {
    server.tool(
      "search_customers",
      "Find customers by name, phone, or street address. Returns id, name, type, balance, and address. Use get_customer for full details.",
      {
        name: z.string().optional().describe("Customer name (partial ok)"),
        phone: z.string().optional().describe("Phone number"),
        street: z.string().optional().describe("Street address (partial ok)"),
        zip: z.string().optional(),
      },
      { readOnlyHint: true },
      safe(async ({ name, phone, street, zip }) => {
        if (!name && !phone && !street && !zip) return err("Give at least one of name, phone, street, zip.");
        const res = await stGet("crm/v2/tenant/{tenant}/customers", {
          name, phone: phone?.replace(/\D/g, ""), street, zip, pageSize: 50,
        });
        return json({
          count: res.data.length,
          more_available: res.hasMore,
          customers: res.data.map((c: any) => ({
            id: c.id, name: c.name, type: c.type, active: c.active, balance: c.balance,
            address: c.address ? `${c.address.street}, ${c.address.city} ${c.address.state} ${c.address.zip}` : null,
            created: c.createdOn?.startsWith("0001") ? null : c.createdOn,
          })),
        });
      })
    );

    server.tool(
      "get_customer",
      "Full details for one customer: profile, contacts (phones/emails), service locations, recent jobs, and open invoice balance.",
      { customer_id: z.number().describe("ServiceTitan customer id") },
      { readOnlyHint: true },
      safe(async ({ customer_id }) => {
        const [customer, contacts, locations, jobs, invoices] = await Promise.all([
          stGet(`crm/v2/tenant/{tenant}/customers/${customer_id}`),
          stGet(`crm/v2/tenant/{tenant}/customers/${customer_id}/contacts`, { pageSize: 50 }),
          stGet("crm/v2/tenant/{tenant}/locations", { customerId: customer_id, pageSize: 50 }),
          stGet("jpm/v2/tenant/{tenant}/jobs", { customerId: customer_id, pageSize: 25, sort: "-createdOn" }),
          stGet("accounting/v2/tenant/{tenant}/invoices", { customerId: customer_id, pageSize: 50, sort: "-invoicedOn" }),
        ]);
        const [jt, bu] = await Promise.all([jobTypeNames(), businessUnitNames()]);
        return json({
          customer,
          contacts: contacts.data.map((c: any) => ({ id: c.id, type: c.type, value: c.value, memo: c.memo })),
          locations: locations.data.map((l: any) => ({ id: l.id, name: l.name, address: l.address })),
          recent_jobs: jobs.data.map((j: any) => ({
            id: j.id, number: j.jobNumber, status: j.jobStatus, type: jt.get(j.jobTypeId),
            business_unit: bu.get(j.businessUnitId), created: j.createdOn, completed: j.completedOn, total: j.total,
          })),
          recent_invoices: invoices.data.map((i: any) => ({
            id: i.id, number: i.referenceNumber, date: i.invoiceDate, total: Number(i.total), balance: Number(i.balance),
          })),
        });
      })
    );

    server.tool(
      "list_jobs",
      "List jobs filtered by date, status, business unit, job type, technician, or customer, with a summary count by status/type/business unit. Date filter applies to completion date when status is Completed, otherwise to creation date unless date_field says otherwise.",
      {
        from: z.string().optional().describe(DATE),
        to: z.string().optional().describe(`${DATE} (exclusive)`),
        date_field: z.enum(["created", "completed", "appointment"]).optional().describe("Which date the from/to range filters on"),
        status: z.enum(["Scheduled", "Dispatched", "InProgress", "Hold", "Completed", "Canceled"]).optional(),
        business_unit: z.string().optional().describe("Business unit name (partial ok) or id"),
        job_type: z.string().optional().describe("Job type name (partial ok) or id"),
        technician: z.string().optional().describe("Technician name (partial ok) or id"),
        customer_id: z.number().optional(),
        include_jobs: z.boolean().optional().describe("Return the individual jobs (default true; set false for big ranges and just read the summary)"),
      },
      { readOnlyHint: true },
      safe(async (a) => {
        const [bu, jt, tech] = await Promise.all([businessUnitNames(), jobTypeNames(), technicianNames()]);
        const field = a.date_field ?? (a.status === "Completed" ? "completed" : "created");
        const range =
          field === "completed" ? { completedOnOrAfter: dateParam(a.from), completedBefore: dateParam(a.to) }
          : field === "appointment" ? { appointmentStartsOnOrAfter: dateParam(a.from), appointmentStartsBefore: dateParam(a.to) }
          : { createdOnOrAfter: dateParam(a.from), createdBefore: dateParam(a.to) };
        const { data, truncated } = await stGetAll("jpm/v2/tenant/{tenant}/jobs", {
          ...range,
          jobStatus: a.status,
          businessUnitId: await resolveId(bu, a.business_unit, "business unit"),
          jobTypeId: await resolveId(jt, a.job_type, "job type"),
          technicianId: await resolveId(tech, a.technician, "technician"),
          customerId: a.customer_id,
        });
        const jobs = data.map((j: any) => ({
          id: j.id, number: j.jobNumber, status: j.jobStatus, type: jt.get(j.jobTypeId) ?? j.jobTypeId,
          business_unit: bu.get(j.businessUnitId) ?? j.businessUnitId, customer_id: j.customerId,
          created: j.createdOn, completed: j.completedOn, total: Number(j.total ?? 0),
          summary: j.summary ? String(j.summary).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) : null,
        }));
        return json({
          count: jobs.length,
          truncated,
          by_status: sumBy(jobs, (j) => j.status, (j) => j.total),
          by_type: sumBy(jobs, (j) => String(j.type), (j) => j.total),
          by_business_unit: sumBy(jobs, (j) => String(j.business_unit), (j) => j.total),
          jobs: a.include_jobs === false ? undefined : jobs.slice(0, 300),
        });
      })
    );

    server.tool(
      "list_appointments",
      "Appointments on the schedule for a date range with the assigned technicians — use for 'what's on the board tomorrow', 'how many appointments does each tech have'.",
      {
        from: z.string().describe(DATE),
        to: z.string().describe(`${DATE} (exclusive)`),
        technician: z.string().optional().describe("Technician name (partial ok) or id"),
      },
      { readOnlyHint: true },
      safe(async ({ from, to, technician }) => {
        const tech = await technicianNames();
        const techId = await resolveId(tech, technician, "technician");
        const appts = await stGetAll("jpm/v2/tenant/{tenant}/appointments", {
          startsOnOrAfter: dateParam(from), startsBefore: dateParam(to),
        });
        const ids = appts.data.map((a: any) => a.id);
        const assignments: any[] = [];
        for (let i = 0; i < ids.length; i += 50) {
          const { data } = await stGetAll("dispatch/v2/tenant/{tenant}/appointment-assignments", {
            appointmentIds: ids.slice(i, i + 50).join(","),
          });
          assignments.push(...data);
        }
        const techsByAppt = new Map<number, string[]>();
        for (const s of assignments.filter((s) => s.active !== false)) {
          if (techId && s.technicianId !== techId) continue;
          techsByAppt.set(s.appointmentId, [...(techsByAppt.get(s.appointmentId) ?? []), s.technicianName ?? tech.get(s.technicianId)]);
        }
        let list = appts.data.map((a: any) => ({
          id: a.id, job_id: a.jobId, number: a.appointmentNumber, status: a.status,
          start: a.start, end: a.end, customer_id: a.customerId, technicians: techsByAppt.get(a.id) ?? [],
        }));
        if (techId) list = list.filter((a: any) => a.technicians.length > 0);
        const perTech: Record<string, number> = {};
        for (const a of list) for (const t of a.technicians) perTech[t] = (perTech[t] ?? 0) + 1;
        return json({ count: list.length, truncated: appts.truncated, per_technician: perTech, appointments: list.slice(0, 300) });
      })
    );

    server.tool(
      "invoices_summary",
      "Invoiced revenue for a date range (by invoice date), with totals, open balance, and breakdowns by business unit and month. Optionally list the invoices. Use for revenue and A/R questions.",
      {
        from: z.string().describe(DATE),
        to: z.string().describe(`${DATE} (exclusive)`),
        business_unit: z.string().optional().describe("Business unit name (partial ok) or id"),
        customer_id: z.number().optional(),
        unpaid_only: z.boolean().optional().describe("Only invoices with a balance due"),
        include_invoices: z.boolean().optional().describe("Also return individual invoices (max 300)"),
      },
      { readOnlyHint: true },
      safe(async (a) => {
        const bu = await businessUnitNames();
        const { data, truncated } = await stGetAll("accounting/v2/tenant/{tenant}/invoices", {
          invoicedOnOrAfter: a.from.slice(0, 10),
          invoicedOnBefore: a.to.slice(0, 10),
          businessUnitId: await resolveId(bu, a.business_unit, "business unit"),
          customerId: a.customer_id,
        }, 20000);
        let inv = data.map((i: any) => ({
          id: i.id, number: i.referenceNumber, date: String(i.invoiceDate ?? "").slice(0, 10),
          customer: i.customer?.name, customer_id: i.customer?.id, job_number: i.job?.number,
          business_unit: i.businessUnit?.name ?? bu.get(i.businessUnit?.id) ?? "(none)",
          subtotal: Number(i.subTotal ?? 0), tax: Number(i.salesTax ?? 0), total: Number(i.total ?? 0), balance: Number(i.balance ?? 0),
        }));
        if (a.unpaid_only) inv = inv.filter((i) => i.balance > 0.005);
        return json({
          count: inv.length,
          truncated,
          total: money(inv.reduce((s, i) => s + i.total, 0)),
          subtotal_before_tax: money(inv.reduce((s, i) => s + i.subtotal, 0)),
          open_balance: money(inv.reduce((s, i) => s + i.balance, 0)),
          by_business_unit: sumBy(inv, (i) => i.business_unit, (i) => i.total),
          by_month: sumBy(inv, (i) => i.date.slice(0, 7), (i) => i.total),
          invoices: a.include_invoices ? inv.slice(0, 300) : undefined,
        });
      })
    );

    server.tool(
      "payments_summary",
      "Payments received in a date range with totals by payment type.",
      {
        from: z.string().describe(DATE),
        to: z.string().describe(`${DATE} (exclusive)`),
        include_payments: z.boolean().optional(),
      },
      { readOnlyHint: true },
      safe(async ({ from, to, include_payments }) => {
        const { data, truncated } = await stGetAll("accounting/v2/tenant/{tenant}/payments", {
          paidOnAfter: dateParam(from), paidOnBefore: dateParam(to),
        }, 20000);
        const pay = data.map((p: any) => ({
          id: p.id, date: p.date, type: p.type, total: Number(p.total ?? 0), customer: p.customer?.name, memo: p.memo,
        }));
        return json({
          count: pay.length, truncated,
          total: money(pay.reduce((s, p) => s + p.total, 0)),
          by_type: sumBy(pay, (p) => p.type, (p) => p.total),
          payments: include_payments ? pay.slice(0, 300) : undefined,
        });
      })
    );

    server.tool(
      "estimates_summary",
      "Estimates created or sold in a date range, with close rate and totals by salesperson/status. Use for sales and close-rate questions.",
      {
        from: z.string().describe(DATE),
        to: z.string().describe(`${DATE} (exclusive)`),
        date_field: z.enum(["created", "sold"]).optional().describe("Filter on created date (default) or sold date"),
        include_estimates: z.boolean().optional(),
      },
      { readOnlyHint: true },
      safe(async ({ from, to, date_field, include_estimates }) => {
        const range = date_field === "sold"
          ? { soldAfter: dateParam(from), soldBefore: dateParam(to) }
          : { createdOnOrAfter: dateParam(from), createdBefore: dateParam(to) };
        const [{ data, truncated }, tech] = await Promise.all([
          stGetAll("sales/v2/tenant/{tenant}/estimates", range, 20000),
          technicianNames(),
        ]);
        const est = data.map((e: any) => ({
          id: e.id, name: e.name, job_number: e.jobNumber, status: e.status?.name ?? e.status,
          sold_by: tech.get(e.soldBy) ?? (e.soldBy ? `employee ${e.soldBy}` : "(unsold)"),
          created: e.createdOn, sold_on: e.soldOn, subtotal: Number(e.subtotal ?? 0),
        }));
        const sold = est.filter((e) => e.sold_on);
        return json({
          count: est.length, truncated,
          sold_count: sold.length,
          sold_total: money(sold.reduce((s, e) => s + e.subtotal, 0)),
          close_rate_by_count: est.length ? `${Math.round((sold.length / est.length) * 100)}%` : null,
          by_status: sumBy(est, (e) => String(e.status), (e) => e.subtotal),
          sold_by_salesperson: sumBy(sold, (e) => e.sold_by, (e) => e.subtotal),
          estimates: include_estimates ? est.slice(0, 300) : undefined,
        });
      })
    );

    server.tool(
      "calls_summary",
      "Phone calls in a date range (ServiceTitan telecom): counts by direction, call type (booked/not booked/etc.), and campaign.",
      {
        from: z.string().describe(DATE),
        to: z.string().describe(`${DATE} (exclusive)`),
        include_calls: z.boolean().optional(),
      },
      { readOnlyHint: true },
      safe(async ({ from, to, include_calls }) => {
        const { data, truncated } = await stGetAll("telecom/v3/tenant/{tenant}/calls", {
          createdOnOrAfter: dateParam(from), createdBefore: dateParam(to),
        }, 20000);
        // v3 wraps the call in leadCall; job info sits on the outer record.
        const calls = data.map((r: any) => ({ ...r.leadCall, jobNumber: r.jobNumber })).map((c: any) => ({
          id: c.id, received: c.receivedOn ?? c.createdOn, job_number: c.jobNumber ?? null, direction: c.direction, type: c.callType ?? "(none)",
          duration: c.duration, from: c.from, to: c.to, campaign: c.campaign?.name ?? "(none)",
          customer: c.customer?.name, agent: c.agent?.name, reason: c.reason?.name,
        }));
        const count = (key: (c: any) => string) => {
          const out: Record<string, number> = {};
          for (const c of calls) out[key(c) || "(none)"] = (out[key(c) || "(none)"] ?? 0) + 1;
          return Object.fromEntries(Object.entries(out).sort((x, y) => y[1] - x[1]));
        };
        return json({
          count: calls.length, truncated,
          by_direction: count((c) => c.direction),
          by_call_type: count((c) => c.type),
          by_campaign: count((c) => c.campaign),
          by_agent: count((c) => c.agent),
          calls: include_calls ? calls.slice(0, 300) : undefined,
        });
      })
    );

    server.tool(
      "list_reference",
      "Lookup lists: technicians, business units, job types, campaigns, employees, or tag types. Use to learn the names before filtering other tools.",
      {
        kind: z.enum([
          "technicians", "business_units", "job_types", "campaigns", "employees", "tag_types",
          "cancel_reasons", "booking_providers", "task_options", "payment_types", "membership_types",
        ]),
      },
      { readOnlyHint: true },
      safe(async ({ kind }) => {
        if (kind === "task_options") {
          const d = await stGet("taskmanagement/v2/tenant/{tenant}/data");
          const slim = (rows: any[], id = "id") => (rows ?? []).filter((r) => r.active !== false).map((r) => ({ id: r[id], name: r.name }));
          return json({
            employees: slim(d.employees), task_types: slim(d.taskTypes), sources: slim(d.taskSources),
            business_units: slim(d.businessUnits, "value"), priorities: (d.taskPriorities ?? []).map((p: any) => p.name),
          });
        }
        if (kind === "membership_types") {
          const { data } = await stGetAll("memberships/v2/tenant/{tenant}/membership-types", { active: "True" }, 2000);
          const withBilling = await Promise.all(data.map(async (t: any) => {
            const b = await stGet(`memberships/v2/tenant/{tenant}/membership-types/${t.id}/duration-billing-items`).catch(() => []);
            const opts = (Array.isArray(b) ? b : b.data ?? []).filter((x: any) => x.active !== false);
            return {
              id: t.id, name: t.name,
              billing_options: opts.map((x: any) => ({ id: x.id, frequency: x.billingFrequency, duration_months: x.duration, sale_price: x.salePrice, billing_price: x.billingPrice })),
            };
          }));
          return json({ count: withBilling.length, items: withBilling });
        }
        const paths = {
          technicians: "settings/v2/tenant/{tenant}/technicians",
          business_units: "settings/v2/tenant/{tenant}/business-units",
          job_types: "jpm/v2/tenant/{tenant}/job-types",
          campaigns: "marketing/v2/tenant/{tenant}/campaigns",
          employees: "settings/v2/tenant/{tenant}/employees",
          tag_types: "settings/v2/tenant/{tenant}/tag-types",
          cancel_reasons: "jpm/v2/tenant/{tenant}/job-cancel-reasons",
          booking_providers: "crm/v2/tenant/{tenant}/booking-provider-tags",
          payment_types: "accounting/v2/tenant/{tenant}/payment-types",
        };
        const { data } = await stGetAll(paths[kind], {}, 5000);
        return json({
          count: data.length,
          items: data.map((r: any) => ({ id: r.id, name: r.name ?? r.tagName, active: r.active, role: r.role, businessUnitId: r.businessUnitId })),
        });
      })
    );

    server.tool(
      "list_reports",
      "List the saved reports in the ServiceTitan Reporting module. Without a category, lists report categories. With a category, lists its reports. Then use describe_report and run_report.",
      { category: z.string().optional().describe("Report category id, e.g. 'operations', 'accounting', 'marketing', 'technician'") },
      { readOnlyHint: true },
      safe(async ({ category }) => {
        if (!category) {
          const { data } = await stGetAll("reporting/v2/tenant/{tenant}/report-categories");
          return json(data);
        }
        const { data } = await stGetAll(`reporting/v2/tenant/{tenant}/report-category/${category}/reports`, {}, 1000);
        return json(data.map((r: any) => ({ id: r.id, name: r.name, description: r.description })));
      })
    );

    server.tool(
      "describe_report",
      "Show a saved report's parameters (e.g. date range, business units) and output columns. Call before run_report.",
      { category: z.string(), report_id: z.number() },
      { readOnlyHint: true },
      safe(async ({ category, report_id }) =>
        json(await stGet(`reporting/v2/tenant/{tenant}/report-category/${category}/reports/${report_id}`))
      )
    );

    server.tool(
      "run_report",
      "Run a saved ServiceTitan report and return its rows. Parameters are name/value pairs from describe_report, e.g. [{name:'From',value:'2026-09-01'},{name:'To',value:'2026-09-30'}]. ServiceTitan limits report runs to a few per minute; wait and retry if rate-limited.",
      {
        category: z.string(),
        report_id: z.number(),
        parameters: z.array(z.object({ name: z.string(), value: z.any() })).default([]),
        max_rows: z.number().optional().describe("Default 1000"),
      },
      { readOnlyHint: true },
      safe(async ({ category, report_id, parameters, max_rows }) => {
        const limit = max_rows ?? 1000;
        const res = await stPost(
          `reporting/v2/tenant/{tenant}/report-category/${category}/reports/${report_id}/data`,
          { parameters },
          { pageSize: Math.min(limit, 5000) }
        );
        const cols = (res.fields ?? []).map((f: any) => f.label ?? f.name);
        const rows = (res.data ?? []).slice(0, limit).map((r: any[]) => Object.fromEntries(cols.map((c: string, i: number) => [c, r[i]])));
        return json({ columns: cols, row_count: rows.length, has_more: res.hasMore, rows });
      })
    );

    server.tool(
      "api_get",
      "Advanced: read any ServiceTitan API endpoint (GET only) when no other tool fits. Path like 'jpm/v2/tenant/{tenant}/jobs/123' or 'pricebook/v2/tenant/{tenant}/services' — {tenant} is filled in automatically. Returns one page; pass page/pageSize in params to page.",
      {
        path: z.string(),
        params: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
      },
      { readOnlyHint: true },
      safe(async ({ path, params }) => {
        const clean = path.replace(/^https?:\/\/[^/]+\//, "").replace(/^\//, "");
        if (!/^[a-z-]+\/v\d+\/tenant\/(\{tenant\}|\d+)\//.test(clean)) {
          return err("Path must look like '<module>/v2/tenant/{tenant}/<resource>'.");
        }
        return json(await stGet(clean.replace(/tenant\/\d+\//, "tenant/{tenant}/"), params ?? {}));
      })
    );

    registerWriteTools(server);
  },
  {
    serverInfo: { name: "servicetitan", version: "1.0.0" },
    instructions:
      "Access to this company's ServiceTitan data. Prefer the summary tools (list_jobs, invoices_summary, estimates_summary, calls_summary, payments_summary) for totals; use list_reference to learn technician/business-unit names; use saved reports (list_reports → describe_report → run_report) for anything matching a report the company already uses; use api_get only as a last resort. Write tools (create_*, update_*, add_*, set_contact, reschedule_appointment, cancel_job, assign_technicians, record_payment, edit_invoice, write_off_balance, sell_membership) always return a preview first: show it to the user, and only call again with confirm: true after they explicitly approve. Never confirm on your own. Plain dates are in the business's local time zone and 'to' dates are exclusive.",
  },
  {
    // Requests are re-addressed to /connector/mcp below, so a secret with
    // characters that get URL-encoded can't break route matching.
    basePath: "/connector",
    maxDuration: 60,
    verboseLogs: false,
  }
);

// The URL's secret segment is the only auth — wrong secret → 404.
async function guarded(req: Request, ctx: { params: Promise<{ secret: string; transport: string }> }) {
  const { secret, transport } = await ctx.params;
  const expected = process.env.MCP_PATH_SECRET?.trim();
  if (!expected || decodeURIComponent(secret).trim() !== expected) {
    return new Response("Not found", { status: 404 });
  }
  if (transport !== "mcp") {
    // SSE legacy transport needs Redis; we only serve streamable HTTP.
    return new Response("Not found", { status: 404 });
  }
  const url = new URL(req.url);
  url.pathname = "/connector/mcp";
  return handler(new Request(url, req));
}

export { guarded as GET, guarded as POST, guarded as DELETE };
