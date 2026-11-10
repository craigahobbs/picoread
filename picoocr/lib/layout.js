// Licensed under the MIT License
// https://github.com/craigahobbs/picoocr/blob/main/LICENSE

// Page layout - a page's text lines in reading order, found without a network: the page binarized (Sauvola), its
// ink's connected components, the components grouped into lines (each line's band followed left to right, so gently
// curved lines hold together), the small marks (dots, accents, quotes, commas) attached to their lines, and the lines
// put in reading order (readingOrder - columns left to right, the lines spanning them dividing the page into bands) and
// broken into paragraphs. The skew is measured from the components' bottoms (skewAngle) so the page can be leveled
// first (lib/index.js).


// Sauvola's sensitivity and dynamic range, and the window radius bounds (pixels). The sensitivity is lower than the
// usual 0.2: a dim, noisy photo's thin strokes are little darker than its paper, and 0.2 broke them into specks
// (DESIGN.md - the test pages' error rates were best from 0.075 to 0.125).
const SAUVOLA_K = 0.1;
const SAUVOLA_R = 128;
const MIN_RADIUS = 8;
const MAX_RADIUS = 40;

// The skew search - the largest skew (radians), the coarse and fine steps, and the coarse histogram's bin (a fraction of
// the median component height - the fine histogram's is a pixel)
const MAX_SKEW = (15 * Math.PI) / 180;
const COARSE_STEP = (0.5 * Math.PI) / 180;
const FINE_STEP = (0.05 * Math.PI) / 180;
const COARSE_BIN = 0.25;

// A component is a character-size ("core") component if its height is within these multiples of the median height
// (the median is about the x-height - most letters are lowercase, and every character is at least half of it);
// smaller ones are marks (dots, quotes, commas, dashes), larger ones (figures, rules, borders) are dropped
const CORE_MIN = 0.5;
const CORE_MAX = 4;

// A component joins a line if it overlaps the line's band by this fraction of the smaller height and the gap to the
// line is at most this many band heights
const JOIN_OVERLAP = 0.5;
const JOIN_GAP = 1.5;

// The members a line's band is the median of (its most recent)
const BAND_MEMBERS = 5;

// A small mark attaches to the nearest line within this many line heights
const ATTACH_DISTANCE = 0.6;

// Two lines merge if they overlap by this fraction of the smaller height (and are within the join gap)
const MERGE_OVERLAP = 0.6;

// Noise, not a line: a line lower than MIN_LINE of the median line height (of lines of at least FEW_MEMBERS + 1
// components), or lower than FEW_LINE with at most FEW_MEMBERS components (specks, a page's edge)
const MIN_LINE = 0.4;
const FEW_LINE = 0.6;
const FEW_MEMBERS = 2;

// The reading order: a column gap of at least this many median component heights; at most this fraction of a group's
// lines set aside as spanning its columns; a paragraph break at a line gap of at least this many median line heights
const COLUMN_GAP = 1;
const MAX_SPANNING = 0.5;
const PARAGRAPH_GAP = 0.75;


// The binary image of a gray image (Uint8Array, 1 for ink) - Sauvola's local threshold over a square window, its
// sums kept by column as the rows advance. (Its loop runs once per pixel, without a JIT too - so no Math calls in it:
// each column's window width is computed ahead, and the threshold's square root is compared squared.)
export function binarize(image) {
    const {width, height, data} = image;
    const radius = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, Math.round(Math.max(width, height) / 100)));
    const binary = new Uint8Array(width * height);
    const columnSum = new Float64Array(width);
    const columnSquares = new Float64Array(width);

    // Each column's window width
    const windowWidths = new Float64Array(width);
    for (let column = 0; column < width; column++) {
        windowWidths[column] = Math.min(width - 1, column + radius) - Math.max(0, column - radius) + 1;
    }

    // The column sums of the window's first rows
    for (let row = 0; row < Math.min(height, radius); row++) {
        for (let column = 0; column < width; column++) {
            const value = data[row * width + column];
            columnSum[column] += value;
            columnSquares[column] += value * value;
        }
    }
    const offset = 1 - SAUVOLA_K;
    const slope = SAUVOLA_K / SAUVOLA_R;
    for (let row = 0; row < height; row++) {
        // Advance the window's rows
        const enter = row + radius;
        if (enter < height) {
            for (let column = 0, ix = enter * width; column < width; column++, ix++) {
                const value = data[ix];
                columnSum[column] += value;
                columnSquares[column] += value * value;
            }
        }
        const leave = row - radius - 1;
        if (leave >= 0) {
            for (let column = 0, ix = leave * width; column < width; column++, ix++) {
                const value = data[ix];
                columnSum[column] -= value;
                columnSquares[column] -= value * value;
            }
        }
        const rows = Math.min(height - 1, row + radius) - Math.max(0, row - radius) + 1;

        // Slide the window across the row - a pixel is ink if it's below mean * (1 + k * (deviation / R - 1)), that is
        // value - mean * (1 - k) < (mean * k / R) * deviation: below if the left side is negative, else if its square
        // is below the right side's
        let sum = 0;
        let squares = 0;
        for (let column = 0; column < Math.min(width, radius); column++) {
            sum += columnSum[column];
            squares += columnSquares[column];
        }
        const base = row * width;
        for (let column = 0; column < width; column++) {
            const enterColumn = column + radius;
            if (enterColumn < width) {
                sum += columnSum[enterColumn];
                squares += columnSquares[enterColumn];
            }
            const leaveColumn = column - radius - 1;
            if (leaveColumn >= 0) {
                sum -= columnSum[leaveColumn];
                squares -= columnSquares[leaveColumn];
            }
            const count = rows * windowWidths[column];
            const mean = sum / count;
            const variance = squares / count - mean * mean;
            const below = data[base + column] - mean * offset;
            if (below < 0) {
                binary[base + column] = 1;
            } else if (variance > 0) {
                const scaled = mean * slope;
                if (below * below < scaled * scaled * variance) {
                    binary[base + column] = 1;
                }
            }
        }
    }
    return binary;
}


// The connected components (8-connected) of a binary image - boxes {x0, y0, x1, y1, area} (x1 and y1 exclusive) -
// one pass labeling the pixels (union-find over the labels), each label's box merged into its root's
const ROOT_FIELDS = 5;

export function components(binary, width, height) {
    const labels = new Int32Array(width * height);
    const parent = [0];
    const stats = [0, 0, 0, 0, 0];

    // The root of a label (with path halving)
    const find = (label) => {
        let root = label;
        while (parent[root] !== root) {
            parent[root] = parent[parent[root]];
            root = parent[root];
        }
        return root;
    };

    // Join two labels' sets (the smaller root kept)
    const union = (first, second) => {
        const firstRoot = find(first);
        const secondRoot = find(second);
        if (firstRoot < secondRoot) {
            parent[secondRoot] = firstRoot;
        } else {
            parent[firstRoot] = secondRoot;
        }
    };

    for (let row = 0; row < height; row++) {
        for (let column = 0; column < width; column++) {
            const ix = row * width + column;
            if (binary[ix] === 0) {
                continue;
            }

            // The labeled neighbors - left, up-left, up, and up-right: the first the pixel's label, the others joined to it
            // (written out - no call per neighbor, for engines without a JIT)
            let label = column > 0 ? labels[ix - 1] : 0;
            if (row > 0) {
                const up = ix - width;
                const upLeft = column > 0 ? labels[up - 1] : 0;
                const upCenter = labels[up];
                const upRight = column + 1 < width ? labels[up + 1] : 0;
                if (upLeft !== 0) {
                    if (label === 0) {
                        label = upLeft;
                    } else if (upLeft !== label) {
                        union(label, upLeft);
                    }
                }
                if (upCenter !== 0) {
                    if (label === 0) {
                        label = upCenter;
                    } else if (upCenter !== label) {
                        union(label, upCenter);
                    }
                }
                if (upRight !== 0) {
                    if (label === 0) {
                        label = upRight;
                    } else if (upRight !== label) {
                        union(label, upRight);
                    }
                }
            }

            // A new label, or the pixel added to its label's box
            if (label === 0) {
                label = parent.length;
                parent.push(label);
                stats.push(column, row, column + 1, row + 1, 1);
            } else {
                const base = label * ROOT_FIELDS;
                stats[base] = Math.min(stats[base], column);
                stats[base + 2] = Math.max(stats[base + 2], column + 1);
                stats[base + 3] = row + 1;
                stats[base + 4] += 1;
            }
            labels[ix] = label;
        }
    }

    // Merge each label's box into its root's
    const boxes = new Map();
    for (let label = 1; label < parent.length; label++) {
        const root = find(label);
        const base = label * ROOT_FIELDS;
        const box = boxes.get(root);
        if (box === undefined) {
            const [x0, y0, x1, y1, area] = stats.slice(base, base + ROOT_FIELDS);
            boxes.set(root, {x0, y0, x1, y1, area});
        } else {
            box.x0 = Math.min(box.x0, stats[base]);
            box.y0 = Math.min(box.y0, stats[base + 1]);
            box.x1 = Math.max(box.x1, stats[base + 2]);
            box.y1 = Math.max(box.y1, stats[base + 3]);
            box.area += stats[base + 4];
        }
    }
    return Array.from(boxes.values());
}


// The median of numbers (0 if none)
export function median(values) {
    if (values.length === 0) {
        return 0;
    }
    const sorted = Float64Array.from(values).sort();
    return sorted[Math.floor((sorted.length - 1) / 2)];
}


// The page's components that may be text - not touching the image's edge (the page's surroundings) and not noise -
// and their median height
export function textComponents(binary, width, height) {
    const boxes = components(binary, width, height).filter((box) => (
        box.x0 > 0 && box.y0 > 0 && box.x1 < width && box.y1 < height && box.area >= 4 && box.y1 - box.y0 >= 2
    ));
    return {boxes, 'medianHeight': median(boxes.map((box) => box.y1 - box.y0))};
}


// The skew angle (radians - positive when lines descend to the right) at which the core components' bottoms line up
// best: the sharpest histogram (sum of squared bin counts) of the bottoms projected across the angle
export function skewAngle(boxes, medianHeight) {
    const points = boxes.filter((box) => {
        const boxHeight = box.y1 - box.y0;
        return boxHeight >= CORE_MIN * medianHeight && boxHeight <= CORE_MAX * medianHeight;
    }).map((box) => [(box.x0 + box.x1) / 2, box.y1]);
    if (points.length < 2) {
        return 0;
    }
    const xMax = Math.max(...points.map(([column]) => column));
    const yMax = Math.max(...points.map(([, row]) => row));
    const offset = Math.ceil(xMax * Math.tan(MAX_SKEW + COARSE_STEP)) + 1;
    const histogram = new Float64Array(Math.ceil(yMax + 2 * offset) + 1);

    // The sharpness at an angle, for a bin size
    const score = (angle, binSize) => {
        histogram.fill(0);
        const tan = Math.tan(angle);
        let sum = 0;
        for (const [column, row] of points) {
            const bin = Math.floor((row - column * tan + offset) / binSize);
            sum += 2 * histogram[bin] + 1;
            histogram[bin] += 1;
        }
        return sum;
    };

    // The best angle of a range (the middle of equals)
    const search = (from, to, step, binSize) => {
        const scores = [];
        const steps = Math.round((to - from) / step);
        for (let ix = 0; ix <= steps; ix++) {
            scores.push(score(from + ix * step, binSize));
        }
        const bestScore = Math.max(...scores);
        const first = scores.indexOf(bestScore);
        let last = first;
        while (last + 1 < scores.length && scores[last + 1] === bestScore) {
            last += 1;
        }
        return from + ((first + last) / 2) * step;
    };
    const coarse = search(-MAX_SKEW, MAX_SKEW, COARSE_STEP, Math.max(1, COARSE_BIN * medianHeight));
    return search(coarse - COARSE_STEP, coarse + COARSE_STEP, FINE_STEP, 1);
}


// A line's band - the median top and bottom of its most recent members
function lineBand(line) {
    const recent = line.members.slice(-BAND_MEMBERS);
    line.bandTop = median(recent.map((box) => box.y0));
    line.bandBottom = median(recent.map((box) => box.y1));
}


// A new line of a component
function newLine(box) {
    const line = {'x0': box.x0, 'y0': box.y0, 'x1': box.x1, 'y1': box.y1, 'members': [box], 'marks': [], 'bandTop': 0, 'bandBottom': 0};
    lineBand(line);
    return line;
}


// Add a component's box to a line's
function extendLine(line, box) {
    line.x0 = Math.min(line.x0, box.x0);
    line.y0 = Math.min(line.y0, box.y0);
    line.x1 = Math.max(line.x1, box.x1);
    line.y1 = Math.max(line.y1, box.y1);
}


// The vertical overlap of two spans as a fraction of the smaller
function overlapFraction(top0, bottom0, top1, bottom1) {
    return (Math.min(bottom0, bottom1) - Math.max(top0, top1)) / Math.min(bottom0 - top0, bottom1 - top1);
}


// Group the text components into lines - boxes {x0, y0, x1, y1, members, marks} (unordered) - the character-size
// components joining lines (members), then the small marks attached (marks), and the noise dropped
export function groupLines(boxes, medianHeight) {
    const core = [];
    const small = [];
    for (const box of boxes) {
        const boxHeight = box.y1 - box.y0;
        if (boxHeight >= CORE_MIN * medianHeight && boxHeight <= CORE_MAX * medianHeight) {
            core.push(box);
        } else if (boxHeight < CORE_MIN * medianHeight) {
            small.push(box);
        }
    }

    // The core components, left to right, each joining the line whose band it overlaps most
    core.sort((box0, box1) => box0.x0 - box1.x0 || box0.y0 - box1.y0);
    let lines = [];
    for (const box of core) {
        let best = null;
        let bestOverlap = JOIN_OVERLAP;
        for (const line of lines) {
            const bandHeight = line.bandBottom - line.bandTop;
            const gap = box.x0 - line.x1;
            if (gap <= JOIN_GAP * bandHeight && gap >= -2 * bandHeight) {
                const overlap = overlapFraction(box.y0, box.y1, line.bandTop, line.bandBottom);
                if (overlap >= bestOverlap) {
                    best = line;
                    bestOverlap = overlap;
                }
            }
        }
        if (best === null) {
            lines.push(newLine(box));
        } else {
            best.members.push(box);
            extendLine(best, box);
            lineBand(best);
        }
    }

    // Merge lines that overlap (a line started twice)
    lines = mergeLines(lines);

    // Attach each small mark to the nearest line, the marks left to right - a line's reach across extends with each mark
    // attached (a closing quote after a dash reaches its line), its reach up and down is its characters' (an accent's
    // height doesn't take the line above's marks)
    const reach = new Map(lines.map((line) => [line, {'x0': line.x0, 'x1': line.x1, 'y0': line.y0, 'y1': line.y1}]));
    for (const box of [...small].sort((box0, box1) => box0.x0 - box1.x0)) {
        const centerX = (box.x0 + box.x1) / 2;
        const centerY = (box.y0 + box.y1) / 2;
        let nearest = null;
        let nearestDistance = Infinity;
        for (const line of lines) {
            const lineReach = reach.get(line);
            const lineHeight = lineReach.y1 - lineReach.y0;
            if (centerX >= lineReach.x0 - lineHeight && centerX <= lineReach.x1 + lineHeight) {
                const distance = Math.max(0, lineReach.y0 - centerY, centerY - lineReach.y1);
                if (distance <= ATTACH_DISTANCE * lineHeight && distance < nearestDistance) {
                    nearest = line;
                    nearestDistance = distance;
                }
            }
        }
        if (nearest !== null) {
            nearest.marks.push(box);
            extendLine(nearest, box);
            const nearestReach = reach.get(nearest);
            nearestReach.x0 = Math.min(nearestReach.x0, box.x0);
            nearestReach.x1 = Math.max(nearestReach.x1, box.x1);
        }
    }

    // Merge lines again - a line split at a mark (an em dash between words) is one, its mark attached
    lines = mergeLines(lines);

    // Drop the noise
    const height = (line) => line.y1 - line.y0;
    const lineHeight = median(lines.filter((line) => line.members.length > FEW_MEMBERS).map(height)) || median(lines.map(height));
    return lines.filter((line) => (
        height(line) >= MIN_LINE * lineHeight && (height(line) >= FEW_LINE * lineHeight || line.members.length > FEW_MEMBERS)
    ));
}


// Merge lines that overlap a line on its row by MERGE_OVERLAP and are within the join gap (of the larger band - the
// larger line sets the word spacing's scale) of it - the lines
function mergeLines(lines) {
    let merged = lines;
    let merging = true;
    while (merging) {
        merging = false;
        for (let ix = 0; ix < merged.length && !merging; ix++) {
            for (let jx = ix + 1; jx < merged.length && !merging; jx++) {
                const [line0, line1] = [merged[ix], merged[jx]];
                const bandHeight = Math.max(line0.bandBottom - line0.bandTop, line1.bandBottom - line1.bandTop);
                const gap = Math.max(line0.x0, line1.x0) - Math.min(line0.x1, line1.x1);
                if (gap <= JOIN_GAP * bandHeight && overlapFraction(line0.y0, line0.y1, line1.y0, line1.y1) >= MERGE_OVERLAP) {
                    line0.members.push(...line1.members);
                    line0.members.sort((box0, box1) => box0.x0 - box1.x0);
                    line0.marks.push(...line1.marks);
                    extendLine(line0, line1);
                    lineBand(line0);
                    merged = merged.filter((line) => line !== line1);
                    merging = true;
                }
            }
        }
    }
    return merged;
}


// Split lines at column gaps of at least minGap - the columns (left to right), or null if there's no such gap
function columnGroups(lines, minGap) {
    const sorted = [...lines].sort((line0, line1) => line0.x0 - line1.x0);
    const groups = [[sorted[0]]];
    let reach = sorted[0].x1;
    for (const line of sorted.slice(1)) {
        if (line.x0 - reach >= minGap) {
            groups.push([]);
        }
        groups[groups.length - 1].push(line);
        reach = Math.max(reach, line.x1);
    }
    return groups.length > 1 ? groups : null;
}


// A line's vertical center
function lineCenter(line) {
    return (line.y0 + line.y1) / 2;
}


// Order lines for reading. A group with columns is read a column at a time, left to right. A group without columns
// may have lines spanning them (a title, a caption): its widest lines are set aside, one at a time (at most
// MAX_SPANNING of them), until the rest have columns - then the spanning lines divide the rest into bands, each read
// in turn (a band's columns, then the spanning line below it). A group with neither is read top to bottom. Each line
// gets "paragraph" - true if it starts what's read top to bottom or follows a wide line gap.
export function readingOrder(lines, medianHeight) {
    if (lines.length === 0) {
        return [];
    }
    const minGap = COLUMN_GAP * medianHeight;
    const lineHeight = median(lines.map((line) => line.y1 - line.y0));
    const ordered = [];

    // Read lines top to bottom, a row at a time - lines whose centers are within a row's first line are its, left to
    // right
    const readDown = (group) => {
        const rows = [];
        for (const line of [...group].sort((line0, line1) => lineCenter(line0) - lineCenter(line1))) {
            const row = rows.at(-1);
            if (row !== undefined && lineCenter(line) < row[0].y1) {
                row.push(line);
            } else {
                rows.push([line]);
            }
        }
        const sorted = rows.flatMap((row) => row.sort((line0, line1) => line0.x0 - line1.x0));
        for (const [ix, line] of sorted.entries()) {
            line.paragraph = ix === 0 || line.y0 - sorted[ix - 1].y1 >= PARAGRAPH_GAP * lineHeight;
            ordered.push(line);
        }
    };

    // Read a group
    const read = (group) => {
        // Columns
        const columns = group.length > 1 ? columnGroups(group, minGap) : null;
        if (columns !== null) {
            for (const column of columns) {
                read(column);
            }
            return;
        }

        // Spanning lines and the bands between them
        const widest = [...group].sort((line0, line1) => (line1.x1 - line1.x0) - (line0.x1 - line0.x0));
        for (let count = 1; count <= MAX_SPANNING * group.length && group.length - count > 1; count++) {
            const rest = widest.slice(count);
            if (columnGroups(rest, minGap) !== null) {
                const spanning = widest.slice(0, count).sort((line0, line1) => lineCenter(line0) - lineCenter(line1));
                const bounds = [-Infinity, ...spanning.map(lineCenter), Infinity];
                for (const [ix, spanningLine] of [...spanning, null].entries()) {
                    const [lower, upper] = [bounds[ix], bounds[ix + 1]];
                    const band = rest.filter((line) => lineCenter(line) >= lower && lineCenter(line) < upper);
                    if (band.length !== 0) {
                        read(band);
                    }
                    if (spanningLine !== null) {
                        readDown([spanningLine]);
                    }
                }
                return;
            }
        }
        readDown(group);
    };
    read(lines);
    return ordered;
}


// The text lines of a gray page in reading order - {boxes, medianHeight, lines}: the text components and their
// median height, and the lines - {x, y, width, height, paragraph}
export function findLines(page) {
    const binary = binarize(page);
    const {boxes, medianHeight} = textComponents(binary, page.width, page.height);
    const lines = readingOrder(groupLines(boxes, medianHeight), medianHeight).map((line) => ({
        'x': line.x0,
        'y': line.y0,
        'width': line.x1 - line.x0,
        'height': line.y1 - line.y0,
        'paragraph': line.paragraph
    }));
    return {boxes, medianHeight, lines};
}
