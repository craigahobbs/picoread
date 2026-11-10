// Licensed under the MIT License
// https://github.com/craigahobbs/picoread/blob/main/LICENSE

import {captureFrame, hasCamera, openCamera} from '../lib/camera.js';
import {JSDOM} from 'jsdom';
import {strict as assert} from 'node:assert';
import {setImmediate} from 'node:timers';
import test from 'node:test';


// Wait for pending promises
async function settle() {
    for (let ix = 0; ix < 5; ix++) {
        await new Promise((resolve) => {
            setImmediate(resolve);
        });
    }
}


// A window with a fake camera (its stream's tracks record their stops) and canvases that encode to a blob (or null)
function cameraWindow({fail = null, blob = 'jpeg'} = {}) {
    const {window} = new JSDOM('<!doctype html><body></body>');
    const stopped = [];
    const requests = [];
    const stream = {'getTracks': () => [{'stop': () => stopped.push('video')}]};
    Object.defineProperty(window.navigator, 'mediaDevices', {
        'value': {
            'getUserMedia': (constraints) => {
                requests.push(constraints);
                return fail === null ? Promise.resolve(stream) : Promise.reject(fail);
            }
        }
    });
    const createElement = window.document.createElement.bind(window.document);
    window.document.createElement = (tag) => {
        const node = createElement(tag);
        if (tag === 'canvas') {
            node.drawn = [];
            node.getContext = () => ({
                'drawImage': () => null,
                'translate': (...args) => {
                    node.drawn.push(['translate', ...args]);
                },
                'scale': (...args) => {
                    node.drawn.push(['scale', ...args]);
                }
            });
            node.toBlob = (callback, type, quality) => {
                const flips = node.drawn.map((call) => call.join(' ')).join(',');
                callback(blob === null ? null : `${blob}:${node.width}x${node.height}:${type}:${quality}${flips ? `:${flips}` : ''}`);
            };
        }
        return node;
    };
    return {window, stream, stopped, requests};
}


// The camera's callbacks - their photos, errors, and state (a failing photo, the closes)
function cameraCallbacks() {
    const photos = [];
    const errors = [];
    const state = {'failPhoto': false, 'closed': 0, 'mirrors': []};
    const callbacks = {
        'onMirror': (mirror) => state.mirrors.push(mirror),
        'onPhoto': (blob) => (state.failPhoto ? Promise.reject(new Error('full')) : Promise.resolve(photos.push(blob))),
        'onError': (error) => errors.push(error.message),
        'onClose': () => {
            state.closed += 1;
        }
    };
    return {callbacks, photos, errors, state};
}


test('hasCamera', () => {
    assert.equal(hasCamera(cameraWindow().window), true);
    assert.equal(hasCamera(new JSDOM('').window), false);
});


test('captureFrame', async () => {
    const {window} = cameraWindow();
    const video = {'videoWidth': 640, 'videoHeight': 480};
    assert.equal(await captureFrame(window, video), 'jpeg:640x480:image/jpeg:0.92');
    assert.equal(await captureFrame(window, video, true), 'jpeg:640x480:image/jpeg:0.92:translate 640 0,scale -1 1');
    await assert.rejects(captureFrame(cameraWindow({'blob': null}).window, video), {'message': 'the photo could not be encoded'});
});


test('openCamera', async () => {
    const {window, stream, stopped, requests} = cameraWindow();
    const {callbacks, photos, errors, state} = cameraCallbacks();
    const camera = await openCamera(window, callbacks);
    assert.equal(requests[0].video.facingMode.ideal, 'environment');
    const overlay = window.document.querySelector('.camera');
    const video = overlay.querySelector('video');
    assert.equal(video.srcObject, stream);
    assert.equal(video.muted, true);

    // Two photos - each added, counted
    const shutter = overlay.querySelector('.shutter');
    shutter.click();
    await settle();
    assert.equal(overlay.querySelector('.camera-count').textContent, '1 page added');
    shutter.click();
    await settle();
    assert.equal(overlay.querySelector('.camera-count').textContent, '2 pages added');
    assert.equal(photos.length, 2);
    assert.doesNotMatch(photos[0], /translate/);
    assert.equal(shutter.disabled, false);

    // Mirrored - the view flipped, and the photos
    const mirror = overlay.querySelector('.camera-mirror');
    assert.equal(mirror.getAttribute('aria-pressed'), 'false');
    mirror.click();
    assert.equal(mirror.getAttribute('aria-pressed'), 'true');
    assert.equal(video.style.transform, 'scaleX(-1)');
    assert.deepEqual(state.mirrors, [true]);
    shutter.click();
    await settle();
    assert.match(photos[2], /translate/);

    // A photo that can't be added
    state.failPhoto = true;
    shutter.click();
    await settle();
    assert.deepEqual(errors, ['full']);
    assert.equal(overlay.querySelector('.camera-count').textContent, '3 pages added');

    // Done - the camera stopped, the overlay gone
    overlay.querySelector('.camera-done').click();
    assert.deepEqual(stopped, ['video']);
    assert.equal(window.document.querySelector('.camera'), null);
    assert.equal(state.closed, 1);
    assert.equal(typeof camera.close, 'function');
});


test('openCamera, denied', async () => {
    const {window} = cameraWindow({'fail': new Error('Permission denied')});
    const {callbacks, errors} = cameraCallbacks();
    const camera = await openCamera(window, callbacks);
    assert.equal(camera, null);
    assert.deepEqual(errors, ['Permission denied']);
    assert.equal(window.document.querySelector('.camera'), null);
});


test('openCamera, mirrored at first', async () => {
    const {window} = cameraWindow();
    const {callbacks} = cameraCallbacks();
    await openCamera(window, {...callbacks, 'mirror': true});
    assert.equal(window.document.querySelector('.viewfinder').style.transform, 'scaleX(-1)');
    assert.equal(window.document.querySelector('.camera-mirror').getAttribute('aria-pressed'), 'true');
});
