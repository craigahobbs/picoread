// Licensed under the MIT License
// https://github.com/craigahobbs/webbo/blob/main/LICENSE

// A document's text for reading aloud. A page's recognized text has its printed line breaks (PicoOCR - a line break
// between lines, a blank line between paragraphs); for speech, a paragraph's lines are joined (a word hyphenated at a
// line's end rejoined), and the paragraphs are cut into chunks - sentences, a long sentence at its commas or spaces -
// each spoken as one utterance (long utterances stall some speech engines).


// The longest chunk, in characters
export const MAX_CHUNK = 200;


// A page's paragraphs - each paragraph's lines joined with spaces, a hyphenated word's halves rejoined
export function paragraphs(text) {
    return text.split(/\n\s*\n/u).map((paragraph) => paragraph.split('\n').reduce((joined, line) => {
        const trimmed = line.trim();
        if (joined === '') {
            return trimmed;
        }
        if (/\p{L}-$/u.test(joined) && /^\p{Ll}/u.test(trimmed)) {
            return joined.slice(0, -1) + trimmed;
        }
        return trimmed === '' ? joined : `${joined} ${trimmed}`;
    }, '')).filter((paragraph) => paragraph !== '');
}


// A paragraph's sentences - each ends at a ".", "!", "?", or "…" (and any closing quotes or brackets) before a space
export function sentences(paragraph) {
    return paragraph.split(/(?<=[.!?…]["'”’)\]]*)\s+/u).filter((sentence) => sentence !== '');
}


// A sentence as chunks of at most maxChunk characters - cut after its last comma, semicolon, or colon that fits, else
// its last space that fits, else at maxChunk
export function chunkSentence(sentence, maxChunk = MAX_CHUNK) {
    const chunks = [];
    let rest = sentence;
    while (rest.length > maxChunk) {
        const head = rest.slice(0, maxChunk + 1);
        const punctuation = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(': '));
        const space = head.lastIndexOf(' ');
        const cut = punctuation > 0 ? punctuation + 1 : (space > 0 ? space : maxChunk);
        chunks.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
    }
    if (rest !== '') {
        chunks.push(rest);
    }
    return chunks;
}


// A document's chunks for reading - [{page, text}], each page's paragraphs' sentences' chunks in order
export function readingChunks(pageTexts) {
    const chunks = [];
    for (const [page, text] of pageTexts.entries()) {
        for (const paragraph of paragraphs(text)) {
            for (const sentence of sentences(paragraph)) {
                for (const chunk of chunkSentence(sentence)) {
                    chunks.push({page, 'text': chunk});
                }
            }
        }
    }
    return chunks;
}


// A document's text for copying or saving - each page's paragraphs, a blank line between paragraphs and pages
export function documentText(pageTexts) {
    return pageTexts.flatMap((text) => paragraphs(text)).join('\n\n');
}
