import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createGroupRefreshScheduler } from '../src/groupMetadataRefresh.js';

test('Group refresh scheduler debounces per JID and can be cleared', async () => {
  let calls = [];
  const scheduler = createGroupRefreshScheduler({
    refreshFn: async (jid) => calls.push(jid),
    delayMs: 20,
  });

  scheduler.schedule('abc');
  scheduler.schedule('abc'); 
  scheduler.schedule('def');
  assert.equal(calls.length, 0);

  await delay(30);
  assert.deepEqual(calls.sort(), ['abc', 'def']);

  calls = [];
  scheduler.schedule('xyz');
  scheduler.clearAll(); 
  await delay(30);
  assert.equal(calls.length, 0);
});
