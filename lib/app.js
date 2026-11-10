// Licensed under the MIT License
// https://github.com/craigahobbs/picoread/blob/main/LICENSE

// PicoRead - photograph a document's pages, read their text (PicoOCR, in a Web Worker - lib/ocrworker.js), and listen to
// it (PicoVox's voices, in a Web Worker - lib/reader.js). Everything stays in the browser (lib/store.js).
//
// Importing this module has no side effects: main(window, overrides) starts the app, as static/index.html does. The
// overrides replace its services (the tests pass fakes): images (a Promise of the photo store - lib/store.js
// openImages), createWorker, preparePhoto and transformPhoto (lib/photo.js), createReader, download, and openCamera
// (lib/camera.js).

import {documentText, readingChunks} from './text.js';
import {hasCamera, openCamera} from './camera.js';
import {loadDocuments, loadSession, memoryImages, newId, openImages, saveDocuments, saveSession} from './store.js';
import {preparePhoto, transformPhoto} from './photo.js';
import {createReader} from './reader.js';


// The reading speeds
export const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];

// The settings' storage key - the voice and speed
const SETTINGS_KEY = 'picoread-settings-v1';


// An element - a tag, its properties (on* properties as listeners), and its children (strings as text)
export function element(document, tag, properties = {}, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(properties)) {
        if (name.startsWith('on')) {
            node.addEventListener(name.slice(2), value);
        } else if (name === 'class') {
            node.className = value;
        } else if (name.startsWith('aria-') || name.startsWith('data-')) {
            node.setAttribute(name, value);
        } else {
            node[name] = value;
        }
    }
    node.append(...children.filter((child) => child !== null));
    return node;
}


// A page's status text
export function statusText(page, progress) {
    if (page.status === 'pending') {
        return progress === undefined ? 'Waiting to read…' : `Reading… ${Math.round(progress * 100)}%`;
    }
    if (page.status === 'error') {
        return 'Could not read this page';
    }
    return page.text === '' ? 'No text found' : '';
}


// Start the app in a window - the app's controller (the tests use it)
export function main(window, overrides = {}) {
    const {document} = window;
    const root = document.getElementById('app');
    const services = {
        'images': overrides.images ?? openImages(window.indexedDB).catch(() => memoryImages()),
        'createWorker': overrides.createWorker ??
            (() => new window.Worker(new URL('./ocrworker.js', import.meta.url), {'type': 'module'})),
        'preparePhoto': overrides.preparePhoto ?? ((file) => preparePhoto(window, file)),
        'transformPhoto': overrides.transformPhoto ?? ((blob, transform) => transformPhoto(window, blob, transform)),
        'createReader': overrides.createReader ?? ((callbacks) => createReader(window, callbacks, () => (
            new window.Worker(new URL('./speechworker.js', import.meta.url), {'type': 'module'})
        ))),
        'openCamera': overrides.openCamera ?? (hasCamera(window) ? (callbacks) => openCamera(window, callbacks) : null),
        'download': overrides.download ?? ((name, text) => {
            const url = window.URL.createObjectURL(new window.Blob([text], {'type': 'text/plain'}));
            element(document, 'a', {'href': url, 'download': name}).click();
            window.URL.revokeObjectURL(url);
        })
    };

    // The state
    const documents = loadDocuments(window.localStorage);
    const session = loadSession(window.sessionStorage);
    let settings = {'voice': null, 'rate': 1};
    try {
        settings = {...settings, ...JSON.parse(window.localStorage.getItem(SETTINGS_KEY))};
    } catch {
        // Unavailable or corrupt storage - the defaults
    }
    const progress = new Map();
    const thumbnails = new Map();
    let message = '';

    // Save the documents (a failure is shown - storage is full or unavailable)
    const save = () => {
        if (!saveDocuments(window.localStorage, documents)) {
            message = 'Your browser could not save this change.';
        }
    };

    // The open document (null for the library)
    const openDocument = () => documents.find((doc) => doc.id === session.documentId) ?? null;

    // A page and its document, by page id
    const findPage = (pageId) => {
        for (const doc of documents) {
            const page = doc.pages.find((candidate) => candidate.id === pageId);
            if (page !== undefined) {
                return {doc, page};
            }
        }
        return null;
    };

    //
    // Recognition - one page at a time, in the worker
    //

    let queue = [];
    let worker = null;
    let busy = false;
    let current = null;
    let job = 0;

    // Read the next queued page
    const pump = async () => {
        if (busy || queue.length === 0) {
            return;
        }
        busy = true;
        const pageId = queue.shift();
        current = pageId;
        job += 1;
        const thisJob = job;
        const blob = await (await services.images).get(pageId);
        if (thisJob !== job) {
            // (canceled while its photo loaded)
            return;
        }
        if (blob === undefined) {
            finish({'id': pageId, 'error': 'missing photo'});
            return;
        }
        if (worker === null) {
            worker = services.createWorker();
            worker.onmessage = ({data}) => {
                if (data.progress === undefined) {
                    finish(data);
                } else {
                    progress.set(data.id, data.progress);
                    updateStatus(data.id);
                }
            };
        }
        worker.postMessage({'id': pageId, blob});
    };

    // A page's recognition finished (or failed)
    const finish = (data) => {
        busy = false;
        current = null;
        progress.delete(data.id);
        const found = findPage(data.id);
        if (found !== null) {
            found.page.status = data.error === undefined ? 'done' : 'error';
            found.page.text = data.text ?? '';
            found.doc.updated = Date.now();
            save();
            render();
        }
        pump();
    };

    // Cancel a page's recognition - queued, or under way (its worker stopped - a new one reads the next page)
    const cancelRecognition = (pageId) => {
        queue = queue.filter((queued) => queued !== pageId);
        if (current === pageId) {
            job += 1;
            busy = false;
            current = null;
            progress.delete(pageId);
            if (worker !== null) {
                worker.terminate();
                worker = null;
            }
        }
    };

    // Queue a page for recognition
    const recognizePage = (page) => {
        page.status = 'pending';
        queue.push(page.id);
        pump();
    };

    //
    // Reading aloud
    //

    const reader = services.createReader({
        'onChunk': (index) => {
            session.chunk = index;
            saveSession(window.sessionStorage, session);
            updateReading();
        },
        'onEnd': () => {
            session.chunk = 0;
            saveSession(window.sessionStorage, session);
            updateReading();
        }
    });

    // The voice - the setting's, if it's one of the reader's, else the reader's first (its default)
    const currentVoice = () => {
        const keys = reader.voices().map((voice) => voice.key);
        return keys.includes(settings.voice) ? settings.voice : keys[0];
    };

    // The open document's reading chunks
    const chunks = () => readingChunks(openDocument().pages.map((page) => page.text));

    // Play from a chunk
    const play = (start) => {
        const docChunks = chunks();
        if (docChunks.length !== 0) {
            reader.play(docChunks, Math.min(start, docChunks.length - 1), {'voice': currentVoice(), 'rate': settings.rate});
        }
        updateReading();
    };

    // Stop reading (or a pause) - keep the position
    const stop = () => {
        if (reader.isPlaying() || reader.isPaused()) {
            session.chunk = reader.stop();
            saveSession(window.sessionStorage, session);
        }
    };

    // Save the settings
    const saveSettings = (changes) => {
        settings = {...settings, ...changes};
        try {
            window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch {
            // Unavailable storage - the settings last the session
        }
    };

    // Save the reading's settings, and play on with them
    const changeSettings = (changes) => {
        saveSettings(changes);
        if (reader.isPlaying()) {
            stop();
            play(session.chunk);
        } else {
            stop();
            updateReading();
        }
    };

    //
    // Actions
    //

    // The open camera (lib/camera.js), if any
    let camera = null;

    // Open the camera - each photo the open document's next page
    const takePhotos = async () => {
        camera = await services.openCamera({
            'mirror': settings.mirror === true,
            'onMirror': (mirror) => saveSettings({mirror}),
            'onPhoto': (blob) => addPhotos([blob]),
            'onError': (error) => {
                message = `The camera couldn't take a photo: ${error.message}`;
                render();
            },
            'onClose': () => {
                camera = null;
            }
        });
    };

    // Open a document (null for the library)
    const open = (docId) => {
        stop();
        camera?.close();
        message = '';
        session.documentId = docId;
        session.chunk = 0;
        saveSession(window.sessionStorage, session);
        render();
    };

    // A new document
    const newDocument = () => {
        const now = Date.now();
        const doc = {'id': newId(), 'title': `Document ${documents.length + 1}`, 'created': now, 'updated': now, 'pages': []};
        documents.unshift(doc);
        open(doc.id);
        save();
        render();
    };

    // Delete a document and its photos
    const deleteDocument = async (doc) => {
        if (window.confirm(`Delete "${doc.title}" and its ${doc.pages.length} page(s)?`)) {
            documents.splice(documents.indexOf(doc), 1);
            for (const page of doc.pages) {
                cancelRecognition(page.id);
            }
            save();
            render();
            const images = await services.images;
            await Promise.all(doc.pages.map((page) => images.remove(page.id)));
        }
    };

    // Add photos to the open document - each prepared, stored, and queued for recognition
    const addPhotos = async (files) => {
        const doc = openDocument();
        const images = await services.images;
        if (images.memory) {
            message = 'This browser can\'t store photos, so they last only until this page closes.';
        }
        for (const file of files) {
            try {
                const blob = await services.preparePhoto(file);
                const page = {'id': newId(), 'text': '', 'status': 'pending'};
                await images.put(page.id, blob);
                doc.pages.push(page);
                doc.updated = Date.now();
                save();
                recognizePage(page);
            } catch (error) {
                message = `Could not add the photo: ${error.message}`;
            }
            render();
        }
    };

    // Turn or flip a page's photo (lib/photo.js TRANSFORMS), and read it again - its reading canceled at once; a page's
    // turns one after another, in order (each turns the last's photo)
    const turns = new Map();
    const adjustPage = (doc, page, transform) => {
        stop();
        cancelRecognition(page.id);
        page.status = 'pending';
        render();
        const turned = (turns.get(page.id) ?? Promise.resolve()).then(async () => {
            try {
                const images = await services.images;
                const blob = await services.transformPhoto(await images.get(page.id), transform);
                if (findPage(page.id) === null) {
                    // (the page was deleted while its photo turned)
                    return;
                }
                await images.put(page.id, blob);
                if (thumbnails.has(page.id)) {
                    window.URL.revokeObjectURL(thumbnails.get(page.id));
                    thumbnails.delete(page.id);
                }
                doc.updated = Date.now();
            } catch (error) {
                message = `Could not turn the photo: ${error.message}`;
            }
            if (turns.get(page.id) === turned) {
                turns.delete(page.id);
                cancelRecognition(page.id);
                recognizePage(page);
            }
            render();
        });
        turns.set(page.id, turned);
        return turned;
    };

    // Move a page by an offset
    const movePage = (doc, index, offset) => {
        stop();
        const [page] = doc.pages.splice(index, 1);
        doc.pages.splice(index + offset, 0, page);
        doc.updated = Date.now();
        save();
        render();
    };

    // Delete a page and its photo
    const deletePage = async (doc, index) => {
        if (window.confirm(`Delete page ${index + 1}?`)) {
            stop();
            const [page] = doc.pages.splice(index, 1);
            cancelRecognition(page.id);
            doc.updated = Date.now();
            save();
            render();
            await (await services.images).remove(page.id);
        }
    };

    // Play from a page's first chunk
    const playPage = (index) => {
        const start = chunks().findIndex((chunk) => chunk.page >= index);
        if (start !== -1) {
            play(start);
        }
    };

    //
    // Rendering
    //

    // A page photo's object URL (made once - a render while the photo loads doesn't make another), or null if there's
    // no photo
    const photoUrl = async (page) => {
        if (!thumbnails.has(page.id)) {
            const blob = await (await services.images).get(page.id);
            if (blob === undefined) {
                return null;
            }
            if (!thumbnails.has(page.id)) {
                thumbnails.set(page.id, window.URL.createObjectURL(blob));
            }
        }
        return thumbnails.get(page.id);
    };

    // A page's thumbnail
    const thumbnail = (page, image) => {
        photoUrl(page).then((url) => {
            if (url !== null) {
                image.src = url;
            }
        });
    };

    // The photo viewer - a page's photo full screen, fitted; tapped, at its full size (scrolled to the tapped point) to
    // pan; closed by its button or Escape. (An overlay of its own - the app's renders leave it be.)
    const viewPhoto = async (page, number) => {
        const url = await photoUrl(page);
        if (url === null) {
            return;
        }
        const image = element(document, 'img', {'class': 'viewer-image', 'src': url, 'alt': `Page ${number}`});
        const frame = element(document, 'div', {'class': 'viewer-frame'}, image);
        image.addEventListener('click', (event) => {
            const fractionX = image.clientWidth > 0 ? event.offsetX / image.clientWidth : 0.5;
            const fractionY = image.clientHeight > 0 ? event.offsetY / image.clientHeight : 0.5;
            if (frame.classList.toggle('zoomed')) {
                frame.scrollLeft = fractionX * image.clientWidth - frame.clientWidth / 2;
                frame.scrollTop = fractionY * image.clientHeight - frame.clientHeight / 2;
            }
        });
        const onKey = (event) => {
            if (event.key === 'Escape') {
                close();
            }
        };
        const close = () => {
            viewer.remove();
            document.removeEventListener('keydown', onKey);
        };
        const viewer = element(document, 'div', {'class': 'viewer', 'role': 'dialog', 'aria-label': `Page ${number} photo`},
            frame, button('viewer-close', '✕', {'aria-label': 'Close'}, close));
        document.body.append(viewer);
        document.addEventListener('keydown', onKey);
    };

    // Update a page's status text
    const updateStatus = (pageId) => {
        const status = root.querySelector(`[data-status="${pageId}"]`);
        const found = findPage(pageId);
        if (status !== null && found !== null) {
            status.textContent = statusText(found.page, progress.get(pageId));
        }
    };

    // Update the reading controls and the page being read
    const updateReading = () => {
        const playButton = root.querySelector('.play');
        if (playButton === null) {
            return;
        }
        const playing = reader.isPlaying();
        playButton.textContent = playing ? 'Pause' : 'Play';
        playButton.setAttribute('aria-pressed', String(playing));
        const chunk = chunks()[session.chunk];
        const reading = (playing || reader.isPaused()) && chunk !== undefined;
        root.querySelector('.now-reading').textContent = reading ? chunk.text : '';
        for (const item of root.querySelectorAll('.page')) {
            item.classList.toggle('reading', reading && Number(item.dataset.index) === chunk.page);
        }
    };

    // A button - its class, label, properties (aria-label, disabled), and click
    const button = (className, label, properties, onclick) => (
        element(document, 'button', {'class': className, ...properties, onclick}, label)
    );

    // The library view
    const renderLibrary = () => {
        const items = documents.map((doc) => {
            const pages = `${doc.pages.length} page${doc.pages.length === 1 ? '' : 's'}`;
            const details = element(document, 'small', {}, `${pages} · ${new Date(doc.updated).toLocaleDateString()}`);
            const title = element(document, 'span', {'class': 'title'}, doc.title);
            const openButton = element(document, 'button', {'class': 'open', 'onclick': () => open(doc.id)}, title, details);
            const deleteButton = button('icon delete', '✕', {'aria-label': `Delete ${doc.title}`}, () => deleteDocument(doc));
            return element(document, 'li', {}, openButton, deleteButton);
        });
        const list = documents.length === 0
            ? element(document, 'p', {'class': 'empty'}, 'No documents yet. Start one, then photograph its pages.')
            : element(document, 'ul', {'class': 'documents'}, ...items);
        return [
            element(document, 'header', {'class': 'bar'}, element(document, 'h1', {}, 'PicoRead')),
            element(document, 'section', {'class': 'library'}, button('primary new', 'New document', {}, newDocument), list)
        ];
    };

    // A page's card
    const renderPage = (doc, page, index) => {
        const number = index + 1;
        const image = element(document, 'img', {'class': 'thumbnail', 'alt': `Page ${number}`});
        thumbnail(page, image);
        const photo = button('photo', image, {'aria-label': `View page ${number}'s photo`}, () => viewPhoto(page, number));
        const pending = page.status === 'pending';
        const actions = element(document, 'span', {'class': 'page-actions'},
            button('icon read', '▶', {'aria-label': `Read from page ${number}`}, () => playPage(index)),
            button('icon up', '↑', {'aria-label': `Move page ${number} up`, 'disabled': index === 0}, () => movePage(doc, index, -1)),
            button('icon down', '↓', {'aria-label': `Move page ${number} down`, 'disabled': number === doc.pages.length},
                () => movePage(doc, index, 1)),
            button('icon retry', '↻', {'aria-label': `Read page ${number} again`, 'disabled': pending}, () => {
                recognizePage(page);
                render();
            }),
            button('icon delete', '✕', {'aria-label': `Delete page ${number}`}, () => deletePage(doc, index)));
        const head = element(document, 'div', {'class': 'page-head'},
            element(document, 'strong', {}, `Page ${number}`),
            element(document, 'span', {'class': 'status', 'data-status': page.id}, statusText(page, progress.get(page.id))),
            actions);
        const adjust = element(document, 'div', {'class': 'page-adjust'},
            ...[['left', '⟲', 'Rotate page %s left'], ['right', '⟳', 'Rotate page %s right'],
                ['horizontal', '⇋', 'Flip page %s horizontally'], ['vertical', '⇅', 'Flip page %s vertically']].
                map(([transform, label, ariaLabel]) => button(`icon adjust ${transform}`, label, {
                    'aria-label': ariaLabel.replace('%s', number)
                }, () => adjustPage(doc, page, transform))));
        const text = element(document, 'textarea', {
            'class': 'text', 'value': page.text, 'aria-label': `Page ${number} text`, 'disabled': pending,
            'oninput': (event) => {
                stop();
                page.text = event.target.value;
                doc.updated = Date.now();
                save();
            }
        });
        return element(document, 'li', {'class': 'page', 'data-index': String(index)}, photo,
            element(document, 'div', {'class': 'page-body'}, head, adjust, text));
    };

    // The document view
    const renderDocument = (doc) => {
        const empty = doc.pages.length === 0;
        const pageTexts = () => doc.pages.map((page) => page.text);

        // The header - back, and the title
        const title = element(document, 'input', {
            'class': 'doc-title', 'value': doc.title, 'aria-label': 'Document title',
            'onchange': (event) => {
                doc.title = event.target.value.trim() || doc.title;
                save();
            }
        });
        const back = button('back', '‹', {'aria-label': 'Documents'}, () => open(null));
        const header = element(document, 'header', {'class': 'bar'}, back, title);

        // The player - play, pause, or resume; from the start; the voice, the speed, and the chunk being read
        const playButton = button('primary play', 'Play', {'aria-pressed': 'false', 'disabled': empty}, () => {
            if (reader.isPlaying()) {
                reader.pause();
            } else if (reader.isPaused()) {
                reader.resume();
            } else {
                play(session.chunk);
            }
            updateReading();
        });
        const voiceOptions = reader.voices().map((voice) => (
            element(document, 'option', {
                'value': voice.key, 'selected': voice.key === currentVoice(), 'title': voice.description
            }, voice.label)
        ));
        const voiceSelect = element(document, 'select', {
            'class': 'voice', 'aria-label': 'Voice', 'onchange': (event) => changeSettings({'voice': event.target.value})
        }, ...voiceOptions);
        const rateOptions = RATES.map((rate) => (
            element(document, 'option', {'value': String(rate), 'selected': rate === settings.rate}, `${rate}×`)
        ));
        const rateSelect = element(document, 'select', {
            'class': 'rate', 'aria-label': 'Speed', 'onchange': (event) => changeSettings({'rate': Number(event.target.value)})
        }, ...rateOptions);
        const player = element(document, 'section', {'class': 'player'}, playButton,
            button('restart', 'From the start', {'disabled': empty}, () => play(0)), voiceSelect, rateSelect,
            element(document, 'p', {'class': 'now-reading', 'aria-live': 'polite'}));

        // The pages
        const pages = empty
            ? element(document, 'p', {'class': 'empty'}, 'No pages yet. Photograph the document\'s pages in order.')
            : element(document, 'ol', {'class': 'pages'}, ...doc.pages.map((page, index) => renderPage(doc, page, index)));

        // Adding photos (the camera, or chosen photos), and the text copied or saved
        const fileInput = (label, capture) => {
            const input = element(document, 'input', {
                'type': 'file', 'accept': 'image/*', 'multiple': !capture, 'hidden': true,
                'onchange': (event) => {
                    addPhotos(Array.from(event.target.files));
                }
            });
            if (capture) {
                input.setAttribute('capture', 'environment');
            }
            return element(document, 'label', {'class': 'button primary'}, label, input);
        };
        const cameraButton = services.openCamera === null
            ? fileInput('Take photo', true)
            : button('primary take-photos', 'Take photos', {}, takePhotos);
        const add = element(document, 'section', {'class': 'add'}, cameraButton, fileInput('Choose photos', false),
            button('copy', 'Copy text', {'disabled': empty}, () => window.navigator.clipboard.writeText(documentText(pageTexts()))),
            button('save', 'Save text', {'disabled': empty}, () => services.download(`${doc.title}.txt`, documentText(pageTexts()))));
        return [header, player, pages, add];
    };

    // Render the view
    const render = () => {
        const doc = openDocument();
        const view = doc === null ? renderLibrary() : renderDocument(doc);
        root.replaceChildren(...view, ...(message === '' ? [] : [element(document, 'p', {'class': 'message', 'role': 'alert'}, message)]));
        updateReading();
    };

    // Recognize the pages left unread (the app closed while reading them)
    for (const doc of documents) {
        for (const page of doc.pages) {
            if (page.status === 'pending') {
                recognizePage(page);
            }
        }
    }
    render();

    return {documents, session, 'settings': () => settings, render, reader, addPhotos};
}
