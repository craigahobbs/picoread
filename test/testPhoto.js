// Licensed under the MIT License
// https://github.com/craigahobbs/webbo/blob/main/LICENSE

import {JPEG_QUALITY, MAX_PHOTO_SIDE, TRANSFORMS, preparePhoto, transformPhoto} from '../lib/photo.js';
import {strict as assert} from 'node:assert';
import test from 'node:test';


// A window whose images are bitmaps of a size, and whose canvases record their drawing and encode to a blob (or null)
function photoWindow(width, height, blob) {
    const calls = [];
    return {
        calls,
        'createImageBitmap': (file) => Promise.resolve({file, width, height, 'close': () => calls.push('close')}),
        'document': {
            'createElement': (tag) => ({
                tag,
                'getContext': () => ({
                    'drawImage': (...args) => calls.push(['drawImage', args.slice(1)]),
                    'translate': (...args) => calls.push(['translate', args]),
                    'rotate': (angle) => calls.push(['rotate', angle]),
                    'scale': (...args) => calls.push(['scale', args])
                }),
                'toBlob'(callback, type, quality) {
                    calls.push(['toBlob', this.width, this.height, type, quality]);
                    callback(blob);
                }
            })
        }
    };
}


test('preparePhoto', async () => {
    // A large photo is scaled to MAX_PHOTO_SIDE
    const window = photoWindow(4000, 3000, 'jpeg');
    assert.equal(await preparePhoto(window, 'file'), 'jpeg');
    assert.deepEqual(window.calls, [
        ['drawImage', [0, 0, MAX_PHOTO_SIDE, 1800]],
        'close',
        ['toBlob', MAX_PHOTO_SIDE, 1800, 'image/jpeg', JPEG_QUALITY]
    ]);

    // A small photo isn't enlarged
    const small = photoWindow(800, 600, 'jpeg');
    await preparePhoto(small, 'file');
    assert.deepEqual(small.calls[0], ['drawImage', [0, 0, 800, 600]]);

    // The encoding fails
    await assert.rejects(preparePhoto(photoWindow(10, 10, null), 'file'), {'message': 'the photo could not be encoded'});
});


test('transformPhoto', async () => {
    // Each transform - the canvas's size and its drawing
    const expected = {
        'left': [[300, 400], [['translate', [0, 400]], ['rotate', -Math.PI / 2]]],
        'right': [[300, 400], [['translate', [300, 0]], ['rotate', Math.PI / 2]]],
        'horizontal': [[400, 300], [['translate', [400, 0]], ['scale', [-1, 1]]]],
        'vertical': [[400, 300], [['translate', [0, 300]], ['scale', [1, -1]]]]
    };
    assert.deepEqual(TRANSFORMS, Object.keys(expected));
    for (const [transform, [[width, height], drawing]] of Object.entries(expected)) {
        const window = photoWindow(400, 300, 'jpeg');
        assert.equal(await transformPhoto(window, 'blob', transform), 'jpeg');
        assert.deepEqual(window.calls, [...drawing, ['drawImage', [0, 0]], 'close', ['toBlob', width, height, 'image/jpeg', JPEG_QUALITY]]);
    }
});
