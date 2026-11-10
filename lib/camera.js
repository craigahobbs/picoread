// Licensed under the MIT License
// https://github.com/craigahobbs/picoread/blob/main/LICENSE

// The camera - a full-screen viewfinder (getUserMedia - the back camera on a phone, as many pixels as it offers) with a
// shutter that adds each photo as the document's next page, so a document's pages are photographed one after another.
// It's an overlay of its own (not re-rendered with the app), so the video plays on as pages are added. Its mirror
// toggle flips the view and the photos - for a camera (a laptop's, a webcam) whose image is mirrored.


// The camera's requested resolution (the browser gives the nearest it has) and the photos' JPEG quality
const IDEAL_WIDTH = 3840;
const IDEAL_HEIGHT = 2160;
const JPEG_QUALITY = 0.92;


// Whether the browser has a camera API (it needs a secure context - https, or localhost)
export function hasCamera(window) {
    return typeof window.navigator.mediaDevices?.getUserMedia === 'function';
}


// A video's current frame as a JPEG Blob - mirrored, or not
export function captureFrame(window, video, mirror = false) {
    const canvas = window.document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (mirror) {
        context.translate(canvas.width, 0);
        context.scale(-1, 1);
    }
    context.drawImage(video, 0, 0);
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


// Open the camera - mirror (the view and photos flipped, at first), and callbacks onPhoto(blob) (a Promise - the shutter
// waits for it), onError(error) (the camera couldn't start, or a photo failed), onMirror(mirror) (the toggle), and
// onClose(). A Promise of the camera {close()}, or null if it couldn't start.
export async function openCamera(window, {mirror = false, onPhoto, onError, onMirror, onClose}) {
    const {document} = window;
    let stream;
    try {
        stream = await window.navigator.mediaDevices.getUserMedia({
            'audio': false,
            'video': {'facingMode': {'ideal': 'environment'}, 'width': {'ideal': IDEAL_WIDTH}, 'height': {'ideal': IDEAL_HEIGHT}}
        });
    } catch (error) {
        onError(error);
        return null;
    }

    // The viewfinder
    const video = document.createElement('video');
    video.className = 'viewfinder';
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    const count = document.createElement('span');
    count.className = 'camera-count';
    count.setAttribute('aria-live', 'polite');
    const shutter = document.createElement('button');
    shutter.className = 'shutter';
    shutter.setAttribute('aria-label', 'Take photo');
    const done = document.createElement('button');
    done.className = 'camera-done';
    done.textContent = 'Done';
    const mirrorToggle = document.createElement('button');
    mirrorToggle.className = 'camera-mirror';
    mirrorToggle.textContent = '⇋';
    mirrorToggle.setAttribute('aria-label', 'Mirror');
    const ends = document.createElement('div');
    ends.className = 'camera-ends';
    ends.append(mirrorToggle, done);
    const controls = document.createElement('div');
    controls.className = 'camera-controls';
    controls.append(count, shutter, ends);

    // The mirror - the view flipped (the photos as they're taken)
    let mirrored = mirror;
    const showMirror = () => {
        video.style.transform = mirrored ? 'scaleX(-1)' : '';
        mirrorToggle.setAttribute('aria-pressed', String(mirrored));
    };
    showMirror();
    mirrorToggle.addEventListener('click', () => {
        mirrored = !mirrored;
        showMirror();
        onMirror(mirrored);
    });
    const overlay = document.createElement('div');
    overlay.className = 'camera';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Camera');
    overlay.append(video, controls);
    document.body.append(overlay);

    // Close - the camera stopped, the overlay removed
    let photos = 0;
    const close = () => {
        for (const track of stream.getTracks()) {
            track.stop();
        }
        overlay.remove();
        onClose();
    };

    // The shutter - the frame added as a page (one at a time)
    shutter.addEventListener('click', async () => {
        shutter.disabled = true;
        try {
            await onPhoto(await captureFrame(window, video, mirrored));
            photos += 1;
            count.textContent = `${photos} page${photos === 1 ? '' : 's'} added`;
        } catch (error) {
            onError(error);
        }
        shutter.disabled = false;
    });
    done.addEventListener('click', close);
    return {close};
}
