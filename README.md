# ServiceTitan connector for Claude

A small server that lets Claude answer questions about your ServiceTitan data
(customers, jobs, appointments, invoices, payments, estimates, calls, and your saved reports) and,
if you turn it on, make changes: bookings, customers, notes, jobs, appointments, tasks, and tags.

Writes are **off** until you set `ALLOW_WRITES=true`. Even then, every change is two steps:
Claude shows a preview of exactly what will change, and only does it after you say yes.

## Setup (about 10 minutes)

### 1. ServiceTitan API app
In the ServiceTitan developer portal, your API app needs **read** scopes for: CRM, Job Planning (JPM),
Dispatch, Accounting, Sales (Estimates), Settings, Marketing, Telecom, and Reporting.
For the write tools it also needs **write** access to CRM, Job Planning, Dispatch, Accounting
(only used to clear invoice items when canceling a job), Settings (tags), and Task Management.
Connect it under **Settings → Integrations → API Application Access**. You'll have 4 values:
Client ID, Client Secret, App Key, and Tenant ID.

### 2. Deploy to Vercel
Vercel → **Add New → Project → Import Third-Party Git Repository** → paste this repo's URL → Deploy.

### 3. Environment variables
Vercel project → **Settings → Environment Variables**:

| Name | Value |
|---|---|
| `SERVICETITAN_CLIENT_ID` | from your ServiceTitan app |
| `SERVICETITAN_CLIENT_SECRET` | from your ServiceTitan app |
| `SERVICETITAN_APP_KEY` | from your ServiceTitan app |
| `SERVICETITAN_TENANT_ID` | your tenant number |
| `SERVICETITAN_ENV` | `production` |
| `MCP_PATH_SECRET` | a long random password you make up (30+ letters and numbers) |
| `BUSINESS_TIMEZONE` | optional, default `America/New_York` (e.g. `America/Chicago`) |
| `ALLOW_WRITES` | optional — `true` to allow the write tools; leave unset for read-only |
| `BOOKING_PROVIDER_ID` | optional — default booking provider tag (name or id) for `create_booking` |
| `TASK_SOURCE` | optional — default task source (name or id) for `create_task` |
| `TASK_REPORTED_BY` | optional — default "reported by" employee (name or id) for `create_task` |

Then **Deployments → ⋯ → Redeploy** so the settings take effect.

`MCP_PATH_SECRET` is what keeps the connector private — treat it like a password.
To change it later, update the variable, redeploy, and update the URL in Claude.

### 4. Add to Claude
claude.ai → **Settings → Connectors → Add custom connector**, URL:

```
https://<your-project>.vercel.app/<your MCP_PATH_SECRET>/mcp
```

Try: *"How much did we invoice last month by business unit?"*

## Tools
| Tool | What it answers |
|---|---|
| `search_customers`, `get_customer` | Find a customer; contacts, locations, recent jobs and invoices |
| `list_jobs` | Jobs by date/status/business unit/job type/technician, with totals |
| `list_appointments` | Schedule for a date range, appointments per technician |
| `invoices_summary` | Revenue and open balance by business unit and month |
| `payments_summary` | Payments received by type |
| `estimates_summary` | Estimates created/sold, close rate, sold by salesperson |
| `calls_summary` | Calls by direction, call type, campaign, agent |
| `list_reference` | Technicians, business units, job types, campaigns, employees, tags |
| `list_reports`, `describe_report`, `run_report` | Run any saved ServiceTitan report |
| `api_get` | Any other ServiceTitan GET endpoint |

### Write tools (need `ALLOW_WRITES=true`; always preview → confirm)
| Tool | What it does |
|---|---|
| `create_booking` | New lead in Calls → Bookings |
| `create_customer` | New customer + location (preview flags possible duplicates) |
| `update_customer` | Name, billing address, do-not-mail / do-not-service |
| `set_contact` | Add or change a phone/email |
| `add_location` | New service address on a customer |
| `add_note` | Note on a customer, location, or job |
| `create_job` | Book a job with its first appointment and techs |
| `reschedule_appointment` | Move an appointment |
| `assign_technicians` | Add/remove techs on an appointment |
| `cancel_job` | Cancel with a reason (can clear auto-added invoice items first) |
| `create_task` | Task Management task |
| `update_tags` | Add/remove tags on a customer, location, or job |

## Troubleshooting
- **"login failed"** — a client id/secret is wrong, or `SERVICETITAN_ENV` doesn't match the app.
- **403 errors** — the API app is missing the scope for that area.
- **"Writes are turned off"** — set `ALLOW_WRITES=true` and redeploy.
- **Connector won't connect** — check the URL ends in `/mcp` and the secret matches exactly.
