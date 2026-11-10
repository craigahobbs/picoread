// Licensed under the MIT License
// https://github.com/craigahobbs/picoocr/blob/main/LICENSE

// Gray images and the recognizer's line input. A gray image is {width, height, data} - data a Float32Array of
// luminance (0 black, 255 white), row-major.
//
// lineInput is the one definition of what the recognizer sees, shared exactly with the training data
// (train/src/picoocr_train/image.py is its port, checked against this module's outputs - tools/parity.js): a text
// line's ink box, padded, scaled to LINE_HEIGHT pixels high, its contrast normalized (ink 1, paper 0), and framed by
// LINE_MARGIN columns of paper on each side - wider than the network's receptive field, so the network's edges never
// reach the text.


// The recognizer's input height, in pixels
export const LINE_HEIGHT = 32;

// The paper columns on each side of a line - at least the network's receptive field radius (45 columns), and a
// multiple of LINE_STRIDE
export const LINE_MARGIN = 48;

// The network's horizontal downsampling - a line's width is padded to a multiple of it
export const LINE_STRIDE = 4;

// The ink box's padding on each side, a fraction of its height
export const LINE_PAD = 0.1;

// The contrast normalization: the ink level is this percentile of the line's pixels, the paper level this one
export const INK_PERCENTILE = 0.01;
export const PAPER_PERCENTILE = 0.9;

// The smallest ink-to-paper range normalized (a blank line's noise isn't amplified)
export const MIN_CONTRAST = 16;


// The gray image of an RGBA image ({width, height, data} - an ImageData, or alike)
export function grayImage(image) {
    const {width, height, data} = image;
    const gray = new Float32Array(width * height);
    for (let ix = 0, px = 0; ix < gray.length; ix++, px += 4) {
        gray[ix] = 0.299 * data[px] + 0.587 * data[px + 1] + 0.114 * data[px + 2];
    }
    return {width, height, 'data': gray};
}


// The resampling weights from a source axis to a destination axis - a tent filter as wide as the scale when
// shrinking (an average of the covered pixels) and bilinear interpolation when enlarging. Each destination pixel has
// a start source index, a count, and its normalized weights (rows of maxCount).
export function resampleWeights(srcSize, dstSize) {
    const scale = srcSize / dstSize;
    const support = Math.max(1, scale);
    const maxCount = Math.ceil(2 * support) + 2;
    const starts = new Int32Array(dstSize);
    const counts = new Int32Array(dstSize);
    const weights = new Float32Array(dstSize * maxCount);
    const values = new Float64Array(maxCount);
    for (let dst = 0; dst < dstSize; dst++) {
        const center = (dst + 0.5) * scale;
        const start = Math.max(0, Math.floor(center - support));
        const end = Math.min(srcSize, Math.ceil(center + support));
        let total = 0;
        for (let src = start; src < end; src++) {
            const weight = Math.max(0, 1 - Math.abs((src + 0.5 - center) / support));
            values[src - start] = weight;
            total += weight;
        }
        for (let src = start; src < end; src++) {
            weights[dst * maxCount + src - start] = values[src - start] / total;
        }
        starts[dst] = start;
        counts[dst] = end - start;
    }
    return {starts, counts, weights, maxCount};
}


// Resize a gray image - each axis resampled (resampleWeights), the rows first (the arrays in locals - no property
// lookups in the loops, for engines without a JIT)
export function resize(image, width, height) {
    const {'starts': acrossStarts, 'counts': acrossCounts, 'weights': acrossWeights, 'maxCount': acrossMax} =
        resampleWeights(image.width, width);
    const {'starts': downStarts, 'counts': downCounts, 'weights': downWeights, 'maxCount': downMax} = resampleWeights(image.height, height);
    const source = image.data;
    const srcWidth = image.width;
    const rows = new Float32Array(width * image.height);
    for (let row = 0; row < image.height; row++) {
        const inBase = row * srcWidth;
        const outBase = row * width;
        for (let column = 0; column < width; column++) {
            const start = inBase + acrossStarts[column];
            const weightBase = column * acrossMax;
            const count = acrossCounts[column];
            let sum = 0;
            for (let ix = 0; ix < count; ix++) {
                sum += acrossWeights[weightBase + ix] * source[start + ix];
            }
            rows[outBase + column] = sum;
        }
    }
    const data = new Float32Array(width * height);
    for (let row = 0; row < height; row++) {
        const weightBase = row * downMax;
        const outBase = row * width;
        const count = downCounts[row];
        for (let ix = 0; ix < count; ix++) {
            const weight = downWeights[weightBase + ix];
            const inBase = (downStarts[row] + ix) * width;
            for (let column = 0; column < width; column++) {
                data[outBase + column] += weight * rows[inBase + column];
            }
        }
    }
    return {width, height, data};
}


// A gray image at half size - each pixel the mean of a 2x2 block (an odd last row or column dropped)
export function halve(image) {
    const width = Math.floor(image.width / 2);
    const height = Math.floor(image.height / 2);
    const source = image.data;
    const srcWidth = image.width;
    const data = new Float32Array(width * height);
    for (let row = 0; row < height; row++) {
        let ix = 2 * row * srcWidth;
        for (let column = 0, out = row * width; column < width; column++, out++, ix += 2) {
            data[out] = (source[ix] + source[ix + 1] + source[ix + srcWidth] + source[ix + srcWidth + 1]) / 4;
        }
    }
    return {width, height, data};
}


// A gray image no larger than maxSide pixels on its longer side (the image itself if it's small enough)
export function limitSize(image, maxSide) {
    const scale = maxSide / Math.max(image.width, image.height);
    if (scale >= 1) {
        return image;
    }
    return resize(image, Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
}


// A gray image rotated about its center (bilinear, the edge pixels extended), so that text lines sloping at angle
// (radians - positive when a line descends to the right) are level. (No Math calls in the per-pixel loop - comparisons
// clamp, and "| 0" floors the non-negative coordinates - for engines without a JIT.)
export function rotate(image, angle) {
    const {width, height} = image;
    const source = image.data;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const centerX = (width - 1) / 2;
    const centerY = (height - 1) / 2;
    const maxX = width - 1;
    const maxY = height - 1;
    const data = new Float32Array(width * height);
    for (let row = 0; row < height; row++) {
        const dy = row - centerY;
        for (let column = 0; column < width; column++) {
            const dx = column - centerX;
            let srcX = centerX + dx * cos - dy * sin;
            let srcY = centerY + dx * sin + dy * cos;
            srcX = srcX < 0 ? 0 : (srcX > maxX ? maxX : srcX);
            srcY = srcY < 0 ? 0 : (srcY > maxY ? maxY : srcY);
            const x0 = srcX | 0;
            const y0 = srcY | 0;
            const x1 = x0 < maxX ? x0 + 1 : maxX;
            const y1 = y0 < maxY ? y0 + 1 : maxY;
            const fx = srcX - x0;
            const fy = srcY - y0;
            const top = source[y0 * width + x0] * (1 - fx) + source[y0 * width + x1] * fx;
            const bottom = source[y1 * width + x0] * (1 - fx) + source[y1 * width + x1] * fx;
            data[row * width + column] = top * (1 - fy) + bottom * fy;
        }
    }
    return {width, height, data};
}


// A gray image flipped - horizontally (mirrored), vertically, or both (rotated 180 degrees)
export function flip(image, horizontal, vertical) {
    const {width, height} = image;
    const data = new Float32Array(width * height);
    for (let row = 0; row < height; row++) {
        const srcRow = vertical ? height - 1 - row : row;
        for (let column = 0; column < width; column++) {
            data[row * width + column] = image.data[srcRow * width + (horizontal ? width - 1 - column : column)];
        }
    }
    return {width, height, data};
}


// A region of a gray image - the edge pixels extended outside it
export function crop(image, left, top, width, height) {
    const data = new Float32Array(width * height);
    for (let row = 0; row < height; row++) {
        const srcY = Math.min(image.height - 1, Math.max(0, top + row));
        for (let column = 0; column < width; column++) {
            const srcX = Math.min(image.width - 1, Math.max(0, left + column));
            data[row * width + column] = image.data[srcY * image.width + srcX];
        }
    }
    return {width, height, data};
}


// The recognizer's input for a text line - box {x, y, width, height}, its ink box in the page (a gray image). The
// input is a gray image of ink levels (0 paper to 1 ink), LINE_HEIGHT high, the line's scaled width plus the margins,
// padded to a multiple of LINE_STRIDE.
export function lineInput(page, box) {
    const pad = Math.round(LINE_PAD * box.height);
    const cropWidth = box.width + 2 * pad;
    const cropHeight = box.height + 2 * pad;
    const scaledWidth = Math.max(1, Math.round((cropWidth * LINE_HEIGHT) / cropHeight));
    const line = resize(crop(page, box.x - pad, box.y - pad, cropWidth, cropHeight), scaledWidth, LINE_HEIGHT);

    // The ink and paper levels
    const sorted = Float32Array.from(line.data).sort();
    const ink = sorted[Math.floor(INK_PERCENTILE * (sorted.length - 1))];
    const paper = sorted[Math.floor(PAPER_PERCENTILE * (sorted.length - 1))];
    const range = Math.max(MIN_CONTRAST, paper - ink);

    // The normalized line, framed by its margins
    const width = Math.ceil((scaledWidth + 2 * LINE_MARGIN) / LINE_STRIDE) * LINE_STRIDE;
    const data = new Float32Array(width * LINE_HEIGHT);
    for (let row = 0; row < LINE_HEIGHT; row++) {
        for (let column = 0; column < scaledWidth; column++) {
            const level = (paper - line.data[row * scaledWidth + column]) / range;
            data[row * width + LINE_MARGIN + column] = Math.min(1, Math.max(0, level));
        }
    }
    return {width, 'height': LINE_HEIGHT, data};
}
