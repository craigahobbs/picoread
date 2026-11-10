// Licensed under the MIT License
// https://github.com/craigahobbs/webbo/blob/main/LICENSE

// The OCR worker - PicoOCR reading a page photo in a Web Worker, so the page stays responsive (a page takes seconds).
// The app sends one photo at a time.
//
// Message in: {id, blob} - a page's id and its photo
// Messages out: {id, progress} (0 to 1, after each text line), then {id, text, confidence} or {id, error}

import {recognize} from 'picoocr/lib/index.js';


// A photo's RGBA pixels (an ImageData)
async function photoPixels(blob) {
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    return context.getImageData(0, 0, canvas.width, canvas.height);
}


self.onmessage = async ({data}) => {
    const {id, blob} = data;
    try {
        const image = await photoPixels(blob);
        const result = recognize(image, {'onProgress': (done, total) => self.postMessage({id, 'progress': done / total})});
        const confidences = result.lines.map((line) => line.confidence);
        const confidence = confidences.length === 0 ? 0 : confidences.reduce((sum, value) => sum + value, 0) / confidences.length;
        self.postMessage({id, 'text': result.text, confidence});
    } catch (error) {
        self.postMessage({id, 'error': error.message});
    }
};
