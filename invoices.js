import { InputError } from './pricing.js';
import { scheduleDate } from './scheduling.js';

// Invoices for completed jobs. An invoice copies the accepted revision's saved line items and total,
// and the service location saved with the booking, so later rate or customer edits never change it.
// Invoices and their lines are write-once; each booking can have at most one invoice.

export function migrateInvoices(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY,
      number TEXT NOT NULL UNIQUE,
      booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(id),
      quote_id INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      customer_name TEXT NOT NULL,
      site_reference TEXT NOT NULL,
      title TEXT NOT NULL,
      service_day TEXT NOT NULL,
      service TEXT NOT NULL,
      square_feet INTEGER NOT NULL,
      bathrooms INTEGER NOT NULL,
      rate_version TEXT NOT NULL,
      total_cents INTEGER NOT NULL CHECK(total_cents >= 0),
      created_at TEXT NOT NULL,
      created_by TEXT,
      FOREIGN KEY (quote_id, revision) REFERENCES revisions(quote_id, number)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS invoices_customer ON invoices(customer_id);
    CREATE TABLE IF NOT EXISTS invoice_lines (
      invoice_id INTEGER NOT NULL REFERENCES invoices(id),
      position INTEGER NOT NULL,
      label TEXT NOT NULL,
      cents INTEGER NOT NULL CHECK(cents >= 0),
      PRIMARY KEY (invoice_id, position)
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS invoices_no_update BEFORE UPDATE ON invoices
      BEGIN SELECT RAISE(ABORT, 'Invoices are immutable.'); END;
    CREATE TRIGGER IF NOT EXISTS invoices_no_delete BEFORE DELETE ON invoices
      BEGIN SELECT RAISE(ABORT, 'Invoices are immutable.'); END;
    CREATE TRIGGER IF NOT EXISTS invoice_lines_no_update BEFORE UPDATE ON invoice_lines
      BEGIN SELECT RAISE(ABORT, 'Invoices are immutable.'); END;
    CREATE TRIGGER IF NOT EXISTS invoice_lines_no_delete BEFORE DELETE ON invoice_lines
      BEGIN SELECT RAISE(ABORT, 'Invoices are immutable.'); END;
  `);
}

// Full manual payments. An invoice has at most one payment, for exactly its total; the payment is
// stored separately, so recording it never changes the invoice. Payments are write-once.
export const PAYMENT_METHODS = Object.freeze({ cash: 'Cash', check: 'Check', card: 'Card', bank_transfer: 'Bank transfer' });

export function migratePayments(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS invoice_payments (
      id INTEGER PRIMARY KEY,
      invoice_id INTEGER NOT NULL UNIQUE REFERENCES invoices(id),
      amount_cents INTEGER NOT NULL,
      paid_on TEXT NOT NULL CHECK(paid_on GLOB '20[0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
      method TEXT NOT NULL CHECK(method IN (${Object.keys(PAYMENT_METHODS).map(key => `'${key}'`).join(', ')})),
      recorded_by TEXT NOT NULL CHECK(length(trim(recorded_by)) > 0),
      recorded_at TEXT NOT NULL
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS invoice_payments_full_amount BEFORE INSERT ON invoice_payments
      WHEN NEW.amount_cents IS NOT (SELECT total_cents FROM invoices WHERE id = NEW.invoice_id)
      BEGIN SELECT RAISE(ABORT, 'A payment must be for the full invoice total.'); END;
    CREATE TRIGGER IF NOT EXISTS invoice_payments_no_update BEFORE UPDATE ON invoice_payments
      BEGIN SELECT RAISE(ABORT, 'Payments are immutable.'); END;
    CREATE TRIGGER IF NOT EXISTS invoice_payments_no_delete BEFORE DELETE ON invoice_payments
      BEGIN SELECT RAISE(ABORT, 'Payments are immutable.'); END;
  `);
}

const easternDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/New_York' });

// Validates the payment form. `now` decides today's Eastern date; a payment cannot be dated later.
export function paymentFields(fields, now) {
  const method = typeof fields.method === 'string' ? fields.method : '';
  if (!Object.hasOwn(PAYMENT_METHODS, method)) throw new InputError('Choose how the customer paid.');
  const paidOn = typeof fields.paidOn === 'string' ? fields.paidOn.trim() : '';
  if (!paidOn) throw new InputError('Enter the date the payment was received.');
  scheduleDate(paidOn);
  if (paidOn > easternDate.format(now)) throw new InputError('The payment date cannot be in the future.');
  return { paidOn, method };
}

// Invoice 1 is INV-000001. Numbers follow the invoice id, which is never reused because
// invoices cannot be deleted.
export function invoiceNumber(id) {
  return 'INV-' + String(id).padStart(6, '0');
}

const count = value => Number.isSafeInteger(value) && value >= 0;

// Checks a saved estimate snapshot (any format the app has written) and returns the parts an
// invoice copies, or null if the snapshot cannot be billed exactly as accepted.
export function billableEstimate(text) {
  let estimate;
  try {
    estimate = JSON.parse(text);
  } catch {
    return null;
  }
  const { lines, totalCents, scope, rateVersion } = estimate ?? {};
  if (!Array.isArray(lines) || !lines.length || !count(totalCents)) return null;
  if (!lines.every(line => typeof line?.label === 'string' && line.label.trim() && count(line.cents))) return null;
  if (lines.reduce((sum, line) => sum + line.cents, 0) !== totalCents) return null;
  if (typeof scope?.service !== 'string' || !count(scope.squareFeet) || !count(scope.bathrooms)) return null;
  if (typeof rateVersion !== 'string') return null;
  return {
    lines: lines.map(line => ({ label: line.label, cents: line.cents })),
    totalCents,
    scope: { service: scope.service, squareFeet: scope.squareFeet, bathrooms: scope.bathrooms },
    rateVersion,
  };
}
