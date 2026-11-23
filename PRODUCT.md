# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Executives / managers (TSS + TGM):** check net sales vs target, channel mix, top customers and products, and approve promotions, quotations and new customers. Mostly desktop.
- **Sales reps and sales managers:** track their own or their team's sales by customer, product and period, prepare promotion price sheets (ใบเคาะราคา), quotations, sample requests and new-customer registrations. Desktop first; they also check figures on a phone in the field.
- **Planning / production staff:** forecast demand, plan stock, record PO/SO bookings, issue production orders and compare plan vs actual. Desktop.
- **Admins / superadmin:** manage SKUs, groups, sales teams and targets, users, page permissions and the audit log.

## Product Purpose

TSS Supply Chain is the internal sales-and-planning system for Thai Sausage (TSS) and Thai-German Meat Product (TGM). It brings sales data from Express (TSS) and Bplus (TGM factory) into one place, runs approval workflows for promotions, quotations and customer registration, and connects sales forecasts to stock, booking and production planning. Success means managers trust the numbers at a glance and staff finish documents and approvals without leaving the system.

## Operating Context

- One source file (`index.html`) builds two deployed apps: **Sales** (`tss-supplychain.vercel.app`) and **Planning** (`tss-planning.vercel.app`), split by `deploy-shared/app-manifest.js`. Menus are role-based; admin and manager roles can use both.
- Data comes from Express and Bplus syncs into a SQLite backend. Figures are in Thai baht; invoices dated after today are excluded from totals.
- Documents produced: promotion price sheets (P1/P2), quotations printed on A4 with the TGM logo, customer registration packs, sample/NPD requests.
- Interface language is Thai, with English for some terms (SKU, PO/SO, Forecast, YoY).

## Capabilities and Constraints

- Executive dashboard, Sales Overview (by customer/product/salesperson, YoY, drill-down to invoice), consignment (CONSI), promotion documents and price-sheet approval chains, price tiers A–G, quotations, sales forecast, stock and daily planning, PO/SO booking and summary, production orders and plan-vs-actual, customer registration (6-step form + approval), samples (existing/NPD + R&D results), SKU settings, group/team/target admin, reports, users, permissions, audit log, notification inbox, personal signature.
- Vanilla JS with no build step and no framework. Pages render as template strings into one content area.
- Tables are wide and numeric; many pages need filters, period switches, Excel import/export.

## Brand Commitments

- **TSS logo:** circular seal "THAI SAUSAGE · EST. 1963 · ไทยซอสเซส" with two pigs. Its inks are red `#C3161B` and indigo-navy `#1B2064` on white (sampled from the logo file). The system palette is derived from these three colors (user decision, 2026-10-17).
- **TGM logo:** used on quotation prints ("THAI-GERMAN MEAT PRODUCT CO.,LTD").
- The previous gold `#D4AF37` accent is retired.

## Evidence on Hand

- TSS logo: `.scratch/tss-logo-b64.txt` (base64 PNG). TGM logo: `QT_LOGO` in `index.html`.
- Mockups and prototypes must use synthetic data clearly labelled as sample data. Never publish real sales figures, customer names or prices.

## Product Principles

1. Numbers first: the figure a person came for is the largest, clearest thing on the screen.
2. One system for both companies and both apps: the same components, states and language everywhere.
3. Approval status is always visible: who has it, what's next, what changed.
4. Desktop is the working surface, but every page must still work on a phone.

## Accessibility & Inclusion

Thai text needs comfortable line height and a base size of at least 14px. Status must never rely on color alone. Target WCAG 2.2 AA contrast.
