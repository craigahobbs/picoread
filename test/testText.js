// Licensed under the MIT License
// https://github.com/craigahobbs/picoread/blob/main/LICENSE

import {MAX_CHUNK, chunkSentence, documentText, paragraphs, readingChunks, sentences} from '../lib/text.js';
import {strict as assert} from 'node:assert';
import test from 'node:test';


test('paragraphs', () => {
    // Lines joined, a hyphenated word rejoined (not a hyphen before a capital, nor a dash), blank lines dropped
    const text = 'The quick brown fox jum-\nped over the\nlazy dog.\n\n  \n\nSecond para-\nGraph - and\n\n\nthird.\n';
    assert.deepEqual(paragraphs(text), [
        'The quick brown fox jumped over the lazy dog.',
        'Second para- Graph - and',
        'third.'
    ]);

    // A blank line within a paragraph's lines
    assert.deepEqual(paragraphs('one\n \ntwo'), ['one', 'two']);
    assert.deepEqual(paragraphs('one\n two\n'), ['one two']);
    assert.deepEqual(paragraphs(''), []);
});


test('sentences', () => {
    assert.deepEqual(sentences('Hello there. “Who are you?” he said! Wait… then (go.) Done'), [
        'Hello there.', '“Who are you?”', 'he said!', 'Wait…', 'then (go.)', 'Done'
    ]);
    assert.deepEqual(sentences('Mr.Smith 3.5 percent.'), ['Mr.Smith 3.5 percent.']);
});


test('chunkSentence', () => {
    assert.deepEqual(chunkSentence('short'), ['short']);

    // At a comma, else a space, else hard
    assert.deepEqual(chunkSentence('aaaa, bbbb cccc', 8), ['aaaa,', 'bbbb', 'cccc']);
    assert.deepEqual(chunkSentence('aaaaaaaaaaaa', 5), ['aaaaa', 'aaaaa', 'aa']);
    assert.deepEqual(chunkSentence('one; two: three', 6), ['one;', 'two:', 'three']);

    // The default limit
    const long = 'word '.repeat(100).trim();
    assert.ok(chunkSentence(long).every((chunk) => chunk.length <= MAX_CHUNK));
    assert.equal(chunkSentence(long).join(' '), long);
});


test('readingChunks', () => {
    assert.deepEqual(readingChunks(['One. Two.\n\nThree', '', 'Four']), [
        {'page': 0, 'text': 'One.'},
        {'page': 0, 'text': 'Two.'},
        {'page': 0, 'text': 'Three'},
        {'page': 2, 'text': 'Four'}
    ]);
});


test('documentText', () => {
    assert.equal(documentText(['a\nb\n\nc', '', 'd']), 'a b\n\nc\n\nd');
});
