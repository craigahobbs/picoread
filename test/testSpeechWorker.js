// Licensed under the MIT License
// https://github.com/craigahobbs/webbo/blob/main/LICENSE

import {strict as assert} from 'node:assert';
import test from 'node:test';


// The worker's scope - its posted messages and transfers
const posted = [];
globalThis.self = {'postMessage': (message, transfer) => posted.push({message, transfer})};
await import('../lib/speechworker.js');


test('speechworker', async () => {
    // A chunk - its blocks (copies, transferred), then its end
    await globalThis.self.onmessage({'data': {'id': 3, 'index': 2, 'text': 'Hello there.', 'voice': 'female', 'rate': 1}});
    const blocks = posted.filter(({message}) => message.block !== undefined);
    assert.ok(blocks.length > 0);
    for (const {message, transfer} of blocks) {
        assert.deepEqual([message.id, message.index], [3, 2]);
        assert.ok(message.block instanceof Float32Array);
        assert.deepEqual(transfer, [message.block.buffer]);
    }
    const samples = blocks.reduce((sum, {message}) => sum + message.block.length, 0);
    assert.ok(samples > 24000 * 0.3, `${samples} samples`);
    assert.deepEqual(posted.at(-1).message, {'id': 3, 'index': 2, 'done': true});

    // An unknown voice
    posted.length = 0;
    await globalThis.self.onmessage({'data': {'id': 4, 'index': 0, 'text': 'Hi.', 'voice': 'nobody', 'rate': 1}});
    assert.equal(posted.length, 1);
    assert.deepEqual([posted[0].message.id, posted[0].message.index], [4, 0]);
    assert.match(posted[0].message.error, /Unknown voice "nobody"/);
});
