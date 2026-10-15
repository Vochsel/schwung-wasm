/* schwung-wasm: force-included BEFORE compat/wasm_compat.h when building
 * catalog modules (scripts/build-modules.sh).
 *
 * 1. wasm_compat.h defines `static inline pthread_setaffinity_np()` and
 *    `pthread_attr_setaffinity_np()`. Under _GNU_SOURCE (always on for C++)
 *    Emscripten's musl <pthread.h> already declares both extern, so the static
 *    definition is a hard error. Renaming them here, after <pthread.h> has
 *    declared the extern ones, binds the shims and every caller to private
 *    static names instead.
 * 2. Emscripten's libc omits musl's src/sched/ and pthread_setname_np, so a
 *    module worker that demotes itself (sched_setscheduler(SCHED_OTHER) — the
 *    documented Schwung pattern), pins a CPU or names itself traps on an
 *    unresolved import. Same rename trick, behaviour-neutral no-ops: the
 *    browser schedules workers itself.
 */
#ifndef SCHWUNG_MODULE_PRELUDE_H
#define SCHWUNG_MODULE_PRELUDE_H
#ifdef __EMSCRIPTEN__
#include <sys/types.h>
#include <pthread.h>
#include <sched.h>
#include <string.h>
#define pthread_setaffinity_np schwung_wasm_pthread_setaffinity_np
#define pthread_attr_setaffinity_np schwung_wasm_pthread_attr_setaffinity_np

#define sched_setscheduler schwung_wasm_sched_setscheduler
#define sched_getscheduler schwung_wasm_sched_getscheduler
#define sched_setparam schwung_wasm_sched_setparam
#define sched_getparam schwung_wasm_sched_getparam
#define sched_setaffinity schwung_wasm_sched_setaffinity
#define sched_getaffinity schwung_wasm_sched_getaffinity
#define pthread_setname_np schwung_wasm_pthread_setname_np
static inline int schwung_wasm_sched_setscheduler(pid_t p, int pol, const struct sched_param *sp) { (void)p; (void)pol; (void)sp; return 0; }
static inline int schwung_wasm_sched_getscheduler(pid_t p) { (void)p; return SCHED_OTHER; }
static inline int schwung_wasm_sched_setparam(pid_t p, const struct sched_param *sp) { (void)p; (void)sp; return 0; }
static inline int schwung_wasm_sched_getparam(pid_t p, struct sched_param *sp) { (void)p; if (sp) memset(sp, 0, sizeof *sp); return 0; }
static inline int schwung_wasm_sched_setaffinity(pid_t p, size_t n, const void *s) { (void)p; (void)n; (void)s; return 0; }
static inline int schwung_wasm_sched_getaffinity(pid_t p, size_t n, void *s) { (void)p; if (s) memset(s, 0xff, n); return 0; }
static inline int schwung_wasm_pthread_setname_np(pthread_t t, const char *name) { (void)t; (void)name; return 0; }
#endif
#endif
