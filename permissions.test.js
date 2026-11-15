// Permissions and edge cases for invoices and payments, checked by sending requests straight to the
// server the way someone bypassing the interface would. Every test also checks the database afterwards.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { app } from './server.js';
import { sampleAccounts } from './staff.js';

// 11:00 AM Eastern on Friday, May 10, 2030. The demo then seeds: booking 1 Move-out cleaning (May 6),
// 2 Unit A turnover (May 9), 3 Townhouse maintenance and 4 Condo deep clean (May 10),
// 5 Unit C preparation (May 11), 6 Guest suite cleaning (May 12), 7 Common area refresh (May 13).
const NOW = '2030-05-10T15:00:00.000Z';
const [DISPATCHER, CLEANER_A, CLEANER_B] = sampleAccounts;

function snapshot(file) {
  const db = new DatabaseSync(file);
  try {
    return JSON.stringify(['invoices', 'invoice_lines', 'invoice_payments', 'bookings', 'booking_events']
      .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  } finally {
    db.close();
  }
}

const count = (file, table) => {
  const db = new DatabaseSync(file);
  try {
    return db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  } finally {
    db.close();
  }
};

// Runs the demo with sign-in and a fixed clock, and passes helpers to `action`.
async function withDemo(action) {
  const dir = await mkdtemp(join(tmpdir(), 'ayc-permissions-'));
  const file = join(dir, 'demo.sqlite');
  const server = app(file, { staffFile: file, demo: true, accounts: sampleAccounts, now: () => new Date(NOW) })
    .listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const send = (method, path, cookie, fields) => fetch(base + path, {
    method, redirect: 'manual',
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method === 'GET' || method === 'HEAD' ? {} : { Origin: base }) },
    ...(fields ? { body: new URLSearchParams(fields) } : {}),
  });
  const login = async account => (await send('POST', '/login', '', account)).headers.get('set-cookie').split(';')[0];
  const dispatcher = await login(DISPATCHER);
  const post = (path, fields = {}) => send('POST', path, dispatcher, fields);
  const finish = async id => {
    assert.equal((await post(`/bookings/${id}/start`, { version: 1 })).status, 303);
    assert.equal((await post(`/bookings/${id}/complete`, { version: 2, detail: '' })).status, 303);
  };
  try {
    await action({ file, base, send, login, dispatcher, post, finish });
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

describe('cleaners cannot reach invoices or payments', () => {
  test('every invoice, payment, and billing page is refused, leaks nothing, and changes nothing', () =>
    withDemo(async ({ file, send, login, post, finish }) => {
      // INV-000001 (booking 1) unpaid, INV-000002 (booking 3) paid, booking 4 completed but not invoiced.
      await finish(1);
      await finish(3);
      await finish(4);
      assert.equal((await post('/bookings/1/invoice')).status, 303);
      assert.equal((await post('/bookings/3/invoice')).status, 303);
      assert.equal((await post('/invoices/2/payment', { paidOn: '2030-05-10', method: 'cash' })).status, 303);
      const before = snapshot(file);

      const payment = { paidOn: '2030-05-10', method: 'card' };
      const attempts = [
        ['GET', '/invoices'], ['GET', '/invoices?status=paid'], ['GET', '/invoices?status=unpaid&q=INV-000001'],
        ['GET', '/invoices/1'], ['GET', '/invoices/2'], ['GET', '/invoices/2?payment=recorded'],
        ['GET', '/invoices/999'], ['GET', '/invoices/1/payment'], ['GET', '/invoices/'], ['GET', '/Invoices/1'],
        ['GET', '/cleaner/../invoices/1'], ['GET', '/cleaner/%2E%2E/invoices/1'], ['GET', '/invoices%2F1'],
        ['GET', '/customers/1'], ['GET', '/customers/3'], ['GET', '/bookings/1'], ['GET', '/bookings/4'],
        ['GET', '/today'], ['GET', '/schedule?day=2030-05-06'], ['HEAD', '/invoices/1'],
        ['POST', '/invoices/1/payment', payment], ['POST', '/invoices/2/payment', payment],
        ['POST', '/invoices/999/payment', payment], ['POST', '/cleaner/../invoices/1/payment', payment],
        ['POST', '/bookings/4/invoice', {}], ['POST', '/bookings/1/invoice', {}], ['POST', '/bookings/5/invoice', {}],
        ['PUT', '/invoices/1/payment', payment], ['DELETE', '/invoices/1', {}], ['PATCH', '/invoices/1', payment],
      ];
      for (const account of [CLEANER_A, CLEANER_B]) {
        const cleaner = await login(account);
        const bodies = new Set();
        for (const [method, path, fields] of attempts) {
          const response = await send(method, path, cleaner, fields);
          const label = `${account.name} ${method} ${path}`;
          assert.equal(response.status, 403, label);
          const body = await response.text();
          if (method !== 'HEAD') {
            assert.match(body, /This page requires dispatcher access\./, label);
            assert.doesNotMatch(body, /INV-|\$\d|Record payment|Create invoice|Paid|Unpaid/, label);
            bodies.add(body);
          }
        }
        // The refusal is identical whether or not the invoice exists, so nothing can be learned from it.
        assert.equal(bodies.size, 1, account.name);
        // The cleaner's own page still works and shows no billing details.
        const own = await send('GET', '/cleaner?day=2030-05-11', cleaner);
        assert.equal(own.status, 200);
        assert.doesNotMatch(await own.text(), /INV-|\$\d|invoice|payment/i);
      }
      assert.equal(snapshot(file), before, 'cleaner requests changed nothing');

      // The same booking can still be invoiced by a dispatcher.
      assert.equal((await post('/bookings/4/invoice')).headers.get('location'), '/invoices/3');
    }));

  test('signed-out requests are sent to sign in and change nothing', () => withDemo(async ({ file, send, post, finish }) => {
    await finish(1);
    assert.equal((await post('/bookings/1/invoice')).status, 303);
    const before = snapshot(file);
    for (const path of ['/invoices', '/invoices/1', '/invoices?status=paid']) {
      const response = await send('GET', path, '');
      assert.deepEqual([response.status, response.headers.get('location')], [303, '/login'], path);
    }
    for (const path of ['/invoices/1/payment', '/bookings/1/invoice']) {
      const response = await send('POST', path, 'ayc_session=' + '0'.repeat(64), { paidOn: '2030-05-10', method: 'cash' });
      assert.equal(response.status, 401, path);
      assert.doesNotMatch(await response.text(), /INV-|\$\d/);
    }
    assert.equal(snapshot(file), before);
  }));
});

describe('only completed jobs can be invoiced, whatever the request', () => {
  test('scheduled, in-progress, cancelled, and stopped jobs are refused by the server', () =>
    withDemo(async ({ file, post, send, dispatcher }) => {
      const refused = async (booking, state) => {
        const response = await post(`/bookings/${booking}/invoice`);
        assert.equal(response.status, 409, `booking ${booking}`);
        const body = await response.text();
        assert.match(body, new RegExp(`Only completed jobs can be invoiced\\. This job is ${state}\\.`), `booking ${booking}`);
        assert.doesNotMatch(body, /action="\/bookings\/\d+\/invoice"/, 'no invoice button is offered');
      };
      await refused(3, 'still scheduled');
      assert.equal((await post('/bookings/6/start', { version: 1 })).status, 303);
      await refused(6, 'still in progress');
      assert.equal((await post('/bookings/4/cancel', { version: 1 })).status, 303);
      await refused(4, 'cancelled');
      assert.equal((await post('/bookings/2/start', { version: 1 })).status, 303);
      assert.equal((await post('/bookings/2/interrupt', { version: 2, detail: 'Customer not home' })).status, 303);
      await refused(2, 'cancelled');
      // Repeating the attempts, with made-up fields, changes nothing.
      for (const booking of [2, 3, 4, 6]) {
        const response = await post(`/bookings/${booking}/invoice`, { version: 99, state: 'completed', job_state: 'completed' });
        assert.equal(response.status, 409);
      }
      assert.equal(count(file, 'invoices'), 0);
      // A GET never creates an invoice.
      assert.equal((await send('GET', '/bookings/3/invoice', dispatcher)).status, 404);
      assert.equal(count(file, 'invoices'), 0);
    }));

  test('recurring visits follow the same rule, one invoice per completed visit', () =>
    withDemo(async ({ file, post, finish }) => {
      // Four weekly visits for the accepted move-out quote (revision 2, $330.00): bookings 8-11.
      const plan = { date: '2030-06-03', start: '09:00', duration: '120', cadence: 'weekly', crewId: '1' };
      assert.equal((await post('/quotes/1/recurring', { ...plan, action: 'confirm' })).status, 303);
      await finish(8);
      assert.equal((await post('/bookings/9/cancel', { version: 1 })).status, 303);
      assert.equal((await post('/bookings/10/start', { version: 1 })).status, 303);
      assert.equal((await post('/bookings/10/interrupt', { version: 2, detail: 'Stopped' })).status, 303);
      for (const [booking, state] of [[9, 'cancelled'], [10, 'cancelled'], [11, 'still scheduled']]) {
        const response = await post(`/bookings/${booking}/invoice`);
        assert.equal(response.status, 409, `visit ${booking}`);
        assert.match(await response.text(), new RegExp(`This job is ${state}\\.`));
      }
      assert.equal((await post('/bookings/8/invoice')).headers.get('location'), '/invoices/1');
      assert.equal(count(file, 'invoices'), 1);
    }));

  test('a completed, invoiced job cannot be cancelled, stopped, moved, or completed again', () =>
    withDemo(async ({ file, post, finish }) => {
      await finish(1);
      assert.equal((await post('/bookings/1/invoice')).status, 303);
      assert.equal((await post('/invoices/1/payment', { paidOn: '2030-05-10', method: 'check' })).status, 303);
      const before = snapshot(file);
      for (const [action, fields] of [
        ['cancel', { version: 3 }], ['interrupt', { version: 3, detail: 'Undo' }],
        ['reschedule', { version: 3, crewId: 1, date: '2030-05-20', start: '09:00', duration: 120 }],
        ['start', { version: 3 }], ['complete', { version: 3, detail: 'Again' }],
        ['cancel', { version: 1 }], ['cancel', { version: 2 }],
      ]) {
        assert.equal((await post(`/bookings/1/${action}`, fields)).status, 409, `${action} v${fields.version}`);
      }
      assert.equal(snapshot(file), before);
    }));

  test('missing, malformed, and out-of-range ids are a plain “not found”', () => withDemo(async ({ file, post, send, dispatcher }) => {
    const before = snapshot(file);
    for (const id of ['0', '999', '99999999999999999999', '-1', 'abc', '1.5', '1e3', '%31']) {
      assert.equal((await post(`/bookings/${id}/invoice`)).status, 404, 'booking ' + id);
      assert.equal((await post(`/invoices/${id}/payment`, { paidOn: '2030-05-10', method: 'cash' })).status, 404, 'pay ' + id);
      assert.equal((await send('GET', `/invoices/${id}`, dispatcher)).status, 404, 'invoice ' + id);
    }
    assert.equal(snapshot(file), before);
  }));
});
