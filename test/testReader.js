// Licensed under the MIT License
// https://github.com/craigahobbs/webbo/blob/main/LICENSE

import {AHEAD, SAMPLE_RATE, createReader, unlockAudio, voices} from '../lib/reader.js';
import {strict as assert} from 'node:assert';
import test from 'node:test';


// A window with a fake Web Audio (its contexts - each one's started and stopped sources) and timers the test runs
function audioWindow() {
    const contexts = [];
    const timers = new Map();
    let nextTimer = 1;
    const window = {
        contexts,
        timers,
        'setTimeout': (callback, delay) => {
            timers.set(nextTimer, {callback, delay});
            nextTimer += 1;
            return nextTimer - 1;
        },
        'clearTimeout': (timer) => timers.delete(timer),
        'AudioContext': class {
            constructor(options) {
                this.options = options;
                this.currentTime = 0;
                this.started = [];
                this.stopped = 0;
                this.closed = false;
                contexts.push(this);
            }

            createBuffer(channels, length, sampleRate) {
                return {channels, length, sampleRate, 'copyToChannel': (data) => {
                    this.copied = data;
                }};
            }

            createBufferSource() {
                const source = {
                    'context': this,
                    'connect': () => null,
                    'start': (time) => {
                        if (time === undefined) {
                            this.unlocked = true;
                        } else {
                            this.started.push([time, source.buffer.length, source]);
                        }
                    },
                    'stop': () => {
                        this.stopped += 1;
                    }
                };
                return source;
            }

            suspend() {
                this.suspended = true;
            }

            resume() {
                this.suspended = false;
                this.resumed = (this.resumed ?? 0) + 1;
            }

            close() {
                this.closed = true;
            }
        }
    };

    // Run the pending timers (in order)
    window.runTimers = () => {
        for (const [timer, {callback}] of [...timers]) {
            timers.delete(timer);
            callback();
        }
    };
    return window;
}


// The reader's speech worker - its posted requests
function fakeWorker() {
    const worker = {'posted': [], 'postMessage': (message) => worker.posted.push(message), 'onmessage': null};
    return worker;
}


// The reader's callbacks - its events (each chunk's index, and "end")
function readerEvents() {
    const events = [];
    return {events, 'callbacks': {'onChunk': (index) => events.push(index), 'onEnd': () => events.push('end')}};
}


test('voices', () => {
    const list = voices();
    assert.equal(list[0].key, 'male');
    assert.ok(list.some((voice) => voice.key === 'female' && voice.label === 'Female' && voice.description));
});


test('createReader', () => {
    const window = audioWindow();
    const worker = fakeWorker();
    const {events, callbacks} = readerEvents();
    let workers = 0;
    const reader = createReader(window, callbacks, () => {
        workers += 1;
        return worker;
    });
    assert.equal(reader.isPlaying(), false);
    assert.equal(reader.voices()[0].key, 'male');

    // Play from the second chunk - an audio context at the synthesis rate, the chunk asked for
    const chunks = [{'text': 'One.'}, {'text': 'Two.'}, {'text': 'Three.'}];
    reader.play(chunks, 1, {'voice': 'female', 'rate': 1.5});
    assert.equal(reader.isPlaying(), true);
    const [context] = window.contexts;
    assert.deepEqual(context.options, {'sampleRate': SAMPLE_RATE});
    assert.equal(context.unlocked, true);
    assert.equal(context.resumed, 1);
    assert.deepEqual(worker.posted, [{'id': 1, 'index': 1, 'text': 'Two.', 'voice': 'female', 'rate': 1.5}]);

    // Its blocks - scheduled back to back after the lead; the chunk announced when it's heard
    worker.onmessage({'data': {'id': 1, 'index': 1, 'block': new Float32Array(SAMPLE_RATE)}});
    worker.onmessage({'data': {'id': 1, 'index': 1, 'block': new Float32Array(SAMPLE_RATE / 2)}});
    assert.deepEqual(context.started.map(([time, length]) => [time, length]), [[0.1, SAMPLE_RATE], [1.1, SAMPLE_RATE / 2]]);

    // A block played out is forgotten (not stopped at the end)
    context.started[0][2].onended();
    assert.deepEqual([...window.timers.values()].map((timer) => timer.delay), [100]);
    window.runTimers();
    assert.deepEqual(events, [1]);

    // The chunk's end - the next asked for at once (1.6 s queued - under AHEAD)
    worker.onmessage({'data': {'id': 1, 'index': 1, 'done': true}});
    assert.equal(worker.posted.length, 2);
    assert.equal(worker.posted[1].text, 'Three.');

    // The last chunk - after a pause; a lot of audio queued
    worker.onmessage({'data': {'id': 1, 'index': 2, 'block': new Float32Array(SAMPLE_RATE * (AHEAD + 2))}});
    assert.equal(context.started[2][0], 1.6 + 0.12);
    window.runTimers();
    assert.deepEqual(events, [1, 2]);

    // Its end (a failed chunk ends as well) - the end announced when the audio ends
    context.currentTime = 1;
    worker.onmessage({'data': {'id': 1, 'index': 2, 'error': 'failed'}});
    const [endTimer] = [...window.timers.values()];
    assert.equal(Math.round(endTimer.delay), Math.round((1.72 + AHEAD + 2 - 1) * 1000));
    window.runTimers();
    assert.deepEqual(events, [1, 2, 'end']);
    assert.equal(reader.isPlaying(), false);
    assert.equal(context.closed, true);
    assert.equal(context.stopped, 2);

    // Play again - the same worker, a new context; a lot queued waits before asking for the next
    reader.play(chunks, 0, {'voice': 'male', 'rate': 1});
    assert.equal(workers, 1);
    const [, second] = window.contexts;
    worker.onmessage({'data': {'id': 2, 'index': 0, 'block': new Float32Array(SAMPLE_RATE * (AHEAD + 1))}});
    worker.onmessage({'data': {'id': 2, 'index': 0, 'done': true}});
    assert.equal(worker.posted.length, 3);
    const waits = [...window.timers.values()].map((timer) => Math.round(timer.delay));
    assert.deepEqual(waits, [100, Math.round((0.1 + AHEAD + 1 - AHEAD) * 1000)]);

    // Its timer runs early (the clock hasn't moved) - it waits again; then, the audio played down, it asks
    window.runTimers();
    assert.equal(worker.posted.length, 3);
    second.currentTime = 1.2;
    window.runTimers();
    assert.equal(worker.posted.length, 4);
    assert.equal(worker.posted[3].text, 'Two.');

    // Stop (the next chunk's start pending) - the chunk heard kept; a stopped playback's late blocks are ignored
    worker.onmessage({'data': {'id': 2, 'index': 1, 'block': new Float32Array(10)}});
    assert.equal(window.timers.size, 1);
    assert.equal(reader.stop(), 0);
    assert.equal(window.timers.size, 0);
    assert.equal(second.closed, true);
    worker.onmessage({'data': {'id': 2, 'index': 1, 'block': new Float32Array(10)}});
    assert.equal(second.started.length, 2);
    assert.equal(reader.isPlaying(), false);

    // Stopped twice
    assert.equal(reader.stop(), 0);
});


test('createReader, pause', () => {
    const window = audioWindow();
    const worker = fakeWorker();
    const {events, callbacks} = readerEvents();
    const reader = createReader(window, callbacks, () => worker);
    const chunks = [{'text': 'One.'}, {'text': 'Two.'}];

    // Not playing - pause and resume do nothing
    reader.pause();
    reader.resume();
    assert.equal(reader.isPaused(), false);

    // Paused before the first chunk is heard - the audio suspended, its timer held
    reader.play(chunks, 0, {'voice': 'male', 'rate': 1});
    const [context] = window.contexts;
    worker.onmessage({'data': {'id': 1, 'index': 0, 'block': new Float32Array(SAMPLE_RATE * (AHEAD + 2))}});
    reader.pause();
    reader.pause();
    assert.equal(reader.isPaused(), true);
    assert.equal(reader.isPlaying(), false);
    assert.equal(context.suspended, true);
    assert.equal(window.timers.size, 0);

    // The chunk's end arrives while paused - its wait held too (the clock is stopped)
    worker.onmessage({'data': {'id': 1, 'index': 0, 'done': true}});
    assert.equal(window.timers.size, 0);
    assert.deepEqual(events, []);

    // Resume - the audio from where it was, both timers re-armed on its clock
    reader.resume();
    assert.equal(context.suspended, false);
    assert.equal(reader.isPlaying(), true);
    assert.deepEqual([...window.timers.values()].map((timer) => Math.round(timer.delay)), [100, Math.round((0.1 + 2) * 1000)]);
    window.runTimers();
    assert.deepEqual(events, [0]);

    // Stopped while paused - not paused after
    reader.pause();
    assert.equal(reader.stop(), 0);
    assert.equal(reader.isPaused(), false);
    assert.equal(context.closed, true);
});


test('unlockAudio', () => {
    // An audio session (Safari) is set for playback
    const window = {...audioWindow(), 'navigator': {'audioSession': {'type': 'auto'}}};
    const context = new window.AudioContext({'sampleRate': SAMPLE_RATE});
    unlockAudio(window, context);
    assert.equal(window.navigator.audioSession.type, 'playback');
    assert.equal(context.resumed, 1);
    assert.equal(context.unlocked, true);
});
