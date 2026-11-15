import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { describe, test } from 'node:test';
import { Conflict, NotFound, openRepository } from './repository.js';
import { app } from './server.js';
import { sampleAccounts } from './staff.js';

const MOVE_OUT = { title: 'Move-out cleaning', service: 'moveout', squareFeet: '1200', bathrooms: '2' };
const V2 = {
  version: 'v2', bathroomCents: 2500, services: {
    standard: { squareFootCents: 12, minimumCents: 10000 },
    deep: { squareFootCents: 20, minimumCents: 16000 },
    moveout: { squareFootCents: 30, minimumCents: 20000 },
  },
};
// The exact JSON the baseline code stored for an accepted revision (no recorded rates).
const LEGACY_DEEP = '{"scope":{"service":"deep","squareFeet":1000,"bathrooms":2},'
  + '"lines":[{"label":"Floor area","cents":17000},{"label":"Bathrooms","cents":3600}],'
  + '"totalCents":20600,"rateVersion":"demo-1"}';

const plain = rows => rows.map(row => ({ ...row }));

function raw(file, action) {
  const db = new DatabaseSync(file);
  try {
    return action(db);
  } finally {
    db.close();
  }
}

const invoiceRows = file => raw(file, db => ({
  invoices: plain(db.prepare('SELECT * FROM invoices ORDER BY id').all()),
  lines: plain(db.prepare('SELECT * FROM invoice_lines ORDER BY invoice_id, position').all()),
}));

async function withRepository(action) {
  const dir = await mkdtemp(join(tmpdir(), 'ayc-invoices-'));
  const file = join(dir, 'invoices.sqlite');
  const repository = openRepository(file);
  try {
    return await action(repository, file);
  } finally {
    repository.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// A customer with an accepted quote: revision 1 at 1,200 sq ft ($288.00), then revision 2 at
// 1,400 sq ft ($330.00) accepted. Returns the ids; the booking is left scheduled.
function acceptedJob(repository, { date = '2030-05-06', start = '09:00' } = {}) {
  const customerId = repository.addCustomer({ name: 'Sample Apartment', reference: 'Unit B' });
  const quoteId = repository.addQuote(customerId, MOVE_OUT);
  repository.revise(quoteId, 1, { ...MOVE_OUT, squareFeet: '1400' });
  repository.decide(quoteId, 2, 'accepted');
  const bookingId = repository.scheduleQuote(quoteId, { date, start, duration: '120' });
  return { customerId, quoteId, bookingId };
}

function finish(repository, bookingId) {
  repository.advanceJob(bookingId, repository.booking(bookingId).version, 'start', '');
  repository.advanceJob(bookingId, repository.booking(bookingId).version, 'complete', 'Done.');
}

describe('creating an invoice from a completed job', () => {
  test('copies the accepted revision’s lines and total and the booking’s saved location', () =>
    withRepository((repository, file) => {
      const { customerId, quoteId, bookingId } = acceptedJob(repository);
      finish(repository, bookingId);
      const result = repository.createInvoice(bookingId, 'demo-dispatcher');
      assert.deepEqual(result, { id: 1, created: true });
      const invoice = repository.invoice(1);
      assert.equal(invoice.number, 'INV-000001');
      assert.equal(invoice.booking_id, bookingId);
      assert.equal(invoice.quote_id, quoteId);
      assert.equal(invoice.revision, 2, 'the accepted revision, not revision 1');
      assert.equal(invoice.customer_id, customerId);
      assert.equal(invoice.customer_name, 'Sample Apartment');
      assert.equal(invoice.site_reference, 'Unit B');
      assert.equal(invoice.title, 'Move-out cleaning');
      assert.equal(invoice.service_day, '2030-05-06');
      assert.deepEqual([invoice.service, invoice.square_feet, invoice.bathrooms, invoice.rate_version],
        ['moveout', 1400, 2, 'demo-1']);
      assert.equal(invoice.created_by, 'demo-dispatcher');
      assert.deepEqual(plain(invoice.lines), [
        { label: 'Floor area', cents: 29400 }, { label: 'Bathrooms', cents: 3600 },
      ]);
      assert.equal(invoice.total_cents, 33000);
      const saved = JSON.parse(raw(file, db => db.prepare(
        'SELECT estimate FROM revisions WHERE quote_id = ? AND number = 2').get(quoteId).estimate));
      assert.deepEqual(plain(invoice.lines), saved.lines);
      assert.equal(invoice.total_cents, saved.totalCents);
      const { id, number, total_cents: total, status } = repository.invoiceForBooking(bookingId);
      assert.deepEqual({ id, number, total, status }, { id: 1, number: 'INV-000001', total: 33000, status: 'unpaid' });
    }));

  test('includes a service minimum line exactly as accepted', () => withRepository(repository => {
    const customerId = repository.addCustomer({ name: 'Small flat', reference: 'Flat 2' });
    const quoteId = repository.addQuote(customerId,
      { title: 'Tidy', service: 'standard', squareFeet: '600', bathrooms: '1' });
    repository.decide(quoteId, 1, 'accepted');
    const bookingId = repository.scheduleQuote(quoteId, { date: '2030-05-07', start: '09:00', duration: '60' });
    finish(repository, bookingId);
    const invoice = repository.invoice(repository.createInvoice(bookingId).id);
    assert.deepEqual(plain(invoice.lines), [
      { label: 'Floor area', cents: 6000 }, { label: 'Bathrooms', cents: 1800 },
      { label: 'Service minimum', cents: 1200 },
    ]);
    assert.equal(invoice.total_cents, 9000);
    assert.equal(invoice.created_by, null);
  }));

  test('uses the accepted price, not rates activated later', () => withRepository(repository => {
    const { bookingId } = acceptedJob(repository);
    finish(repository, bookingId);
    repository.publishRateProfile(V2, { activate: true, expectedActive: 'demo-1' });
    const invoice = repository.invoice(repository.createInvoice(bookingId).id);
    assert.equal(invoice.total_cents, 33000);
    assert.equal(invoice.rate_version, 'demo-1');
    assert.deepEqual(plain(invoice.lines).map(line => line.cents), [29400, 3600]);
  }));

  test('uses the location saved at booking, and later edits do not change a saved invoice', () =>
    withRepository(repository => {
      const { customerId, bookingId } = acceptedJob(repository);
      finish(repository, bookingId);
      repository.updateCustomer(customerId, { name: 'Sample Apartment', reference: 'Renamed unit' });
      const id = repository.createInvoice(bookingId).id;
      assert.equal(repository.invoice(id).site_reference, 'Unit B');
      repository.updateCustomer(customerId, { name: 'New owner', reference: 'Another unit' });
      repository.publishRateProfile(V2, { activate: true, expectedActive: 'demo-1' });
      const invoice = repository.invoice(id);
      assert.deepEqual([invoice.customer_name, invoice.site_reference, invoice.total_cents],
        ['Sample Apartment', 'Unit B', 33000]);
    }));
});

describe('only completed jobs can be invoiced', () => {
  test('scheduled, in-progress, cancelled, and stopped jobs are refused and nothing is saved', () =>
    withRepository((repository, file) => {
      const refused = (bookingId, pattern) => assert.throws(() => repository.createInvoice(bookingId),
        error => error instanceof Conflict && pattern.test(error.message));
      const { bookingId: scheduled } = acceptedJob(repository, { date: '2030-05-06' });
      refused(scheduled, /Only completed jobs can be invoiced\. This job is still scheduled\./);
      repository.advanceJob(scheduled, 1, 'start', '');
      refused(scheduled, /still in progress/);
      repository.interruptJob(scheduled, 2, 'Power cut');
      refused(scheduled, /cancelled/);

      const { bookingId: cancelled } = acceptedJob(repository, { date: '2030-05-07' });
      repository.changeBooking(cancelled, 1, {}, true);
      refused(cancelled, /cancelled/);

      assert.throws(() => repository.createInvoice(999), NotFound);
      assert.deepEqual(invoiceRows(file), { invoices: [], lines: [] });
    }));

  test('a replacement booking can be invoiced once completed, the cancelled one still cannot', () =>
    withRepository(repository => {
      const { quoteId, bookingId: first } = acceptedJob(repository);
      repository.changeBooking(first, 1, {}, true);
      const second = repository.scheduleQuote(quoteId, { date: '2030-05-08', start: '10:00', duration: '120' });
      finish(repository, second);
      assert.throws(() => repository.createInvoice(first), Conflict);
      assert.equal(repository.invoice(repository.createInvoice(second).id).booking_id, second);
    }));

  test('an accepted price that does not add up is refused rather than guessed', () =>
    withRepository((repository, file) => {
      const { quoteId, bookingId } = acceptedJob(repository);
      finish(repository, bookingId);
      raw(file, db => db.prepare('UPDATE revisions SET estimate = ? WHERE quote_id = ? AND number = 2')
        .run(LEGACY_DEEP.replace('"totalCents":20600', '"totalCents":99999'), quoteId));
      assert.throws(() => repository.createInvoice(bookingId), /saved price is incomplete/);
      assert.deepEqual(invoiceRows(file), { invoices: [], lines: [] });
    }));
});

describe('one invoice per booking', () => {
  test('repeating the request returns the same invoice and saves nothing new', () =>
    withRepository((repository, file) => {
      const { bookingId } = acceptedJob(repository);
      finish(repository, bookingId);
      assert.deepEqual(repository.createInvoice(bookingId, 'first'), { id: 1, created: true });
      const before = invoiceRows(file);
      assert.deepEqual(repository.createInvoice(bookingId, 'second'), { id: 1, created: false });
      assert.deepEqual(invoiceRows(file), before);
      assert.equal(before.invoices.length, 1);
      assert.equal(before.invoices[0].created_by, 'first');
    }));

  test('the database itself rejects a second invoice for a booking', () => withRepository((repository, file) => {
    const { bookingId } = acceptedJob(repository);
    finish(repository, bookingId);
    repository.createInvoice(bookingId);
    raw(file, db => {
      const row = db.prepare('SELECT * FROM invoices WHERE id = 1').get();
      assert.throws(() => db.prepare(`INSERT INTO invoices (id, number, booking_id, quote_id, revision,
        customer_id, customer_name, site_reference, title, service_day, service, square_feet, bathrooms,
        rate_version, total_cents, created_at) VALUES (2, 'INV-000002', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(row.booking_id, row.quote_id, row.revision, row.customer_id, row.customer_name, row.site_reference,
          row.title, row.service_day, row.service, row.square_feet, row.bathrooms, row.rate_version,
          row.total_cents, row.created_at), /UNIQUE constraint failed: invoices\.booking_id/);
    });
  }));

  test('saved invoices and lines cannot be changed or deleted', () => withRepository((repository, file) => {
    const { bookingId } = acceptedJob(repository);
    finish(repository, bookingId);
    repository.createInvoice(bookingId);
    const before = invoiceRows(file);
    raw(file, db => {
      for (const sql of ['UPDATE invoices SET total_cents = 1', 'DELETE FROM invoices',
        'UPDATE invoice_lines SET cents = 1', 'DELETE FROM invoice_lines']) {
        assert.throws(() => db.exec(sql), /Invoices are immutable/, sql);
      }
    });
    assert.deepEqual(invoiceRows(file), before);
  }));

  // Two signed-in dispatchers with the same completed booking open in their own tabs both press
  // Create invoice. Both pages were loaded before either pressed, so both still show the button.
  test('two dispatchers pressing Create invoice at the same moment get one shared invoice', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ayc-invoice-tabs-'));
    const file = join(dir, 'tabs.sqlite');
    const second = { name: 'demo-dispatcher-2', password: 'DUMMY-DISPATCHER-TWO-ONLY', role: 'dispatcher' };
    const server = app(file, { staffFile: file, demo: true, accounts: [...sampleAccounts, second] })
      .listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const send = (path, cookie, fields) => fetch(base + path, {
      redirect: 'manual',
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(fields ? { Origin: base } : {}) },
      ...(fields ? { method: 'POST', body: new URLSearchParams(fields) } : {}),
    });
    const login = async account => (await send('/login', '', account)).headers.get('set-cookie').split(';')[0];
    try {
      const one = await login(sampleAccounts[0]);
      const two = await login(second);
      assert.equal((await send('/bookings/1/start', one, { version: 1 })).status, 303);
      assert.equal((await send('/bookings/1/complete', one, { version: 2, detail: 'Done' })).status, 303);

      // Both tabs are open on the completed job and both offer the button.
      const tabs = await Promise.all([send('/bookings/1', one), send('/bookings/1', two)]);
      for (const tab of tabs) assert.match(await tab.text(), /action="\/bookings\/1\/invoice"/);

      // Both press it without either page being reloaded.
      const pressed = await Promise.all([
        send('/bookings/1/invoice', one, {}), send('/bookings/1/invoice', two, {}),
      ]);
      assert.deepEqual(pressed.map(response => response.status), [303, 303]);
      assert.deepEqual(pressed.map(response => response.headers.get('location')).sort(),
        ['/invoices/1', '/invoices/1?existing=1'], 'one creates the invoice, the other reuses it');

      const { invoices, lines } = invoiceRows(file);
      assert.equal(invoices.length, 1, 'exactly one invoice row');
      assert.equal(lines.length, 2);
      assert.equal(invoices[0].total_cents, 33000);
      assert.ok(['demo-dispatcher', second.name].includes(invoices[0].created_by));
      // Both tabs now show the same invoice and no button.
      for (const cookie of [one, two]) {
        const page = await (await send('/bookings/1', cookie)).text();
        assert.match(page, /<a href="\/invoices\/1">INV-000001<\/a>/);
        assert.doesNotMatch(page, /Create invoice/);
      }
    } finally {
      await new Promise(resolve => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The same two-tab press, but each request is served by its own app process with its own database
  // connection, so the tabs really are in flight together and only SQLite can settle it.
  test('separate app processes serving the same booking at once create exactly one invoice', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ayc-invoice-servers-'));
    const file = join(dir, 'servers.sqlite');
    try {
      const repository = openRepository(file);
      const { bookingId } = acceptedJob(repository);
      finish(repository, bookingId);
      repository.close();
      const startAt = Date.now() + 2000;
      const script = `
        const { app } = await import(${JSON.stringify(new URL('./server.js', import.meta.url).href)});
        const { once } = await import('node:events');
        const server = app(${JSON.stringify(file)}).listen(0, '127.0.0.1');
        await once(server, 'listening');
        const url = 'http://127.0.0.1:' + server.address().port + '/bookings/${bookingId}/invoice';
        while (Date.now() < ${startAt});
        const response = await fetch(url, { method: 'POST', redirect: 'manual',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' });
        process.stdout.write(response.status + ' ' + response.headers.get('location'));
        server.close();`;
      const run = promisify(execFile);
      const results = (await Promise.all(Array.from({ length: 4 }, () =>
        run(process.execPath, ['--no-warnings', '--input-type=module', '-e', script]))))
        .map(result => result.stdout.trim());
      assert.deepEqual(results.filter(result => result === '303 /invoices/1').length, 1, results.join(' | '));
      assert.deepEqual(results.filter(result => result === '303 /invoices/1?existing=1').length, 3, results.join(' | '));
      const { invoices, lines } = invoiceRows(file);
      assert.equal(invoices.length, 1);
      assert.equal(lines.length, 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('separate processes invoicing the same booking at once create exactly one invoice', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ayc-invoice-race-'));
    const file = join(dir, 'race.sqlite');
    try {
      const repository = openRepository(file);
      const { bookingId } = acceptedJob(repository);
      finish(repository, bookingId);
      repository.close();
      const startAt = Date.now() + 1500;
      const script = `
        const { openRepository } = await import(${JSON.stringify(new URL('./repository.js', import.meta.url).href)});
        const repository = openRepository(${JSON.stringify(file)});
        while (Date.now() < ${startAt});
        process.stdout.write(JSON.stringify(repository.createInvoice(${bookingId})));
        repository.close();`;
      const run = promisify(execFile);
      const results = (await Promise.all(Array.from({ length: 6 }, () =>
        run(process.execPath, ['--no-warnings', '--input-type=module', '-e', script]))))
        .map(result => JSON.parse(result.stdout));
      assert.equal(results.filter(result => result.created).length, 1);
      assert.ok(results.every(result => result.id === 1));
      const { invoices, lines } = invoiceRows(file);
      assert.equal(invoices.length, 1);
      assert.equal(lines.length, 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('recurring visits', () => {
  test('each completed visit gets its own invoice for the full accepted amount', () => withRepository(repository => {
    const customerId = repository.addCustomer({ name: 'Weekly client', reference: 'Main office' });
    const quoteId = repository.addQuote(customerId, { ...MOVE_OUT, title: 'Weekly clean' });
    repository.decide(quoteId, 1, 'accepted');
    repository.confirmPlan(quoteId, { date: '2030-05-06', start: '09:00', duration: '120', cadence: 'weekly', crewId: '1' });
    const visits = repository.quote(quoteId).bookings.filter(item => item.recurring_visit_id != null)
      .sort((a, b) => a.day.localeCompare(b.day));
    assert.equal(visits.length, 4);
    finish(repository, visits[0].id);
    finish(repository, visits[1].id);
    const first = repository.invoice(repository.createInvoice(visits[0].id).id);
    const second = repository.invoice(repository.createInvoice(visits[1].id).id);
    assert.deepEqual([first.number, first.service_day, first.total_cents], ['INV-000001', '2030-05-06', 28800]);
    assert.deepEqual([second.number, second.service_day, second.total_cents], ['INV-000002', '2030-05-13', 28800]);
    assert.deepEqual(repository.createInvoice(visits[0].id), { id: 1, created: false });
    assert.throws(() => repository.createInvoice(visits[2].id), /still scheduled/);
  }));
});

describe('jobs completed before invoicing existed', () => {
  test('an older database gains the invoice tables, and its completed jobs can be invoiced', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ayc-invoice-upgrade-'));
    const file = join(dir, 'old.sqlite');
    try {
      const repository = openRepository(file);
      const customerId = repository.addCustomer({ name: 'Legacy client', reference: 'Old house' });
      const quoteId = repository.addQuote(customerId, { title: 'Legacy deep clean', service: 'deep',
        squareFeet: '1000', bathrooms: '2' });
      repository.decide(quoteId, 1, 'accepted');
      const bookingId = repository.scheduleQuote(quoteId, { date: '2030-05-06', start: '09:00', duration: '120' });
      finish(repository, bookingId);
      repository.close();
      // Make it look like a database from before invoices and booking site snapshots: the baseline
      // snapshot JSON, no saved site, and no invoice tables.
      raw(file, db => db.exec(`
        DROP TRIGGER invoices_no_update; DROP TRIGGER invoices_no_delete;
        DROP TRIGGER invoice_lines_no_update; DROP TRIGGER invoice_lines_no_delete;
        DROP TABLE invoice_lines; DROP TABLE invoices;
        DELETE FROM booking_site_snapshots;
        UPDATE revisions SET estimate = '${LEGACY_DEEP}';`));

      const upgraded = openRepository(file);
      try {
        assert.equal(upgraded.booking(bookingId).job_state, 'completed');
        const invoice = upgraded.invoice(upgraded.createInvoice(bookingId).id);
        assert.equal(invoice.number, 'INV-000001');
        assert.equal(invoice.site_reference, 'Old house', 'falls back to the quote’s location');
        assert.equal(invoice.total_cents, 20600);
        assert.deepEqual(plain(invoice.lines), [
          { label: 'Floor area', cents: 17000 }, { label: 'Bathrooms', cents: 3600 },
        ]);
      } finally {
        upgraded.close();
      }
      assert.equal(raw(file, db => db.prepare('SELECT estimate FROM revisions').get().estimate), LEGACY_DEEP);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('invoice pages and access', () => {
  test('dispatchers invoice a completed demo job once; the server refuses everything else', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ayc-invoice-http-'));
    const file = join(dir, 'demo.sqlite');
    let server;
    let base;
    async function start(demo) {
      server = app(file, { staffFile: file, demo, accounts: demo ? sampleAccounts : [] }).listen(0, '127.0.0.1');
      await once(server, 'listening');
      base = 'http://127.0.0.1:' + server.address().port;
    }
    const stop = () => new Promise(resolve => server.close(resolve));
    const send = (path, cookie, fields, origin = base) => fetch(base + path, {
      redirect: 'manual',
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(fields ? { Origin: origin } : {}) },
      ...(fields ? { method: 'POST', body: new URLSearchParams(fields) } : {}),
    });
    const login = async index => (await send('/login', '', sampleAccounts[index])).headers.get('set-cookie').split(';')[0];
    const text = response => response.text();
    try {
      await start(true);
      const dispatch = await login(0);
      const cleaner = await login(1);
      const invoiceCount = () => raw(file, db => db.prepare('SELECT count(*) AS n FROM invoices').get().n);

      // Seeded move-out booking 1: revision 2 accepted at $330.00, still scheduled.
      assert.doesNotMatch(await text(await send('/bookings/1', dispatch)), /Create invoice/);
      let refused = await send('/bookings/1/invoice', dispatch, {});
      assert.equal(refused.status, 409);
      assert.match(await text(refused), /Only completed jobs can be invoiced\. This job is still scheduled\./);
      assert.equal((await send('/bookings/1/start', dispatch, { version: 1 })).status, 303);
      refused = await send('/bookings/1/invoice', dispatch, {});
      assert.equal(refused.status, 409);
      assert.match(await text(refused), /still in progress/);
      assert.equal(invoiceCount(), 0);
      assert.equal((await send('/invoices/1', dispatch)).status, 404);

      assert.equal((await send('/bookings/1/complete', dispatch, { version: 2, detail: 'Done' })).status, 303);
      const completed = await text(await send('/bookings/1', dispatch));
      assert.match(completed, /Not invoiced yet\. The invoice bills \$330\.00\s+from accepted quote revision 2\./);
      assert.match(completed, /action="\/bookings\/1\/invoice"/);

      assert.equal((await send('/bookings/1/invoice', cleaner, {})).status, 403);
      assert.equal((await send('/bookings/1/invoice', dispatch, {}, 'http://elsewhere.example')).status, 403);
      assert.equal((await send('/bookings/1/invoice', '', {})).status, 401);
      assert.equal(invoiceCount(), 0);

      const created = await send('/bookings/1/invoice', dispatch, {});
      assert.equal(created.status, 303);
      assert.equal(created.headers.get('location'), '/invoices/1');
      const page = await text(await send('/invoices/1', dispatch));
      assert.match(page, /<h1>Invoice INV-000001<\/h1>/);
      assert.match(page, /Sample Apartment Turnover/);
      assert.match(page, /Service location: Unit B/);
      assert.match(page, /Move-out · 1400 sq ft ·\s+2 bathrooms/);
      assert.match(page, /Accepted quote revision 2/);
      assert.match(page, /Floor area<\/td>\s*<td class="amount">\$294\.00/);
      assert.match(page, /Bathrooms<\/td>\s*<td class="amount">\$36\.00/);
      assert.match(page, /Total<\/th><th class="amount">\$330\.00/);
      assert.match(page, /by demo-dispatcher/);
      assert.doesNotMatch(page, /already invoiced/);

      const repeated = await send('/bookings/1/invoice', dispatch, {});
      assert.equal(repeated.status, 303);
      assert.equal(repeated.headers.get('location'), '/invoices/1?existing=1');
      assert.match(await text(await send('/invoices/1?existing=1', dispatch)),
        /This job was already invoiced, so no new invoice was created\./);
      assert.equal(invoiceCount(), 1);

      const after = await text(await send('/bookings/1', dispatch));
      assert.match(after, /<a href="\/invoices\/1">INV-000001<\/a>\s*· \$330\.00/);
      assert.doesNotMatch(after, /Create invoice/);

      assert.equal((await send('/invoices/1', cleaner)).status, 403);
      assert.equal((await send('/invoices/2', dispatch)).status, 404);
      assert.equal((await send('/invoices/x', dispatch)).status, 404);
      assert.equal((await send('/bookings/1/invoice', dispatch)).status, 404, 'GET does not create');
      await stop();

      await start(false);
      const restarted = await text(await send('/invoices/1', dispatch));
      assert.match(restarted, /Invoice INV-000001/);
      assert.match(restarted, /Total<\/th><th class="amount">\$330\.00/);
      assert.equal(invoiceCount(), 1);
    } finally {
      if (server?.listening) await stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
