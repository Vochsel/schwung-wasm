/* Force-included (-include) into every Schwung translation unit built for wasm.
 * Supplies the few glibc/Linux extensions that Emscripten's musl lacks, so the
 * upstream sources compile unmodified. Keep each shim behaviour-neutral. */
#ifndef SCHWUNG_WASM_COMPAT_H
#define SCHWUNG_WASM_COMPAT_H
#ifdef __EMSCRIPTEN__
#include <stddef.h>
#ifndef SCHWUNG_WASM
#define SCHWUNG_WASM 1
#endif
/* glibc: give freed heap back to the OS. Emscripten's heap never shrinks. */
static inline int malloc_trim(size_t pad) { (void)pad; return 0; }
/* dlopen waits until the audio (device) thread has synced the new side
 * module; see engine/dlsync.c. */
#include <dlfcn.h>
void *schwung_wasm_dlopen(const char *path, int flags);
#define dlopen schwung_wasm_dlopen
/* glibc: CPU affinity. A browser schedules workers itself. */
#include <pthread.h>
#include <sched.h>
#ifndef CPU_SETSIZE
typedef struct { unsigned long bits[2]; } cpu_set_t;
#define CPU_ZERO(s) ((void)(s))
#define CPU_SET(c, s) ((void)(c), (void)(s))
#endif
/* musl declares this under _GNU_SOURCE without defining it; route to a
 * private no-op so both C and C++ translation units compile. */
#define pthread_attr_setaffinity_np schwung_wasm_attr_setaffinity_np
static inline int schwung_wasm_attr_setaffinity_np(pthread_attr_t *a, size_t n, const cpu_set_t *s) { (void)a; (void)n; (void)s; return 0; }
#endif
#endif
