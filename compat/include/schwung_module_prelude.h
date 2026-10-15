/* schwung-wasm: force-included BEFORE compat/wasm_compat.h when building
 * catalog modules (scripts/build-modules.sh).
 *
 * wasm_compat.h defines `static inline pthread_setaffinity_np()` and
 * `pthread_attr_setaffinity_np()`. Under _GNU_SOURCE (always on for C++, and
 * set by some C modules) Emscripten's musl <pthread.h> already declares both
 * as extern, so the static definition is a hard error. Renaming the symbols
 * here, after <pthread.h> has declared the extern ones, makes the compat
 * header's shims (and every caller) bind to private static names instead.
 * Harmless when _GNU_SOURCE is off. */
#ifndef SCHWUNG_MODULE_PRELUDE_H
#define SCHWUNG_MODULE_PRELUDE_H
#ifdef __EMSCRIPTEN__
#include <pthread.h>
#include <sched.h>
#define pthread_setaffinity_np schwung_wasm_pthread_setaffinity_np
#define pthread_attr_setaffinity_np schwung_wasm_pthread_attr_setaffinity_np
#endif
#endif
