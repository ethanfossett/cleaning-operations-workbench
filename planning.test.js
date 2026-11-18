import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { planningFormValues } from './planning.js';
import { app } from './server.js';
import { sampleAccounts } from './staff.js';

test('dispatcher saves independent planning assumptions and reopens them after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ayc-planning-'));
  const file = join(dir, 'practice.sqlite');
  let server;
  let base;
  async function start(demo) {
    server = app(file, { staffFile: file, demo, accounts: demo ? sampleAccounts : [] })
      .listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = 'http://127.0.0.1:' + server.address().port;
  }
  const stop = () => new Promise(resolve => server.close(resolve));
  const send = (path, cookie, fields) => fetch(base + path, {
    redirect: 'manual',
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(fields ? { Origin: base } : {}) },
    ...(fields ? { method: 'POST', body: new URLSearchParams(fields) } : {}),
  });
  async function login(index) {
    const result = await send('/login', '', sampleAccounts[index]);
    assert.equal(result.status, 303);
    return result.headers.get('set-cookie').split(';')[0];
  }
  try {
    await start(true);
    const dispatch = await login(0);
    const cleaner = await login(1);
    const initialCustomers = await (await send('/customers', dispatch)).text();
    const initial = await (await send('/planning', dispatch)).text();
    assert.match(initial, /Sample baseline[\s\S]*Sample higher lead volume/);
    assert.equal((await send('/planning')).headers.get('location'), '/login');
    assert.equal((await send('/planning', cleaner)).status, 403);
    assert.equal((await send('/planning/new', cleaner, {})).status, 403);
    const values = { ...planningFormValues(), name: 'Sample < growth', leadCostCents: '12.35' };
    const invalid = await send('/planning/new', dispatch, { ...values, firstCleanPercent: '101' });
    assert.equal(invalid.status, 400);
    assert.match(await invalid.text(), /Sample &lt; growth/);
    assert.equal((await send('/planning/new', dispatch, { ...values, leadCostCents: '12.345' })).status, 400);
    const created = await send('/planning/new', dispatch, values);
    assert.equal(created.status, 303);
    const path = created.headers.get('location');
    assert.equal(path, '/planning/3');
    assert.equal((await send(path, dispatch, { ...values, monthlyLeads: '31' })).status, 303);
    assert.equal(await (await send('/customers', dispatch)).text(), initialCustomers);
    await stop();
    await start(false);
    const reopened = await (await send(path, await login(0))).text();
    assert.match(reopened, /Sample &lt; growth/);
    assert.match(reopened, /name="monthlyLeads"[\s\S]*?value="31"/);
    assert.match(reopened, /name="leadCostCents"[\s\S]*?value="12.35"/);
  } finally {
    if (server?.listening) await stop();
    await rm(dir, { recursive: true, force: true });
  }
});
