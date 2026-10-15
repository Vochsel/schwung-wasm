/* The page's door into slot parameters: the same SPSC ring Schwung's web
 * manager (schwung-manager, :7700 on the device) writes, drained by the shim
 * once per block (shadow_drain_web_param_set). Lets the page load modules or
 * set parameters without driving the OLED UI. */
#include <emscripten.h>
#include <string.h>

#include "host/shadow_constants.h"
#include "host/shadow_shm_util.h"

static web_param_set_ring_t *ring;

EMSCRIPTEN_KEEPALIVE int sw_web_param_set(int slot, const char *key, const char *value) {
    if (!ring) ring = (web_param_set_ring_t *)shadow_shm_map(SHM_WEB_PARAM_SET, sizeof(web_param_set_ring_t), 0, 0);
    if (!ring || !key || !value) return -1;
    uint8_t head = __atomic_load_n(&ring->write_idx, __ATOMIC_ACQUIRE);
    uint8_t tail = __atomic_load_n(&ring->reserved[0], __ATOMIC_ACQUIRE);
    if ((uint8_t)(head - tail) >= WEB_PARAM_SET_ENTRIES) return -2;   /* full */
    web_param_set_entry_t *e = &ring->entries[head % WEB_PARAM_SET_ENTRIES];
    e->slot = (uint8_t)slot;
    strncpy(e->key, key, WEB_PARAM_KEY_LEN - 1);
    e->key[WEB_PARAM_KEY_LEN - 1] = 0;
    strncpy(e->value, value, WEB_PARAM_VALUE_LEN - 1);
    e->value[WEB_PARAM_VALUE_LEN - 1] = 0;
    __atomic_store_n(&ring->write_idx, (uint8_t)(head + 1), __ATOMIC_RELEASE);
    return 0;
}
