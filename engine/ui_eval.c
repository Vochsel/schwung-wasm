/* sw_ui_eval(): queue JavaScript to run inside the shadow UI's own QuickJS
 * context, on its thread, between ticks. A development and test door: it
 * reaches the same functions shadow_ui.js uses (shadow_set_param, host_*),
 * with the same claim protocol and timing, instead of poking shared memory
 * from outside. The result (or exception) is kept for sw_ui_result(). */
#include <emscripten.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "quickjs.h"

static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static char *pending;
static char result[4096];
static int seq_done, seq_req;

EMSCRIPTEN_KEEPALIVE int sw_ui_eval(const char *src) {
    pthread_mutex_lock(&mu);
    free(pending);
    pending = strdup(src);
    int id = ++seq_req;
    pthread_mutex_unlock(&mu);
    return id;
}

EMSCRIPTEN_KEEPALIVE int sw_ui_done(void) { return __atomic_load_n(&seq_done, __ATOMIC_ACQUIRE); }
EMSCRIPTEN_KEEPALIVE const char *sw_ui_result(void) { return result; }

void schwung_wasm_ui_poll(JSContext *ctx) {
    pthread_mutex_lock(&mu);
    char *src = pending;
    pending = NULL;
    int id = seq_req;
    pthread_mutex_unlock(&mu);
    if (!src) return;
    JSValue v = JS_Eval(ctx, src, strlen(src), "<sw_ui_eval>", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(v)) {
        JSValue e = JS_GetException(ctx);
        const char *m = JS_ToCString(ctx, e);
        snprintf(result, sizeof result, "ERROR %s", m ? m : "?");
        if (m) JS_FreeCString(ctx, m);
        JS_FreeValue(ctx, e);
    } else {
        JSValue j = JS_JSONStringify(ctx, v, JS_UNDEFINED, JS_UNDEFINED);
        const char *m = JS_IsUndefined(j) ? NULL : JS_ToCString(ctx, j);
        snprintf(result, sizeof result, "%s", m ? m : "undefined");
        if (m) JS_FreeCString(ctx, m);
        JS_FreeValue(ctx, j);
    }
    JS_FreeValue(ctx, v);
    free(src);
    __atomic_store_n(&seq_done, id, __ATOMIC_RELEASE);
}
