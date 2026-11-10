// Licensed under the MIT License
// https://github.com/craigahobbs/picoread/blob/main/LICENSE

// A page photo as it's stored - no larger than MAX_PHOTO_SIDE on its longer side (PicoOCR analyzes a page at 2400
// pixels - lib/index.js MAX_PAGE_SIDE - so more is only storage), upright (createImageBitmap applies the photo's EXIF
// orientation), as a JPEG - and turned or flipped (transformPhoto), for a page photographed sideways or mirrored.


// The stored photo's longer side, at most, and its JPEG quality
export const MAX_PHOTO_SIDE = 2400;
export const JPEG_QUALITY = 0.85;

// The transforms - rotated a quarter turn left or right, or flipped horizontally or vertically
export const TRANSFORMS = ['left', 'right', 'horizontal', 'vertical'];


// A canvas as a JPEG - a Promise of a Blob
function encodeCanvas(canvas) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob === null) {
                reject(new Error('the photo could not be encoded'));
            } else {
                resolve(blob);
            }
        }, 'image/jpeg', JPEG_QUALITY);
    });
}


// A photo file (a File or Blob) as the stored photo - a Promise of a JPEG Blob
export async function preparePhoto(window, file) {
    const bitmap = await window.createImageBitmap(file);
    const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = window.document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return encodeCanvas(canvas);
}


// A stored photo transformed (one of TRANSFORMS) - a Promise of a JPEG Blob
export async function transformPhoto(window, blob, transform) {
    const bitmap = await window.createImageBitmap(blob);
    const {width, height} = bitmap;
    const turn = transform === 'left' || transform === 'right';
    const canvas = window.document.createElement('canvas');
    canvas.width = turn ? height : width;
    canvas.height = turn ? width : height;
    const context = canvas.getContext('2d');
    if (transform === 'right') {
        context.translate(height, 0);
        context.rotate(Math.PI / 2);
    } else if (transform === 'left') {
        context.translate(0, width);
        context.rotate(-Math.PI / 2);
    } else if (transform === 'horizontal') {
        context.translate(width, 0);
        context.scale(-1, 1);
    } else {
        context.translate(0, height);
        context.scale(1, -1);
    }
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    return encodeCanvas(canvas);
}
