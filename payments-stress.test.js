// Stress tests for payments and the paid/unpaid filters: many invoices, many simultaneous requests,
// several app processes, and repeated submissions. Every run checks the database afterwards.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { describe, test } from 'node:test';
import { openRepository } from './repository.js';
import { shiftDay } from './scheduling.js';
import { app } from './server.js';
import { openStaff } from './staff.js';

const NOW = '2030-05-10T15:00:00.000Z';
const clock = { now: () => new Date(NOW) };
const NAMES = ['Alpha Homes', 'Beta Offices', 'Gamma Flats', 'Delta Lofts'];
const METHODS = ['cash', 'check', 'card', 'bank_transfer'];
const DISPATCHERS = [
  { name: 'stress-dispatcher-a', password: 'STRESS-DISPATCHER-A', role: 'dispatcher' },
  { name: 'stress-dispatcher-b', password: 'STRESS-DISPATCHER-B', role: 'dispatcher' },
];
const run = promisify(execFile);
const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

function raw(file, action) {
  const db = new DatabaseSync(file);
  try {
    return action(db);
  } finally {
    db.close();
  }
}

const paymentRows = file => raw(file, db => db.prepare('SELECT * FROM invoice_payments ORDER BY id').all()
  .map(row => ({ ...row })));

async function withDir(action) {
  const dir = await mkdtemp(join(tmpdir(), 'ayc-payment-stress-'));
  try {
    return await action(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Creates `count` completed, invoiced jobs spread over four customers, one job a day from 2030-01-01.
// Invoice n belongs to NAMES[(n - 1) % 4] and totals (1000 + 10n) sq ft at $0.10 plus one $18 bathroom.
function invoices(repository, count) {
  const customers = NAMES.map(name => repository.addCustomer({ name, reference: name + ' site' }));
  return Array.from({ length: count }, (_, index) => {
    const quoteId = repository.addQuote(customers[index % 4], {
      title: 'Job ' + (index + 1), service: 'standard', squareFeet: String(1010 + 10 * index), bathrooms: '1',
    });
    repository.decide(quoteId, 1, 'accepted');
    const bookingId = repository.scheduleQuote(quoteId, { date: shiftDay('2030-01-01', index), start: '09:00', duration: '60' });
    repository.advanceJob(bookingId, 1, 'start', '');
    repository.advanceJob(bookingId, 2, 'complete', '');
    const { id } = repository.createInvoice(bookingId, 'stress');
    return { id, number: 'INV-' + String(id).padStart(6, '0'), name: NAMES[index % 4],
      total: (1010 + 10 * index) * 10 + 1800 };
  });
}

// Signs in the two stress dispatchers directly against the database and returns their cookies.
function sessions(file) {
  const staff = openStaff(file, DISPATCHERS);
  try {
    return DISPATCHERS.map(account => staff.login(account.name, account.password).cookie.split(';')[0]);
  } finally {
    staff.close();
  }
}

// Starts an app on `file` in this process.
async function serve(file) {
  const server = app(file, { staffFile: file, ...clock }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  return {
    base,
    post: (path, cookie, fields) => fetch(base + path, { method: 'POST', redirect: 'manual',
      headers: { Cookie: cookie, Origin: base }, body: new URLSearchParams(fields) }),
    get: (path, cookie) => fetch(base + path, { redirect: 'manual', headers: { Cookie: cookie } }),
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

// Each child process starts its own app (its own database connection) on `file`, waits for the shared
// start instant, then sends its requests all at once. It prints one "status location" per request.
function childServer(file, startAt, requests) {
  return `
    const { app } = await import(${JSON.stringify(new URL('./server.js', import.meta.url).href)});
    const { once } = await import('node:events');
    const server = app(${JSON.stringify(file)}, { staffFile: ${JSON.stringify(file)}, now: () => new Date(${JSON.stringify(NOW)}) })
      .listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const requests = ${JSON.stringify(requests)};
    while (Date.now() < ${startAt});
    const results = await Promise.all(requests.map(({ path, cookie, fields }) => fetch(base + path, {
      method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: base }, body: new URLSearchParams(fields),
    }).then(response => response.status + ' ' + response.headers.get('location'))));
    process.stdout.write(JSON.stringify(results));
    server.close();`;
}

async function children(scripts) {
  const outputs = await Promise.all(scripts.map(script =>
    run(process.execPath, ['--no-warnings', '--input-type=module', '-e', script])));
  return outputs.map(output => JSON.parse(output.stdout));
}

describe('paid and unpaid filters stay exact', () => {
  test('across 40 invoices, every search and filter matches the recorded payments', () => withDir(async dir => {
    const file = join(dir, 'filters.sqlite');
    const repository = openRepository(file, clock);
    let expected;
    try {
      expected = invoices(repository, 40);
      // Pay every third invoice, with a mix of methods, dates, and dispatchers.
      for (const [index, item] of expected.entries()) {
        if (index % 3) continue;
        repository.recordPayment(item.id, { paidOn: shiftDay('2030-05-01', index % 9), method: METHODS[index % 4] },
          DISPATCHERS[index % 2].name);
        item.paid = true;
      }
      const paid = expected.filter(item => item.paid);
      assert.equal(paid.length, 14);
      const numbers = rows => rows.map(row => row.number);
      const newestFirst = items => items.map(item => item.number).reverse();
      const want = (status, match = () => true) => newestFirst(expected.filter(item => match(item)
        && (status === 'all' || (status === 'paid') === Boolean(item.paid))));

      for (const status of ['all', 'paid', 'unpaid']) {
        assert.deepEqual(numbers(repository.invoices({ status })), want(status), status);
        for (const name of NAMES) {
          for (const query of [name, name.toLowerCase(), name.split(' ')[0].toUpperCase()]) {
            assert.deepEqual(numbers(repository.invoices({ status, query })),
              want(status, item => item.name === name), status + ' ' + query);
          }
        }
        for (const item of [expected[0], expected[1], expected[29], expected[39]]) {
          for (const query of [item.number, item.number.toLowerCase(), 'INV-' + item.id]) {
            const hit = status === 'all' || (status === 'paid') === Boolean(item.paid);
            assert.deepEqual(numbers(repository.invoices({ status, query })), hit ? [item.number] : [],
              status + ' ' + query);
          }
        }
      }
      // Paid and unpaid never overlap and together are every invoice.
      const paidNumbers = numbers(repository.invoices({ status: 'paid' }));
      const unpaidNumbers = numbers(repository.invoices({ status: 'unpaid' }));
      assert.equal(paidNumbers.filter(number => unpaidNumbers.includes(number)).length, 0);
      assert.deepEqual([...paidNumbers, ...unpaidNumbers].sort(), numbers(repository.invoices()).sort());
      // Each customer's history agrees with the register.
      for (const row of repository.invoices()) {
        const own = repository.customerInvoices(row.customer_id).find(item => item.id === row.id);
        assert.equal(own.status, row.status, row.number);
      }
    } finally {
      repository.close();
    }

    // The register pages show the same invoices, counts, and totals.
    const [cookie] = sessions(file);
    const server = await serve(file);
    try {
      const page = async path => (await server.get(path, cookie)).text();
      const listed = html => [...html.matchAll(/<td><a href="\/invoices\/\d+">(INV-\d+)<\/a><\/td>/g)].map(match => match[1]);
      for (const [status, items] of [['all', expected], ['paid', expected.filter(item => item.paid)],
        ['unpaid', expected.filter(item => !item.paid)]]) {
        const html = await page('/invoices?status=' + status);
        assert.deepEqual(listed(html), items.map(item => item.number).reverse(), status);
        const kind = status === 'all' ? 'invoices' : status + ' invoices';
        const sum = items.reduce((cents, item) => cents + item.total, 0);
        assert.match(html, new RegExp(`${items.length} ${kind}\\s+· ${money(sum).replace(/[.$]/g, '\\$&')}`), status);
        assert.equal((html.match(/<span class="tag">Paid<\/span>/g) ?? []).length, status === 'unpaid' ? 0
          : items.filter(item => item.paid).length, status);
        assert.equal((html.match(/<span class="tag">Unpaid<\/span>/g) ?? []).length, status === 'paid' ? 0
          : items.filter(item => !item.paid).length, status);
      }
      const gamma = expected.filter(item => item.name === 'Gamma Flats');
      assert.deepEqual(listed(await page('/invoices?status=paid&q=gamma')),
        gamma.filter(item => item.paid).map(item => item.number).reverse());
      assert.deepEqual(listed(await page('/invoices?status=unpaid&q=gamma')),
        gamma.filter(item => !item.paid).map(item => item.number).reverse());
    } finally {
      await server.close();
    }
  }));
});

describe('duplicate payments under load', () => {
  test('60 simultaneous requests from two dispatchers on one invoice record one payment', () => withDir(async dir => {
    const file = join(dir, 'burst.sqlite');
    const repository = openRepository(file, clock);
    const [invoice] = invoices(repository, 1);
    repository.close();
    const cookies = sessions(file);
    const server = await serve(file);
    try {
      // 30 identical double clicks from dispatcher A, and 30 different payments from dispatcher B.
      const requests = [
        ...Array.from({ length: 30 }, () => ({ cookie: cookies[0], fields: { paidOn: '2030-05-09', method: 'cash' } })),
        ...Array.from({ length: 30 }, (_, index) => ({ cookie: cookies[1],
          fields: { paidOn: shiftDay('2030-04-01', index), method: METHODS[index % 4] } })),
      ];
      const responses = await Promise.all(requests.map(({ cookie, fields }) =>
        server.post(`/invoices/${invoice.id}/payment`, cookie, fields)));
      const results = responses.map(response => response.status + ' ' + response.headers.get('location'));
      assert.deepEqual(results.filter(result => !/^(303|409) /.test(result)), [], 'only 303 and 409 responses');
      assert.equal(results.filter(result => result.endsWith('?payment=recorded')).length, 1);

      const payments = paymentRows(file);
      assert.equal(payments.length, 1);
      const [payment] = payments;
      assert.equal(payment.amount_cents, invoice.total);
      // Only requests identical to the winning one are treated as repeats; all others are refused.
      const winner = requests.findIndex((request, index) => results[index].endsWith('?payment=recorded'));
      const same = requests.filter(request => request.cookie === requests[winner].cookie
        && request.fields.paidOn === payment.paid_on && request.fields.method === payment.method).length;
      assert.equal(results.filter(result => result.endsWith('?payment=existing')).length, same - 1);
      assert.equal(results.filter(result => result.startsWith('409 ')).length, requests.length - same);
      assert.equal((await (await server.get('/invoices?status=paid', cookies[0])).text()).match(/INV-000001/g).length, 1);
    } finally {
      await server.close();
    }
  }));

  test('four app processes with ten simultaneous requests each record one payment', () => withDir(async dir => {
    const file = join(dir, 'processes.sqlite');
    const repository = openRepository(file, clock);
    const [invoice] = invoices(repository, 1);
    repository.close();
    const cookies = sessions(file);
    const startAt = Date.now() + 2500;
    // Each process sends ten identical requests; the processes differ in dispatcher and date.
    const scripts = Array.from({ length: 4 }, (_, child) => childServer(file, startAt, Array.from({ length: 10 }, () => ({
      path: `/invoices/${invoice.id}/payment`, cookie: cookies[child % 2],
      fields: { paidOn: shiftDay('2030-05-01', child), method: METHODS[child] },
    }))));
    const results = await children(scripts);
    const flat = results.flat();
    assert.deepEqual(flat.filter(result => !/^(303|409) /.test(result)), [], flat.join(' | '));
    assert.equal(flat.filter(result => result.endsWith('?payment=recorded')).length, 1, flat.join(' | '));
    // The winning process's other nine requests are repeats; every other process is refused ten times.
    const winner = results.findIndex(list => list.some(result => result.endsWith('?payment=recorded')));
    assert.deepEqual(results[winner].filter(result => result.endsWith('?payment=existing')).length, 9);
    for (const [index, list] of results.entries()) {
      if (index !== winner) assert.deepEqual(list.map(result => result.split(' ')[0]), Array(10).fill('409'));
    }
    const payments = paymentRows(file);
    assert.equal(payments.length, 1);
    assert.deepEqual([payments[0].paid_on, payments[0].method, payments[0].recorded_by],
      [shiftDay('2030-05-01', winner), METHODS[winner], DISPATCHERS[winner % 2].name]);
  }));

  test('eight processes paying eight different invoices at once all succeed', () => withDir(async dir => {
    const file = join(dir, 'many.sqlite');
    const repository = openRepository(file, clock);
    const items = invoices(repository, 10);
    repository.close();
    const cookies = sessions(file);
    const startAt = Date.now() + 2500;
    // Invoices 1-8 are each paid by one process (twice, as a double click). 9 and 10 stay unpaid.
    const scripts = items.slice(0, 8).map((item, child) => childServer(file, startAt, Array.from({ length: 2 }, () => ({
      path: `/invoices/${item.id}/payment`, cookie: cookies[child % 2],
      fields: { paidOn: '2030-05-10', method: METHODS[child % 4] },
    }))));
    const results = await children(scripts);
    for (const [child, list] of results.entries()) {
      assert.deepEqual(list.sort(), [`303 /invoices/${items[child].id}?payment=existing`,
        `303 /invoices/${items[child].id}?payment=recorded`], 'invoice ' + items[child].number);
    }
    const payments = paymentRows(file);
    assert.deepEqual(payments.map(row => row.invoice_id).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
    for (const row of payments) assert.equal(row.amount_cents, items[row.invoice_id - 1].total);
    const check = openRepository(file, clock);
    try {
      assert.deepEqual(check.invoices({ status: 'unpaid' }).map(row => row.number), ['INV-000010', 'INV-000009']);
      assert.equal(check.invoices({ status: 'paid' }).length, 8);
    } finally {
      check.close();
    }
  }));
});

describe('repeated and altered submissions', () => {
  test('25 repeats of the same payment and 25 different ones leave the first payment untouched', () =>
    withDir(async dir => {
      const file = join(dir, 'repeats.sqlite');
      const repository = openRepository(file, clock);
      const [invoice] = invoices(repository, 1);
      repository.close();
      const cookies = sessions(file);
      const server = await serve(file);
      try {
        const path = `/invoices/${invoice.id}/payment`;
        const first = await server.post(path, cookies[0], { paidOn: '2030-05-09', method: 'card' });
        assert.equal(first.headers.get('location'), `/invoices/${invoice.id}?payment=recorded`);
        const recorded = paymentRows(file);
        for (let attempt = 0; attempt < 25; attempt++) {
          const again = await server.post(path, cookies[0], { paidOn: '2030-05-09', method: 'card' });
          assert.equal(again.headers.get('location'), `/invoices/${invoice.id}?payment=existing`);
        }
        for (let attempt = 0; attempt < 25; attempt++) {
          const other = await server.post(path, cookies[attempt % 2], {
            paidOn: shiftDay('2030-05-01', attempt % 9), method: METHODS[attempt % 4] });
          const expected = attempt % 2 === 0 && attempt % 9 === 8 && METHODS[attempt % 4] === 'card' ? 303 : 409;
          assert.equal(other.status, expected, 'attempt ' + attempt);
        }
        assert.deepEqual(paymentRows(file), recorded);
      } finally {
        await server.close();
      }
    }));

  test('extra form fields cannot change the amount, the invoice, or who recorded the payment', () =>
    withDir(async dir => {
      const file = join(dir, 'tamper.sqlite');
      const repository = openRepository(file, clock);
      const [first, second] = invoices(repository, 2);
      repository.close();
      const cookies = sessions(file);
      const server = await serve(file);
      try {
        const response = await server.post(`/invoices/${first.id}/payment`, cookies[0], {
          paidOn: '2030-05-09', method: 'cash', amount: '1.00', amount_cents: '100', amountCents: '100',
          total_cents: '100', invoice_id: String(second.id), invoiceId: String(second.id),
          recorded_by: 'someone-else', recordedBy: 'someone-else', status: 'paid',
        });
        assert.equal(response.status, 303);
        const payments = paymentRows(file);
        assert.equal(payments.length, 1);
        assert.deepEqual([payments[0].invoice_id, payments[0].amount_cents, payments[0].recorded_by],
          [first.id, first.total, DISPATCHERS[0].name]);
        const check = openRepository(file, clock);
        try {
          assert.equal(check.invoice(second.id).status, 'unpaid');
          assert.equal(check.invoice(first.id).total_cents, first.total);
        } finally {
          check.close();
        }
      } finally {
        await server.close();
      }
    }));
});
