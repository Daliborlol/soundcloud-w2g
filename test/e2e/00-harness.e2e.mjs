import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, createRoom, roomItems } from './harness.mjs';

test('harness: launches the extension and creates/joins a w2g room', { timeout: 180000 }, async () => {
  const b = await launch();
  try {
    assert.match(b.extensionId, /^[a-p]{32}$/);
    const { page, streamkey } = await createRoom(b.context);
    assert.match(streamkey, /^[a-z0-9]{10,32}$/);
    assert.deepEqual(await roomItems(page, streamkey), []);
  } finally {
    await b.close();
  }
});
