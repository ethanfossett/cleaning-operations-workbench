import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { app } from './server.js';
import { sampleAccounts } from './staff.js';

test('assigned cleaner and dispatcher take a returned closeout through approval and invoicing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ayc-closeout-'));
  const file = join(dir, 'test.sqlite');
  let server;
  let base;
  async function start(demo) {
    server = app(file, { staffFile: file, demo, accounts: demo ? sampleAccounts : [] }).listen(0, '127.0.0.1');
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
    const response = await send('/login', '', sampleAccounts[index]);
    assert.equal(response.status, 303);
    return response.headers.get('set-cookie').split(';')[0];
  }
  const day = '2030-05-06';
  const job = '/bookings/1';
  const cleanerPage = '/cleaner?day=' + day;
  const submit = '/cleaner/closeout';
  const review = job + '/review-closeout';
  const checks = { bookingId: 1, day, version: 2, scopeDone: 'yes', walkthrough: 'yes', secured: 'yes' };
  async function reviewForm(cookie) {
    const page = await (await send(job, cookie)).text();
    return { version: page.match(/name="version" value="(\d+)"/)[1],
      submissionId: page.match(/name="submissionId" value="(\d+)"/)[1] };
  }
  try {
    await start(true);
    const dispatch = await login(0);
    const cleaner = await login(1);
    const other = await login(2);
    assert.equal((await send(job + '/start', dispatch, { version: 1 })).status, 303);
    assert.match(await (await send(cleanerPage, cleaner)).text(), /Closeout checklist/);
    assert.doesNotMatch(await (await send(cleanerPage + '&crew=1', other)).text(), /Move-out cleaning/);
    assert.equal((await send(submit, other, checks)).status, 404);
    assert.equal((await send(submit, dispatch, checks)).status, 403);
    assert.equal((await send(submit, '', checks)).status, 401);
    assert.equal((await send(submit, cleaner, { ...checks, secured: '' })).status, 400);
    const repeated = await Promise.all([send(submit, cleaner, checks), send(submit, cleaner, checks)]);
    assert.deepEqual(repeated.map(r => r.status).sort(), [303, 409]);
    assert.match(await (await send('/today', dispatch)).text(), /Closeout awaiting review/);
    const first = await reviewForm(dispatch);
    assert.equal((await send(job + '/complete', dispatch, first)).status, 409);
    assert.equal((await send(job + '/invoice', dispatch, {})).status, 409);
    assert.equal((await send(review, cleaner, { ...first, decision: 'approved' })).status, 403);
    assert.equal((await send(review, dispatch, { ...first, decision: 'returned', detail: '   ' })).status, 400);
    assert.equal((await send(review, dispatch, { ...first, decision: 'returned', detail: 'Recheck the demo room.' })).status, 303);
    assert.match(await (await send(cleanerPage, cleaner)).text(), /Sent back: Recheck the demo room/);
    assert.match(await (await send('/today', dispatch)).text(), /Sent back to crew/);
    assert.equal((await send(submit, cleaner, { ...checks, version: 4, notes: 'Demo room checked again.' })).status, 303);
    const second = await reviewForm(dispatch);
    assert.equal((await send(review, dispatch, { ...first, version: second.version, decision: 'approved' })).status, 409);
    assert.equal((await send(review, dispatch, { ...second, decision: 'approved' })).status, 303);
    assert.doesNotMatch(await (await send('/today', dispatch)).text(), /Closeout awaiting review|Sent back to crew/);
    assert.match(await (await send('/today', dispatch)).text(), /Invoice needed/);
    assert.equal((await send(job + '/invoice', dispatch, {})).status, 303);
    assert.match(await (await send('/today', dispatch)).text(), /No closeouts or invoices need attention/);
    await stop();
    await start(false);
    const page = await (await send(job, await login(0))).text();
    assert.match(page, /Demo room checked again/);
    assert.match(page, /Recheck the demo room/);
    assert.match(page, /INV-000001/);
    assert.match(await (await send(cleanerPage, await login(1))).text(), /Closeout approved/);
  } finally {
    if (server?.listening) await stop();
    await rm(dir, { recursive: true, force: true });
  }
});
