# ServiceTitan connector for Claude

A small read-only server that lets Claude answer questions about your ServiceTitan data
(customers, jobs, appointments, invoices, payments, estimates, calls, and your saved reports).
It cannot create, change, or delete anything in ServiceTitan.

## Setup (about 10 minutes)

### 1. ServiceTitan API app
In the ServiceTitan developer portal, your API app needs **read** scopes for: CRM, Job Planning (JPM),
Dispatch, Accounting, Sales (Estimates), Settings, Marketing, Telecom, and Reporting.
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

## Troubleshooting
- **"login failed"** — a client id/secret is wrong, or `SERVICETITAN_ENV` doesn't match the app.
- **403 errors** — the API app is missing the read scope for that area.
- **Connector won't connect** — check the URL ends in `/mcp` and the secret matches exactly.
