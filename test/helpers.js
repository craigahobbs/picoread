// Licensed under the MIT License
// https://github.com/craigahobbs/picoread/blob/main/LICENSE

// The tests' shared fakes

import {setImmediate} from 'node:timers';


// A Storage of a Map - or one that throws (unavailable)
export function fakeStorage(fail = false) {
    const items = new Map();
    return {
        items,
        'getItem': (key) => {
            if (fail) {
                throw new Error('unavailable');
            }
            return items.has(key) ? items.get(key) : null;
        },
        'setItem': (key, value) => {
            if (fail) {
                throw new Error('unavailable');
            }
            items.set(key, String(value));
        }
    };
}


// An IndexedDB of Maps - requests complete asynchronously; a failing database's open fails
export function fakeIndexedDB(fail = false) {
    const stores = new Map();
    const request = (compute) => {
        const req = {'result': undefined, 'error': null, 'onsuccess': null, 'onerror': null};
        setImmediate(() => {
            req.result = compute();
            req.onsuccess();
        });
        return req;
    };
    const database = {
        'createObjectStore': (name) => stores.set(name, new Map()),
        'transaction': (name) => ({
            'objectStore': () => {
                const store = stores.get(name);
                return {
                    'get': (key) => request(() => store.get(key)),
                    'put': (value, key) => request(() => store.set(key, value) && key),
                    'delete': (key) => request(() => {
                        store.delete(key);
                    })
                };
            }
        })
    };
    return {
        stores,
        'open': () => {
            const req = {'result': database, 'error': null, 'onsuccess': null, 'onerror': null, 'onupgradeneeded': null};
            setImmediate(() => {
                if (fail) {
                    req.error = new Error('blocked');
                    req.onerror();
                } else {
                    req.onupgradeneeded();
                    req.onsuccess();
                }
            });
            return req;
        }
    };
}


// The fake reader's voices
const FAKE_VOICES = [
    {'key': 'male', 'label': 'Male', 'description': 'Warm'},
    {'key': 'female', 'label': 'Female', 'description': 'Bright'}
];


// A reader (lib/reader.js's interface) the test drives - its plays and stops, and the app's callbacks (reader.callbacks
// - set by the app's createReader)
export function fakeReader(voices = FAKE_VOICES) {
    const reader = {
        'plays': [],
        'stops': 0,
        'playing': false,
        'position': 0,
        'callbacks': null,
        'voices': () => voices,
        'paused': false,
        'isPlaying': () => reader.playing && !reader.paused,
        'isPaused': () => reader.paused,
        'pause': () => {
            reader.paused = true;
        },
        'resume': () => {
            reader.paused = false;
        },
        'play': (chunks, start, settings) => {
            reader.plays.push({'texts': chunks.map((chunk) => chunk.text), start, settings});
            reader.playing = true;
            reader.paused = false;
            reader.position = start;
            reader.callbacks.onChunk(start);
        },
        'stop': () => {
            reader.stops += 1;
            reader.playing = false;
            reader.paused = false;
            return reader.position;
        },

        // The reader moves on to a chunk - or ends
        'advance': (index) => {
            reader.position = index;
            reader.callbacks.onChunk(index);
        },
        'end': () => {
            reader.playing = false;
            reader.callbacks.onEnd();
        }
    };
    return reader;
}
