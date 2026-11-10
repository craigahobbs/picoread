// Licensed under the MIT License
// https://github.com/craigahobbs/webbo/blob/main/LICENSE

import {RATES, element, main, statusText} from '../lib/app.js';
import {fakeIndexedDB, fakeReader, fakeStorage} from './helpers.js';
import {JSDOM} from 'jsdom';
import {strict as assert} from 'node:assert';
import {readFileSync} from 'node:fs';
import {setImmediate} from 'node:timers';
import test from 'node:test';


// The page
const indexHtml = readFileSync(new URL('../static/index.html', import.meta.url), 'utf8').replace(/<script[\s\S]*?<\/script>/, '');


// Wait for the app's pending promises and tasks
async function settle() {
    for (let ix = 0; ix < 10; ix++) {
        await new Promise((resolve) => {
            setImmediate(resolve);
        });
    }
}


// A started app and its fakes - options: documents and settings (localStorage), voices, confirm (its answer), the
// photo store's photos {pageId: blob}, and a preparePhoto that fails for a file "bad"
function setup(options = {}) {
    const dom = new JSDOM(indexHtml, {'url': 'https://example.com/webbo/'});
    const {window} = dom;
    if (options.documents !== undefined) {
        window.localStorage.setItem('webbo-documents-v1', JSON.stringify(options.documents));
    }
    if (options.settings !== undefined) {
        window.localStorage.setItem('webbo-settings-v1', options.settings);
    }
    const reader = fakeReader(options.voices);
    window.confirm = () => options.confirm ?? true;
    const copied = [];
    Object.defineProperty(window.navigator, 'clipboard', {'value': {'writeText': (text) => Promise.resolve(copied.push(text))}});
    let urls = 0;
    const revoked = [];
    window.URL.createObjectURL = (blob) => {
        urls += 1;
        return `blob:${blob}`;
    };
    window.URL.revokeObjectURL = (url) => revoked.push(url);

    // The fakes
    const photos = new Map(Object.entries(options.photos ?? {}));
    const removed = [];
    const workers = [];
    const downloads = [];
    const overrides = {
        'images': Promise.resolve({
            'get': (id) => Promise.resolve(photos.get(id)),
            'put': (id, blob) => Promise.resolve(photos.set(id, blob)),
            'remove': (id) => Promise.resolve(removed.push(id))
        }),
        'createWorker': () => {
            const worker = {
                'posted': [], 'terminated': false, 'onmessage': null,
                'postMessage': (message) => worker.posted.push(message),
                'terminate': () => {
                    worker.terminated = true;
                }
            };
            workers.push(worker);
            return worker;
        },
        'preparePhoto': (file) => (file === 'bad' ? Promise.reject(new Error('unreadable')) : Promise.resolve(`jpeg:${file}`)),
        'transformPhoto': (blob, transform) => (
            blob === 'unturnable' ? Promise.reject(new Error('broken')) : Promise.resolve(`${blob}+${transform}`)
        ),
        'createReader': (callbacks) => {
            reader.callbacks = callbacks;
            return reader;
        },
        'download': (name, text) => downloads.push([name, text])
    };
    const app = main(window, overrides);
    return {
        window, app, reader, photos, removed, workers, downloads, copied, revoked,
        'urls': () => urls,
        'query': (selector) => window.document.querySelector(selector),
        'queryAll': (selector) => Array.from(window.document.querySelectorAll(selector))
    };
}


// A document of pages - texts as page ids p0, p1, ...
function testDocument(texts, status = 'done') {
    return {'id': 'd1', 'title': 'Letter', 'created': 0, 'updated': 0, 'pages': texts.map((text, ix) => ({'id': `p${ix}`, text, status}))};
}


test('element', () => {
    const {window} = new JSDOM('');
    let clicked = false;
    const node = element(window.document, 'button', {
        'class': 'big', 'aria-label': 'Go', 'data-x': '1', 'disabled': true, 'onclick': () => {
            clicked = true;
        }
    }, 'Go', null);
    assert.equal(node.outerHTML, '<button class="big" aria-label="Go" data-x="1" disabled="">Go</button>');
    node.disabled = false;
    node.click();
    assert.equal(clicked, true);
});


test('statusText', () => {
    assert.equal(statusText({'status': 'pending'}), 'Waiting to read…');
    assert.equal(statusText({'status': 'pending'}, 0.456), 'Reading… 46%');
    assert.equal(statusText({'status': 'error'}), 'Could not read this page');
    assert.equal(statusText({'status': 'done', 'text': ''}), 'No text found');
    assert.equal(statusText({'status': 'done', 'text': 'Hi'}), '');
});


test('library', () => {
    const {window, query, queryAll} = setup();
    assert.equal(query('h1').textContent, 'Webbo');
    assert.match(query('.empty').textContent, /No documents yet/);
    assert.equal(query('#app').textContent.includes('null'), false);

    // A new document opens
    query('.new').click();
    assert.equal(query('.doc-title').value, 'Document 1');
    assert.match(query('.empty').textContent, /No pages yet/);
    assert.equal(query('.play').disabled, true);

    // Its title, changed (a blank title is kept)
    query('.doc-title').value = ' Recipe ';
    query('.doc-title').dispatchEvent(new window.Event('change'));
    query('.doc-title').value = ' ';
    query('.doc-title').dispatchEvent(new window.Event('change'));

    // Back to the library
    query('.back').click();
    assert.deepEqual(queryAll('.documents .title').map((title) => title.textContent), ['Recipe']);
    assert.match(query('.documents small').textContent, /^0 pages · /);
    assert.equal(JSON.parse(window.sessionStorage.getItem('webbo-session-v1')).documentId, null);

    // Open it again
    query('.documents .open').click();
    assert.equal(query('.doc-title').value, 'Recipe');
});


test('delete document', async () => {
    const {query, queryAll, removed} = setup({'documents': [testDocument(['a', 'b'])]});
    assert.match(query('.documents small').textContent, /^2 pages/);
    query('.documents .delete').click();
    await settle();
    assert.equal(queryAll('.documents li').length, 0);
    assert.deepEqual(removed, ['p0', 'p1']);

    // Not confirmed
    const declined = setup({'documents': [testDocument(['a'])], 'confirm': false});
    declined.query('.documents .delete').click();
    await settle();
    assert.equal(declined.queryAll('.documents li').length, 1);
    assert.match(declined.query('.documents small').textContent, /^1 page ·/);
});


test('add photos and recognize', async () => {
    const {window, query, queryAll, workers, photos, urls} = setup();
    query('.new').click();

    // Two photos chosen - each stored and queued; the first sent to the worker
    const [camera, input] = queryAll('.add input');
    assert.equal(input.multiple, true);
    Object.defineProperty(input, 'files', {'value': ['one', 'two']});
    input.dispatchEvent(new window.Event('change'));
    await settle();
    assert.equal(queryAll('.page').length, 2);
    assert.equal(photos.size, 2);
    assert.equal(workers.length, 1);
    const [worker] = workers;
    assert.equal(worker.posted.length, 1);
    const [first] = worker.posted;
    assert.equal(first.blob, 'jpeg:one');
    assert.deepEqual(queryAll('.status').map((status) => status.textContent), ['Waiting to read…', 'Waiting to read…']);
    assert.equal(queryAll('.text')[0].disabled, true);
    assert.equal(queryAll('.thumbnail')[0].src, 'blob:jpeg:one');

    // Progress, then the text - the second page sent
    worker.onmessage({'data': {'id': first.id, 'progress': 0.5}});
    assert.equal(queryAll('.status')[0].textContent, 'Reading… 50%');
    worker.onmessage({'data': {'id': first.id, 'text': 'Hello there.', 'confidence': 0.9}});
    assert.equal(queryAll('.text')[0].value, 'Hello there.');
    assert.equal(queryAll('.status')[0].textContent, '');
    await settle();
    assert.equal(worker.posted.length, 2);
    assert.equal(urls(), 2);

    // The second page fails
    worker.onmessage({'data': {'id': worker.posted[1].id, 'error': 'oops'}});
    assert.equal(queryAll('.status')[1].textContent, 'Could not read this page');

    // Read again
    queryAll('.retry')[1].click();
    await settle();
    assert.equal(worker.posted.length, 3);
    assert.equal(queryAll('.status')[1].textContent, 'Waiting to read…');

    // A progress or result for a page since deleted is ignored
    worker.onmessage({'data': {'id': 'gone', 'progress': 0.5}});
    worker.onmessage({'data': {'id': 'gone', 'text': 'x'}});

    // The camera input takes one photo; a photo that can't be read
    assert.equal(camera.getAttribute('capture'), 'environment');
    Object.defineProperty(camera, 'files', {'value': ['bad']});
    camera.dispatchEvent(new window.Event('change'));
    await settle();
    assert.equal(query('.message').textContent, 'Could not add the photo: unreadable');
});


test('a queued page deleted', async () => {
    // Two pending pages - the first sent; the second deleted while it waits, so it's skipped
    const {query, queryAll, workers} = setup({'documents': [testDocument(['', ''], 'pending')], 'photos': {'p0': 'a', 'p1': 'b'}});
    query('.documents .open').click();
    await settle();
    queryAll('.page .delete')[1].click();
    await settle();
    const [worker] = workers;
    worker.onmessage({'data': {'id': 'p0', 'text': 'Done.'}});
    await settle();
    assert.equal(worker.posted.length, 1);
    assert.deepEqual(queryAll('.text').map((text) => text.value), ['Done.']);
});


test('startup recognizes pending pages', async () => {
    // A pending page whose photo is missing fails; a pending page with its photo is sent
    const doc = testDocument(['', ''], 'pending');
    const {workers, queryAll} = setup({'documents': [doc], 'photos': {'p1': 'jpeg'}});
    await settle();
    assert.equal(workers.length, 1);
    assert.deepEqual(workers[0].posted, [{'id': 'p1', 'blob': 'jpeg'}]);
    assert.equal(queryAll('.documents li').length, 1);
});


test('page actions', async () => {
    const {window, query, queryAll, removed, urls} = setup({'documents': [testDocument(['one', 'two', 'three'])], 'photos': {'p0': 'a'}});
    query('.documents .open').click();
    await settle();
    assert.equal(queryAll('.up')[0].disabled, true);
    assert.equal(queryAll('.down')[2].disabled, true);

    // Move pages
    queryAll('.down')[0].click();
    assert.deepEqual(queryAll('.text').map((text) => text.value), ['two', 'one', 'three']);
    queryAll('.up')[2].click();
    assert.deepEqual(queryAll('.text').map((text) => text.value), ['two', 'three', 'one']);

    // The thumbnail is made once
    await settle();
    assert.equal(queryAll('.thumbnail')[2].src, 'blob:a');
    assert.equal(urls(), 1);

    // The photo viewed - fitted, then zoomed (and back), closed by Escape; then by its button
    queryAll('.photo')[2].click();
    await settle();
    const viewer = query('.viewer');
    assert.equal(viewer.getAttribute('aria-label'), 'Page 3 photo');
    const image = viewer.querySelector('.viewer-image');
    assert.equal(image.src, 'blob:a');
    image.click();
    assert.equal(viewer.querySelector('.viewer-frame').classList.contains('zoomed'), true);
    image.click();

    // Zoomed at a point - scrolled to center it (the sizes as laid out)
    const frame = viewer.querySelector('.viewer-frame');
    for (const [node, width, height] of [[image, 2000, 1000], [frame, 400, 300]]) {
        Object.defineProperty(node, 'clientWidth', {'value': width, 'configurable': true});
        Object.defineProperty(node, 'clientHeight', {'value': height, 'configurable': true});
    }
    const tap = new window.MouseEvent('click');
    Object.defineProperty(tap, 'offsetX', {'value': 500});
    Object.defineProperty(tap, 'offsetY', {'value': 250});
    image.dispatchEvent(tap);
    assert.equal(frame.scrollLeft, 500 - 200);
    assert.equal(frame.scrollTop, 250 - 150);
    image.click();
    assert.equal(viewer.querySelector('.viewer-frame').classList.contains('zoomed'), false);
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', {'key': 'Enter'}));
    assert.notEqual(query('.viewer'), null);
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', {'key': 'Escape'}));
    assert.equal(query('.viewer'), null);
    queryAll('.photo')[2].click();
    await settle();
    query('.viewer-close').click();
    assert.equal(query('.viewer'), null);

    // A page without a photo - no viewer
    queryAll('.photo')[0].click();
    await settle();
    assert.equal(query('.viewer'), null);

    // Edit a page's text
    queryAll('.text')[0].value = 'TWO';
    queryAll('.text')[0].dispatchEvent(new window.Event('input'));
    assert.equal(JSON.parse(window.localStorage.getItem('webbo-documents-v1'))[0].pages[0].text, 'TWO');

    // Delete a page
    queryAll('.page .delete')[1].click();
    await settle();
    assert.deepEqual(queryAll('.text').map((text) => text.value), ['TWO', 'one']);
    assert.deepEqual(removed, ['p2']);
});


test('copy, save, and declined delete', async () => {
    const {query, queryAll, copied, downloads} = setup({'documents': [testDocument(['a\nb', 'c'])], 'confirm': false});
    query('.documents .open').click();
    query('.copy').click();
    query('.save').click();
    await settle();
    assert.deepEqual(copied, ['a b\n\nc']);
    assert.deepEqual(downloads, [['Letter.txt', 'a b\n\nc']]);
    queryAll('.page .delete')[0].click();
    assert.equal(queryAll('.page').length, 2);
});


test('reading aloud', () => {
    const {window, query, queryAll, reader} = setup({
        'documents': [testDocument(['One. Two.', 'Three.'])], 'settings': '{"rate": 1.25, "voice": "not-a-voice"}'
    });
    query('.documents .open').click();
    assert.equal(query('.rate').value, '1.25');
    assert.deepEqual(queryAll('.voice option').map((option) => [option.value, option.textContent, option.title]), [
        ['male', 'Male', 'Warm'], ['female', 'Female', 'Bright']
    ]);

    // Play - the reader's default voice (the setting's isn't one), the first chunk, its page marked
    query('.play').click();
    assert.deepEqual(reader.plays[0], {'texts': ['One.', 'Two.', 'Three.'], 'start': 0, 'settings': {'voice': 'male', 'rate': 1.25}});
    assert.equal(query('.play').textContent, 'Pause');
    assert.equal(query('.now-reading').textContent, 'One.');
    assert.deepEqual(queryAll('.page').map((page) => page.classList.contains('reading')), [true, false]);

    // The next chunk
    reader.advance(1);
    assert.equal(query('.now-reading').textContent, 'Two.');
    assert.equal(JSON.parse(window.sessionStorage.getItem('webbo-session-v1')).chunk, 1);

    // A new voice - it plays on from the chunk
    query('.voice').value = 'female';
    query('.voice').dispatchEvent(new window.Event('change'));
    assert.deepEqual(reader.plays[1], {'texts': ['One.', 'Two.', 'Three.'], 'start': 1, 'settings': {'voice': 'female', 'rate': 1.25}});
    assert.equal(JSON.parse(window.localStorage.getItem('webbo-settings-v1')).voice, 'female');

    // Pause - the sentence still shown - then resume (no new playback)
    query('.play').click();
    assert.equal(reader.isPaused(), true);
    assert.equal(query('.play').textContent, 'Play');
    assert.equal(query('.now-reading').textContent, 'Two.');
    query('.play').click();
    assert.equal(reader.isPlaying(), true);
    assert.equal(query('.play').textContent, 'Pause');
    assert.equal(reader.plays.length, 2);

    // Paused, the speed changed - stopped at the sentence (not played)
    query('.play').click();
    query('.rate').value = '1.5';
    query('.rate').dispatchEvent(new window.Event('change'));
    assert.equal(reader.isPaused(), false);
    assert.equal(reader.isPlaying(), false);
    assert.equal(query('.now-reading').textContent, '');
    query('.play').click();
    assert.deepEqual(reader.plays[2], {'texts': ['One.', 'Two.', 'Three.'], 'start': 1, 'settings': {'voice': 'female', 'rate': 1.5}});

    // Read from page 2, to the end
    queryAll('.read')[1].click();
    assert.equal(reader.plays[3].start, 2);
    assert.deepEqual(queryAll('.page').map((page) => page.classList.contains('reading')), [false, true]);
    reader.end();
    assert.equal(query('.play').textContent, 'Play');
    assert.equal(JSON.parse(window.sessionStorage.getItem('webbo-session-v1')).chunk, 0);

    // The speed changed while stopped, then from the start
    query('.rate').value = '2';
    query('.rate').dispatchEvent(new window.Event('change'));
    assert.equal(reader.plays.length, 4);
    query('.restart').click();
    assert.deepEqual(reader.plays[4], {'texts': ['One.', 'Two.', 'Three.'], 'start': 0, 'settings': {'voice': 'female', 'rate': 2}});
    assert.ok(RATES.includes(2));

    // Leaving the document stops the reading
    query('.back').click();
    assert.equal(reader.playing, false);
});


test('reading a document without text', () => {
    const {query, queryAll, reader} = setup({'documents': [testDocument(['', ''])]});
    query('.documents .open').click();
    query('.play').click();
    queryAll('.read')[1].click();
    assert.equal(reader.plays.length, 0);
    assert.equal(query('.play').textContent, 'Play');
});


test('storage unavailable', () => {
    const dom = new JSDOM(indexHtml, {'url': 'https://example.com/webbo/'});
    const {window} = dom;
    const failing = fakeStorage(true);
    Object.defineProperty(window, 'localStorage', {'value': failing});
    Object.defineProperty(window, 'sessionStorage', {'value': failing});
    const app = main(window, {'images': Promise.resolve({})});
    window.document.querySelector('.new').click();
    assert.equal(window.document.querySelector('.message').textContent, 'Your browser could not save this change.');

    // The settings can't be saved - they last the session
    const rate = window.document.querySelector('.rate');
    rate.value = '1.5';
    rate.dispatchEvent(new window.Event('change'));
    assert.equal(app.settings().rate, 1.5);
});


test('corrupt settings', () => {
    const {app} = setup({'settings': 'not JSON'});
    assert.deepEqual(app.settings(), {'voice': null, 'rate': 1});
});


test('default services', async () => {
    const dom = new JSDOM(indexHtml, {'url': 'https://example.com/webbo/'});
    const {window} = dom;
    window.indexedDB = fakeIndexedDB();
    const workers = [];
    const instances = [];
    window.Worker = class {
        constructor(url, options) {
            workers.push([String(url), options]);
            instances.push(this);
            this.postMessage = () => null;
        }
    };
    const contexts = [];
    window.AudioContext = class {
        constructor(options) {
            contexts.push(options);
            this.currentTime = 0;
        }

        suspend() {
            this.suspended = true;
        }

        resume() {
            this.suspended = false;
        }

        createBuffer(channels, length) {
            this.buffers = (this.buffers ?? 0) + 1;
            return {channels, length};
        }

        createBufferSource() {
            return {'connect': () => null, 'start': () => {
                this.unlocked = true;
            }};
        }

        close() {
            this.closed = true;
        }
    };
    window.createImageBitmap = () => Promise.resolve({'width': 10, 'height': 10, 'close': () => null});
    const createElement = window.document.createElement.bind(window.document);
    window.document.createElement = (tag) => {
        const node = createElement(tag);
        if (tag === 'canvas') {
            node.getContext = () => ({'drawImage': () => null, 'translate': () => null, 'rotate': () => null});
            node.toBlob = (callback) => callback('jpeg');
        }
        return node;
    };
    const clicks = [];
    window.HTMLAnchorElement.prototype.click = function click() {
        clicks.push([this.download, this.href]);
    };
    window.URL.createObjectURL = () => 'blob:text';
    window.URL.revokeObjectURL = () => null;

    Object.defineProperty(window.navigator, 'mediaDevices', {'value': {'getUserMedia': () => Promise.reject(new Error('no camera'))}});

    const app = main(window);
    window.document.querySelector('.new').click();

    // The camera - it can't start
    window.document.querySelector('.take-photos').click();
    await settle();
    assert.equal(window.document.querySelector('.message').textContent, 'The camera couldn\'t take a photo: no camera');

    await app.addPhotos(['photo']);
    await settle();
    assert.equal(workers.length, 1);
    assert.match(workers[0][0], /\/lib\/ocrworker\.js$/);
    assert.deepEqual(workers[0][1], {'type': 'module'});
    assert.equal(app.documents[0].pages.length, 1);

    // Read, then the photo turned
    instances[0].onmessage({'data': {'id': app.documents[0].pages[0].id, 'text': ''}});
    window.document.querySelector('.adjust.right').click();
    await settle();
    assert.doesNotMatch(window.document.querySelector('.message').textContent, /Could not turn/);
    assert.equal(app.documents[0].pages[0].status, 'pending');

    // The text saved as a file
    window.document.querySelector('.save').click();
    assert.deepEqual(clicks, [['Document 1.txt', 'blob:text']]);

    // Reading aloud - the speech worker, and an audio context at PicoVox's rate
    app.documents[0].pages[0].text = 'Hello there.';
    window.document.querySelector('.play').click();
    assert.match(workers[1][0], /\/lib\/speechworker\.js$/);
    assert.deepEqual(contexts, [{'sampleRate': 24000}]);

    // Paused, then the document left - the reading stopped
    window.document.querySelector('.play').click();
    assert.equal(window.document.querySelector('.play').textContent, 'Play');
    window.document.querySelector('.back').click();
    assert.equal(window.document.querySelector('.play'), null);
});


test('no IndexedDB - photos in memory', async () => {
    const dom = new JSDOM(indexHtml, {'url': 'https://example.com/webbo/'});
    const {window} = dom;
    window.URL.createObjectURL = (blob) => `blob:${blob}`;
    const app = main(window, {'createWorker': () => ({'postMessage': () => null}), 'preparePhoto': () => Promise.resolve('jpeg')});
    window.document.querySelector('.new').click();
    await app.addPhotos(['photo']);
    await settle();
    assert.equal(app.documents[0].pages.length, 1);
    assert.match(window.document.querySelector('.message').textContent, /last only until this page closes/);
    assert.equal(window.document.querySelector('.thumbnail').src, 'blob:jpeg');
});


test('take photos with the camera', async () => {
    const dom = new JSDOM(indexHtml, {'url': 'https://example.com/webbo/'});
    const {window} = dom;
    window.URL.createObjectURL = (blob) => `blob:${blob}`;
    const photos = new Map();
    const cameras = [];
    const app = main(window, {
        'images': Promise.resolve({
            'get': (id) => Promise.resolve(photos.get(id)),
            'put': (id, blob) => Promise.resolve(photos.set(id, blob))
        }),
        'createWorker': () => ({'postMessage': () => null}),
        'preparePhoto': (blob) => Promise.resolve(`jpeg:${blob}`),
        'openCamera': (callbacks) => {
            const camera = {callbacks, 'closed': 0, 'close': () => {
                camera.closed += 1;
                callbacks.onClose();
            }};
            cameras.push(camera);
            return Promise.resolve(camera);
        }
    });
    window.document.querySelector('.new').click();

    // The camera's button (not a file input) - each photo a page
    assert.equal(window.document.querySelectorAll('.add input').length, 1);
    window.document.querySelector('.take-photos').click();
    await settle();
    const [camera] = cameras;

    // Mirrored - remembered for the next time it opens
    assert.equal(camera.callbacks.mirror, false);
    camera.callbacks.onMirror(true);
    assert.equal(app.settings().mirror, true);
    await camera.callbacks.onPhoto('frame1');
    await camera.callbacks.onPhoto('frame2');
    assert.equal(app.documents[0].pages.length, 2);
    assert.equal(photos.get(app.documents[0].pages[1].id), 'jpeg:frame2');

    // An error is shown
    camera.callbacks.onError(new Error('Permission denied'));
    assert.equal(window.document.querySelector('.message').textContent, 'The camera couldn\'t take a photo: Permission denied');

    // Leaving the document closes the camera (once - it's closed after)
    window.document.querySelector('.back').click();
    assert.equal(camera.closed, 1);
    window.document.querySelector('.documents .open').click();
    window.document.querySelector('.take-photos').click();
    await settle();
    assert.equal(cameras[1].callbacks.mirror, true);
    window.document.querySelector('.back').click();
    assert.equal(camera.closed, 1);
});


test('turn and flip a page', async () => {
    const {query, queryAll, photos, workers, revoked} = setup({
        'documents': [testDocument(['one', 'two'])], 'photos': {'p0': 'a', 'p1': 'unturnable'}
    });
    query('.documents .open').click();
    await settle();
    assert.equal(queryAll('.page')[0].querySelectorAll('.adjust').length, 4);

    // Rotated right - the photo turned, its thumbnail made again, the page read again
    queryAll('.adjust.right')[0].click();
    await settle();
    assert.equal(photos.get('p0'), 'a+right');
    assert.deepEqual(revoked, ['blob:a']);
    assert.equal(queryAll('.thumbnail')[0].src, 'blob:a+right');
    assert.deepEqual(workers[0].posted, [{'id': 'p0', 'blob': 'a+right'}]);

    // Turned twice while it's read - its reading canceled (the worker stopped), both turns made in order, then it's read
    // once, by a new worker
    assert.equal(queryAll('.adjust.left')[0].disabled, false);
    queryAll('.adjust.right')[0].click();
    queryAll('.adjust.vertical')[0].click();
    assert.equal(workers[0].terminated, true);
    await settle();
    assert.equal(photos.get('p0'), 'a+right+right+vertical');
    assert.equal(workers.length, 2);
    assert.deepEqual(workers[1].posted, [{'id': 'p0', 'blob': 'a+right+right+vertical'}]);

    // A queued page turned - taken from the queue, then read after its turn
    queryAll('.retry')[1].click();
    await settle();
    assert.equal(workers[1].posted.length, 1);
    queryAll('.adjust.horizontal')[1].click();
    await settle();

    // A photo that can't be turned - it's read as it is
    assert.equal(query('.message').textContent, 'Could not turn the photo: broken');
    assert.equal(photos.get('p1'), 'unturnable');
    workers[1].onmessage({'data': {'id': 'p0', 'text': 'One.'}});
    await settle();
    assert.deepEqual(workers[1].posted.at(-1), {'id': 'p1', 'blob': 'unturnable'});

    // A page deleted while it's read, and one deleted while its photo turns
    queryAll('.page .delete')[1].click();
    assert.equal(workers[1].terminated, true);
    queryAll('.adjust.left')[0].click();
    queryAll('.page .delete')[0].click();
    await settle();
    assert.equal(photos.get('p0'), 'a+right+right+vertical');
});


test('a page turned while its photo loads to be read', async () => {
    const dom = new JSDOM(indexHtml, {'url': 'https://example.com/webbo/'});
    const {window} = dom;
    window.localStorage.setItem('webbo-documents-v1', JSON.stringify([testDocument([''], 'pending')]));
    window.URL.createObjectURL = (blob) => `blob:${blob}`;
    const photos = new Map([['p0', 'a']]);
    let releaseFirst = null;
    const workers = [];
    main(window, {
        'images': Promise.resolve({
            // (the first photo read - the startup's reading - waits for the test)
            'get': (id) => (releaseFirst === null
                ? new Promise((resolve) => {
                    releaseFirst = () => resolve(photos.get(id));
                })
                : Promise.resolve(photos.get(id))),
            'put': (id, blob) => Promise.resolve(photos.set(id, blob))
        }),
        'createWorker': () => {
            const worker = {'posted': [], 'postMessage': (message) => worker.posted.push(message)};
            workers.push(worker);
            return worker;
        },
        'transformPhoto': (blob, transform) => Promise.resolve(`${blob}+${transform}`)
    });
    window.document.querySelector('.documents .open').click();
    await settle();

    // Turned while the startup's reading loads the photo - that reading is dropped; the turned photo is read
    window.document.querySelector('.adjust.right').click();
    await settle();
    releaseFirst();
    await settle();
    assert.equal(workers.length, 1);
    assert.deepEqual(workers[0].posted, [{'id': 'p0', 'blob': 'a+right'}]);
});
