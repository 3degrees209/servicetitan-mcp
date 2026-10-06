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
}
