import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { InputError } from './pricing.js';
import { openRepository } from './repository.js';
import { app } from './server.js';
import { sampleAccounts } from './staff.js';

async function withRepository(action) {
  const dir = await mkdtemp(join(tmpdir(), 'ayc-register-'));
  const file = join(dir, 'register.sqlite');
  const repository = openRepository(file);
  try {
    return await action(repository, file);
  } finally {
    repository.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// Creates a customer with a completed job on `date` and returns its ids. Invoicing is left to the test.
function completedJob(repository, name, { date = '2030-05-06', service = 'standard', squareFeet = '1000' } = {}) {
  const customerId = repository.addCustomer({ name, reference: name + ' site' });
  const quoteId = repository.addQuote(customerId, { title: name + ' clean', service, squareFeet, bathrooms: '1' });
  repository.decide(quoteId, 1, 'accepted');
  const bookingId = repository.scheduleQuote(quoteId, { date, start: '09:00', duration: '60' });
  repository.advanceJob(bookingId, 1, 'start', '');
  repository.advanceJob(bookingId, 2, 'complete', '');
  return { customerId, quoteId, bookingId };
}

const numbers = rows => rows.map(row => row.number);

// Three invoices: INV-000001 Alpha Homes, INV-000002 Beta Offices, INV-000003 Alpha Homes (second job).
function threeInvoices(repository) {
  const alpha = completedJob(repository, 'Alpha Homes', { date: '2030-05-06' });
  const beta = completedJob(repository, 'Beta Offices', { date: '2030-05-07', squareFeet: '2000' });
  repository.createInvoice(alpha.bookingId);
  repository.createInvoice(beta.bookingId);
  const again = repository.addQuote(alpha.customerId, { title: 'Alpha follow-up', service: 'deep', squareFeet: '1000', bathrooms: '2' });
  repository.decide(again, 1, 'accepted');
  const booking = repository.scheduleQuote(again, { date: '2030-05-08', start: '09:00', duration: '60' });
  repository.advanceJob(booking, 1, 'start', '');
  repository.advanceJob(booking, 2, 'complete', '');
  repository.createInvoice(booking);
  return { alpha, beta };
}

describe('invoice register queries', () => {
  test('lists every invoice newest first, all unpaid for now', () => withRepository(repository => {
    assert.deepEqual(repository.invoices(), []);
    assert.equal(repository.invoiceCount(), 0);
    threeInvoices(repository);
    const rows = repository.invoices();
    assert.deepEqual(numbers(rows), ['INV-000003', 'INV-000002', 'INV-000001']);
    assert.ok(rows.every(row => row.status === 'unpaid'));
    assert.deepEqual(rows.map(row => row.total_cents), [20600, 21800, 11800]);
    assert.equal(repository.invoiceCount(), 3);
  }));

  test('searches customer names in any case and by part of the name', () => withRepository(repository => {
    threeInvoices(repository);
    assert.deepEqual(numbers(repository.invoices({ query: 'alpha' })), ['INV-000003', 'INV-000001']);
    assert.deepEqual(numbers(repository.invoices({ query: '  BETA offices ' })), ['INV-000002']);
    assert.deepEqual(numbers(repository.invoices({ query: 'homes' })), ['INV-000003', 'INV-000001']);
    assert.deepEqual(repository.invoices({ query: 'Gamma' }), []);
  }));

  test('searches invoice numbers in full, in part, and in short form', () => withRepository(repository => {
    threeInvoices(repository);
    for (const query of ['INV-000002', 'inv-000002', '000002', 'INV-2', 'inv2', '2']) {
      assert.deepEqual(numbers(repository.invoices({ query })), ['INV-000002'], query);
    }
    assert.deepEqual(numbers(repository.invoices({ query: 'INV-' })), ['INV-000003', 'INV-000002', 'INV-000001']);
    assert.deepEqual(repository.invoices({ query: 'INV-000099' }), []);
    assert.deepEqual(repository.invoices({ query: '99' }), []);
  }));

  test('finds invoices by the billed name and by the customer’s current name', () => withRepository(repository => {
    const { beta } = threeInvoices(repository);
    repository.updateCustomer(beta.customerId, { name: 'Renamed Works', reference: 'Beta Offices site' });
    assert.deepEqual(numbers(repository.invoices({ query: 'Beta' })), ['INV-000002']);
    assert.deepEqual(numbers(repository.invoices({ query: 'renamed' })), ['INV-000002']);
    const [row] = repository.invoices({ query: 'renamed' });
    assert.deepEqual([row.customer_name, row.current_customer_name], ['Beta Offices', 'Renamed Works']);
  }));

  test('treats quotes, percent signs, and underscores as plain text', () => withRepository(repository => {
    completedJob(repository, "O'Brien_50% Co");
    repository.createInvoice(1);
    for (const query of ["O'Brien", '_50%', '%']) {
      assert.deepEqual(numbers(repository.invoices({ query })), ['INV-000001'], query);
    }
    assert.deepEqual(repository.invoices({ query: "' OR 1=1 --" }), []);
  }));

  test('filters unpaid and paid, combined with search', () => withRepository(repository => {
    threeInvoices(repository);
    assert.equal(repository.invoices({ status: 'unpaid' }).length, 3);
    assert.deepEqual(repository.invoices({ status: 'paid' }), []);
    assert.deepEqual(numbers(repository.invoices({ query: 'beta', status: 'unpaid' })), ['INV-000002']);
    assert.deepEqual(repository.invoices({ query: 'beta', status: 'paid' }), []);
    assert.equal(repository.invoices({ status: 'all' }).length, 3);
    for (const status of ['', 'Paid', 'overdue', null]) {
      assert.throws(() => repository.invoices({ status }), InputError, String(status));
    }
  }));

  test('customer history lists only that customer’s invoices and links invoiced bookings', () =>
    withRepository(repository => {
      const { alpha, beta } = threeInvoices(repository);
      assert.deepEqual(numbers(repository.customerInvoices(alpha.customerId)), ['INV-000003', 'INV-000001']);
      assert.deepEqual(numbers(repository.customerInvoices(beta.customerId)), ['INV-000002']);
      const unbilled = completedJob(repository, 'Gamma Flats', { date: '2030-05-09' });
      assert.deepEqual(repository.customerInvoices(unbilled.customerId), []);
      const history = repository.customerBookings(alpha.customerId);
      assert.deepEqual(history.map(row => [row.invoice_id, row.invoice_number]),
        [[3, 'INV-000003'], [1, 'INV-000001']]);
      assert.deepEqual(repository.customerBookings(unbilled.customerId).map(row => row.invoice_id), [null]);
    }));

  test('reading the register writes nothing and leaves invoice creation unchanged', () =>
    withRepository((repository, file) => {
      const { alpha } = threeInvoices(repository);
      const dump = () => {
        const db = new DatabaseSync(file);
        try {
          return JSON.stringify([db.prepare('SELECT * FROM invoices').all(), db.prepare('SELECT * FROM invoice_lines').all()]);
        } finally {
          db.close();
        }
      };
      const before = dump();
      repository.invoices({ query: 'alpha', status: 'unpaid' });
      repository.customerInvoices(alpha.customerId);
      assert.equal(dump(), before);
      assert.deepEqual(repository.createInvoice(alpha.bookingId), { id: 1, created: false });
      assert.equal(repository.invoiceCount(), 3);
    }));
});

describe('invoice register pages', () => {
  test('dispatchers search, filter, and reach the same invoice from every page', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ayc-register-http-'));
    const file = join(dir, 'demo.sqlite');
    const server = app(file, { staffFile: file, demo: true, accounts: sampleAccounts }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const send = (path, cookie, fields) => fetch(base + path, {
      redirect: 'manual',
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(fields ? { Origin: base } : {}) },
      ...(fields ? { method: 'POST', body: new URLSearchParams(fields) } : {}),
    });
    const login = async account => (await send('/login', '', account)).headers.get('set-cookie').split(';')[0];
    try {
      const dispatch = await login(sampleAccounts[0]);
      const cleaner = await login(sampleAccounts[1]);
      const page = async path => {
        const response = await send(path, dispatch);
        assert.equal(response.status, 200, path);
        return response.text();
      };
      const listed = html => [...html.matchAll(/<td><a href="\/invoices\/(\d+)">(INV-\d+)<\/a><\/td>/g)].map(match => match[2]);

      // Before any invoice exists.
      assert.match(await page('/today'), /<a href="\/invoices">Invoices<\/a>/);
      const empty = await page('/invoices');
      assert.match(empty, /No invoices yet\. Open a completed booking and choose Create invoice\./);
      assert.match(await page('/invoices?q=anything'), /No invoices yet\./);

      // Demo booking 1: Sample Apartment Turnover, $330.00. Booking 3: Sample Townhouse, $141.00.
      for (const id of [1, 3]) {
        assert.equal((await send(`/bookings/${id}/start`, dispatch, { version: 1 })).status, 303);
        assert.equal((await send(`/bookings/${id}/complete`, dispatch, { version: 2, detail: '' })).status, 303);
        assert.equal((await send(`/bookings/${id}/invoice`, dispatch, {})).status, 303);
      }

      const all = await page('/invoices');
      assert.deepEqual(listed(all), ['INV-000002', 'INV-000001']);
      assert.match(all, /2 invoices\s+· \$471\.00/);
      assert.equal(all.match(/<span class="tag">Unpaid<\/span>/g).length, 2);
      assert.match(all, /Sample Townhouse[\s\S]*Townhouse maintenance[\s\S]*\$141\.00[\s\S]*Sample Apartment Turnover[\s\S]*Move-out cleaning[\s\S]*2030-05-06[\s\S]*\$330\.00/);

      // Search by customer name and by invoice number.
      assert.deepEqual(listed(await page('/invoices?q=townhouse')), ['INV-000002']);
      assert.deepEqual(listed(await page('/invoices?q=Apartment')), ['INV-000001']);
      assert.deepEqual(listed(await page('/invoices?q=INV-000001')), ['INV-000001']);
      assert.deepEqual(listed(await page('/invoices?q=inv-2')), ['INV-000002']);
      const one = await page('/invoices?q=Apartment');
      assert.match(one, /1 invoice\s+· \$330\.00 matching “Apartment”/);
      assert.match(one, /<input name="q" maxlength="80" value="Apartment">/);

      // Searches and filters that find nothing say so.
      const missing = await page('/invoices?q=Nobody+Here');
      assert.deepEqual(listed(missing), []);
      assert.match(missing, /No invoices match “Nobody Here”\./);
      assert.match(missing, /Search by customer name or invoice number, such as INV-000001\./);
      assert.match(missing, /<a href="\/invoices">Show all invoices<\/a>/);
      assert.match(await page('/invoices?q=INV-000099'), /No invoices match “INV-000099”\./);
      const paid = await page('/invoices?status=paid');
      assert.deepEqual(listed(paid), []);
      assert.match(paid, /No paid invoices\./);
      assert.match(await page('/invoices?status=paid&q=Townhouse'), /No paid invoices match “Townhouse”\./);
      assert.deepEqual(listed(await page('/invoices?status=unpaid')), ['INV-000002', 'INV-000001']);
      assert.deepEqual(listed(await page('/invoices?status=unpaid&q=townhouse')), ['INV-000002']);
      assert.match(await page('/invoices?status=unpaid&q=townhouse'), /1 unpaid invoice\s+· \$141\.00/);
      assert.deepEqual(listed(await page('/invoices?status=&q=')), ['INV-000002', 'INV-000001']);
      const bad = await send('/invoices?status=overdue', dispatch);
      assert.equal(bad.status, 400);
      assert.match(await bad.text(), /Choose all, unpaid, or paid invoices\./);

      // Filter links keep the search; search text is escaped.
      assert.match(await page('/invoices?q=town'), /href="\/invoices\?q=town&amp;status=paid">Paid<\/a>/);
      const hostile = await page('/invoices?q=' + encodeURIComponent('<script>alert(1)</script>'));
      assert.doesNotMatch(hostile, /<script>alert/);
      assert.match(hostile, /No invoices match “&lt;script&gt;alert\(1\)&lt;\/script&gt;”\./);

      // Customer history: Sample Apartment Turnover (customer 1) has INV-000001 only.
      const apartment = await page('/customers/1');
      assert.match(apartment, /<h2>Invoices<\/h2>/);
      assert.deepEqual(listed(apartment), ['INV-000001']);
      assert.match(apartment, /<span class="tag">Completed<\/span> · Invoice\s+<a href="\/invoices\/1">INV-000001<\/a>/);
      assert.deepEqual(listed(await page('/customers/3')), ['INV-000002']);
      assert.match(await page('/customers/2'), /<h2>Invoices<\/h2><p>No invoices yet\.<\/p>/);

      // The booking page, customer history, and register all open the one invoice page.
      const links = [await page('/bookings/1'), apartment, all].map(html => /href="(\/invoices\/1)"/.exec(html)?.[1]);
      assert.deepEqual(links, ['/invoices/1', '/invoices/1', '/invoices/1']);
      const invoice = await page('/invoices/1');
      assert.match(invoice, /<h1>Invoice INV-000001<\/h1>/);
      assert.match(invoice, /<span class="tag">Unpaid<\/span> · Issued/);
      assert.match(invoice, /Total<\/th><th class="amount">\$330\.00/);
      assert.match(invoice, /<a href="\/invoices">All invoices<\/a>/);

      // Creation and duplicate protection are unchanged.
      const repeat = await send('/bookings/1/invoice', dispatch, {});
      assert.equal(repeat.headers.get('location'), '/invoices/1?existing=1');
      assert.equal((await send('/bookings/2/invoice', dispatch, {})).status, 409);
      assert.deepEqual(listed(await page('/invoices')), ['INV-000002', 'INV-000001']);

      // Cleaners cannot see the register.
      assert.equal((await send('/invoices', cleaner)).status, 403);
      assert.equal((await send('/invoices?q=Apartment', cleaner)).status, 403);
      assert.equal((await send('/invoices')).headers.get('location'), '/login');
    } finally {
      await new Promise(resolve => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    }
  });
});
