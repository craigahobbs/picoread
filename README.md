# Webbo

Webbo turns a paper document into one you can listen to. Photograph its pages in order, and Webbo reads their text
and speaks it - all in your browser, on your device:

- **Pages** - take photos with the camera (or choose them), reorder them, retake a page's reading, fix its text
- **Text** - each page is read by [PicoOCR](https://github.com/craigahobbs/picoocr), a neural text recognizer
  written in plain JavaScript whose network is part of its code - no server, no downloads, works offline
- **Listening** - [PicoVox](https://github.com/craigahobbs/picovox)'s natural voices, synthesized on your device in a
  Web Worker a sentence ahead of playback, at your speed, from any page
- **Storage** - the documents and their text in localStorage, the page photos in IndexedDB (localStorage's few
  megabytes hold only a handful of photos), and the reading position in sessionStorage - nothing leaves the device

Webbo's runtime dependencies are its family's: PicoOCR (`../picoocr` - a file dependency until it's published)
and PicoVox.


## Development

Webbo is a [javascript-build](https://github.com/craigahobbs/javascript-build#readme) package:

~~~
make commit      # tests, lint, docs, 100% coverage - and PicoOCR's gate
make run         # the site, build/app/, at http://localhost:8000/
~~~

- `lib/app.js` - the UI (`main(window, overrides)`; the tests pass fakes for its services)
- `lib/store.js` - the browser storage
- `lib/ocrworker.js` - PicoOCR in a Web Worker
- `lib/photo.js` - a photo scaled and stored as a JPEG
- `lib/camera.js` - the camera: a viewfinder, each photo the next page
- `lib/reader.js` - reading aloud: PicoVox's audio blocks scheduled in Web Audio, a sentence requested at a time
- `lib/speechworker.js` - PicoVox in a Web Worker
- `lib/text.js` - a page's text for speech: lines joined, hyphenated words rejoined, sentences
- `static/` - the page, its icon and manifest, and the service worker (the site offline)
