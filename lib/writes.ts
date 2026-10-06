import { z } from "zod";
import {
  bookingProviderNames,
  businessUnitNames,
  campaignNames,
  cancelReasonNames,
  dateParam,
  jobTypeNames,
  resolveId,
  stGet,
  stGetAll,
  stWrite,
  tagTypeNames,
  technicianNames,
  writesEnabled,
} from "./st";

// Write tools. Every one works in two steps:
//   1. called without confirm → returns a preview of exactly what will change
//      (nothing is sent to ServiceTitan);
//   2. called again with confirm: true after the user approves → does it.
// All writes are also blocked unless ALLOW_WRITES=true in the environment.

const text = (data: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

const CONFIRM = z
  .boolean()
  .optional()
  .describe("Leave out first to get a preview. Set true ONLY after the user has seen the preview and said yes.");

type Plan = { action: string; details: Record<string, unknown>; run: () => Promise<any> };

async function twoStep(confirm: boolean | undefined, plan: () => Promise<Plan>) {
  try {
    const p = await plan();
    if (!confirm) {
      return text({
        status: "PREVIEW ONLY — nothing has been changed in ServiceTitan",
        action: p.action,
        details: p.details,
        writes_enabled: writesEnabled(),
        next_step:
          "Show this preview to the user in plain language and ask them to approve it. Only if they say yes, call this tool again with the same arguments plus confirm: true.",
      });
    }
    if (!writesEnabled()) {
      return text("Writes are turned off for this connector. To allow them, set ALLOW_WRITES=true in the Vercel environment variables and redeploy.", true);
    }
    const result = await p.run();
    return text({ status: "DONE", action: p.action, result });
  } catch (e: any) {
    return text(e?.message ?? String(e), true);
  }
}

const ADDRESS = {
  street: z.string().describe("Street address"),
  unit: z.string().optional(),
  city: z.string(),
  state: z.string().describe("2-letter state"),
  zip: z.string(),
};

const addr = (a: { street: string; unit?: string; city: string; state: string; zip: string }) => ({
  street: a.street, unit: a.unit ?? "", city: a.city, state: a.state, zip: a.zip, country: "USA",
});

async function resolveMany(map: Map<number, string>, values: string[] | undefined, label: string): Promise<number[]> {
  const out: number[] = [];
  for (const v of values ?? []) out.push((await resolveId(map, v, label))!);
  return out;
}

// Task Management's lookup lists (employees, task types, sources, BUs) come from one endpoint.
let taskData: { at: number; data: any } | null = null;
async function getTaskData() {
  if (taskData && Date.now() - taskData.at < 600_000) return taskData.data;
  const data = await stGet("taskmanagement/v2/tenant/{tenant}/data");
  taskData = { at: Date.now(), data };
  return data;
}
const toMap = (rows: any[], id = "id") => new Map<number, string>((rows ?? []).filter((r) => r.active !== false).map((r) => [r[id], r.name]));


// Pricebook lookup by id, code, or name across services / materials / equipment.
// The pricebook endpoints ignore search filters, so load once and match here.
let pricebook: { at: number; items: any[] } | null = null;
async function getPricebook() {
  if (pricebook && Date.now() - pricebook.at < 1_800_000) return pricebook.items;
  const kinds = ["services", "materials", "equipment"] as const;
  const lists = await Promise.all(
    kinds.map((k) => stGetAll(`pricebook/v2/tenant/{tenant}/${k}`, { active: "True" }, 20000).then((r) => r.data.map((x: any) => ({ ...x, kind: k }))))
  );
  pricebook = { at: Date.now(), items: lists.flat() };
  return pricebook.items;
}

async function resolveSku(value: string): Promise<any> {
  const items = await getPricebook();
  const v = value.trim().toLowerCase();
  if (/^\d+$/.test(v)) {
    const byId = items.find((x) => String(x.id) === v);
    if (byId) return byId;
  }
  const byCode = items.filter((x) => String(x.code ?? "").toLowerCase() === v);
  if (byCode.length === 1) return byCode[0];
  const byName = items.filter((x) =>
    [x.code, x.displayName, x.description].some((f) => String(f ?? "").toLowerCase().includes(v))
  );
  if (byName.length === 1) return byName[0];
  if (!byName.length) throw new Error(`No pricebook item matches "${value}".`);
  throw new Error(`"${value}" matches several pricebook items: ${byName.slice(0, 12).map((x) => `${x.code} (${x.displayName ?? ""})`).join(", ")}. Use the exact code.`);
}

const skuLabel = (x: any) => `${x.code}${x.displayName ? ` — ${x.displayName}` : ""}`;
const plainText = (h: unknown) => String(h ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

async function getInvoice(id: number) {
  const res = await stGet("accounting/v2/tenant/{tenant}/invoices", { ids: id });
  const inv = res.data?.[0];
  if (!inv) throw new Error(`Invoice ${id} not found.`);
  return inv;
}

const invoiceSummary = (inv: any) => ({
  invoice: inv.referenceNumber, customer: inv.customer?.name, job: inv.job?.number ?? null,
  date: String(inv.invoiceDate ?? "").slice(0, 10), total: Number(inv.total), balance: Number(inv.balance),
  exported: !!inv.exportId || inv.syncStatus === "Exported",
});

const TARGET_PATHS = {
  customer: (id: number) => `crm/v2/tenant/{tenant}/customers/${id}`,
  location: (id: number) => `crm/v2/tenant/{tenant}/locations/${id}`,
  job: (id: number) => `jpm/v2/tenant/{tenant}/jobs/${id}`,
};

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const CHANGE = { ...WRITE, destructiveHint: true };

export function registerWriteTools(server: any) {
  server.tool(
    "create_booking",
    "Create a booking (new lead) in ServiceTitan's Calls → Bookings queue for the office to schedule. Two-step: preview first, then confirm.",
    {
      name: z.string().describe("Customer name"),
      phone: z.string().optional(),
      email: z.string().optional(),
      street: z.string().optional(), unit: z.string().optional(), city: z.string().optional(),
      state: z.string().optional(), zip: z.string().optional(),
      summary: z.string().describe("What the customer needs"),
      customer_type: z.enum(["Residential", "Commercial"]).optional(),
      business_unit: z.string().optional().describe("Name (partial ok) or id"),
      job_type: z.string().optional().describe("Name (partial ok) or id"),
      campaign: z.string().optional().describe("Marketing campaign name or id"),
      preferred_start: z.string().optional().describe("Preferred date/time, e.g. 2026-10-08T09:00 (local)"),
      booking_provider: z.string().optional().describe("Booking provider tag name or id; defaults to BOOKING_PROVIDER_ID env"),
      confirm: CONFIRM,
    },
    WRITE,
    async (a: any) =>
      twoStep(a.confirm, async () => {
        const providerValue = a.booking_provider ?? process.env.BOOKING_PROVIDER_ID;
        if (!providerValue) {
          throw new Error("No booking provider. Pass booking_provider (see list_reference kind=booking_providers) or set BOOKING_PROVIDER_ID in Vercel.");
        }
        const [bp, bu, jt, camp] = await Promise.all([bookingProviderNames(), businessUnitNames(), jobTypeNames(), campaignNames()]);
        const provider = await resolveId(bp, String(providerValue), "booking provider");
        const body: Record<string, unknown> = {
          source: "Claude",
          name: a.name,
          summary: a.summary,
          isFirstTimeClient: true,
          isSendConfirmationEmail: false,
          externalId: `claude-${Date.now()}`,
          customerType: a.customer_type ?? "Residential",
          priority: "Normal",
          contacts: [
            ...(a.phone ? [{ type: "Phone", value: a.phone }] : []),
            ...(a.email ? [{ type: "Email", value: a.email }] : []),
          ],
        };
        if (a.street && a.city && a.state && a.zip) body.address = addr(a);
        if (a.preferred_start) body.start = dateParam(a.preferred_start);
        if (a.business_unit) body.businessUnitId = await resolveId(bu, a.business_unit, "business unit");
        if (a.job_type) body.jobTypeId = await resolveId(jt, a.job_type, "job type");
        if (a.campaign) body.campaignId = await resolveId(camp, a.campaign, "campaign");
        return {
          action: `Create booking for ${a.name}`,
          details: {
            booking_provider: bp.get(provider!) ?? provider,
            business_unit: body.businessUnitId ? bu.get(body.businessUnitId as number) : null,
            job_type: body.jobTypeId ? jt.get(body.jobTypeId as number) : null,
            campaign: body.campaignId ? camp.get(body.campaignId as number) : null,
            request: body,
          },
          run: () => stWrite("POST", `crm/v2/tenant/{tenant}/booking-provider/${provider}/bookings`, body),
        };
      })
  );

  server.tool(
    "create_customer",
    "Create a new customer with a service location (and optional phone/email). The preview lists possible existing duplicates. Two-step: preview first, then confirm.",
    {
      name: z.string(),
      customer_type: z.enum(["Residential", "Commercial"]).optional(),
      ...ADDRESS,
      phone: z.string().optional(),
      email: z.string().optional(),
      location_name: z.string().optional().describe("Defaults to the customer name"),
      confirm: CONFIRM,
    },
    WRITE,
    async (a: any) =>
      twoStep(a.confirm, async () => {
        const address = addr(a);
        const body = {
          name: a.name,
          type: a.customer_type ?? "Residential",
          address,
          locations: [{ name: a.location_name ?? a.name, address }],
        };
        const checks = await Promise.all([
          a.phone ? stGet("crm/v2/tenant/{tenant}/customers", { phone: a.phone.replace(/\D/g, ""), pageSize: 5 }) : null,
          stGet("crm/v2/tenant/{tenant}/customers", { street: a.street, zip: a.zip, pageSize: 5 }),
        ]);
        const dupes = new Map<number, any>();
        for (const r of checks) for (const c of r?.data ?? []) dupes.set(c.id, { id: c.id, name: c.name, address: c.address });
        return {
          action: `Create customer ${a.name}`,
          details: {
            possible_duplicates: [...dupes.values()],
            request: body,
            contacts_to_add: [a.phone && { type: "Phone", value: a.phone }, a.email && { type: "Email", value: a.email }].filter(Boolean),
          },
          run: async () => {
            const cust = await stWrite("POST", "crm/v2/tenant/{tenant}/customers", body);
            for (const [type, value] of [["Phone", a.phone], ["Email", a.email]]) {
              if (value) await stWrite("POST", `crm/v2/tenant/{tenant}/customers/${cust.id}/contacts`, { type, value });
            }
            return { customer_id: cust.id, name: cust.name };
          },
        };
      })
  );

  server.tool(
    "update_customer",
    "Change a customer's name, billing address, or do-not-mail / do-not-service flags. Two-step: preview first, then confirm.",
    {
      customer_id: z.number(),
      name: z.string().optional(),
      street: z.string().optional(), unit: z.string().optional(), city: z.string().optional(),
      state: z.string().optional(), zip: z.string().optional(),
      do_not_mail: z.boolean().optional(),
      do_not_service: z.boolean().optional(),
      confirm: CONFIRM,
    },
    CHANGE,
    async (a: any) =>
      twoStep(a.confirm, async () => {
        const cur = await stGet(TARGET_PATHS.customer(a.customer_id));
        const body: Record<string, unknown> = {};
        if (a.name) body.name = a.name;
        if (a.do_not_mail !== undefined) body.doNotMail = a.do_not_mail;
        if (a.do_not_service !== undefined) body.doNotService = a.do_not_service;
        if (a.street || a.city || a.state || a.zip || a.unit !== undefined) {
          body.address = { ...cur.address, ...Object.fromEntries(["street", "unit", "city", "state", "zip"].filter((k) => a[k] !== undefined).map((k) => [k, a[k]])) };
        }
        if (!Object.keys(body).length) throw new Error("Nothing to change — pass at least one field.");
        return {
          action: `Update customer ${cur.name} (#${cur.id})`,
          details: {
            before: Object.fromEntries(Object.keys(body).map((k) => [k, cur[k]])),
            after: body,
          },
          run: () => stWrite("PATCH", TARGET_PATHS.customer(a.customer_id), body),
        };
      })
  );

  server.tool(
    "set_contact",
    "Add a phone/email to a customer, or change an existing one (pass contact_id from get_customer). Two-step: preview first, then confirm.",
    {
      customer_id: z.number(),
      contact_id: z.number().optional().describe("Existing contact to change; leave out to add a new one"),
      type: z.enum(["Phone", "MobilePhone", "Email", "Fax"]),
      value: z.string(),
      memo: z.string().optional(),
      confirm: CONFIRM,
    },
    CHANGE,
    async (a: any) =>
      twoStep(a.confirm, async () => {
        const [cust, contacts] = await Promise.all([
          stGet(TARGET_PATHS.customer(a.customer_id)),
          stGet(`crm/v2/tenant/{tenant}/customers/${a.customer_id}/contacts`, { pageSize: 50 }),
        ]);
        const existing = a.contact_id ? contacts.data.find((c: any) => c.id === a.contact_id) : null;
        if (a.contact_id && !existing) throw new Error(`Contact ${a.contact_id} isn't on customer ${a.customer_id}.`);
        const body = { type: a.type, value: a.value, memo: a.memo ?? existing?.memo ?? null };
        return {
          action: existing ? `Change ${existing.type} on ${cust.name}` : `Add ${a.type} to ${cust.name}`,
          details: { before: existing ? { type: existing.type, value: existing.value, memo: existing.memo } : null, after: body },
          run: () =>
            existing
              ? stWrite("PATCH", `crm/v2/tenant/{tenant}/customers/${a.customer_id}/contacts/${a.contact_id}`, body)
              : stWrite("POST", `crm/v2/tenant/{tenant}/customers/${a.customer_id}/contacts`, body),
        };
      })
  );

  server.tool(
    "add_location",
    "Add a new service location (address) to an existing customer. Two-step: preview first, then confirm.",
    { customer_id: z.number(), name: z.string().optional().describe("Defaults to the customer name"), ...ADDRESS, confirm: CONFIRM },
    WRITE,
    async (a: any) =>
      twoStep(a.confirm, async () => {
        const cust = await stGet(TARGET_PATHS.customer(a.customer_id));
        const body = { customerId: a.customer_id, name: a.name ?? cust.name, address: addr(a) };
        return {
          action: `Add location to ${cust.name}`,
          details: { request: body },
          run: () => stWrite("POST", "crm/v2/tenant/{tenant}/locations", body),
        };
      })
  );

  server.tool(
    "add_note",
    "Add a note to a customer, location, or job. Two-step: preview first, then confirm.",
    {
      target: z.enum(["customer", "location", "job"]),
      id: z.number().describe("Customer, location, or job id"),
      text: z.string(),
      pin: z.boolean().optional().describe("Pin the note to the top"),
      confirm: CONFIRM,
    },
    WRITE,
    async (a: any) =>
      twoStep(a.confirm, async () => {
        const rec = await stGet(TARGET_PATHS[a.target as keyof typeof TARGET_PATHS](a.id));
        const label = a.target === "job" ? `job #${rec.jobNumber}` : `${a.target} ${rec.name}`;
        const body = { text: a.text, isPinned: !!a.pin, pinToTop: !!a.pin };
        return {
          action: `Add note to ${label}`,
          details: { text: a.text, pinned: !!a.pin },
          run: () => stWrite("POST", `${TARGET_PATHS[a.target as keyof typeof TARGET_PATHS](a.id)}/notes`, body),
        };
      })
  );

  server.tool(
    "create_job",
    "Create (book) a job with its first appointment. Times like 2026-10-08T09:00 are local. Two-step: preview first, then confirm.",
    {
      customer_id: z.number(),
      location_id: z.number(),
      business_unit: z.string().describe("Name (partial ok) or id"),
      job_type: z.string().describe("Name (partial ok) or id"),
      campaign: z.string().describe("Marketing campaign name or id"),
      summary: z.string(),
      start: z.string().describe("Appointment start"),
      end: z.string().describe("Appointment end"),
      arrival_window_start: z.string().optional(),
      arrival_window_end: z.string().optional(),
      technicians: z.array(z.string()).optional().describe("Technician names or ids to assign"),
      priority: z.enum(["Low", "Normal", "High", "Urgent"]).optional(),
      confirm: CONFIRM,
    },
    WRITE,
    async (a: any) =>
      twoStep(a.confirm, async () => {
        const [bu, jt, camp, tech, cust, loc] = await Promise.all([
          businessUnitNames(), jobTypeNames(), campaignNames(), technicianNames(),
          stGet(TARGET_PATHS.customer(a.customer_id)), stGet(TARGET_PATHS.location(a.location_id)),
        ]);
        if (loc.customerId !== a.customer_id) throw new Error(`Location ${a.location_id} doesn't belong to customer ${a.customer_id}.`);
        const techIds = await resolveMany(tech, a.technicians, "technician");
        const appt = {
          start: dateParam(a.start), end: dateParam(a.end),
          arrivalWindowStart: dateParam(a.arrival_window_start ?? a.start),
          arrivalWindowEnd: dateParam(a.arrival_window_end ?? a.end),
          ...(techIds.length ? { technicianIds: techIds } : {}),
        };
        const body = {
          customerId: a.customer_id, locationId: a.location_id,
          businessUnitId: await resolveId(bu, a.business_unit, "business unit"),
          jobTypeId: await resolveId(jt, a.job_type, "job type"),
          campaignId: await resolveId(camp, a.campaign, "campaign"),
          priority: a.priority ?? "Normal",
          summary: a.summary,
          appointments: [appt],
        };
        return {
          action: `Book ${jt.get(body.jobTypeId!)} for ${cust.name}`,
          details: {
            customer: cust.name, location: loc.address,
            business_unit: bu.get(body.businessUnitId!), job_type: jt.get(body.jobTypeId!), campaign: camp.get(body.campaignId!),
            appointment: { start: a.start, end: a.end, technicians: techIds.map((t) => tech.get(t)) },
            request: body,
          },
          run: async () => {
            const job = await stWrite("POST", "jpm/v2/tenant/{tenant}/jobs", body);
            return { job_id: job.id, job_number: job.jobNumber };
          },
        };
      })
  );

  server.tool(
    "reschedule_appointment",
    "Move an appointment to a new time. Get the appointment id from list_appointments or get_customer → jobs. Two-step: preview first, then confirm.",
    {
      appointment_id: z.number(),
      start: z.string(), end: z.string(),
      arrival_window_start: z.string().optional(), arrival_window_end: z.string().optional(),
      confirm: CONFIRM,
    },
    CHANGE,
    async (a: any) =>
      twoStep(a.confirm, async () => {
        const cur = await stGet(`jpm/v2/tenant/{tenant}/appointments/${a.appointment_id}`);
        if (["Canceled", "Done"].includes(cur.status)) {
          throw new Error(`Appointment ${cur.appointmentNumber} is ${cur.status} and can't be rescheduled.`);
        }
        const body = {
          start: dateParam(a.start), end: dateParam(a.end),
          arrivalWindowStart: dateParam(a.arrival_window_start ?? a.start),
          arrivalWindowEnd: dateParam(a.arrival_window_end ?? a.end),
        };
        return {
          action: `Reschedule appointment ${cur.appointmentNumber}`,
          details: { before: { start: cur.start, end: cur.end, status: cur.status }, after: body },
          run: () => stWrite("PATCH", `jpm/v2/tenant/{tenant}/appointments/${a.appointment_id}/reschedule`, body),
        };
      })
  );

  server.tool(
    "cancel_job",
    "Cancel a job with a cancel reason (see list_reference kind=cancel_reasons). ServiceTitan won't cancel a job whose invoice has items (e.g. an auto-added trip charge); the preview lists them, and clear_invoice_items: true removes them first. Two-step: preview first, then confirm.",
    {
      job_id: z.number(),
      reason: z.string().describe("Cancel reason name (partial ok) or id"),
      memo: z.string(),
      clear_invoice_items: z.boolean().optional().describe("Remove the job invoice's line items first so the cancel is allowed"),
      confirm: CONFIRM,
    },
    CHANGE,
    async (a: any) =>
      twoStep(a.confirm, async () => {
        const [job, reasons, jt, inv] = await Promise.all([
          stGet(TARGET_PATHS.job(a.job_id)), cancelReasonNames(), jobTypeNames(),
          stGet("accounting/v2/tenant/{tenant}/invoices", { jobId: a.job_id }),
        ]);
        if (job.jobStatus === "Canceled") throw new Error(`Job #${job.jobNumber} is already canceled.`);
        if (job.jobStatus === "Completed") throw new Error(`Job #${job.jobNumber} is completed and can't be canceled.`);
        const reasonId = await resolveId(reasons, a.reason, "cancel reason");
        const items = (inv.data ?? []).flatMap((i: any) =>
          (i.items ?? []).map((x: any) => ({ invoice_id: i.id, item_id: x.id, item: x.skuName ?? x.description, total: Number(x.total) }))
        );
        const paid = (inv.data ?? []).some((i: any) => Number(i.total) - Number(i.balance) > 0.005);
        if (items.length && paid) throw new Error(`Job #${job.jobNumber} has payments on its invoice — handle those in ServiceTitan before canceling.`);
        if (items.length && !a.clear_invoice_items) {
          throw new Error(
            `Job #${job.jobNumber}'s invoice has items (${items.map((x: any) => `${x.item} $${x.total}`).join(", ")}). ` +
            "ServiceTitan won't cancel it until they're removed. Ask the user whether to remove them, and if yes, call again with clear_invoice_items: true."
          );
        }
        return {
          action: `Cancel job #${job.jobNumber}`,
          details: {
            job_type: jt.get(job.jobTypeId), status: job.jobStatus, reason: reasons.get(reasonId!), memo: a.memo,
            invoice_items_to_remove: items,
          },
          run: async () => {
            for (const x of items) await stWrite("DELETE", `accounting/v2/tenant/{tenant}/invoices/${x.invoice_id}/items/${x.item_id}`);
            await stWrite("PUT", `jpm/v2/tenant/{tenant}/jobs/${a.job_id}/cancel`, { reasonId, memo: a.memo });
            return { canceled: true, invoice_items_removed: items.length };
          },
        };
      })
  );

  server.tool(
    "assign_technicians",
    "Add and/or remove technicians on an appointment. Two-step: preview first, then confirm.",
    {
      appointment_id: z.number(),
      add: z.array(z.string()).optional().describe("Technician names or ids to assign"),
      remove: z.array(z.string()).optional().describe("Technician names or ids to unassign"),
      confirm: CONFIRM,
    },
    CHANGE,
    async (a: any) =>
      twoStep(a.confirm, async () => {
        const tech = await technicianNames();
        const [appt, current] = await Promise.all([
          stGet(`jpm/v2/tenant/{tenant}/appointments/${a.appointment_id}`),
          stGet("dispatch/v2/tenant/{tenant}/appointment-assignments", { appointmentIds: a.appointment_id }),
        ]);
        const assigned = (current.data ?? []).filter((s: any) => s.active !== false).map((s: any) => s.technicianId);
        const add = (await resolveMany(tech, a.add, "technician")).filter((t) => !assigned.includes(t));
        const remove = (await resolveMany(tech, a.remove, "technician")).filter((t) => assigned.includes(t));
        if (!add.length && !remove.length) throw new Error("Nothing to change — those technicians are already in that state.");
        return {
          action: `Change technicians on appointment ${appt.appointmentNumber}`,
          details: {
            currently_assigned: assigned.map((t: number) => tech.get(t) ?? t),
            add: add.map((t) => tech.get(t)),
            remove: remove.map((t) => tech.get(t)),
          },
          run: async () => {
            if (add.length) await stWrite("POST", "dispatch/v2/tenant/{tenant}/appointment-assignments/assign-technicians", { jobAppointmentId: a.appointment_id, technicianIds: add });
            if (remove.length) await stWrite("POST", "dispatch/v2/tenant/{tenant}/appointment-assignments/unassign-technicians", { jobAppointmentId: a.appointment_id, technicianIds: remove });
            return { added: add.map((t) => tech.get(t)), removed: remove.map((t) => tech.get(t)) };
          },
        };
      })
  );

  server.tool(
    "create_task",
    "Create a Task Management task (follow-up, to-do) assigned to an employee. See list_reference kind=task_options for task types, sources, and employees. Two-step: preview first, then confirm.",
    {
      name: z.string().describe("Short task title"),
      description: z.string().optional(),
      assigned_to: z.string().describe("Employee name (partial ok) or id"),
      reported_by: z.string().optional().describe("Employee name or id; defaults to TASK_REPORTED_BY env, else the assignee"),
      task_type: z.string().describe("Task type name (partial ok) or id"),
      business_unit: z.string().describe("Business unit name (partial ok) or id"),
      source: z.string().optional().describe("Task source name or id; defaults to TASK_SOURCE env, else one named 'Other' or 'Claude'"),
      priority: z.enum(["Low", "Normal", "High", "Urgent"]).optional(),
      due: z.string().optional().describe("Complete-by date/time"),
      customer_id: z.number().optional(),
      job_id: z.number().optional(),
      confirm: CONFIRM,
    },
    WRITE,
    async (a: any) =>
      twoStep(a.confirm, async () => {
        const d = await getTaskData();
        const emp = toMap(d.employees);
        const types = toMap(d.taskTypes);
        const sources = toMap(d.taskSources);
        const bus = toMap(d.businessUnits, "value");
        const assignedToId = await resolveId(emp, a.assigned_to, "employee");
        const reportedById = await resolveId(emp, a.reported_by ?? process.env.TASK_REPORTED_BY ?? String(assignedToId), "employee");
        const sourceValue = a.source ?? process.env.TASK_SOURCE ?? [...sources].find(([, n]) => /other|claude/i.test(n))?.[0]?.toString();
        if (!sourceValue) {
          throw new Error(`Which task source? Options: ${[...sources.values()].join(", ")}. (Set TASK_SOURCE in Vercel to make one the default.)`);
        }
        const body: Record<string, unknown> = {
          name: a.name,
          description: a.description ?? "",
          assignedToId, reportedById,
          employeeTaskTypeId: await resolveId(types, a.task_type, "task type"),
          employeeTaskSourceId: await resolveId(sources, sourceValue, "task source"),
          businessUnitId: await resolveId(bus, a.business_unit, "business unit"),
          priority: a.priority ?? "Normal",
          isClosed: false,
          reportedDate: new Date().toISOString(),
          ...(a.due ? { completeBy: dateParam(a.due) } : {}),
          ...(a.customer_id ? { customerId: a.customer_id } : {}),
          ...(a.job_id ? { jobId: a.job_id } : {}),
        };
        return {
          action: `Create task "${a.name}" for ${emp.get(assignedToId!)}`,
          details: {
            assigned_to: emp.get(assignedToId!), reported_by: emp.get(reportedById!),
            task_type: types.get(body.employeeTaskTypeId as number), source: sources.get(body.employeeTaskSourceId as number),
            business_unit: bus.get(body.businessUnitId as number), priority: body.priority, due: a.due ?? null,
            request: body,
          },
          run: () => stWrite("POST", "taskmanagement/v2/tenant/{tenant}/tasks", body),
        };
      })
  );

  server.tool(
    "update_tags",
    "Add and/or remove tags on a customer, location, or job (see list_reference kind=tag_types). Two-step: preview first, then confirm.",
    {
      target: z.enum(["customer", "location", "job"]),
      id: z.number(),
      add: z.array(z.string()).optional().describe("Tag names or ids to add"),
      remove: z.array(z.string()).optional().describe("Tag names or ids to remove"),
      confirm: CONFIRM,
    },
    CHANGE,
    async (a: any) =>
      twoStep(a.confirm, async () => {
        const path = TARGET_PATHS[a.target as keyof typeof TARGET_PATHS](a.id);
        const [rec, tags] = await Promise.all([stGet(path), tagTypeNames()]);
        const have: number[] = rec.tagTypeIds ?? [];
        const add = (await resolveMany(tags, a.add, "tag")).filter((t) => !have.includes(t));
        const remove = (await resolveMany(tags, a.remove, "tag")).filter((t) => have.includes(t));
        if (!add.length && !remove.length) throw new Error("Nothing to change — the tags are already in that state.");
        const next = [...have.filter((t) => !remove.includes(t)), ...add];
        const label = a.target === "job" ? `job #${rec.jobNumber}` : `${a.target} ${rec.name}`;
        return {
          action: `Update tags on ${label}`,
          details: {
            before: have.map((t) => tags.get(t) ?? t),
            add: add.map((t) => tags.get(t)),
            remove: remove.map((t) => tags.get(t)),
            after: next.map((t) => tags.get(t) ?? t),
          },
          run: () => stWrite("PATCH", path, { tagTypeIds: next }),
        };
      })
  );
  server.tool(
    "record_payment",
    "Record a payment received (cash, check, card taken elsewhere, ACH, financing) and apply it to one or more invoices. This only records money already collected — it does not charge a card. See list_reference kind=payment_types. Two-step: preview first, then confirm.",
    {
      payment_type: z.string().describe("Payment type name (partial ok) or id, e.g. 'Check', 'Cash'"),
      applied_to: z
        .array(z.object({ invoice_id: z.number(), amount: z.number().positive() }))
        .min(1)
        .describe("Invoices and the amount applied to each"),
      paid_on: z.string().optional().describe("Date received (default today)"),
      memo: z.string().optional(),
      check_number: z.string().optional(),
      auth_code: z.string().optional().describe("Card authorization code, if any"),
      confirm: CONFIRM,
    },
    CHANGE,
    async (a: any) =>
      twoStep(a.confirm, async () => {
        const { data: types } = await stGetAll("accounting/v2/tenant/{tenant}/payment-types", {}, 500);
        const typeId = await resolveId(new Map(types.map((t: any) => [t.id, t.name])), a.payment_type, "payment type");
        const invoices = await Promise.all(a.applied_to.map((x: any) => getInvoice(x.invoice_id)));
        const warnings: string[] = [];
        a.applied_to.forEach((x: any, i: number) => {
          const bal = Number(invoices[i].balance);
          if (x.amount > bal + 0.005) warnings.push(`Invoice ${invoices[i].referenceNumber}: $${x.amount} is more than its $${bal} balance (would create a credit).`);
        });
        const total = a.applied_to.reduce((s: number, x: any) => s + x.amount, 0);
        const body: Record<string, unknown> = {
          typeId,
          paidOn: dateParam(a.paid_on ?? new Date().toISOString().slice(0, 10)),
          memo: a.memo ?? "",
          splits: a.applied_to.map((x: any) => ({ invoiceId: x.invoice_id, amount: x.amount })),
          ...(a.check_number ? { checkNumber: a.check_number } : {}),
          ...(a.auth_code ? { authCode: a.auth_code } : {}),
        };
        return {
          action: `Record $${total.toFixed(2)} ${types.find((t: any) => t.id === typeId)?.name} payment`,
          details: {
            applied_to: a.applied_to.map((x: any, i: number) => ({ ...invoiceSummary(invoices[i]), applying: x.amount })),
            warnings,
            request: body,
          },
          run: () => stWrite("POST", "accounting/v2/tenant/{tenant}/payments", body),
        };
      })
  );

  server.tool(
    "edit_invoice",
    "Edit an invoice: summary, invoice date, due date, and line items (add by pricebook code, change quantity/price/description, or remove). Two-step: preview first, then confirm.",
    {
      invoice_id: z.number(),
      summary: z.string().optional(),
      invoice_date: z.string().optional(),
      due_date: z.string().optional(),
      add_items: z
        .array(z.object({
          sku: z.string().describe("Pricebook code, name, or id"),
          quantity: z.number().optional(),
          unit_price: z.number().optional().describe("Leave out to use the pricebook price"),
          description: z.string().optional(),
        }))
        .optional(),
      change_items: z
        .array(z.object({
          item_id: z.number().describe("Line item id from the preview / invoice"),
          quantity: z.number().optional(),
          unit_price: z.number().optional(),
          description: z.string().optional(),
        }))
        .optional(),
      remove_item_ids: z.array(z.number()).optional(),
      confirm: CONFIRM,
    },
    CHANGE,
    async (a: any) =>
      twoStep(a.confirm, async () => {
        const inv = await getInvoice(a.invoice_id);
        const items: any[] = inv.items ?? [];
        const byId = new Map(items.map((x) => [x.id, x]));
        for (const id of [...(a.remove_item_ids ?? []), ...(a.change_items ?? []).map((c: any) => c.item_id)]) {
          if (!byId.has(id)) throw new Error(`Item ${id} isn't on invoice ${inv.referenceNumber}. Current items: ${items.map((x) => `${x.id} ${x.skuName}`).join(", ")}`);
        }
        const fields: Record<string, unknown> = {};
        if (a.summary !== undefined) fields.summary = a.summary;
        if (a.invoice_date) fields.invoicedOn = dateParam(a.invoice_date);
        if (a.due_date) fields.dueDate = dateParam(a.due_date);
        const adds = await Promise.all((a.add_items ?? []).map(async (x: any) => {
          const sku = await resolveSku(x.sku);
          return {
            label: skuLabel(sku),
            body: {
              skuId: sku.id,
              description: x.description || plainText(sku.description) || sku.displayName || sku.code,
              quantity: x.quantity ?? 1,
              isAddOn: false,
              ...(x.unit_price !== undefined ? { unitPrice: x.unit_price } : {}),
            },
          };
        }));
        const changes = (a.change_items ?? []).map((c: any) => {
          const cur = byId.get(c.item_id);
          return {
            label: cur.skuName,
            before: { quantity: Number(cur.quantity), unit_price: Number(cur.price), description: plainText(cur.description) },
            body: {
              id: cur.id, skuId: cur.skuId,
              description: c.description ?? cur.description,
              quantity: c.quantity ?? Number(cur.quantity),
              unitPrice: c.unit_price ?? Number(cur.price),
              isAddOn: !!cur.isAddOn,
            },
          };
        });
        const removes = (a.remove_item_ids ?? []).map((id: number) => byId.get(id));
        if (!Object.keys(fields).length && !adds.length && !changes.length && !removes.length) {
          throw new Error("Nothing to change.");
        }
        const s = invoiceSummary(inv);
        return {
          action: `Edit invoice ${inv.referenceNumber}`,
          details: {
            invoice: s,
            warnings: [
              ...(s.exported ? ["This invoice was already exported to accounting — the change may need to be re-synced."] : []),
              ...(Number(inv.total) - Number(inv.balance) > 0.005 ? ["This invoice has payments applied; changing the total changes the balance due."] : []),
            ],
            current_items: items.map((x) => ({ item_id: x.id, item: x.skuName, quantity: Number(x.quantity), unit_price: Number(x.price), total: Number(x.total) })),
            field_changes: Object.keys(fields).length ? { before: { summary: inv.summary, invoice_date: inv.invoiceDate, due_date: inv.dueDate }, after: fields } : null,
            add: adds.map((x: any) => ({ item: x.label, quantity: x.body.quantity, unit_price: x.body.unitPrice ?? "pricebook price" })),
            change: changes.map((c: any) => ({ item: c.label, before: c.before, after: { quantity: c.body.quantity, unit_price: c.body.unitPrice } })),
            remove: removes.map((x: any) => ({ item_id: x.id, item: x.skuName, total: Number(x.total) })),
          },
          run: async () => {
            const path = `accounting/v2/tenant/{tenant}/invoices/${a.invoice_id}`;
            if (Object.keys(fields).length) await stWrite("PATCH", path, fields);
            for (const x of removes) await stWrite("DELETE", `${path}/items/${x.id}`);
            for (const c of changes) await stWrite("PATCH", `${path}/items`, c.body);
            for (const x of adds) await stWrite("PATCH", `${path}/items`, x.body);
            const after = await getInvoice(a.invoice_id);
            return { invoice: after.referenceNumber, total: Number(after.total), balance: Number(after.balance) };
          },
        };
      })
  );

  server.tool(
    "write_off_balance",
    "Write off an invoice's unpaid balance by creating an adjustment invoice with a negative write-off line (the usual ServiceTitan A/R cleanup). Uses the WRITEOFF_SKU pricebook item unless sku is given. Two-step: preview first, then confirm.",
    {
      invoice_id: z.number(),
      amount: z.number().positive().optional().describe("Amount to write off (default: the full balance)"),
      reason: z.string().describe("Why it's being written off — goes on the adjustment invoice"),
      sku: z.string().optional().describe("Write-off pricebook code/name/id; defaults to WRITEOFF_SKU env"),
      confirm: CONFIRM,
    },
    CHANGE,
    async (a: any) =>
      twoStep(a.confirm, async () => {
        const skuValue = a.sku ?? process.env.WRITEOFF_SKU;
        if (!skuValue) throw new Error("Which pricebook item is the write-off? Pass sku (e.g. its code) or set WRITEOFF_SKU in Vercel.");
        const [inv, sku] = await Promise.all([getInvoice(a.invoice_id), resolveSku(skuValue)]);
        if (inv.adjustmentToId) throw new Error(`Invoice ${inv.referenceNumber} is itself an adjustment invoice — write off the original instead.`);
        const balance = Number(inv.balance);
        if (balance <= 0.005) throw new Error(`Invoice ${inv.referenceNumber} has no balance to write off.`);
        const amount = Math.round((a.amount ?? balance) * 100) / 100;
        if (amount > balance + 0.005) throw new Error(`$${amount} is more than the $${balance} balance.`);
        const body = {
          adjustmentToId: a.invoice_id,
          summary: `Write-off: ${a.reason}`,
          items: [{ skuId: sku.id, description: `Write-off: ${a.reason}`, quantity: 1, unitPrice: -amount, isAddOn: false }],
        };
        return {
          action: `Write off $${amount.toFixed(2)} on invoice ${inv.referenceNumber}`,
          details: {
            invoice: invoiceSummary(inv),
            write_off_item: skuLabel(sku),
            balance_after: Math.round((balance - amount) * 100) / 100,
            request: body,
          },
          run: async () => {
            const adj = await stWrite("POST", "accounting/v2/tenant/{tenant}/invoices", body);
            const after = await getInvoice(a.invoice_id);
            return { adjustment_invoice_id: adj?.id ?? adj, original_balance_now: Number(after.balance) };
          },
        };
      })
  );

  server.tool(
    "sell_membership",
    "Sell a membership to a customer at a location, which also creates the membership type's recurring services (e.g. annual filter changes). See list_reference kind=membership_types for types and billing options. Two-step: preview first, then confirm.",
    {
      customer_id: z.number(),
      location_id: z.number(),
      membership_type: z.string().describe("Membership type name (partial ok) or id"),
      billing_option_id: z.number().optional().describe("Duration/billing option id; required if the type has more than one"),
      business_unit: z.string().describe("Business unit name (partial ok) or id"),
      sale_sku: z.string().describe("Pricebook item used to sell this membership (code, name, or id)"),
      create_recurring_services: z.boolean().optional().describe("Default true — create the type's recurring services at the location"),
      confirm: CONFIRM,
    },
    WRITE,
    async (a: any) =>
      twoStep(a.confirm, async () => {
        const { data: types } = await stGetAll("memberships/v2/tenant/{tenant}/membership-types", { active: "True" }, 2000);
        const typeId = await resolveId(new Map(types.map((t: any) => [t.id, t.name])), a.membership_type, "membership type");
        const [billing, services, bu, cust, loc, sku] = await Promise.all([
          stGet(`memberships/v2/tenant/{tenant}/membership-types/${typeId}/duration-billing-items`),
          stGet(`memberships/v2/tenant/{tenant}/membership-types/${typeId}/recurring-service-items`),
          businessUnitNames(),
          stGet(TARGET_PATHS.customer(a.customer_id)),
          stGet(TARGET_PATHS.location(a.location_id)),
          resolveSku(a.sale_sku),
        ]);
        if (loc.customerId !== a.customer_id) throw new Error(`Location ${a.location_id} doesn't belong to customer ${a.customer_id}.`);
        const options = (Array.isArray(billing) ? billing : billing.data ?? []).filter((b: any) => b.active !== false);
        const option = a.billing_option_id ? options.find((b: any) => b.id === a.billing_option_id) : options.length === 1 ? options[0] : null;
        if (!option) {
          throw new Error(`Pick a billing option (billing_option_id): ${options.map((b: any) => `${b.id} = ${b.billingFrequency}${b.duration ? `, ${b.duration} months` : ""}, sale $${b.salePrice}, billing $${b.billingPrice}`).join("; ")}`);
        }
        const withServices = a.create_recurring_services !== false;
        const body = {
          customerId: a.customer_id,
          locationId: a.location_id,
          businessUnitId: await resolveId(bu, a.business_unit, "business unit"),
          saleTaskId: sku.id,
          durationBillingId: option.id,
          recurringServiceAction: withServices ? "All" : "None",
          ...(withServices ? { recurringLocationId: a.location_id } : {}),
        };
        const svc = Array.isArray(services) ? services : services.data ?? [];
        return {
          action: `Sell ${types.find((t: any) => t.id === typeId)?.name} membership to ${cust.name}`,
          details: {
            customer: cust.name, location: loc.address,
            business_unit: bu.get(body.businessUnitId!), sale_item: skuLabel(sku),
            billing: { frequency: option.billingFrequency, duration_months: option.duration, sale_price: option.salePrice, billing_price: option.billingPrice },
            recurring_services: withServices ? (svc.length ? svc : "this membership type has no recurring services") : "not created",
            request: body,
          },
          run: () => stWrite("POST", "memberships/v2/tenant/{tenant}/memberships/sale", body),
        };
      })
  );
}
