# AGENTS.md

Instructions for coding agents. Humans: start with README.md.

## What this is

Schwung (the open-source framework for Ableton Move, `third_party/schwung`) running in a
browser: its shim, chain host, shadow UI and QuickJS compiled with Emscripten into one
pthreads program, catalog modules rebuilt from source as side modules, and a virtual Move
panel. `docs/ARCHITECTURE.md` is the map.

## The rule

**Run Schwung's code, don't rewrite it.** When something doesn't work, the fix is a stand-in
for what the browser lacks (`engine/`), a guarded edit in `patches/apply.py`, or a compat shim
— never a JS reimplementation of Schwung behaviour. If Schwung does it on the device, the
same C/JS should do it here.

## Commands

```bash
git submodule update --init          # Schwung source, pinned
bash scripts/build-modules.sh        # catalog modules → build/vfs (≈2 min, clones from GitHub)
bash scripts/build-engine.sh         # engine → web/engine/ (≈1 min); stages build/vfs-base
node scripts/serve.mjs               # http://localhost:8790 with COOP/COEP
node tests/drive.mjs "shift+vol+track1" "click" "jog 1" "click" "pad 3 0"   # headless, saves OLED PNGs
node scripts/test-module.mjs [ids]   # each module alone in a test host
```

Builds run in the pinned `emscripten/emsdk:4.0.10` image via `scripts/em` (Docker). Tests need
Playwright's Chromium (`build/tools`: `npm i --prefix build/tools playwright@1.56.1`).

## Invariants (each broke once)

- **Never edit `build/schwung` by hand.** `scripts/prepare.sh` re-copies it from the submodule
  and runs `patches/apply.py`. Put the edit in `apply.py`, behind `SCHWUNG_WASM`, with a reason.
- **Side modules are built before the engine links**, because the link packages the FS.
- **Two FS trees:** `build/vfs-base` (Schwung's own files, chain + built-ins; `stage-vfs.sh`) and
  `build/vfs` (catalog modules; `build-modules.sh`). Never `rm -rf` either wholesale.
- **Undefined symbols fail the build.** With `MAIN_MODULE` the linker would defer them to load
  time; `build-engine.sh` turns the warning into an error. Add a stub in `engine/stubs.c`.
- **Atomics on the ring use an `Int32Array` view.** `Atomics.notify` rejects `Uint32Array`.
- **Pads reach slots through Move's echo.** Virtual Move must turn the MIDI_IN the shim lets
  through into MIDI_OUT cable 2 notes on the selected track's channel. Track 1 is a drum rack
  (notes 36+), tracks 2–4 are melodic; a drum module on a melodic track hears notes it ignores.
- **No analytics.** `stage-vfs.sh` answers Schwung's first-run prompt "No"; keep it that way.
- **Licences.** Module sources are cloned at build time, never committed. Don't add recipes for
  repos without a licence that allows redistribution (see docs/MODULES.md).

## Deploying

`bash scripts/deploy.sh` (after both builds) deploys `web/` as prebuilt static files. The Vercel project is deliberately not connected to Git: a Git build has no engine to serve and replaces the live site with 404s.

## Debugging

`tests/engine.html?log` turns on Schwung's own debug log; `tests/drive.mjs` saves it to
`build/smoke/debug.log`, plus `midi_out.log` (every note the shim dispatched to a slot) and an
OLED PNG per step in `build/smoke/drive/`. Look at the PNGs.
