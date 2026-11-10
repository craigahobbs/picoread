// Licensed under the MIT License
// https://github.com/craigahobbs/picoread/blob/main/LICENSE

// PicoRead's storage, all in the browser:
//
// - localStorage - the documents: each document's id, title, dates, and pages in order (each page's id, its text,
//   and its recognition status - "pending", "done", or "error")
// - IndexedDB - the page photos (Blobs, by page id) - localStorage's few megabytes hold only a handful of photos
// - sessionStorage - the tab's session: the open document and the reading position
//
// Storage may be unavailable (private browsing) or full, so the localStorage and sessionStorage accesses are guarded:
// a load falls back to the default, and a save returns false.


// The storage keys
const DOCUMENTS_KEY = 'picoread-documents-v1';
const SESSION_KEY = 'picoread-session-v1';

// The IndexedDB database and its store
const DATABASE = 'picoread';
const IMAGES = 'images';


// A short unique id
export function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}


// A JSON value from storage - the fallback if it's missing, unreadable, or not an object
function loadJSON(storage, key, fallback) {
    try {
        const value = JSON.parse(storage.getItem(key));
        if (value !== null && typeof value === 'object') {
            return value;
        }
    } catch {
        // Unavailable or corrupt storage - the fallback
    }
    return fallback;
}


// Save a JSON value to storage - false if storage is unavailable or full
function saveJSON(storage, key, value) {
    try {
        storage.setItem(key, JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
}


// The documents (localStorage)
export function loadDocuments(storage) {
    const documents = loadJSON(storage, DOCUMENTS_KEY, []);
    return Array.isArray(documents) ? documents : [];
}


// Save the documents - false if they couldn't be saved
export function saveDocuments(storage, documents) {
    return saveJSON(storage, DOCUMENTS_KEY, documents);
}


// The session (sessionStorage) - {documentId, chunk}
export function loadSession(storage) {
    return {'documentId': null, 'chunk': 0, ...loadJSON(storage, SESSION_KEY, {})};
}


// Save the session
export function saveSession(storage, session) {
    return saveJSON(storage, SESSION_KEY, session);
}


// An IndexedDB request's result (a Promise)
function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}


// A page photo store in memory - for a browser without IndexedDB (the photos last until the page closes)
export function memoryImages() {
    const photos = new Map();
    return {
        'memory': true,
        'get': (id) => Promise.resolve(photos.get(id)),
        'put': (id, blob) => Promise.resolve(photos.set(id, blob)).then(() => id),
        'remove': (id) => Promise.resolve(photos.delete(id)).then(() => undefined)
    };
}


// The page photo store (IndexedDB) - a Promise of {get(id), put(id, blob), remove(id)}, each a Promise
export async function openImages(indexedDB) {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
        request.result.createObjectStore(IMAGES);
    };
    const database = await requestResult(request);
    const store = (mode) => database.transaction(IMAGES, mode).objectStore(IMAGES);
    return {
        'get': (id) => requestResult(store('readonly').get(id)),
        'put': (id, blob) => requestResult(store('readwrite').put(blob, id)),
        'remove': (id) => requestResult(store('readwrite').delete(id))
    };
}
