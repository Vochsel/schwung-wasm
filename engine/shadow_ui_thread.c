/* shadow_ui as a thread. src/shadow/shadow_ui.c is compiled with
 * -Dmain=shadow_ui_main; on the device it is its own process, launched and
 * watched by the shim (shadow_process.c, patched to call these). */
#include <emscripten.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>

int shadow_ui_main(int argc, char **argv);

static atomic_int ui_running;

static void *ui_thread(void *arg) {
    (void)arg;
    static char name[] = "shadow_ui";
    char *argv[] = { name, NULL };
    int rc = shadow_ui_main(1, argv);
    fprintf(stderr, "schwung-wasm: shadow_ui exited (%d)\n", rc);
    atomic_store(&ui_running, 0);
    return NULL;
}

int schwung_wasm_shadow_ui_running(void) { return atomic_load(&ui_running); }

void schwung_wasm_spawn_shadow_ui(void) {
    if (atomic_exchange(&ui_running, 1)) return;
    pthread_t t;
    pthread_attr_t a;
    pthread_attr_init(&a);
    /* QuickJS recurses deeply over 85k lines of UI JS. */
    pthread_attr_setstacksize(&a, 8 << 20);
    if (pthread_create(&t, &a, ui_thread, NULL) != 0) {
        atomic_store(&ui_running, 0);
        return;
    }
    pthread_detach(t);
}
