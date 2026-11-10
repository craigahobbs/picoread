// Licensed under the MIT License
// https://github.com/craigahobbs/picoread/blob/main/LICENSE

import {strict as assert} from 'node:assert';
import test from 'node:test';


// The worker's scope - its posted messages
const posted = [];
globalThis.self = {'postMessage': (message) => posted.push(message)};

// A photo's pixels - a blob is {width, height, rects} (dark boxes on paper), or "bad" (it can't be decoded)
globalThis.createImageBitmap = (blob) => (
    blob === 'bad' ? Promise.reject(new Error('bad photo')) : Promise.resolve({...blob, 'close': () => null})
);
globalThis.OffscreenCanvas = class {
    constructor(width, height) {
        this.width = width;
        this.height = height;
        this.getContext = () => this.context();
    }

    // The canvas's 2-D context - the drawn bitmap's rects as dark pixels
    context() {
        let bitmap = null;
        return {
            'canvas': this,
            'drawImage': (image) => {
                bitmap = image;
            },
            'getImageData': (left, top, width, height) => {
                const data = new Uint8ClampedArray(width * height * 4).fill(230);
                for (const [rectLeft, rectTop, rectWidth, rectHeight] of bitmap.rects) {
                    for (let row = rectTop; row < rectTop + rectHeight; row++) {
                        data.fill(30, (row * width + rectLeft) * 4, (row * width + rectLeft + rectWidth) * 4);
                    }
                }
                return {width, height, data};
            }
        };
    }
};
await import('../lib/ocrworker.js');


test('ocrworker', async () => {
    // A page with a line of "characters" - its progress, then its text and confidence
    const rects = Array.from({'length': 12}, (_value, ix) => [30 + ix * 15, 50, 10, 20]);
    await globalThis.self.onmessage({'data': {'id': 'p1', 'blob': {'width': 300, 'height': 120, rects}}});
    assert.deepEqual(posted[0], {'id': 'p1', 'progress': 1});
    assert.equal(posted[1].id, 'p1');
    assert.equal(typeof posted[1].text, 'string');
    assert.ok(posted[1].confidence > 0 && posted[1].confidence <= 1);

    // A blank page - no lines
    posted.length = 0;
    await globalThis.self.onmessage({'data': {'id': 'p2', 'blob': {'width': 50, 'height': 50, 'rects': []}}});
    assert.deepEqual(posted, [{'id': 'p2', 'text': '', 'confidence': 0}]);

    // A photo that can't be decoded
    posted.length = 0;
    await globalThis.self.onmessage({'data': {'id': 'p3', 'blob': 'bad'}});
    assert.deepEqual(posted, [{'id': 'p3', 'error': 'bad photo'}]);
});
