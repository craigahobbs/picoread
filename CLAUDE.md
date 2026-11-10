# CLAUDE.md

Notes for coding agents working in this repository.

## javascript-build

This is a [javascript-build](https://github.com/craigahobbs/javascript-build#readme) package. Read the javascript-build
skill before running tests, lint, coverage, or changing the Makefile:
[`../javascript-build/SKILL.md`](../javascript-build/SKILL.md) if that file exists, otherwise
[https://raw.githubusercontent.com/craigahobbs/javascript-build/main/SKILL.md](https://raw.githubusercontent.com/craigahobbs/javascript-build/main/SKILL.md).

Local Makefile overrides:

- `GHPAGES_SRC` - `build/app/`
- `USE_JSDOM` - jsdom is a development dependency (the app's tests)
- `ESLINT_ARGS` - also `static/sw.js`
- `commit` also depends on `app`

Package-specific targets:

- `make app` - the site, `build/app/`: `static/`, `lib/`, PicoOCR and PicoVox (`node_modules/<package>/lib/` in
  `<package>/lib/`), the app's bare `picoocr/...` and `picovox/...` imports rewritten to relative ones, and the service
  worker with its version and files
- `make run` - `make app`, then serve `build/app/` at http://localhost:8000/

## Code

- `lib/` - the app (browser ES modules). PicoOCR (`picoocr/lib/...`) and PicoVox (`picovox/lib/...`), npm packages,
  are imported bare, so the code runs under Node's tests as is.
- `test/` - `node --test` unit tests; jsdom stands in for the browser; `test/helpers.js` - the shared fakes
- Runs must be clean: no warnings in tests or builds - fix them, or silence one with a comment saying why
