# AYC Operations

A standalone operations workspace for a cleaning business. An operator can find or create a customer, build an itemized quote, revise its scope, and record a decision against the exact revision the customer saw. Accepted quotes can become bookings, with a daily schedule and controls to reschedule or cancel.

This is a new JavaScript implementation of selected All Your Cleaning workflows. Pricing is illustrative. The archive contains fresh application code and uses no WordPress code, production records, live credentials, or third-party assets. The MIT license applies to this implementation.

## Run locally

Use Node.js 22.21 or later. No dependency install, downloads, external database, or external service credentials are required. SQLite ships with Node. Some Node 22 releases print an experimental SQLite warning.

    npm test
    npm start -- --demo

Open [the local app](http://127.0.0.1:3000) and sign in as
`demo-dispatcher` with `DUMMY-DISPATCHER-ONLY`. **Today** opens with fictional
jobs. Demo mode starts with a fresh temporary database each time.

To check quoting, add a sample customer with site reference “Demo house”.
Create a deep-clean quote for 1,000 square feet and two bathrooms. Revision 1
should total $206.00. Change the area to 1,200 square feet and save a revision.
Revision 2 should total $240.00, and revision 1 should still show $206.00.

## Dispatcher workflow

The home page opens **Today**, with scheduled work, unfinished jobs from earlier
days, and quotes needing attention. **Customers** shows service details, quote
revisions, and job history. Customers can have multiple service locations. Choose a location when creating a quote. Existing sites become default locations.
**Schedule** includes a week overview and a detailed day view. **Settings**
links to versioned pricing and lists the operating window.

In demo mode, open a job from Today. Reschedule it to an open slot, click
**Start job**, then enter a note and click **Complete job**. From the job page,
open the linked customer and find the completed job in **Booking history**.
Use ordinary mode to retain changes across restarts.

## Booking rules

Open **Crews** to add crews. Existing bookings are assigned to **Default crew**.
Choose a crew when booking or rescheduling. The weekly schedule groups jobs by
crew. Different crews can work at the same time. Each crew operates in Eastern
local time from 8 AM to 6 PM, with starts on half-hour increments. A transaction
checks that crew’s capacity before saving. Adjacent jobs are allowed,
and cancelled jobs release their slot while remaining visible. Each accepted
quote can have one standalone booking and separate recurring visits. A cancelled
booking can be replaced. A job can be moved or cancelled before start.
Starting and completing a job preserve its booked slot and accepted price.
If a started job needs to stop, use **Stop without completing** and enter a
reason. The job is cancelled, its history remains visible, and dispatch can
schedule a replacement. A booking conflict shows the proposed slot again so
you can adjust it.

New bookings save the service site reference and instructions as they were
when booked. Edits to a customer affect future bookings. Older bookings
without a snapshot display current customer details with a clear label. Stale reschedule and cancel requests return
a conflict. The app assumes a trusted local operator and uses sample data.

## Growth planning

Open **Planning** as a dispatcher to create or edit a scenario. Demo mode
starts with two fictional scenarios. In ordinary mode, saved scenarios
persist in the same local database as the app, in a separate planning table.

Enter acquisition and conversion assumptions, expected recurring retention,
visit frequency, prices, labor time, supplies, and available person-hours.
The page includes a worked first-clean example. Initial prices use the
bundled sample quote rates. Editing a scenario affects that scenario only.

## Cleaner closeout and dispatcher review

Dispatch starts a scheduled booking. In **Cleaner workspace**, the assigned
cleaner selects the booking date, confirms the three closeout checklist items,
and can leave notes for dispatch. The submission stays with that booking.

**Today → Needs attention** lists closeouts waiting for review, closeouts sent
back to the crew, and completed jobs that still need an invoice. Open the job in
that list to read the checklist confirmation and notes. **Send back to crew**
requires a reason, which the cleaner sees before submitting again. **Approve
and complete** completes the booking and enables **Create invoice**. The booking
retains all submissions and the reviewer, time and notes for each decision.
Creating the invoice clears that item from the list.

Dispatch can still complete a job directly before a cleaner submits a closeout.
After submission, dispatch completes it through approval. Dispatch can still stop
unfinished jobs using the existing stop action.

To try the workflow in demo mode:

1. Sign in as the demo dispatcher. Open **Customers → Sample Apartment Turnover**
   and find the **Move-out cleaning** booking dated May 6, 2030. Open the
   booking and select **Start job**.
2. Sign out. Sign in as the first demo cleaner and show jobs for May 6, 2030.
   Fill the checklist, enter a fictional note, and select **Submit closeout**.
3. Sign in as the dispatcher again. Open the job from **Today → Needs attention**.
   Send it back with a fictional reason, or approve it to complete the job.
4. If returned, sign in as the same cleaner, open the same day, and resubmit.
   After dispatch approves, create the invoice and check that the job leaves
   **Needs attention**.

Run `node --test closeouts.test.js` for the end-to-end HTTP checks.

## Invoicing completed jobs

Open a completed booking and click **Create invoice** in the **Invoice** panel. The invoice copies the
line items and total of the accepted quote revision, and the service location saved when the job was
booked. Later rate changes or customer edits never change it. Invoices are numbered `INV-000001`,
`INV-000002`, and so on, and open at `/invoices/ID`. The booking page links to its invoice.

Only completed jobs can be invoiced: the server refuses scheduled, in-progress, cancelled, and stopped
jobs, whatever the page shows. Each booking can have one invoice. Repeating the request opens the
existing invoice instead of creating another, and the database rejects a second invoice for a
booking. Each completed recurring visit is its own booking, so it gets its own invoice for the full
accepted amount. Jobs completed before invoicing existed can be invoiced too; if such a booking has no
saved site, the quote's service location is used. Saved invoices cannot be changed or deleted.

Open **Invoices** to see every invoice, newest first, with its customer, job, service date, total,
and payment status. Search by part of a customer name (as billed or as currently named) or an
invoice number: `INV-000001`, `inv-1`, and `1` all find the first invoice. Use **All**, **Unpaid**,
or **Paid** to filter; filters combine with the search. A search or filter with no results says so and offers a link back to all invoices.
A customer's page lists that customer's invoices, and each invoiced job in **Booking history** links
to its invoice. The booking page, customer page, and register all open the same invoice page.
Run `npm run test:invoices` to run only the invoice and payment tests.

### Recording payments

Open an unpaid invoice, enter the date the payment was received (today or earlier, Eastern time),
choose Cash, Check, Card, or Bank transfer, and click **Record full payment**. The payment is
always the full invoice total and records the signed-in dispatcher. The invoice then shows as
**Paid** on its page, in the register and its filters, in the customer's history, and on the
booking. Payments are stored separately, so the invoice and its amounts never change.

An invoice can be paid once. The server checks in the same transaction that saves the payment, so a
page opened before someone else recorded the payment cannot add a second one; it shows the payment
already recorded instead. Pressing the button twice with the same details just reopens the invoice.
The database also rejects a second payment, any amount other than the full total, and any edit or
deletion of a payment. Partial payments, refunds, and online payments are not supported.

## Quote expiration

Each new revision is valid for 14 calendar days: a revision issued on an Eastern calendar date
stays acceptable through 11:59 PM Eastern on the date 14 days later, and is expired from the next
instant. The quote page shows when each revision is or was valid. An expired revision cannot be
accepted (Accept is hidden and the server refuses it), but it can be declined, or revised to issue
a fresh revision at the current rates with a new 14-day window. Expiration is worked out from the
stored timestamp, so quotes keep their existing statuses. Revisions saved before expiration existed
have no expiration date and never expire. Accepted quotes, their bookings, and repeated identical
decisions are unaffected.

## Rate management

Open **Settings → Manage pricing rates** to see the active pricing version and its rates. To change prices,
fill in the publish form (it starts with the active rates) with a new version name and amounts
in dollars, at most 2 decimal places. Tick "Activate immediately" to use the new rates for new
quotes and revisions right away, or publish first and press "Activate" on that version later.
Published versions cannot be changed, saved quotes keep the rates they were priced with, and
if someone else changed the active version since the page was loaded, nothing is changed and
the page explains what happened.

## Code map

- server.js handles HTTP routing, form input, and status responses, including the rate management routes (`GET /rates`, `POST /rates`, `POST /rates/activate`).
- views.js renders the customer directory, customer history, quote detail, and rate management page.
- pricing.js validates quote scope and computes line items in integer cents against a versioned rate profile (default `demo-1`). New revisions record the profile version and the unit rates used; older revisions without recorded rates still display.
- pricing.test.js covers default and alternate rate profiles, whole-cent arithmetic, and historical totals.
- repository.js owns the SQLite schema and transaction boundaries. Quotes retain immutable estimate snapshots. A stale revision cannot be accepted, and a repeated identical decision is idempotent.
  It also stores versioned rate profiles (`rate_profiles`, `rate_profile_services`). Stored profiles are write-once, and opening any database adds the default `demo-1` profile once if it is missing, without touching existing quotes, revisions, decisions, or bookings.
  `publishRateProfile` validates and stores a new version, optionally activating it in the same transaction; `activateRateProfile` switches the active version. The active version lives in the append-only `rate_profile_activations` log (newest row wins), so activation never edits pricing rows. Activation requires the caller's expected active version and returns a conflict if it is stale. An identical republish or re-activation is a no-op; reusing a version with different rates is a conflict. New quotes and revisions are priced with the active profile: reading it, pricing, and saving the revision happen in one transaction, so a concurrent activation can never produce a revision whose version and total disagree. Saved revisions are never repriced.
- rate-profiles.test.js covers the initial profile, persistence, upgrades of existing databases, and repeated initialization.
- rate-publishing.test.js covers publishing, validation failures, duplicate versions, rollback, concurrent requests, and persistence of the active version.
- rates-page.test.js covers the rate management page: routes, form validation, publishing, activation, stale requests, persistence, and regressions.
- quote-pricing.test.js covers quotes and revisions priced with the active profile, unchanged history, minimums and whole cents, concurrent activation, and the approval and booking workflows.
- operations.js adds customer details and timestamped job history to existing databases.
- app.css defines the shared dispatcher layout.
- scheduling.js validates dates, start times, and durations.
- expiration.js computes and formats the 14-day Eastern expiration of a revision. Expiration timestamps are stored in `revision_expirations`, written with each revision; the repository takes a `now` clock so tests can control time.
- expiration.test.js covers expiration boundaries (including daylight-saving changes), historical compatibility, repeat decisions, revised quotes, and booking workflows.
- invoices.js defines the write-once `invoices`, `invoice_lines`, and `invoice_payments` tables (one invoice per booking, one full payment per invoice), checks that an accepted estimate can be billed exactly, and validates payment details. repository.js `createInvoice` checks completion and writes the invoice in one transaction.
- invoices.test.js covers invoice contents, refusal of unfinished jobs, one invoice per booking (two dispatchers pressing at once, concurrent app processes, and direct database writes), recurring visits, older databases, and the HTTP pages and access rules.
- invoice-register.test.js covers the register: listing, search by customer name and invoice number, paid and unpaid filters, empty results, customer history links, and access rules.
- payments.test.js covers recording full payments, paid status everywhere, validation, one payment per invoice (outdated pages, double clicks, two dispatchers, concurrent processes, and direct database writes), older databases, and access rules.
- payments-stress.test.js stress-tests payments and filters: 40 mixed invoices checked against every search and filter, 60 simultaneous requests on one invoice, several app processes at once, repeated and altered submissions.
- permissions.test.js sends requests straight to the server: cleaners and signed-out visitors cannot view, create, or pay invoices by any route or method; scheduled, in-progress, cancelled, and stopped jobs (including recurring visits) cannot be invoiced; completed, invoiced jobs cannot be undone; bad ids are "not found".
- recurring-pricing.test.js covers, through the app's pages, separate invoices for each completed recurring visit (including simultaneous and rescheduled visits), and shows that publishing, activating, or switching back rates never changes accepted quotes, booking prices, invoices, or payments, while new quotes use the new rates.
- persistence.test.js starts the real app (`node server.js` with `AYC_DATABASE` and `AYC_DISPATCHER_PASSWORD`) as separate processes on a persistent database with fictional data: invoices and payments survive a normal stop, a crash right after a payment, and a backup and restore, and the one-invoice and one-payment rules still apply afterwards.
- recurrence.js computes visit dates for weekly, biweekly and monthly plans.
- staff.js handles local staff accounts and sessions. server.js enforces route access and crew scope.
- backup.js creates and checks SQLite copies for backup and restore.
- demo.js creates synthetic cases for manual review.
- server.test.js exercises the full HTTP workflow against a temporary on-disk database, including restart.

## Cleaner workspace

Sign in as a cleaner and select a date to see scheduled work for your crew.
For the sample move-out booking, use May 6, 2030 with `demo-cleaner-a`.
Dispatch sees the acknowledgment on the booking. Changing the time or crew
requires a new acknowledgment. Dispatchers can preview any crew from **Cleaner**.

## Staff sign-in and database recovery

Demo mode uses temporary storage and these fictional accounts:

| Username | Demo password |
|---|---|
| demo-dispatcher | DUMMY-DISPATCHER-ONLY |
| demo-cleaner-a | DUMMY-CLEANER-A-ONLY |
| demo-cleaner-b | DUMMY-CLEANER-B-ONLY |

For persistent local use, set `AYC_DISPATCHER_PASSWORD` in your shell and run
`npm start`. Sign in as `dispatcher`. The password must have 12–256 characters.
It initializes the account once. Later starts preserve the stored password.
To provision a cleaner, create a crew in the app, set `AYC_NEW_STAFF_PASSWORD`
in your shell, then run `node add-cleaner.js USERNAME CREW_ID` from the app
folder. Use synthetic records for demos. The server binds to localhost.

Create a backup with `node backup.js data/operations.sqlite data/backup.sqlite`.
To verify a restore without touching the original, run
`node backup.js data/backup.sqlite data/restored.sqlite`. The tool checks
database integrity and refuses to overwrite an existing file. It removes
sessions from the copy, so restored accounts must sign in again. Keep backup
files private because they contain records and password hashes. To open the
restored copy, set `AYC_DATABASE=data/restored.sqlite` and start the app with
your existing dispatcher password in the environment. Sign in again and check
the customer, accepted quote, booking, and job history.


## Recurring service

Open an accepted quote and select **Recurring service plan**. Choose a crew,
first date, local start time, duration, and cadence. Preview four visits,
then confirm the available ones. Monthly plans use the original day of the
month or the last day in shorter months.

Confirming rechecks availability before saving. If a conflict clears, reopen
the plan and recheck to book the missing visit. Repeating confirmation keeps
existing visits, including visits moved or cancelled individually. Pause
stops confirmation of additional visits in this batch while leaving existing
bookings in place. Plans cover four occurrences and do not extend automatically.
