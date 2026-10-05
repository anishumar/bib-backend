# fix/client-answers-1005: 10x's answers of 5 Oct, on top of the final release

> **For Anish. Merge only `fix/client-answers-1005`, in both repos.** It CONTAINS
> `release/2026-10-final` (and so `release/2026-10-05` and S1-S5). Merging it replaces merging the
> final release. It fast-forwards `main` (main is an ancestor). Nothing is on `main` or QA yet.
>
> **Feature freeze still holds** after this: 10x tests (`bib/qa/BiB_UAT_10x_2026-10.xlsx`), then only
> bug fixes.

Built 2026-10-05 in Shrestha's main session. The release note for everything underneath is
`docs/deploy/release-2026-10-final.md`; this adds four fixes from 10x's answers.

## What is in it, in plain words

| Q | 10x's answer | What changed |
|---|---|---|
| Q069 | "Client's engagement manager" | A new check rule: the client's Key Manager checks the work; when the client has none, or the Key Manager did the work, the person who signs for the firm. The check notification goes to that person. |
| Q084 | "While closing job, ask filing date separately" | Marking a task done (or Approving it) asks the day each return was filed on the portal; the calendar records that day and counts lateness from it. A future day, or one before the return's period, is refused. |
| Q087 | "round off" | Each company can round its invoice totals to the whole rupee, with a "Round off" line (screen and PDF). **ON for every company registered in India** (0380, existing and new), off elsewhere until the firm turns it on. Issued invoices never change; Indian companies' DRAFTS re-render rounded on deploy. |
| Q085 | "Invoice to be mapped to manager, not at advance stage" | An advance is no manager's revenue when it is invoiced; when a bill takes part of it, that part becomes the bill's manager's revenue in the month of that bill. The report's "nobody" row reads "No manager yet (incl. advances not adjusted)". |

Q086 and Q088 were answered "as built": no change.

**Follow-ups, same branch (2026-10-05 evening):** a company can keep **Los Angeles** time (Q075:
"United States, Pacific" was missing from the Time zone list); the advance box reads **"Ask for an
advance"** (the old "Hold the work until an advance is paid" has been untrue since 3 Oct); **Round off
starts ON** for Indian companies (0380); **Approve on the Checks queue** asks the portal days too
(Q084), as the task page does.

## Commits

| Repo | base `release/2026-10-final` | head |
|---|---|---|
| bib-backend | 7b175f6 | see `git log` (last: CLAUDE.md commits after a54e97f) |
| bib-frontend | 21033cc | see `git log` (last: 2c62357) |

## Migrations: run in order on QA's database

On top of the final release's 0337-0339, 0343-0345 and 0350-0371:

| # | What | Data change |
|---|---|---|
| 0375 | Round off: `crm.firm_entity.round_off_total` (default false), `crm.invoice.round_off` (frozen at issue), `crm.company_rounds_off()`, `crm.invoice_totals` rounds and appends `round_off`, the freeze trigger covers it | none; nothing rounds until a firm turns it on |
| 0376 | `crm.invoice_manager_share` puts advances on nobody until a bill takes them (`counts_on` appended); `crm.advance_invoice` | none (a view) |
| 0380 | Round off ON for a company registered in India: switches existing ones on, BEFORE INSERT trigger on `crm.firm_entity` for new ones | **yes**: every Indian company's `round_off_total` -> true, in every firm. Drafts re-render rounded; issued invoices do not change. No ledger event (a default) |

All three were rolled down and up again on `bib_ans` (0380's down twice: it is idempotent; it
leaves the switches as they stand). 0375's down leaves the view's `round_off` column (a
replaced view cannot lose one) always zero; 0376's down leaves `counts_on` always NULL.

## Env vars and config

None new. No Terraform, no deploy config.

## Deploy

As in `docs/deploy/release-2026-10-final.md`: by hand (the GitHub deploy workflow's GCP secret is
still missing), backend first, then frontend, then `scripts/postdeploy-check.sh` (read-only). **Do
not run `npm run smoke` against QA.**

## After deploy, on QA (each only with Shrestha's yes)

Everything in the final release's list (companies' year and zone Q075, automatic billing via the
preflight, sending domains left empty, GST setup, Setup gaps, rules OFF, the UAT sheet), plus:

1. **Q087:** nothing to switch: 0380 turns the Indian company on. Check on Your firm -> Bank details
   and LUT on invoices that "Round off the total: on" shows for it, and look at one of 10x's drafts.
2. **Q075:** set the US company's Time zone to "United States, Pacific (America/Los_Angeles)" on Your
   firm -> Change (now on the list).
3. **Q069:** How work runs -> Check rules: publish a rule "Key Manager review" with "The client's Key
   Manager", and choose it on the process steps and as the review rule tasks are sent with. Every
   client needs a Key Manager on its account team (Setup lists the gaps).

## Gates (2026-10-05, on `bib_ans`)

| Gate | Result |
|---|---|
| Backend `npm run check` (foreground) | **172 files, 3,538 tests** (3,528 + 10) |
| Integration | **105 files, 1,123 tests** |
| Smoke against :8230 | **264 passed, 0 failed** |
| `npm run demo` + `demo:verify` | **73 / 73** |
| `worker:once` on `bib_ans` | every queue ran; per-firm failures only on integration tests' half-seeded firms (as in S7) |
| Frontend `npm run check` | green |
| Browser walk `bib/demo-assets/tools/ans-walk.mjs` | **29 / 29** (Q069 6, Q084 11, Q087 9, Q085 3), screenshots and the rasterized invoice in `bib/demo-assets/notes/ans-walk/` |
| Follow-ups: backend `npm run check` | **172 files, 3,538 tests** |
| Follow-ups: integration | **105 files, 1,124 tests** (+1: India ON, UAE OFF) |
| Follow-ups: frontend `npm run check` | green |
| Follow-ups: walk `bib/demo-assets/tools/fix4-walk.mjs` | **17 / 17** (queue portal day 7, Round off 3, Los Angeles 4, advance box 3), `bib/demo-assets/notes/fix4-walk/` |

## Known limits (said, not hidden)

- The portal day is asked on the task page (Done, Approve) and on the Checks queue's Approve. The
  work board has no state change of its own. A missed filing's decision on the calendar records a
  decision, not a filed day.
- The originator report still credits an ad-hoc advance through its mappings (Q085 was about
  managers).
- 10x still to answer: Q068 (FINCOMPLIANCE list sent back to them), Q083 (rephrased), and the
  questions in the sheet's waiting tabs.
