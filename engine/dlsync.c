/* dlopen across threads.
 *
 * Emscripten loads a side module into the calling thread at once and into the
 * other threads lazily. Schwung loads modules off the audio path (slot loader,
 * bus worker) and then calls them from the SPI callback, which here is the
 * device thread: if that thread hasn't synced the new library yet, the first
 * call through its function table traps ("null function") and the device
 * thread dies. compat/wasm_compat.h routes every dlopen in Schwung's code to
 * this wrapper, which waits until the device thread has synced the library
 * before handing the handle back. The device thread syncs at the top of each
 * block (schwung_wasm_dlsync_poll), so a load costs at most one block more. */
#undef dlopen
#undef dlsym
#include <dlfcn.h>
#include <emscripten.h>
#include <emscripten/threading.h>
#include <pthread.h>
#include <stdatomic.h>

extern int _emscripten_dlsync_self(void);

static _Atomic uint32_t dl_gen, dl_synced;
static _Atomic(pthread_t) device_thread;

void schwung_wasm_dlsync_set_device_thread(void) { device_thread = pthread_self(); }

void schwung_wasm_dlsync_poll(void) {
    uint32_t g = atomic_load(&dl_gen);
    if (g == atomic_load(&dl_synced)) return;
    _emscripten_dlsync_self();
    atomic_store(&dl_synced, g);
    emscripten_futex_wake((void *)&dl_synced, 0x7fffffff);
}

/* Any thread that is about to dlopen or dlsym first catches up with every
 * library other threads have loaded, so the handles and function pointers it
 * gets back (and old instances it may tear down) are callable from it. */
EMSCRIPTEN_KEEPALIVE void *schwung_wasm_dlsym(void *h, const char *name) {
    _emscripten_dlsync_self();
    return dlsym(h, name);
}

EMSCRIPTEN_KEEPALIVE void *schwung_wasm_dlopen(const char *path, int flags) {
    _emscripten_dlsync_self();
    void *h = dlopen(path, flags);
    if (!h || !device_thread || pthread_equal(pthread_self(), device_thread)) return h;
    uint32_t g = atomic_fetch_add(&dl_gen, 1) + 1;
    /* Wait for the device thread to pick it up (bounded: a stalled device
     * thread must not wedge the loader forever). */
    for (int i = 0; i < 200 && (int32_t)(atomic_load(&dl_synced) - g) < 0; i++)
        emscripten_futex_wait((void *)&dl_synced, atomic_load(&dl_synced), 5.0);
    return h;
}
