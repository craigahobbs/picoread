// Licensed under the MIT License
// https://github.com/craigahobbs/webbo/blob/main/LICENSE

import {fakeIndexedDB, fakeStorage} from './helpers.js';
import {loadDocuments, loadSession, memoryImages, newId, openImages, saveDocuments, saveSession} from '../lib/store.js';
import {strict as assert} from 'node:assert';
import test from 'node:test';


test('newId', () => {
    const first = newId();
    assert.match(first, /^[0-9a-z]+$/);
    assert.notEqual(newId(), first);
});


test('documents', () => {
    const storage = fakeStorage();
    assert.deepEqual(loadDocuments(storage), []);
    const documents = [{'id': 'a', 'title': 'A', 'pages': []}];
    assert.equal(saveDocuments(storage, documents), true);
    assert.deepEqual(loadDocuments(storage), documents);

    // Not a list, not JSON, not an object
    storage.setItem('webbo-documents-v1', '{"id": 1}');
    assert.deepEqual(loadDocuments(storage), []);
    storage.setItem('webbo-documents-v1', 'not JSON');
    assert.deepEqual(loadDocuments(storage), []);
    storage.setItem('webbo-documents-v1', '7');
    assert.deepEqual(loadDocuments(storage), []);

    // Unavailable storage
    assert.deepEqual(loadDocuments(fakeStorage(true)), []);
    assert.equal(saveDocuments(fakeStorage(true), documents), false);
});


test('session', () => {
    const storage = fakeStorage();
    assert.deepEqual(loadSession(storage), {'documentId': null, 'chunk': 0});
    assert.equal(saveSession(storage, {'documentId': 'a', 'chunk': 3}), true);
    assert.deepEqual(loadSession(storage), {'documentId': 'a', 'chunk': 3});
});


test('openImages', async () => {
    const indexedDB = fakeIndexedDB();
    const images = await openImages(indexedDB);
    assert.ok(indexedDB.stores.has('images'));
    assert.equal(await images.get('a'), undefined);
    assert.equal(await images.put('a', 'blob'), 'a');
    assert.equal(await images.get('a'), 'blob');
    await images.remove('a');
    assert.equal(await images.get('a'), undefined);

    // The database can't be opened
    await assert.rejects(openImages(fakeIndexedDB(true)), {'message': 'blocked'});
});


test('memoryImages', async () => {
    const images = memoryImages();
    assert.equal(images.memory, true);
    assert.equal(await images.put('a', 'blob'), 'a');
    assert.equal(await images.get('a'), 'blob');
    assert.equal(await images.remove('a'), undefined);
    assert.equal(await images.get('a'), undefined);
});
