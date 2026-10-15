/* Linux- and Move-only pieces with nothing to stand behind them in a browser.
 * Each stub answers the way the real code does when its source is absent, so
 * the callers' existing "not available" paths run. */
#include <errno.h>
#include <pthread.h>
#include <sched.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <sys/types.h>

#include "host/move_model.h"
#include "lib/schwung_jack_bridge.h"

/* Move's live song model is read from MoveOriginal's heap; there is no Move.
 * valid = 0 is the "model not live" answer every caller already handles. */
void move_model_start(void) {}
int move_model_get(move_model_t *out) { if (out) memset(out, 0, sizeof *out); return 0; }
uint64_t move_model_last_publish_ms(void) { return 0; }
void move_model_set_listener(move_model_listener_fn fn) { (void)fn; }
void move_model_set_tick_hook(move_model_tick_fn fn) { (void)fn; }
int move_model_edited_notes(int previous, const mm_note_t **notes, mm_clip_ref_t *ref) {
    (void)previous; (void)ref; if (notes) *notes = NULL; return 0;
}
const char *move_model_quant_name(int v) { (void)v; return NULL; }

/* JACK serves only the RNBO runner overtake; it never connects here. */
SchwungJackShm *schwung_jack_bridge_create(void) { return NULL; }
void schwung_jack_bridge_wake(SchwungJackShm *shm) { (void)shm; }
const int16_t *schwung_jack_bridge_read_audio(SchwungJackShm *shm) { (void)shm; return NULL; }
int schwung_jack_bridge_pre(SchwungJackShm *shm, uint8_t *shadow) { (void)shm; (void)shadow; return 0; }
void schwung_jack_bridge_stash_midi_out(const uint8_t *b, int m) { (void)b; (void)m; }
void schwung_jack_bridge_post(SchwungJackShm *shm, uint8_t *shadow, const uint8_t *hw,
                              const volatile uint8_t *om, const volatile uint8_t *sh) {
    (void)shm; (void)shadow; (void)hw; (void)om; (void)sh;
}
uint32_t schwung_jack_bridge_get_miss_count(void) { return 0; }
uint32_t schwung_jack_bridge_get_hit_count(void) { return 0; }

/* Per-Set xattrs live on Move's filesystem; none exist here. */
ssize_t getxattr(const char *p, const char *n, void *v, size_t s) { (void)p; (void)n; (void)v; (void)s; errno = ENODATA; return -1; }
int setxattr(const char *p, const char *n, const void *v, size_t s, int f) { (void)p; (void)n; (void)v; (void)s; (void)f; errno = ENOTSUP; return -1; }

/* Scheduling hints: a browser schedules its workers itself. */
int sched_setscheduler(pid_t pid, int policy, const struct sched_param *p) { (void)pid; (void)policy; (void)p; return 0; }
int sched_setaffinity(pid_t pid, size_t n, const cpu_set_t *mask) { (void)pid; (void)n; (void)mask; return 0; }
int pthread_setname_np(pthread_t t, const char *name) { (void)t; (void)name; return 0; }
int pthread_setaffinity_np(pthread_t t, size_t n, const cpu_set_t *mask) { (void)t; (void)n; (void)mask; return 0; }
