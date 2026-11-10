// Licensed under the MIT License
// https://github.com/craigahobbs/webbo/blob/main/LICENSE

// Reading aloud - PicoVox's voices. The chunks (lib/text.js readingChunks - sentences) are synthesized in the speech
// worker (lib/speechworker.js), one at a time as playback needs them (at most AHEAD seconds of audio queued), and their
// blocks scheduled back to back in a Web Audio context at the synthesis rate (blocks joined exactly - no clicks). Each
// chunk's start is announced as it's heard (onChunk), so the page follows the reading. Pausing suspends the context -
// its clock and the reader's timers (kept on that clock) stop - and resuming plays on from the very sample. Stopping
// closes the context and keeps the position (the chunk being heard); a playback's late blocks are ignored by its id.

import {voices as picovoxVoices} from 'picovox/lib/index.js';


// The synthesis sample rate (PicoVox's)
export const SAMPLE_RATE = 24000;

// The audio queued ahead of playback (seconds), the first block's lead, and the pause between chunks
export const AHEAD = 4;
const LEAD = 0.1;
const GAP = 0.12;


// Unlock a new audio context for playback, in the user's tap - for iOS: its contexts start suspended (even in a tap),
// its audio isn't unlocked until a sound starts in the tap, and its Web Audio is muted by the silent switch unless the
// page's audio session is for playback (Safari 16.4 and later)
export function unlockAudio(window, context) {
    if (window.navigator?.audioSession !== undefined) {
        window.navigator.audioSession.type = 'playback';
    }
    context.resume();
    const silence = context.createBufferSource();
    silence.buffer = context.createBuffer(1, 1, SAMPLE_RATE);
    silence.connect(context.destination);
    silence.start();
}


// The voices - PicoVox's [{key, label, sex, description}], its default first
export function voices() {
    return picovoxVoices();
}


// A reader - callbacks onChunk(index) (a chunk is heard) and onEnd() (the last chunk ended); createWorker - the speech
// worker
export function createReader(window, {onChunk, onEnd}, createWorker) {
    let worker = null;
    let context = null;
    let playback = 0;
    let playing = false;
    let paused = false;
    let chunks = [];
    let settings = {};
    let next = 0;
    let current = 0;
    let time = 0;
    let started = new Set();
    const sources = new Set();
    const timers = new Map();
    const held = [];

    // Arm a timer for its audio clock time (held while paused - the clock is stopped)
    const arm = (entry) => {
        if (paused) {
            held.push(entry);
            return;
        }
        const timer = window.setTimeout(() => {
            timers.delete(timer);
            entry.callback();
        }, Math.max(0, (entry.at - context.currentTime) * 1000));
        timers.set(timer, entry);
    };

    // Run a function after a delay (seconds, on the audio clock) - unless playback stops first
    const later = (seconds, callback) => {
        arm({'at': context.currentTime + seconds, callback});
    };

    // Clear the timers - their entries
    const clearTimers = () => {
        const entries = [...timers.values()];
        for (const timer of timers.keys()) {
            window.clearTimeout(timer);
        }
        timers.clear();
        return entries;
    };

    // Ask the worker for the next chunk - once the queued audio is under AHEAD seconds
    const requestNext = () => {
        const queued = time - context.currentTime;
        if (queued > AHEAD) {
            later(queued - AHEAD, requestNext);
            return;
        }
        worker.postMessage({'id': playback, 'index': next, 'text': chunks[next].text, 'voice': settings.voice, 'rate': settings.rate});
        next += 1;
    };

    // A chunk's block - scheduled after the last (the chunk's first after a pause, announced when it's heard)
    const scheduleBlock = (index, block) => {
        if (!started.has(index)) {
            started.add(index);
            time = Math.max(time + (started.size > 1 ? GAP : 0), context.currentTime + LEAD);
            later(time - context.currentTime, () => {
                current = index;
                onChunk(index);
            });
        }
        const buffer = context.createBuffer(1, block.length, SAMPLE_RATE);
        buffer.copyToChannel(block, 0);
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        source.onended = () => sources.delete(source);
        source.start(time);
        sources.add(source);
        time += block.length / SAMPLE_RATE;
    };

    // The worker's messages - a block, or a chunk's end (the next asked for, or the end announced when it's heard)
    const onMessage = ({data}) => {
        if (data.id !== playback) {
            return;
        }
        if (data.block !== undefined) {
            scheduleBlock(data.index, data.block);
        } else if (next < chunks.length) {
            requestNext();
        } else {
            later(time - context.currentTime, () => {
                playing = false;
                closeContext();
                onEnd();
            });
        }
    };

    // Close the audio context (and stop its sources and timers)
    const closeContext = () => {
        clearTimers();
        held.length = 0;
        for (const source of sources) {
            source.onended = null;
            source.stop();
        }
        sources.clear();
        context?.close();
        context = null;
    };

    return {
        voices,

        // Whether it's reading (not paused), and whether it's paused
        'isPlaying': () => playing && !paused,
        'isPaused': () => paused,

        // Read chunks from an index - settings {voice, rate}. (Call it from a user gesture, so the audio may start.)
        'play': (newChunks, start, newSettings) => {
            playback += 1;
            closeContext();
            if (worker === null) {
                worker = createWorker();
                worker.onmessage = onMessage;
            }
            context = new window.AudioContext({'sampleRate': SAMPLE_RATE});
            unlockAudio(window, context);
            chunks = newChunks;
            settings = newSettings;
            next = start;
            current = start;
            time = 0;
            started = new Set();
            playing = true;
            paused = false;
            requestNext();
        },

        // Pause - the audio and its timers held
        'pause': () => {
            if (playing && !paused) {
                paused = true;
                held.push(...clearTimers());
                context.suspend();
            }
        },

        // Resume a pause - the audio from the very sample, the timers re-armed on its clock
        'resume': () => {
            if (paused) {
                paused = false;
                context.resume();
                for (const entry of held.splice(0)) {
                    arm(entry);
                }
            }
        },

        // Stop reading - the index of the chunk being heard
        'stop': () => {
            playback += 1;
            playing = false;
            paused = false;
            closeContext();
            return current;
        }
    };
}
