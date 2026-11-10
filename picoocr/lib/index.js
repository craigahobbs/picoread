// Licensed under the MIT License
// https://github.com/craigahobbs/picoocr/blob/main/LICENSE

/**
 * PicoOCR - text recognition in pure JavaScript. A page image's text lines are found (lib/layout.js) and each is read
 * by a small neural network (lib/model.js) whose weights are part of the code (lib/models/recognizer.js) - no
 * network requests, no files, no dependencies.
 *
 * @module picoocr
 */

import * as recognizer from './models/recognizer.js';
import {LINE_MARGIN, LINE_STRIDE, flip, grayImage, halve, limitSize, lineInput, rotate} from './image.js';
import {binarize, findLines, skewAngle, textComponents} from './layout.js';
import {decode, forward, loadModel, meanConfidence} from './model.js';


/**
 * The longest side, in pixels, a page is analyzed at - larger pages are scaled down first. At this size a phone photo
 * of a letter-size page puts body text near the recognizer's scale.
 */
export const MAX_PAGE_SIDE = 2400;

// The smallest skew (radians) worth leveling the page for, and the page side above which the skew is measured at half
// size (as accurately - within the search's 0.05 degree steps - for a quarter of the pixels)
const MIN_SKEW = (0.1 * Math.PI) / 180;
const HALVE_SIDE = 1200;


/**
 * The page orientations recognize detects - an orientation's index is its flips: 1 horizontal (mirrored), 2 vertical
 * (both - rotated 180 degrees)
 */
export const ORIENTATIONS = ['upright', 'mirrored', 'upside-down mirrored', 'upside-down'];

// The orientation's evidence - the page's longest lines (at most ORIENT_LINES, each at most ORIENT_WIDTH line heights
// long), and the lead over upright the best orientation needs
const ORIENT_LINES = 3;
const ORIENT_WIDTH = 10;
const ORIENT_LEAD = 0.02;


// The recognizer, loaded on first use
let defaultModel = null;


/**
 * Load the recognizer model (done on first use by recognize - call it to choose when the cost is paid)
 *
 * @param {Object} [module] - A model module ({manifest, weights}); the package's model by default
 * @returns {Object} The loaded model
 */
export function loadRecognizer(module = null) {
    if (module !== null) {
        return loadModel(module);
    }
    defaultModel ??= loadModel(recognizer);
    return defaultModel;
}


/**
 * @typedef {Object} Line
 * @property {string} text - The line's text
 * @property {number} confidence - The recognizer's mean character probability (0 to 1)
 * @property {boolean} paragraph - True if the line starts a paragraph
 * @property {{x: number, y: number, width: number, height: number}} box - The line's box in the leveled page image
 *     (the analyzed page - scaled to MAX_PAGE_SIDE and rotated by the result's angle)
 */


/**
 * @typedef {Object} Result
 * @property {string} text - The page's text - its lines in reading order, a blank line between paragraphs
 * @property {Line[]} lines - The page's text lines in reading order
 * @property {number} angle - The page's measured skew (radians - positive when lines descend to the right)
 * @property {number} scale - The scale the page was analyzed at (1 if it wasn't larger than MAX_PAGE_SIDE)
 * @property {string} orientation - The page's orientation as photographed (one of ORIENTATIONS) - it's read upright
 */


/**
 * Recognize the text of a page image
 *
 * @param {{width: number, height: number, data: Uint8ClampedArray}} image - An RGBA image (an ImageData, or alike)
 * @param {Object} [options] - Options
 * @param {function(number, number): void} [options.onProgress] - Called after each line is read (lines read, lines)
 * @param {Object} [options.model] - A loaded model (loadRecognizer); the package's model by default
 * @param {boolean} [options.orient = true] - Detect a mirrored or upside-down page (and read it upright)
 * @returns {Result} The page's text
 */
export function recognize(image, options = {}) {
    const model = options.model ?? loadRecognizer();
    const fullGray = grayImage(image);
    let page = limitSize(fullGray, MAX_PAGE_SIDE);
    const scale = page.width / fullGray.width;

    // Level the page
    const measured = Math.max(page.width, page.height) > HALVE_SIDE ? halve(page) : page;
    const {boxes, medianHeight} = textComponents(binarize(measured), measured.width, measured.height);
    const angle = skewAngle(boxes, medianHeight);
    if (Math.abs(angle) >= MIN_SKEW) {
        page = rotate(page, angle);
    }

    // Turn the page upright
    let layout = findLines(page);
    const orientation = options.orient === false ? 0 : pageOrientation(model, page, layout.lines);
    if (orientation !== 0) {
        page = flip(page, (orientation & 1) !== 0, (orientation & 2) !== 0);
        layout = findLines(page);
    }

    // Read each line
    const lines = [];
    for (const [ix, box] of layout.lines.entries()) {
        const {text, confidence} = decode(model, forward(model, lineInput(page, box)));
        const lineBox = {'x': box.x, 'y': box.y, 'width': box.width, 'height': box.height};
        lines.push({'text': text.trim(), confidence, 'paragraph': box.paragraph, 'box': lineBox});
        options.onProgress?.(ix + 1, layout.lines.length);
    }
    return {'text': pageText(lines), lines, angle, scale, 'orientation': ORIENTATIONS[orientation]};
}


/**
 * A level page's orientation (an index of ORIENTATIONS) - its longest lines read each way (flipped horizontally,
 * vertically, both), the network surest of the upright way; upright unless another way leads by ORIENT_LEAD
 *
 * @param {Object} model - The loaded model
 * @param {{width: number, height: number, data: Float32Array}} page - The level gray page
 * @param {Object[]} lines - The page's text lines - each {x, y, width, height}
 * @returns {number} The orientation's index
 */
export function pageOrientation(model, page, lines) {
    const sample = [...lines].sort((line0, line1) => line1.width - line0.width).slice(0, ORIENT_LINES).
        map((box) => lineInput(page, {...box, 'width': Math.min(box.width, ORIENT_WIDTH * box.height)}));
    if (sample.length === 0) {
        return 0;
    }
    const scores = ORIENTATIONS.map((_name, index) => {
        let sum = 0;
        for (const line of sample) {
            const scores_ = forward(model, flip(line, (index & 1) !== 0, (index & 2) !== 0));
            sum += meanConfidence(scores_, LINE_MARGIN / LINE_STRIDE, (line.width - LINE_MARGIN) / LINE_STRIDE);
        }
        return sum / sample.length;
    });
    const best = scores.indexOf(Math.max(...scores));
    return scores[best] - scores[0] >= ORIENT_LEAD ? best : 0;
}


/**
 * The text of lines - in order, a line break between lines and a blank line between paragraphs (empty lines skipped)
 *
 * @param {Line[]} lines - The lines
 * @returns {string} The text
 */
export function pageText(lines) {
    let text = '';
    for (const line of lines) {
        if (line.text !== '') {
            if (text !== '') {
                text += line.paragraph ? '\n\n' : '\n';
            }
            text += line.text;
        }
    }
    return text;
}
