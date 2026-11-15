// Invoices and payments survive restarts of the real app. Each step starts `node server.js` in its own
// process, configured the way `npm start` is (AYC_DATABASE, AYC_DISPATCHER_PASSWORD, PORT), on a
// persistent database file with fictional data. The backup tool is checked the same way.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { test } from 'node:test';

const PASSWORD = 'fictional-dispatcher-pass';
const here = new URL('.', import.meta.url).pathname;

async function freePort() {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

// Starts `node server.js` as a separate process and waits until it is listening.
async function startApp(database) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--no-warnings', 'server.js'], {
    cwd: here, env: { ...process.env, AYC_DATABASE: database, AYC_DISPATCHER_PASSWORD: PASSWORD, PORT: String(port) },
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const deadline = Date.now() + 20000;
  while (!output.includes('Open http://')) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error('App did not start: ' + output);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const base = 'http://127.0.0.1:' + port;
  return {
    base,
    // 'SIGTERM' is an ordinary stop; 'SIGKILL' is a crash with no chance to clean up.
    stop: async (signal = 'SIGTERM') => {
      const exited = once(child, 'exit');
      child.kill(signal);
      await exited;
    },
  };
}

function client(base, cookie = '') {
  const state = { cookie };
  const request = async (path, fields) => {
    const response = await fetch(base + path, {
      redirect: 'manual',
      headers: { ...(state.cookie ? { Cookie: state.cookie } : {}), ...(fields ? { Origin: base } : {}) },
      ...(fields ? { method: 'POST', body: new URLSearchParams(fields) } : {}),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) state.cookie = setCookie.split(';')[0];
    return response;
  };
  return {
    state,
    get: path => request(path),
    post: request,
    location: async (path, fields) => (await request(path, fields)).headers.get('location'),
    page: async path => {
      const response = await request(path);
      assert.equal(response.status, 200, path);
      return response.text();
    },
    login: async () => assert.equal((await request('/login', { name: 'dispatcher', password: PASSWORD })).status, 303),
  };
}

const counts = file => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return { ...db.prepare(`SELECT (SELECT count(*) FROM invoices) AS invoices,
      (SELECT count(*) FROM invoice_lines) AS lines, (SELECT count(*) FROM invoice_payments) AS payments`).get() };
  } finally {
    db.close();
  }
};

test('invoices and payments survive stopping, crashing, and restoring the real app', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ayc-persistence-'));
  const database = join(dir, 'data', 'operations.sqlite');
  let app;
  try {
    // First run: fictional customer, accepted quote, two completed jobs, two invoices, one paid.
    app = await startApp(database);
    let web = client(app.base);
    await web.login();
    const customer = await web.location('/customers', { name: 'Fictional Fern Apartments', reference: 'Unit 12' });
    const quote = await web.location(customer + '/quotes', { title: 'Spring deep clean', service: 'deep',
      squareFeet: '1000', bathrooms: '2' });
    assert.match(await web.page(quote), /Revision 1 · \$206\.00/);
    assert.equal((await web.post(quote + '/decision', { revision: 1, outcome: 'accepted' })).status, 303);
    const plan = { date: '2030-05-06', start: '09:00', duration: '120', cadence: 'weekly', crewId: '1', action: 'confirm' };
    assert.equal((await web.post(quote + '/recurring', plan)).status, 303);
    for (const booking of ['/bookings/1', '/bookings/2']) {
      assert.equal((await web.post(booking + '/start', { version: 1 })).status, 303);
      assert.equal((await web.post(booking + '/complete', { version: 2, detail: 'Done' })).status, 303);
    }
    assert.equal(await web.location('/bookings/1/invoice', {}), '/invoices/1');
    assert.equal(await web.location('/bookings/2/invoice', {}), '/invoices/2');
    const today = /name="paidOn" required max="(\d{4}-\d{2}-\d{2})"/.exec(await web.page('/invoices/1'))[1];
    assert.equal(await web.location('/invoices/1/payment', { paidOn: today, method: 'check' }), '/invoices/1?payment=recorded');
    const before = { one: await web.page('/invoices/1'), two: await web.page('/invoices/2'),
      register: await web.page('/invoices'), customer: await web.page(customer) };
    assert.deepEqual(counts(database), { invoices: 2, lines: 4, payments: 1 });
    await app.stop('SIGTERM');

    // Second run: everything is still there, and the protections still apply.
    app = await startApp(database);
    web = client(app.base, web.state.cookie);
    assert.equal(await web.page('/invoices/1'), before.one, 'same invoice page, same session');
    assert.equal(await web.page('/invoices/2'), before.two);
    assert.equal(await web.page('/invoices'), before.register);
    assert.equal(await web.page(customer), before.customer);
    const paid = await web.page('/invoices/1');
    assert.match(paid, /<h1>Invoice INV-000001<\/h1>/);
    assert.match(paid, new RegExp(`<strong>Paid in full</strong> · \\$206\\.00\\s+· Check · received ${today}`));
    assert.match(paid, /Recorded by dispatcher/);
    assert.match(await web.page('/invoices?status=paid'), /1 paid invoice\s+· \$206\.00/);
    assert.match(await web.page('/invoices?status=unpaid'), /1 unpaid invoice\s+· \$206\.00/);
    assert.match(await web.page('/bookings/1'), /INV-000001<\/a>\s*· \$206\.00 · <span class="tag">Paid<\/span>/);
    assert.equal((await web.post('/invoices/1/payment', { paidOn: today, method: 'cash' })).status, 409);
    assert.equal(await web.location('/bookings/1/invoice', {}), '/invoices/1?existing=1');
    assert.deepEqual(counts(database), { invoices: 2, lines: 4, payments: 1 });

    // Pay the second invoice, then crash the app straight away.
    assert.equal(await web.location('/invoices/2/payment', { paidOn: today, method: 'bank_transfer' }),
      '/invoices/2?payment=recorded');
    await app.stop('SIGKILL');

    // Third run: the payment recorded just before the crash is there.
    app = await startApp(database);
    web = client(app.base, web.state.cookie);
    assert.match(await web.page('/invoices/2'), /<strong>Paid in full<\/strong> · \$206\.00\s+· Bank transfer/);
    assert.match(await web.page('/invoices?status=paid'), /2 paid invoices\s+· \$412\.00/);
    assert.match(await web.page('/invoices?status=unpaid'), /No unpaid invoices\./);
    assert.deepEqual(counts(database), { invoices: 2, lines: 4, payments: 2 });
    const final = { one: await web.page('/invoices/1'), two: await web.page('/invoices/2') };
    await app.stop();

    // Backup and restore with the documented commands, then run the app on the restored copy.
    const run = promisify(execFile);
    const backup = join(dir, 'data', 'backup.sqlite');
    const restored = join(dir, 'data', 'restored.sqlite');
    await run(process.execPath, ['--no-warnings', 'backup.js', database, backup], { cwd: here });
    await run(process.execPath, ['--no-warnings', 'backup.js', backup, restored], { cwd: here });
    assert.deepEqual(counts(restored), { invoices: 2, lines: 4, payments: 2 });
    app = await startApp(restored);
    web = client(app.base, web.state.cookie);
    assert.equal((await web.get('/invoices/1')).headers.get('location'), '/login', 'restored copies require sign-in');
    web = client(app.base);
    await web.login();
    assert.equal(await web.page('/invoices/1'), final.one);
    assert.equal(await web.page('/invoices/2'), final.two);
    assert.equal((await web.post('/invoices/2/payment', { paidOn: today, method: 'cash' })).status, 409);
    await app.stop();
    app = null;
  } finally {
    if (app) await app.stop('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});
