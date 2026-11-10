// Licensed under the MIT License
// https://github.com/craigahobbs/picoread/blob/main/LICENSE

// The speech worker - PicoVox synthesizing a chunk of text (a sentence - lib/text.js readingChunks) in a Web Worker,
// so the page stays responsive. The reader (lib/reader.js) asks for one chunk at a time, as playback needs it.
//
// Message in: {id, index, text, voice, rate} - a playback's id, the chunk's index and text, and the voice and speed
// Messages out: {id, index, block} (each block of samples - 24 kHz, mono), then {id, index, 'done': true} or
// {id, index, error}

import {stream} from '../picovox/lib/index.js';


// The noise seed of a document's first chunk (each chunk's is the next - the voice varies naturally from one to the
// next)
const SEED = 1000;


self.onmessage = async ({data}) => {
    const {id, index, text, voice, rate} = data;
    try {
        for await (const block of stream(text, {voice, rate, 'seed': SEED + index})) {
            // (a copy, transferred - a block may be a view of the synthesizer's buffer)
            const copy = block.slice();
            self.postMessage({id, index, 'block': copy}, [copy.buffer]);
        }
        self.postMessage({id, index, 'done': true});
    } catch (error) {
        self.postMessage({id, index, 'error': error.message});
    }
};
