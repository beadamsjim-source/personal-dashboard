# CLAUDE.md — Personal Dashboard

Project memory for Claude Code. Read this first.

## What this is

Single-page Belgian VAT & corporate-tax projection dashboard for a management
company (BV/SRL). The user uploads bank-CSV exports, the app categorizes
transactions, then projects VAT, vennootschapsbelasting, sociale bijdragen,
advance payments and a month-by-month cash buffer through 31 December.

Owner: **Jim @ boostU** (`jim@boostu.be`).

## Repo

- GitHub: `beadamsjim-source/ai-tool-sessions` (user is renaming to
  `personal-dashboard` via GitHub Settings UI — MCP has no rename endpoint).
- Default branch: `main`.
- The dashboard ships at the repo root as plain static files:
  - `index.html` — markup shell, references CSS+JS, loads PapaParse from CDN
  - `dashboard.css` — design tokens + layout (copied from the original
    boostU workshop signup page, dark theme, DM Sans + Fraunces)
  - `dashboard.js` — all logic in IIFE namespaces (≈ 1400 lines)
- No `package.json`, no build step. Open `index.html` directly or deploy to
  any static host.
- Hosting: **Vercel** with Framework Preset = **Other**, all build/output
  fields left empty.

## User profile (drives calculations)

| Field | Value |
|---|---|
| Legal form | BV / SRL ("managementvennootschap") |
| VAT regime | Quarterly (turnover < €2.5M) |
| Fiscal year | Calendar year, ends 31 December |
| Director salary | **< €50,000** — currently failing the 2026 reduced-rate gate |
| Storage | Browser `localStorage` only |
| Input format | Bank-CSV uploads (Belfius / KBC / BNP / ING / Argenta + generic) |
| Backup | JSON export/import via the top-right menu |

## Belgian tax rules encoded (verified May 2026)

Live as constants in `Tax` module (`dashboard.js`):

| Rule | Constant | Value |
|---|---|---|
| Standard VAT | `STANDARD_VAT` | 21% (also 12%, 6% reduced via sub-category) |
| Quarterly VAT deadlines | hard-coded in `vatForQuarter` | 25 Apr · 25 Jul · 25 Oct · 25 Jan |
| Corporate tax standard | `CORP_STANDARD` | 25% |
| Corporate tax reduced (SME) | `CORP_REDUCED` | 20% on first €100k profit |
| Reduced-rate bracket | `REDUCED_BRACKET` | €100,000 |
| Min director salary (2026 indexed) | `MIN_DIRECTOR_SALARY` | €50,000 |
| Salary-shortfall penalty | `SHORTFALL_PENALTY_RATE` | 5% on (€50,000 − actual) |
| Surcharge AY 2027 | `SURCHARGE_RATE` | 6.75% |
| Advance-payment credit rates | `VA_CREDITS` | VA1 9% · VA2 7.5% · VA3 6% · VA4 4.5% |
| VA due dates (per year) | `vaDueFor(year)` | 10 Apr · 10 Jul · 10 Oct · 20 Dec |
| Social contributions (self-empl. director) | `SOCIAL_CONTRIB_RATE` | 20.5% of gross |
| Startup small co exemption | `isStartupSmall` + foundingYear | first 3 FYs exempt from surcharge |

Reduced 20% rate requires ALL of:
1. Small company per art. 1:24 WVV
2. Director salary ≥ €50,000
3. ≤ 50% shares held by another company
4. Benefits-in-kind ≤ 20% of total remuneration

Sub-category deductibility defaults (`Rules.SUB`):
- `office_supplies` 100% (21%) · `software_saas` 100% (21%) · `mobile_internet` 75% (21%)
- `restaurant` 69% (12%) · `reception` 50% (21%) · `gift` 50% (21%, ≤€125/client)
- `car_fuel` 50% (21%) · `car_lease` 50% (21%) · `home_office` 30% (21%)
- `training` 100% · `accountant` 100% · `bank_fees` 100% (0%) · `insurance` 100% (0%) · `rent` 100% (0%) · `utilities` 100% (21%) · `other` 100% (21%)

## Architecture — IIFE namespaces inside `dashboard.js`

```
Store       localStorage R/W, versioned migrations (key "btax.v1"), JSON export/import
Tax         pure functions: vatForQuarter, vatYear, annualBuckets,
            corpTax (gating + reasons), advancePaymentPlan, socialPlan
Parsers     CSV detection + per-bank profiles + normalizeKey
Rules       SUB defaults, recomputeVat, autoClassify, createOrUpdateRule
Projection  month-by-month cashBuffer with reserved bucket → safeToSpend
Charts      hand-rolled SVG line + bar (no Chart.js); mousemove tooltips
UI          panel renderers + event wiring, ~900 LOC
App         bootstrap, console hook window.__btax for debugging
```

`Tax` and `Projection` are pure functions (no DOM access) — safe to unit-test
from Node by stubbing `localStorage`, `document`, `window`, `Papa`.

## Data model — single localStorage key `btax.v1`

```js
{
  version: 1,
  profile: {
    legalName, vatNumber, vatRegime: "quarterly"|"monthly",
    fiscalYear, fiscalYearStart, fiscalYearEnd,
    directorSalaryGross, directorBenefitsInKind,
    expectedAnnualRevenue,
    foundingYear, isStartupSmall, affiliatedHoldingMajority, smallCompanyArt124,
    openingCashBalance, openingCashDate
  },
  transactions: [{
    id, date, amount(±), counterparty, counterpartyKey,
    rawDescription, bank: "belfius"|"kbc"|"bnp"|"ing"|"argenta"|"generic"|"manual",
    category, subCategory, vatRate, vatAmount, netAmount, deductibilityPct,
    sourceFile, sourceRow, manuallyEdited
  }],
  categorizationRules: [{ id, match:{type:"counterparty"|"contains", value}, apply:{...} }],
  manualEntries: [...],          // monthly projection overrides
  vatPaymentsPlanned: [{ quarter, dueDate, amount, paid }],
  advancePaymentsPlanned: [{ code:"VA1"..."VA4", dueDate, amount, paid }],
  socialContributionsPlanned: [...],
  ui: { activeTab, activeReviewTab, lastBackup, salaryWhatIf, advisor }
}
```

Categories: `revenue | expense | non_deductible | vat_payment | corp_tax_payment | advance_payment | salary | social_contribution | transfer | ignore | unclassified`.

Derived projections (vat, corpTax, social, cashBuffer, yearEnd) are **never
persisted** — recomputed on every state mutation via `UI.renderAll()`.

## UI — 8 tabs (all rendered by `UI.render<Tab>`)

1. **Overzicht** — 4 KPI cards (YTD revenue, projected profit, total tax, safe-to-spend) + cash-buffer SVG line chart + top-5 action items
2. **Transacties** — drop-zone, sub-tabs Review / Alles / Regels, per-row editable category/sub/VAT/deductibility, "→ regel" button to create rule from row
3. **BTW** — 4 quarter cards (Q1–Q4) with output/input/payable/deadline, color-coded by status, bar chart
4. **Vennootschapsbelasting** — big tax KPI, gating checklist (green/red per condition), salary "wat als" comparison, advance-payment table (4 editable rows with auto "Verdeel gelijkmatig" / "Front-load" buttons)
5. **Sociale bijdragen** — annual + 4 quarterly rows
6. **Uitgaven-adviseur** — inputs per category (restaurant, gift, car, software, home office) → net cost after deduction, VAT recoverable, impact on cash buffer
7. **Jaareinde** — all-up totals projected to 31/12 + numbered action items
8. **Profiel** — setup form, editable any time, "Alles wissen" button

Active tab persists in `state.ui.activeTab`. Tab rendering uses `[hidden]`
toggling — no router.

## CSV bank-format detection

`Parsers.detect()` scores headers against 5 known profiles + generic fallback.
PapaParse is loaded from CDN with `delimiter:";"` first, comma fallback.
Detection is in `dashboard.js` around line 380–470 (`profiles[]`).

| Bank | Date col | Amount col | Counterparty col |
|---|---|---|---|
| Belfius | `Boekingsdatum` | `Bedrag` | `Naam tegenpartij` / `Tegenpartij` |
| KBC | `Datum` | `Bedrag` | `Naam tegenpartij` / `Vrije mededeling` |
| BNP | `Execution date` / `Uitvoeringsdatum` | `Amount` / `Bedrag` | `Counterparty` / `Tegenpartij` |
| ING | `Datum` | `Bedrag` | `Naam tegenpartij` / `Omschrijving` |
| Argenta | `Boekdatum` | `Bedrag` | `Omschrijving` |
| generic | first `*date*` field | first `*amount*\|*bedrag*` | first `*omschrijving*\|*tegen*\|*details*` |

Rule engine normalizes counterparty (strip BV/NV/SRL/SA/BVBA/SPRL/SCS,
lowercase, drop diacritics, keep alphanumerics) → `counterpartyKey`.
Exact match wins, then `contains`. "→ regel" button creates or updates the
rule and re-runs `Rules.autoClassify` on all matching transactions.

## Verification scenario (smoke-tested via Node, passes)

Profile: revenue €120k, salary €40k, founded 2022, small co, no holding majority, BIK 0.
4× revenue invoices €30,000 + 21% VAT (one/quarter); Q1 expenses: €5,000 + 21% software (100% ded.) + €1,000 + 12% restaurant (69% ded.).

Expected outputs (all match exactly):

| Output | Expected | Actual |
|---|---|---|
| Q1 VAT output | €6,300.00 | ✅ |
| Q1 VAT input | €1,132.80 | ✅ |
| Q1 VAT payable | €5,167.20 | ✅ |
| Q1 deadline | 2026-04-25 | ✅ |
| Annual revenue (net) | €120,000.00 | ✅ |
| Deductible expenses (net) | €5,690.00 | ✅ |
| Profit before tax | €66,110.00 | ✅ |
| Qualifies 20%? | false (salary < €50k) | ✅ |
| Tax @ 25% | €16,527.50 | ✅ |
| Shortfall penalty | €500.00 | ✅ |
| What-if @ €50k salary | qualifies, tax €10,812 | ✅ |
| Surcharge basis (6.75%) | ~€1,149 | ✅ |
| Social annual | €8,200 | ✅ |

To re-run: concatenate browser stubs + `dashboard.js` (minus the
`DOMContentLoaded` line) + a scenario script, then `node` it. The exact
script is in the session history; the console hook `window.__btax` exposes
all modules for in-browser console testing too.

## Deployment

- **Vercel**: Framework Preset = `Other`, all other fields empty. Root URL serves `index.html` directly. No `vercel.json` needed.
- **GitHub Pages**: Settings → Pages → branch `main`, folder `/` (root).
- **Local**: open `index.html` directly via `file://`. localStorage works.

## History

- PR #1 (`claude/belgian-vat-dashboard-C0RQr`) **squash-merged** to `main` as `ea017f1`.
- The previous `index.html` (a boostU workshop-signup form with a hard-coded
  Google Apps Script URL) was **deleted** in the same PR. `dashboard.html`
  was renamed to `index.html`.
- Outstanding: user is renaming the repo from `ai-tool-sessions` to
  `personal-dashboard` in the GitHub UI (must be done manually).

## What's intentionally NOT built

Don't re-implement these unless asked — they were considered and scoped out:

- PDF invoice OCR / parsing
- Multi-currency support (everything assumed EUR)
- Cloud sync / Supabase backend (user explicitly chose localStorage-only)
- Authentication / multi-user
- Detailed CO2-based car deduction formula (uses flat 50% default)
- VAT regularization / mixed-use proration (`herziening`)
- Provisional social contributions vs. regularization 2 years later (uses simple 20.5% on gross)
- Monthly VAT regime (constants are quarterly-only; `vatForQuarter` would need an `m`-variant)

## Conventions

- Language: UI text is **Dutch (Flemish)**. Code, comments, and identifiers are English.
- All money formatted via `fmtEUR` / `fmtEUR0` (uses `nl-BE` locale, comma decimal).
- All dates stored as `YYYY-MM-DD` strings; `parseEUDate` accepts `DD/MM/YYYY` from bank CSVs.
- Numbers are tabular (`font-variant-numeric: tabular-nums`) in tables.
- Design tokens (cyan/violet/emerald/amber) reused from the original boostU
  page so the look matches their internal lab aesthetic.

## Style notes

- No emoji in code. Allowed in user-facing UI strings (e.g., "✨", "🎉").
- Vanilla DOM; no jQuery, no React, no build chain. Keep it that way.
- Prefer extending an IIFE module over inventing a new one.
- The smoke test scenario is the source of truth for the calculation
  semantics — any change that breaks those numbers needs a deliberate update
  to this file.
