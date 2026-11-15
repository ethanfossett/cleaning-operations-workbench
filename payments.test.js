import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { describe, test } from 'node:test';
import { InputError } from './pricing.js';
import { Conflict, NotFound, openRepository } from './repository.js';
import { app } from './server.js';
import { sampleAccounts } from './staff.js';

// 11:00 AM Eastern on Friday, May 10, 2030.
const NOW = '2030-05-10T15:00:00.000Z';
const plain = rows => rows.map(row => ({ ...row }));

function raw(file, action) {
  const db = new DatabaseSync(file);
  try {
    return action(db);
  } finally {
    db.close();
  }
}

const tables = file => raw(file, db => Object.fromEntries(['invoices', 'invoice_lines', 'invoice_payments']
  .map(table => [table, plain(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())])));

async function withRepository(action) {
  const dir = await mkdtemp(join(tmpdir(), 'ayc-payments-'));
  const file = join(dir, 'payments.sqlite');
  let time = new Date(NOW);
  const repository = openRepository(file, { now: () => time });
  try {
    return await action(repository, file, value => { time = new Date(value); });
  } finally {
    repository.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// A customer with a completed, invoiced move-out job: revision 2 accepted at $330.00.
function invoicedJob(repository, name = 'Sample Apartment', date = '2030-05-06') {
  const customerId = repository.addCustomer({ name, reference: 'Unit B' });
  const scope = { title: 'Move-out cleaning', service: 'moveout', squareFeet: '1200', bathrooms: '2' };
  const quoteId = repository.addQuote(customerId, scope);
  repository.revise(quoteId, 1, { ...scope, squareFeet: '1400' });
  repository.decide(quoteId, 2, 'accepted');
  const bookingId = repository.scheduleQuote(quoteId, { date, start: '09:00', duration: '120' });
  repository.advanceJob(bookingId, 1, 'start', '');
  repository.advanceJob(bookingId, 2, 'complete', '');
  const invoiceId = repository.createInvoice(bookingId, 'demo-dispatcher').id;
  return { customerId, bookingId, invoiceId };
}

const CASH = { paidOn: '2030-05-08', method: 'cash' };

describe('recording a full payment', () => {
  test('marks the invoice paid everywhere and never changes the invoice', () => withRepository((repository, file) => {
    const { customerId, bookingId, invoiceId } = invoicedJob(repository);
    const before = tables(file);
    assert.deepEqual(repository.recordPayment(invoiceId, CASH, 'demo-dispatcher'), { created: true });

    const invoice = repository.invoice(invoiceId);
    assert.deepEqual(
      [invoice.status, invoice.paid_cents, invoice.paid_on, invoice.payment_method, invoice.payment_recorded_by,
        invoice.payment_recorded_at],
      ['paid', 33000, '2030-05-08', 'cash', 'demo-dispatcher', NOW]);
    assert.equal(repository.invoices()[0].status, 'paid');
    assert.equal(repository.customerInvoices(customerId)[0].status, 'paid');
    assert.equal(repository.invoiceForBooking(bookingId).status, 'paid');
    assert.equal(repository.customerBookings(customerId)[0].invoice_status, 'paid');

    const after = tables(file);
    assert.deepEqual(after.invoices, before.invoices, 'invoice rows unchanged');
    assert.deepEqual(after.invoice_lines, before.invoice_lines, 'invoice lines unchanged');
    assert.equal(after.invoices[0].total_cents, 33000);
    assert.deepEqual(after.invoice_payments.map(({ id, ...row }) => row), [{
      invoice_id: invoiceId, amount_cents: 33000, paid_on: '2030-05-08', method: 'cash',
      recorded_by: 'demo-dispatcher', recorded_at: NOW,
    }]);
  }));

  test('accepts every method and today’s Eastern date', () => withRepository(repository => {
    for (const [index, method] of ['cash', 'check', 'card', 'bank_transfer'].entries()) {
      const { invoiceId } = invoicedJob(repository, 'Customer ' + index, `2030-05-0${index + 1}`);
      repository.recordPayment(invoiceId, { paidOn: '2030-05-10', method }, 'demo-dispatcher');
      assert.equal(repository.invoice(invoiceId).payment_method, method);
    }
  }));

  test('only the paid invoice changes status; other invoices stay unpaid', () => withRepository(repository => {
    const first = invoicedJob(repository, 'First', '2030-05-06');
    const second = invoicedJob(repository, 'Second', '2030-05-07');
    repository.recordPayment(first.invoiceId, CASH, 'demo-dispatcher');
    assert.deepEqual(repository.invoices().map(row => [row.number, row.status]),
      [['INV-000002', 'unpaid'], ['INV-000001', 'paid']]);
    assert.deepEqual(repository.invoices({ status: 'paid' }).map(row => row.number), ['INV-000001']);
    assert.deepEqual(repository.invoices({ status: 'unpaid' }).map(row => row.number), ['INV-000002']);
    assert.deepEqual(repository.invoices({ status: 'paid', query: 'second' }), []);
    assert.deepEqual(repository.invoices({ status: 'unpaid', query: 'second' }).map(row => row.number), ['INV-000002']);
    assert.equal(repository.invoice(second.invoiceId).paid_on, null);
  }));
});

describe('payment details are checked before anything is saved', () => {
  test('missing or invalid method and date, future dates, and no dispatcher are refused', () =>
    withRepository((repository, file) => {
      const { invoiceId } = invoicedJob(repository);
      const refused = (fields, by, message) => assert.throws(() => repository.recordPayment(invoiceId, fields, by),
        error => error instanceof InputError && message.test(error.message), JSON.stringify(fields));
      refused({ paidOn: '2030-05-08' }, 'demo-dispatcher', /Choose how the customer paid/);
      refused({ paidOn: '2030-05-08', method: 'bitcoin' }, 'demo-dispatcher', /Choose how the customer paid/);
      refused({ paidOn: '2030-05-08', method: 'toString' }, 'demo-dispatcher', /Choose how the customer paid/);
      refused({ method: 'cash' }, 'demo-dispatcher', /Enter the date the payment was received/);
      refused({ paidOn: '  ', method: 'cash' }, 'demo-dispatcher', /Enter the date the payment was received/);
      refused({ paidOn: '05/08/2030', method: 'cash' }, 'demo-dispatcher', /from 2000 to 2099/);
      refused({ paidOn: '2030-02-30', method: 'cash' }, 'demo-dispatcher', /valid calendar date/);
      refused({ paidOn: '2030-05-11', method: 'cash' }, 'demo-dispatcher', /cannot be in the future/);
      refused(CASH, undefined, /signed-in dispatcher/);
      refused(CASH, '  ', /signed-in dispatcher/);
      assert.deepEqual(tables(file).invoice_payments, []);
      assert.equal(repository.invoice(invoiceId).status, 'unpaid');
      assert.throws(() => repository.recordPayment(99, CASH, 'demo-dispatcher'), NotFound);
    }));

  test('“today” is the Eastern date, not the UTC date', () => withRepository((repository, file, setNow) => {
    const { invoiceId } = invoicedJob(repository);
    setNow('2030-05-11T03:30:00Z'); // 11:30 PM Eastern on May 10.
    assert.throws(() => repository.recordPayment(invoiceId, { paidOn: '2030-05-11', method: 'card' }, 'd'),
      /cannot be in the future/);
    repository.recordPayment(invoiceId, { paidOn: '2030-05-10', method: 'card' }, 'd');
    assert.equal(repository.invoice(invoiceId).paid_on, '2030-05-10');
  }));
});

describe('an invoice is paid at most once', () => {
  test('repeating the same payment changes nothing; a different one is refused with the details', () =>
    withRepository((repository, file) => {
      const { invoiceId } = invoicedJob(repository);
      repository.recordPayment(invoiceId, CASH, 'demo-dispatcher');
      const before = tables(file);
      assert.deepEqual(repository.recordPayment(invoiceId, CASH, 'demo-dispatcher'), { created: false });
      const message = /^INV-000001 is already paid: Cash on 2030-05-08, recorded by demo-dispatcher\. No second payment was recorded\.$/;
      for (const [fields, by] of [
        [{ paidOn: '2030-05-09', method: 'cash' }, 'demo-dispatcher'],
        [{ paidOn: '2030-05-08', method: 'card' }, 'demo-dispatcher'],
        [CASH, 'demo-dispatcher-2'],
        [{ paidOn: 'not a date', method: 'nothing' }, 'demo-dispatcher-2'],
      ]) {
        assert.throws(() => repository.recordPayment(invoiceId, fields, by),
          error => error instanceof Conflict && message.test(error.message));
      }
      assert.deepEqual(tables(file), before);
    }));

  test('the database rejects a second payment, a partial or larger amount, and any edit', () =>
    withRepository((repository, file) => {
      const paid = invoicedJob(repository, 'Paid', '2030-05-06');
      const unpaid = invoicedJob(repository, 'Unpaid', '2030-05-07');
      repository.recordPayment(paid.invoiceId, CASH, 'demo-dispatcher');
      const before = tables(file);
      raw(file, db => {
        const insert = (invoiceId, cents, method = 'cash') => db.prepare(`INSERT INTO invoice_payments
          (invoice_id, amount_cents, paid_on, method, recorded_by, recorded_at) VALUES (?, ?, '2030-05-09', ?, 'x', ?)`)
          .run(invoiceId, cents, method, NOW);
        assert.throws(() => insert(paid.invoiceId, 33000), /UNIQUE constraint failed: invoice_payments\.invoice_id/);
        assert.throws(() => insert(unpaid.invoiceId, 10000), /A payment must be for the full invoice total\./);
        assert.throws(() => insert(unpaid.invoiceId, 33001), /A payment must be for the full invoice total\./);
        assert.throws(() => insert(unpaid.invoiceId, 33000, 'crypto'), /CHECK constraint failed/);
        assert.throws(() => insert(99, 33000), /full invoice total|FOREIGN KEY/);
        for (const sql of ['UPDATE invoice_payments SET amount_cents = 1', 'UPDATE invoice_payments SET paid_on = \'2030-01-01\'',
          'DELETE FROM invoice_payments']) {
          assert.throws(() => db.exec(sql), /Payments are immutable/, sql);
        }
        assert.throws(() => db.exec('UPDATE invoices SET total_cents = 1'), /Invoices are immutable/);
      });
      assert.deepEqual(tables(file), before);
    }));

  test('separate processes paying the same invoice at once record exactly one payment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ayc-payment-race-'));
    const file = join(dir, 'race.sqlite');
    try {
      const repository = openRepository(file, { now: () => new Date(NOW) });
      const { invoiceId } = invoicedJob(repository);
      repository.close();
      const startAt = Date.now() + 1500;
      const script = index => `
        const { openRepository } = await import(${JSON.stringify(new URL('./repository.js', import.meta.url).href)});
        const repository = openRepository(${JSON.stringify(file)}, { now: () => new Date(${JSON.stringify(NOW)}) });
        while (Date.now() < ${startAt});
        let outcome;
        try {
          outcome = repository.recordPayment(${invoiceId}, { paidOn: '2030-05-0${index + 1}', method: 'cash' },
            'dispatcher-${index}').created ? 'recorded' : 'repeat';
        } catch (error) {
          outcome = error.constructor.name;
        }
        process.stdout.write(outcome);
        repository.close();`;
      const run = promisify(execFile);
      const results = (await Promise.all(Array.from({ length: 6 }, (_, index) =>
        run(process.execPath, ['--no-warnings', '--input-type=module', '-e', script(index)]))))
        .map(result => result.stdout.trim());
      assert.deepEqual(results.filter(result => result === 'recorded').length, 1, results.join(' '));
      assert.deepEqual(results.filter(result => result === 'Conflict').length, 5, results.join(' '));
      assert.equal(tables(file).invoice_payments.length, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('databases from before payments', () => {
  test('gain the payments table; existing invoices are unpaid and can be paid', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ayc-payment-upgrade-'));
    const file = join(dir, 'old.sqlite');
    const clock = { now: () => new Date(NOW) };
    try {
      const repository = openRepository(file, clock);
      const { invoiceId } = invoicedJob(repository);
      repository.close();
      // Make it look like a database from before payments existed.
      raw(file, db => db.exec(`DROP TRIGGER invoice_payments_full_amount; DROP TRIGGER invoice_payments_no_update;
        DROP TRIGGER invoice_payments_no_delete; DROP TABLE invoice_payments;`));
      const before = raw(file, db => plain(db.prepare('SELECT * FROM invoices').all()));
      const reopened = openRepository(file, clock);
      try {
        assert.equal(reopened.invoice(invoiceId).status, 'unpaid');
        reopened.recordPayment(invoiceId, CASH, 'demo-dispatcher');
        assert.equal(reopened.invoice(invoiceId).status, 'paid');
      } finally {
        reopened.close();
      }
      assert.deepEqual(raw(file, db => plain(db.prepare('SELECT * FROM invoices').all())), before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('payment pages', () => {
  test('dispatchers record a payment once; outdated pages and other roles cannot add another', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ayc-payment-http-'));
    const file = join(dir, 'demo.sqlite');
    const second = { name: 'demo-dispatcher-2', password: 'DUMMY-DISPATCHER-TWO-ONLY', role: 'dispatcher' };
    let server;
    let base;
    async function start(demo) {
      server = app(file, { staffFile: file, demo, now: () => new Date(NOW),
        accounts: demo ? [...sampleAccounts, second] : [] }).listen(0, '127.0.0.1');
      await once(server, 'listening');
      base = 'http://127.0.0.1:' + server.address().port;
    }
    const stop = () => new Promise(resolve => server.close(resolve));
    const send = (path, cookie, fields) => fetch(base + path, {
      redirect: 'manual',
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(fields ? { Origin: base } : {}) },
      ...(fields ? { method: 'POST', body: new URLSearchParams(fields) } : {}),
    });
    const login = async account => (await send('/login', '', account)).headers.get('set-cookie').split(';')[0];
    const payments = () => raw(file, db => plain(db.prepare('SELECT * FROM invoice_payments ORDER BY id').all()));
    try {
      await start(true);
      const one = await login(sampleAccounts[0]);
      const two = await login(second);
      const cleaner = await login(sampleAccounts[1]);
      const page = async (path, cookie = one) => {
        const response = await send(path, cookie);
        assert.equal(response.status, 200, path);
        return response.text();
      };
      for (const id of [1, 3]) {
        await send(`/bookings/${id}/start`, one, { version: 1 });
        await send(`/bookings/${id}/complete`, one, { version: 2, detail: '' });
        assert.equal((await send(`/bookings/${id}/invoice`, one, {})).status, 303);
      }

      // Both dispatchers open INV-000001 while it is unpaid.
      const tabs = [await page('/invoices/1', one), await page('/invoices/1', two)];
      for (const tab of tabs) {
        assert.match(tab, /<span class="tag">Unpaid<\/span> · Issued/);
        assert.match(tab, /action="\/invoices\/1\/payment"/);
        assert.match(tab, /<input type="date" name="paidOn" required max="2030-05-10"\s+value="2030-05-10">/);
        assert.match(tab, /<button>Record full payment of \$330\.00<\/button>/);
      }

      // Only signed-in dispatchers, from the app, by POST.
      assert.equal((await send('/invoices/1/payment', cleaner, CASH)).status, 403);
      assert.equal((await send('/invoices/1/payment', '', CASH)).status, 401);
      assert.equal((await send('/invoices/1/payment', one)).status, 404);
      assert.equal((await send('/invoices/99/payment', one, CASH)).status, 404);

      // Invalid details are explained and keep what was entered.
      let response = await send('/invoices/1/payment', one, { paidOn: '2030-05-08', method: '' });
      assert.equal(response.status, 400);
      let body = await response.text();
      assert.match(body, /<p role="alert">Choose how the customer paid\.<\/p>/);
      assert.match(body, /value="2030-05-08"/);
      response = await send('/invoices/1/payment', one, { paidOn: '2030-05-11', method: 'card' });
      assert.equal(response.status, 400);
      body = await response.text();
      assert.match(body, /The payment date cannot be in the future\./);
      assert.match(body, /<option value="card" selected>Card<\/option>/);
      assert.deepEqual(payments(), []);

      // Dispatcher one records cash.
      response = await send('/invoices/1/payment', one, CASH);
      assert.equal(response.status, 303);
      assert.equal(response.headers.get('location'), '/invoices/1?payment=recorded');
      const paid = await page('/invoices/1?payment=recorded');
      assert.match(paid, /<p role="status">Payment recorded\. This invoice is paid in full\.<\/p>/);
      assert.match(paid, /<span class="tag">Paid<\/span> · Issued/);
      assert.match(paid, /<strong>Paid in full<\/strong> · \$330\.00\s+· Cash · received 2030-05-08/);
      assert.match(paid, /Recorded by demo-dispatcher · Fri, May 10, 2030, 11:00 AM Eastern/);
      assert.match(paid, /Total<\/th><th class="amount">\$330\.00/);
      assert.doesNotMatch(paid, /action="\/invoices\/1\/payment"/);

      // Dispatcher two submits from the outdated page: refused, with what was already recorded.
      response = await send('/invoices/1/payment', two, { paidOn: '2030-05-09', method: 'card' });
      assert.equal(response.status, 409);
      body = await response.text();
      assert.match(body, /<p role="alert">INV-000001 is already paid: Cash on 2030-05-08, recorded by demo-dispatcher\. No second payment was recorded\.<\/p>/);
      assert.match(body, /<strong>Paid in full<\/strong>/);
      // The same dispatcher pressing again with the same details (a double click) just reopens the invoice.
      response = await send('/invoices/1/payment', one, CASH);
      assert.equal(response.headers.get('location'), '/invoices/1?payment=existing');
      assert.match(await page('/invoices/1?payment=existing'),
        /This payment was already recorded\. No second payment was recorded\./);
      assert.equal(payments().length, 1);
      assert.equal(payments()[0].recorded_by, 'demo-dispatcher');

      // Paid everywhere: register, filters, customer history, booking page.
      const listed = html => [...html.matchAll(/<td><a href="\/invoices\/\d+">(INV-\d+)<\/a><\/td>/g)].map(match => match[1]);
      const register = await page('/invoices');
      assert.match(register, /INV-000001[\s\S]*<span class="tag">Paid<\/span><div class="muted">2030-05-08<\/div>/);
      assert.match(register, /INV-000002[\s\S]*<span class="tag">Unpaid<\/span>/);
      assert.deepEqual(listed(await page('/invoices?status=paid')), ['INV-000001']);
      assert.deepEqual(listed(await page('/invoices?status=unpaid')), ['INV-000002']);
      assert.match(await page('/invoices?status=paid&q=Townhouse'), /No paid invoices match “Townhouse”\./);
      const customer = await page('/customers/1');
      assert.match(customer, /Invoice\s+<a href="\/invoices\/1">INV-000001<\/a> <span class="tag">Paid<\/span>/);
      assert.match(customer, /<h2>Invoices<\/h2>[\s\S]*\$330\.00<\/td><td><span class="tag">Paid<\/span>/);
      assert.match(await page('/bookings/1'), /INV-000001<\/a>\s*· \$330\.00 · <span class="tag">Paid<\/span>/);
      assert.match(await page('/bookings/3'), /INV-000002<\/a>\s*· \$141\.00 · <span class="tag">Unpaid<\/span>/);
      // A stale "recorded" notice is not shown on an unpaid invoice.
      assert.doesNotMatch(await page('/invoices/2?payment=recorded'), /Payment recorded/);

      // Both dispatchers pay INV-000002 at the same moment: one payment.
      const pressed = await Promise.all([
        send('/invoices/2/payment', one, { paidOn: '2030-05-10', method: 'check' }),
        send('/invoices/2/payment', two, { paidOn: '2030-05-10', method: 'bank_transfer' }),
      ]);
      assert.deepEqual(pressed.map(item => item.status).sort(), [303, 409]);
      assert.equal(payments().length, 2);
      assert.deepEqual(listed(await page('/invoices?status=unpaid')), []);
      assert.match(await page('/invoices?status=unpaid'), /No unpaid invoices\./);

      // Creating invoices and duplicate protection are unchanged.
      assert.equal((await send('/bookings/1/invoice', one, {})).headers.get('location'), '/invoices/1?existing=1');
      assert.equal((await send('/bookings/2/invoice', one, {})).status, 409);
      await stop();

      // Payments survive a restart.
      await start(false);
      assert.match(await page('/invoices/1'), /<strong>Paid in full<\/strong> · \$330\.00\s+· Cash · received 2030-05-08/);
      assert.equal(payments().length, 2);
    } finally {
      if (server?.listening) await stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
