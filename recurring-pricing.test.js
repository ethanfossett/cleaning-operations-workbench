// Recurring visits and historical pricing, through the app's own pages and forms: each completed visit
// gets its own invoice, and publishing or activating rates never changes an accepted quote, a booking's
// accepted price, an invoice, or a payment.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { openRepository } from './repository.js';
import { app } from './server.js';
import { sampleAccounts } from './staff.js';

// 11:00 AM Eastern on Friday, May 10, 2030. Demo quote 1 is the move-out cleaning, revision 2 accepted
// at $330.00 under demo-1 (1,400 sq ft × $0.21 + 2 bathrooms × $18), with standalone booking 1 on May 6.
// Demo booking 2 (Unit A turnover, accepted under demo-1) is $256.50.
const NOW = '2030-05-10T15:00:00.000Z';
// Four weekly visits at 4 PM, clear of the demo's other jobs: bookings 8-11 on May 6, 13, 20, and 27.
const PLAN = { date: '2030-05-06', start: '16:00', duration: '120', cadence: 'weekly', crewId: '1', action: 'confirm' };
// Much higher rates. Under these, quote 1's scope would cost $470.00 and demo booking 2's $293.50.
const V2 = {
  version: 'v2', bathroom: '25.00', standardRate: '0.12', standardMinimum: '100.00',
  deepRate: '0.20', deepMinimum: '160.00', moveoutRate: '0.30', moveoutMinimum: '200.00',
};

function tables(file, names) {
  const db = new DatabaseSync(file);
  try {
    return JSON.stringify(names.map(name => db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()));
  } finally {
    db.close();
  }
}
const HISTORY = ['revisions', 'decisions', 'invoices', 'invoice_lines', 'invoice_payments'];

async function withDemo(action) {
  const dir = await mkdtemp(join(tmpdir(), 'ayc-recurring-pricing-'));
  const file = join(dir, 'demo.sqlite');
  const server = app(file, { staffFile: file, demo: true, accounts: sampleAccounts, now: () => new Date(NOW) })
    .listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const login = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { Origin: base },
    body: new URLSearchParams(sampleAccounts[0]) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const post = (path, fields = {}) => fetch(base + path, { method: 'POST', redirect: 'manual',
    headers: { Cookie: cookie, Origin: base }, body: new URLSearchParams(fields) });
  const page = async path => {
    const response = await fetch(base + path, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200, path);
    return response.text();
  };
  const finish = async id => {
    assert.equal((await post(`/bookings/${id}/start`, { version: 1 })).status, 303, 'start ' + id);
    assert.equal((await post(`/bookings/${id}/complete`, { version: 2, detail: '' })).status, 303, 'complete ' + id);
  };
  const invoice = async id => {
    const response = await post(`/bookings/${id}/invoice`);
    assert.equal(response.status, 303, 'invoice ' + id);
    return response.headers.get('location');
  };
  try {
    await action({ file, post, page, finish, invoice });
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

// The parts of an invoice page that describe what is billed.
function billed(html) {
  const lines = [...html.matchAll(/<tr><td>([^<]+)<\/td>\s*<td class="amount">([^<]+)<\/td><\/tr>/g)]
    .map(match => match[1] + ' ' + match[2]);
  return { lines, total: /Total<\/th><th class="amount">([^<]+)</.exec(html)?.[1],
    revision: /Accepted quote revision (\d+)/.exec(html)?.[1], version: /revision \d+<\/a> · ([^<\n]+)/.exec(html)?.[1],
    day: /completed job on (\d{4}-\d{2}-\d{2})/.exec(html)?.[1], booking: /href="\/bookings\/(\d+)">/.exec(html)?.[1] };
}
const listed = html => [...html.matchAll(/<td><a href="\/invoices\/\d+">(INV-\d+)<\/a><\/td>/g)].map(match => match[1]);
const MOVE_OUT = ['Floor area $294.00', 'Bathrooms $36.00'];

describe('recurring visits are invoiced separately', () => {
  test('two completed visits from one plan get two invoices for the full accepted amount', () =>
    withDemo(async ({ post, page, finish, invoice }) => {
      assert.equal((await post('/quotes/1/recurring', PLAN)).status, 303);
      await finish(8);
      await finish(9);
      assert.equal(await invoice(8), '/invoices/1');
      assert.equal(await invoice(9), '/invoices/2');

      const first = billed(await page('/invoices/1'));
      const second = billed(await page('/invoices/2'));
      assert.deepEqual(first, { lines: MOVE_OUT, total: '$330.00', revision: '2', version: 'demo-1', day: '2030-05-06', booking: '8' });
      assert.deepEqual(second, { lines: MOVE_OUT, total: '$330.00', revision: '2', version: 'demo-1', day: '2030-05-13', booking: '9' });
      assert.match(await page('/invoices/1'), /<h1>Invoice INV-000001<\/h1>/);
      assert.match(await page('/invoices/2'), /<h1>Invoice INV-000002<\/h1>/);

      // Each visit's booking page points at its own invoice.
      assert.match(await page('/bookings/8'), /<a href="\/invoices\/1">INV-000001<\/a>/);
      assert.match(await page('/bookings/9'), /<a href="\/invoices\/2">INV-000002<\/a>/);
      assert.doesNotMatch(await page('/bookings/9'), /INV-000001/);

      // Register and customer history list both.
      const register = await page('/invoices');
      assert.deepEqual(listed(register), ['INV-000002', 'INV-000001']);
      assert.match(register, /2 invoices\s+· \$660\.00/);
      const customer = await page('/customers/1');
      assert.deepEqual(listed(customer), ['INV-000002', 'INV-000001']);
      assert.match(customer, /2030-05-13 · 16:00[\s\S]*?Invoice\s+<a href="\/invoices\/2">INV-000002<\/a>/);
      assert.match(customer, /2030-05-06 · 16:00[\s\S]*?Invoice\s+<a href="\/invoices\/1">INV-000001<\/a>/);

      // Repeating visit 1 reuses its invoice and leaves visit 2 alone; paying one leaves the other unpaid.
      assert.equal(await invoice(8), '/invoices/1?existing=1');
      assert.equal((await post('/invoices/1/payment', { paidOn: '2030-05-10', method: 'cash' })).status, 303);
      assert.deepEqual(listed(await page('/invoices?status=paid')), ['INV-000001']);
      assert.deepEqual(listed(await page('/invoices?status=unpaid')), ['INV-000002']);

      // The same quote's standalone booking is a separate job with its own invoice.
      await finish(1);
      assert.equal(await invoice(1), '/invoices/3');
      assert.equal(billed(await page('/invoices/3')).total, '$330.00');
      assert.equal(billed(await page('/invoices/3')).booking, '1');
    }));

  test('invoicing two visits at the same moment gives each its own invoice, once', () =>
    withDemo(async ({ file, post, page, finish }) => {
      assert.equal((await post('/quotes/1/recurring', PLAN)).status, 303);
      await finish(10);
      await finish(11);
      // Two presses for each visit, all at once.
      const responses = await Promise.all([10, 11, 10, 11].map(id => post(`/bookings/${id}/invoice`)));
      const locations = responses.map(response => response.headers.get('location'));
      assert.deepEqual(responses.map(response => response.status), [303, 303, 303, 303]);
      assert.equal(new Set(locations.map(location => location.replace('?existing=1', ''))).size, 2);
      assert.equal(locations.filter(location => location.endsWith('?existing=1')).length, 2);
      const db = new DatabaseSync(file);
      try {
        assert.deepEqual(db.prepare('SELECT booking_id, total_cents FROM invoices ORDER BY booking_id').all()
          .map(row => ({ ...row })), [{ booking_id: 10, total_cents: 33000 }, { booking_id: 11, total_cents: 33000 }]);
      } finally {
        db.close();
      }
      assert.match(await page('/invoices'), /2 invoices\s+· \$660\.00/);
    }));

  test('a visit moved to another day is billed for the day it happened, at the same price', () =>
    withDemo(async ({ post, page, finish, invoice }) => {
      assert.equal((await post('/quotes/1/recurring', PLAN)).status, 303);
      assert.equal((await post('/bookings/9/reschedule', { version: 1, crewId: 1, date: '2030-05-15', start: '10:00',
        duration: 120 })).status, 303);
      assert.equal((await post('/bookings/9/start', { version: 2 })).status, 303);
      assert.equal((await post('/bookings/9/complete', { version: 3, detail: '' })).status, 303);
      await finish(8);
      assert.equal(await invoice(9), '/invoices/1');
      assert.equal(await invoice(8), '/invoices/2');
      assert.deepEqual(billed(await page('/invoices/1')),
        { lines: MOVE_OUT, total: '$330.00', revision: '2', version: 'demo-1', day: '2030-05-15', booking: '9' });
      assert.equal(billed(await page('/invoices/2')).day, '2030-05-06');
    }));
});

describe('changing rates never changes what was accepted or invoiced', () => {
  test('publishing and activating new rates on the rates page leaves accepted quotes, invoices, and payments alone', () =>
    withDemo(async ({ file, post, page, finish, invoice }) => {
      // Before the change: a recurring plan, visit 1 invoiced and paid, the standalone booking invoiced.
      assert.equal((await post('/quotes/1/recurring', PLAN)).status, 303);
      await finish(8);
      assert.equal(await invoice(8), '/invoices/1');
      assert.equal((await post('/invoices/1/payment', { paidOn: '2030-05-09', method: 'card' })).status, 303);
      await finish(1);
      assert.equal(await invoice(1), '/invoices/2');
      const pages = async () => Promise.all(['/invoices/1', '/invoices/2', '/quotes/1', '/bookings/1', '/bookings/8',
        '/invoices', '/customers/1'].map(page));
      const before = await pages();
      const history = tables(file, HISTORY);

      // Publish v2 and activate it from the rates page.
      const published = await post('/rates', { ...V2, expected: 'demo-1', activate: 'yes' });
      assert.equal(published.status, 303);
      assert.match(await page('/rates'), /<h3>v2 · active<\/h3>/);

      // Nothing already saved changed, in the database or on any page.
      assert.equal(tables(file, HISTORY), history);
      assert.deepEqual(await pages(), before);
      assert.match(await page('/quotes/1'), /Revision 2 · \$330\.00[\s\S]*Rates: \$0\.21 per sq ft/);
      assert.match(await page('/bookings/1'), /1400 sq ft ·\s+2 bathrooms · \$330\.00/);
      for (const html of before) assert.doesNotMatch(html, /\$470\.00|v2/);

      // Jobs accepted before the change are still billed at their accepted price when invoiced after it:
      // the next visit of the same plan, and demo booking 2.
      await finish(9);
      assert.equal(await invoice(9), '/invoices/3');
      assert.deepEqual(billed(await page('/invoices/3')),
        { lines: MOVE_OUT, total: '$330.00', revision: '2', version: 'demo-1', day: '2030-05-13', booking: '9' });
      await finish(2);
      assert.equal(await invoice(2), '/invoices/4');
      assert.deepEqual(billed(await page('/invoices/4')).total, '$256.50');
      assert.deepEqual(billed(await page('/invoices/4')).version, 'demo-1');
      // Paying after the change records the invoice's own total.
      assert.equal((await post('/invoices/3/payment', { paidOn: '2030-05-10', method: 'cash' })).status, 303);
      assert.match(await page('/invoices/3'), /<strong>Paid in full<\/strong> · \$330\.00/);

      // A quote created after the change does use the new rates, so the change really took effect.
      const draft = await post('/customers/3/quotes', { title: 'New-rate deep clean', service: 'deep', squareFeet: '1000', bathrooms: '2' });
      const quote = draft.headers.get('location');
      assert.match(await page(quote), /Revision 1 · \$250\.00/);
      assert.equal((await post(quote + '/decision', { revision: 1, outcome: 'accepted' })).status, 303);
      const booked = await post(quote + '/book', { date: '2030-05-14', start: '09:00', duration: '120', crewId: '1' });
      const booking = Number(booked.headers.get('location').split('/').pop());
      await finish(booking);
      assert.equal(await invoice(booking), '/invoices/5');
      assert.deepEqual(billed(await page('/invoices/5')), { lines: ['Floor area $200.00', 'Bathrooms $50.00'],
        total: '$250.00', revision: '1', version: 'v2', day: '2030-05-14', booking: String(booking) });

      // Switching back to demo-1 changes no saved invoice, including the one priced under v2.
      const saved = tables(file, HISTORY);
      const invoicePages = await Promise.all([1, 2, 3, 4, 5].map(id => page('/invoices/' + id)));
      assert.equal((await post('/rates/activate', { version: 'demo-1', expected: 'v2' })).status, 303);
      assert.match(await page('/rates'), /<h3>demo-1 · active<\/h3>/);
      assert.equal(tables(file, HISTORY), saved);
      assert.deepEqual(await Promise.all([1, 2, 3, 4, 5].map(id => page('/invoices/' + id))), invoicePages);
      assert.match(await page('/invoices'), /5 invoices\s+· \$1,496\.50/);
    }));

  test('a recurring plan created after a rate change bills the rate the customer accepted', () =>
    withDemo(async ({ post, page, finish, invoice }) => {
      assert.equal((await post('/rates', { ...V2, expected: 'demo-1', activate: 'yes' })).status, 303);
      assert.equal((await post('/quotes/1/recurring', PLAN)).status, 303);
      await finish(8);
      await finish(9);
      assert.equal(await invoice(8), '/invoices/1');
      assert.equal(await invoice(9), '/invoices/2');
      for (const id of [1, 2]) {
        const { lines, total, version } = billed(await page('/invoices/' + id));
        assert.deepEqual({ lines, total, version }, { lines: MOVE_OUT, total: '$330.00', version: 'demo-1' });
      }
    }));

  test('an invoice keeps its own copy of the price, even if the quote record were altered later', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ayc-invoice-copy-'));
    const file = join(dir, 'copy.sqlite');
    try {
      const repository = openRepository(file, { now: () => new Date(NOW) });
      const customerId = repository.addCustomer({ name: 'Copy check', reference: 'Flat 1' });
      const quoteId = repository.addQuote(customerId, { title: 'Deep', service: 'deep', squareFeet: '1000', bathrooms: '2' });
      repository.decide(quoteId, 1, 'accepted');
      const bookingId = repository.scheduleQuote(quoteId, { date: '2030-05-06', start: '09:00', duration: '120' });
      repository.advanceJob(bookingId, 1, 'start', '');
      repository.advanceJob(bookingId, 2, 'complete', '');
      const { id } = repository.createInvoice(bookingId, 'demo-dispatcher');
      const before = repository.invoice(id);
      // The app never edits saved revisions; simulate it anyway to show the invoice does not depend on them.
      const db = new DatabaseSync(file);
      db.prepare('UPDATE revisions SET estimate = ? WHERE quote_id = ?').run(JSON.stringify({
        scope: { service: 'deep', squareFeet: 5000, bathrooms: 9 }, lines: [{ label: 'Floor area', cents: 99900 }],
        totalCents: 99900, rateVersion: 'tampered' }), quoteId);
      db.close();
      const after = repository.invoice(id);
      assert.deepEqual({ ...after, lines: after.lines.map(line => ({ ...line })) },
        { ...before, lines: before.lines.map(line => ({ ...line })) });
      assert.equal(after.total_cents, 20600);
      repository.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
