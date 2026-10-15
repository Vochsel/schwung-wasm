/* Virtual SPI device and "Virtual Move".
 *
 * On the device, Ableton's MoveOriginal calls ioctl() on /dev/ablspi0.0 once
 * per 128-frame block; Schwung's shim hooks that call and does all its work in
 * the pre/post callbacks around the hardware exchange (docs/SPI_PROTOCOL.md).
 * Here a "device" pthread plays both outside parties:
 *
 *   - the XMOS side of the mailbox (schwung_wasm_hw_exchange): it takes the
 *     outgoing audio, LED MIDI and display slices, and supplies MIDI_IN from
 *     the page plus the display-slice request index;
 *   - MoveOriginal (vmove_*): it turns pad presses that reach Move into notes
 *     on the selected track's channel on cable 2 of MIDI_OUT, which is how
 *     Schwung's chain slots hear Move's tracks, and runs the transport clock.
 *
 * The shim's own code runs unchanged between the two. The device thread is
 * paced by the audio ring the AudioWorklet drains. */
#include <emscripten.h>
#include <emscripten/threading.h>
#include <math.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "lib/schwung_spi_lib.h"
#include "vm_font.h"

void shim_spi_init(void);
void schwung_spi_wasm_attach(uint8_t *hw);
void schwung_spi_wasm_transfer(void);
uint8_t *schwung_spi_wasm_shadow(void);

#define FRAMES 128
#define RING_BLOCKS 16
#define MIDI_RING 1024

/* ---- shared with the page ------------------------------------------------ */

static int16_t audio_ring[RING_BLOCKS * FRAMES * 2] __attribute__((aligned(16)));
/* [0] write block, [1] read block, [2] capacity, [3] underruns (worklet),
 * [4] target fill in blocks, [5] dropped (free-run) blocks */
static uint32_t audio_ctl[8] __attribute__((aligned(16)));

static _Atomic uint32_t midi_ring[MIDI_RING];
static _Atomic uint32_t midi_w, midi_r;

static uint8_t display_frame[1024];
static uint8_t display_build[1024];
static _Atomic uint32_t display_seq;

/* notes[128] then ccs[128], each (value, channel) */
static uint8_t leds[512];
static uint8_t led_rgb[2 * 128 * 4];
static _Atomic uint32_t leds_seq;

/* external MIDI out (cable 2) for the page: packed like midi_ring */
static _Atomic uint32_t ext_ring[256];
static _Atomic uint32_t ext_w;

static _Atomic uint32_t stats[8];   /* 0 frames, 1 last frame µs, 2 max µs, 3 pads seen by Move, 4 notes echoed */

static uint8_t hw_page[4096] __attribute__((aligned(64)));
static int running;
static int sample_rate = 44100;

/* ---- Virtual Move state --------------------------------------------------- */

static float vm_bpm = 120.0f;
static _Atomic int vm_playing_req = -1;  /* page request: -1 none, 0 stop, 1 play */
static int vm_playing;
static double vm_clock_acc;              /* samples since last 24ppqn tick */
static int vm_track;                     /* 0..3, Track 1 = 0 */
/* Pad layout per track, like Move's default set: Track 1 a drum rack,
 * Tracks 2-4 melodic. The page can change it (sw_set_pad_layout). */
static _Atomic int vm_layout[4] = {1, 0, 0, 0};   /* 1 drums, 0 melodic */
static _Atomic int vm_relight;
static int vm_pad_note[128];             /* pad → sounding note (+1), 0 none */
static uint32_t vm_out[64];              /* queued MIDI_OUT packets (cable<<28|...) */
static int vm_out_n;
static uint8_t vm_display[1024];
static int vm_display_idx;               /* slice index Move must answer */

static const int major[7] = {0, 2, 4, 5, 7, 9, 11};

static void vm_queue(uint8_t cable, uint8_t st, uint8_t d1, uint8_t d2) {
    if (vm_out_n >= 64) return;
    uint8_t cin = (st >= 0xF8) ? 0x0F : (st >> 4);
    vm_out[vm_out_n++] = ((uint32_t)((cable << 4) | cin) << 24) | ((uint32_t)st << 16) |
                         ((uint32_t)d1 << 8) | d2;
}

/* Move's pad layouts. Melodic: in key (C major), rows a fourth apart.
 * Drums: a 4x4 drum rack on the left half from note 36, bottom-left up; the
 * right half continues from 52 so every pad sounds. */
static int vm_pad_to_note(int pad) {
    int idx = pad - 68;
    int row = idx / 8, col = idx % 8;   /* row 0 is the bottom row */
    if (vm_layout[vm_track & 3]) return col < 4 ? 36 + row * 4 + col : 52 + row * 4 + (col - 4);
    int degree = col + row * 3;
    return 48 + major[degree % 7] + 12 * (degree / 7);
}

static uint8_t vm_pad_colour(int pad) {
    int n = vm_pad_to_note(pad);
    if (vm_layout[vm_track & 3]) return ((pad - 68) % 8) < 4 ? 125 : 124;
    return (n % 12 == 0) ? 125 : 124;
}

/* Pads Move would light: drum-rack half or roots brighter. */
static void vm_light_pads(void) {
    for (int p = 68; p < 100; p++)
        vm_queue(0, 0x90, (uint8_t)p, vm_pad_note[p] ? 120 : vm_pad_colour(p));
}

/* What Move itself does with the input the shim let through. */
static void vm_on_midi_in(uint8_t cable, uint8_t st, uint8_t d1, uint8_t d2) {
    if (cable != 0) return;
    uint8_t type = st & 0xF0;
    if ((type == 0x90 || type == 0x80) && d1 >= 68 && d1 < 100) {
        int on = (type == 0x90 && d2 > 0);
        uint8_t ch = (uint8_t)(vm_track & 0x0F);
        atomic_fetch_add(&stats[3], 1);
        if (on) {
            int n = vm_pad_to_note(d1);
            atomic_fetch_add(&stats[4], 1);
            vm_pad_note[d1] = n + 1;
            vm_queue(2, 0x90 | ch, (uint8_t)n, d2);
            vm_queue(0, 0x90, d1, 120);
        } else if (vm_pad_note[d1]) {
            vm_queue(2, 0x80 | ch, (uint8_t)(vm_pad_note[d1] - 1), 0);
            vm_pad_note[d1] = 0;
            int n = vm_pad_to_note(d1);
            (void)n;
            vm_queue(0, 0x90, d1, vm_pad_colour(d1));
        }
        return;
    }
    if (type == 0xA0 && d1 >= 68 && d1 < 100 && vm_pad_note[d1]) {
        vm_queue(2, 0xA0 | (vm_track & 0x0F), (uint8_t)(vm_pad_note[d1] - 1), d2);
        return;
    }
    if (type == 0xB0 && d2 == 127) {
        if (d1 >= 40 && d1 <= 43) {           /* track buttons, 43 = Track 1 */
            vm_track = 43 - d1;
            vm_relight = 1;
            for (int t = 0; t < 4; t++) vm_queue(0, 0xB0, (uint8_t)(43 - t), t == vm_track ? 127 : 16);
        } else if (d1 == 85) {                /* Play */
            vm_playing_req = !vm_playing;
        }
    }
}

static void vm_transport(void) {
    if (atomic_exchange(&vm_relight, 0)) vm_light_pads();
    int req = atomic_exchange(&vm_playing_req, -1);
    if (req >= 0 && req != vm_playing) {
        vm_playing = req;
        vm_clock_acc = 0;
        vm_queue(0, req ? 0xFA : 0xFC, 0, 0);
        if (req) vm_queue(0, 0xF8, 0, 0);
        vm_queue(0, 0xB0, 85, req ? 127 : 0);
    }
    if (!vm_playing) return;
    double per_tick = sample_rate * 60.0 / (vm_bpm * 24.0);
    vm_clock_acc += FRAMES;
    while (vm_clock_acc >= per_tick) {
        vm_clock_acc -= per_tick;
        vm_queue(0, 0xF8, 0, 0);
    }
}


/* ---- Virtual Move's own screen -------------------------------------------
 * What MoveOriginal would show when Schwung's UI is not on screen. Ableton's
 * real screens can't be reproduced, so it shows the state Virtual Move owns
 * and how to get into Schwung. */
static void vm_px(int x, int y) {
    if (x >= 0 && x < 128 && y >= 0 && y < 64) vm_display[(y >> 3) * 128 + x] |= (uint8_t)(1 << (y & 7));
}

static int vm_text(int x, int y, const char *t, int scale) {
    for (; *t; t++) {
        int c = (unsigned char)*t;
        if (c < 32 || c > 126) c = '?';
        for (int cx = 0; cx < VM_FONT_W; cx++)
            for (int cy = 0; cy < VM_FONT_H; cy++)
                if (vm_font[c - 32][cx] & (1 << cy))
                    for (int sx = 0; sx < scale; sx++)
                        for (int sy = 0; sy < scale; sy++) vm_px(x + cx * scale + sx, y + cy * scale + sy);
        x += (VM_FONT_W + 1) * scale;
    }
    return x;
}

static int vm_text_w(const char *t, int scale) { return (int)strlen(t) * (VM_FONT_W + 1) * scale - scale; }

static void vm_draw_screen(void) {
    char buf[48];
    memset(vm_display, 0, sizeof vm_display);
    vm_text(0, 0, "MOVE", 1);
    snprintf(buf, sizeof buf, "%s%d BPM", vm_playing ? "> " : "", (int)(vm_bpm + 0.5f));
    vm_text(128 - vm_text_w(buf, 1), 0, buf, 1);
    for (int x = 0; x < 128; x++) vm_px(x, 9);
    snprintf(buf, sizeof buf, "TRACK %d", vm_track + 1);
    vm_text(0, 14, buf, 2);
    vm_text(0, 33, vm_layout[vm_track & 3] ? "Drum rack pads" : "Melodic, C major", 1);
    vm_text(0, 45, "Shift+Vol+Track:", 1);
    vm_text(0, 54, "open Schwung", 1);
}

static int vm_screen_key = -1;

static void vm_update_screen(void) {
    int key = vm_track | (vm_layout[vm_track & 3] << 2) | (vm_playing << 3) | ((int)(vm_bpm * 10) << 4);
    if (key != vm_screen_key) { vm_screen_key = key; vm_draw_screen(); }
}

/* MoveOriginal's half of the frame, before the shim's pre callback: fresh
 * MIDI_OUT, its own display slice, silence for its audio. */
static void vm_write_tx(uint8_t *sh) {
    vm_update_screen();
    memset(sh + SCHWUNG_OFF_OUT_MIDI, 0, SCHWUNG_MIDI_OUT_MAX * 4);
    int n = vm_out_n < SCHWUNG_MIDI_OUT_MAX ? vm_out_n : SCHWUNG_MIDI_OUT_MAX;
    for (int i = 0; i < n; i++) {
        uint32_t p = vm_out[i];
        sh[i * 4 + 0] = (uint8_t)(p >> 24);
        sh[i * 4 + 1] = (uint8_t)(p >> 16);
        sh[i * 4 + 2] = (uint8_t)(p >> 8);
        sh[i * 4 + 3] = (uint8_t)p;
    }
    memmove(vm_out, vm_out + n, (size_t)(vm_out_n - n) * sizeof vm_out[0]);
    vm_out_n -= n;

    uint32_t idx = (uint32_t)vm_display_idx;
    if (idx >= 1 && idx <= 6) {
        int len = idx == 6 ? 1024 - 5 * 172 : 172;
        memcpy(sh + SCHWUNG_OFF_OUT_DISP_STAT, &idx, 4);
        memset(sh + SCHWUNG_OFF_OUT_DISP_DATA, 0, 172);
        memcpy(sh + SCHWUNG_OFF_OUT_DISP_DATA, vm_display + (idx - 1) * 172, (size_t)len);
    }
    memset(sh + SCHWUNG_OFF_OUT_AUDIO, 0, FRAMES * 4);
}

/* MoveOriginal reads what the shim's post callback left in MIDI_IN. */
static void vm_read_rx(const uint8_t *sh) {
    const uint8_t *in = sh + SCHWUNG_OFF_IN_MIDI;
    for (int i = 0; i < SCHWUNG_MIDI_IN_MAX; i++) {
        const uint8_t *e = in + i * 8;
        if (!e[0] && !e[1] && !e[2] && !e[3]) break;   /* zeroed slot terminates */
        vm_on_midi_in(e[0] >> 4, e[1], e[2], e[3]);
    }
    uint32_t idx;
    memcpy(&idx, sh + SCHWUNG_OFF_IN_DISP_STAT, 4);
    vm_display_idx = (int)idx;
}

/* ---- the XMOS side of the mailbox ---------------------------------------- */

static uint32_t disp_req = 1;
static uint8_t sysex_buf[64];
static int sysex_len;

static void led_set(int is_cc, uint8_t num, uint8_t val, uint8_t ch) {
    uint8_t *e = leds + (is_cc ? 256 : 0) + num * 2;
    if (e[0] != val || e[1] != ch) {
        e[0] = val;
        e[1] = ch;
        atomic_fetch_add(&leds_seq, 1);
    }
}

/* RGB override: F0 00 21 1D 01 01 3B <ns> <idx> rl rh gl gh bl bh F7 */
static void sysex_done(void) {
    if (sysex_len >= 16 && sysex_buf[1] == 0x00 && sysex_buf[2] == 0x21 && sysex_buf[3] == 0x1D &&
        sysex_buf[6] == 0x3B) {
        int ns = sysex_buf[7] == 0x10 ? 1 : 0;
        uint8_t idx = sysex_buf[8] & 0x7F;
        uint8_t *e = led_rgb + (ns * 128 + idx) * 4;
        e[0] = (uint8_t)((sysex_buf[9] & 0x7F) | ((sysex_buf[10] & 1) << 7));
        e[1] = (uint8_t)((sysex_buf[11] & 0x7F) | ((sysex_buf[12] & 1) << 7));
        e[2] = (uint8_t)((sysex_buf[13] & 0x7F) | ((sysex_buf[14] & 1) << 7));
        e[3] = 1;
        atomic_fetch_add(&leds_seq, 1);
    }
    sysex_len = 0;
}

static void on_midi_out(const uint8_t *p) {
    uint8_t cable = p[0] >> 4, cin = p[0] & 0x0F;
    if (cable == 0) {
        if (cin >= 0x4 && cin <= 0x7) {           /* SysEx start/continue/end */
            int n = cin == 0x5 ? 1 : cin == 0x6 ? 2 : 3;
            for (int i = 0; i < n && sysex_len < (int)sizeof sysex_buf; i++) sysex_buf[sysex_len++] = p[1 + i];
            if (cin != 0x4) sysex_done();
            return;
        }
        uint8_t type = p[1] & 0xF0;
        if (type == 0x90 || type == 0x80) led_set(0, p[2] & 0x7F, type == 0x80 ? 0 : p[3], p[1] & 0x0F);
        else if (type == 0xB0) led_set(1, p[2] & 0x7F, p[3], p[1] & 0x0F);
    } else if (cable == 2 && cin >= 0x8) {
        uint32_t w = atomic_fetch_add(&ext_w, 1);
        ext_ring[w % 256] = ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
    }
}

void schwung_wasm_hw_exchange(uint8_t *hw) {
    /* TX: audio → ring */
    uint32_t wb = audio_ctl[0];
    memcpy(audio_ring + (wb % RING_BLOCKS) * FRAMES * 2, hw + SCHWUNG_OFF_OUT_AUDIO, FRAMES * 4);
    __atomic_store_n(&audio_ctl[0], wb + 1, __ATOMIC_RELEASE);
    {
        const int16_t *a = (const int16_t *)(hw + SCHWUNG_OFF_OUT_AUDIO);
        uint32_t pk = stats[5];
        for (int i = 0; i < FRAMES * 2; i++) { uint32_t v = (uint32_t)(a[i] < 0 ? -a[i] : a[i]); if (v > pk) pk = v; }
        stats[5] = pk;
    }

    /* TX: MIDI_OUT → LEDs / external */
    for (int i = 0; i < SCHWUNG_MIDI_OUT_MAX; i++) {
        const uint8_t *p = hw + SCHWUNG_OFF_OUT_MIDI + i * 4;
        if (p[0] | p[1] | p[2] | p[3]) on_midi_out(p);
    }

    /* TX: display slice answering last frame's request */
    uint32_t idx;
    memcpy(&idx, hw + SCHWUNG_OFF_OUT_DISP_STAT, 4);
    if (idx >= 1 && idx <= 6) {
        int len = idx == 6 ? 1024 - 5 * 172 : 172;
        memcpy(display_build + (idx - 1) * 172, hw + SCHWUNG_OFF_OUT_DISP_DATA, (size_t)len);
        if (idx == 6) {
            memcpy(display_frame, display_build, 1024);
            atomic_fetch_add(&display_seq, 1);
        }
    }

    /* RX: MIDI_IN from the page, zero-terminated, increasing timestamps */
    memset(hw + SCHWUNG_OFF_IN_BASE, 0, 4096 - SCHWUNG_OFF_IN_BASE);
    uint32_t r = atomic_load(&midi_r), w = atomic_load(&midi_w);
    int n = 0;
    uint32_t ts = (uint32_t)stats[0] * FRAMES;
    while (r != w && n < SCHWUNG_MIDI_IN_MAX) {
        uint32_t e = midi_ring[r % MIDI_RING];
        uint8_t *slot = hw + SCHWUNG_OFF_IN_MIDI + n * 8;
        uint8_t cable = (uint8_t)(e >> 24), st = (uint8_t)(e >> 16);
        slot[0] = (uint8_t)((cable << 4) | (st >= 0xF0 ? 0x0F : (st >> 4)));
        slot[1] = st;
        slot[2] = (uint8_t)(e >> 8);
        slot[3] = (uint8_t)e;
        uint32_t t = ts + (uint32_t)n;
        memcpy(slot + 4, &t, 4);
        n++;
        r++;
    }
    atomic_store(&midi_r, r);

    /* RX: ask for the next display slice */
    memcpy(hw + SCHWUNG_OFF_IN_DISP_STAT, &disp_req, 4);
    disp_req = disp_req % 6 + 1;
}

/* ---- device thread ------------------------------------------------------- */

static double now_ms(void) { return emscripten_get_now(); }

void schwung_wasm_dlsync_set_device_thread(void);
void schwung_wasm_dlsync_poll(void);

static void *device_main(void *arg) {
    (void)arg;
    schwung_wasm_dlsync_set_device_thread();
    uint8_t *sh = schwung_spi_wasm_shadow();
    double last_read_change = now_ms();
    uint32_t last_read = 0;
    vm_light_pads();
    for (int t = 0; t < 4; t++) vm_queue(0, 0xB0, (uint8_t)(43 - t), t == 0 ? 127 : 16);
    while (running) {
        uint32_t w = audio_ctl[0];
        uint32_t r = __atomic_load_n(&audio_ctl[1], __ATOMIC_ACQUIRE);
        uint32_t target = audio_ctl[4];
        if (r != last_read) { last_read = r; last_read_change = now_ms(); }
        if (w - r >= target) {
            /* Ring full. If the worklet stopped draining (suspended or
             * background tab), keep the device running in real time anyway so
             * the UI's synchronous param reads are still served. */
            if (now_ms() - last_read_change > 60.0) {
                __atomic_store_n(&audio_ctl[1], r + 1, __ATOMIC_RELEASE);
                audio_ctl[5]++;
                emscripten_futex_wait(&audio_ctl[1], r + 1, 1000.0 * FRAMES / sample_rate);
            } else {
                emscripten_futex_wait(&audio_ctl[1], r, 4.0);
            }
            continue;
        }
        schwung_wasm_dlsync_poll();
        double t0 = now_ms();
        vm_transport();
        vm_write_tx(sh);
        schwung_spi_wasm_transfer();
        vm_read_rx(sh);
        uint32_t us = (uint32_t)((now_ms() - t0) * 1000.0);
        atomic_store(&stats[1], us);
        if (us > stats[2]) atomic_store(&stats[2], us);
        atomic_fetch_add(&stats[0], 1);
    }
    return NULL;
}

/* ---- exports --------------------------------------------------------------- */

EMSCRIPTEN_KEEPALIVE int sw_start(int sr) {
    if (running) return 0;
    sample_rate = sr > 0 ? sr : 44100;
    audio_ctl[2] = RING_BLOCKS;
    audio_ctl[4] = 4;
    shim_spi_init();
    schwung_spi_wasm_attach(hw_page);
    running = 1;
    pthread_t t;
    pthread_attr_t a;
    pthread_attr_init(&a);
    pthread_attr_setstacksize(&a, 1 << 20);
    if (pthread_create(&t, &a, device_main, NULL) != 0) return -1;
    pthread_detach(t);
    return 0;
}

EMSCRIPTEN_KEEPALIVE void sw_midi_in(int cable, int b0, int b1, int b2) {
    uint32_t w = atomic_load(&midi_w);
    if (w - atomic_load(&midi_r) >= MIDI_RING) return;
    midi_ring[w % MIDI_RING] = ((uint32_t)(cable & 0xF) << 24) | ((uint32_t)(b0 & 0xFF) << 16) |
                               ((uint32_t)(b1 & 0x7F) << 8) | (uint32_t)(b2 & 0x7F);
    atomic_store(&midi_w, w + 1);
}

EMSCRIPTEN_KEEPALIVE uint8_t *sw_display(void) { return display_frame; }
EMSCRIPTEN_KEEPALIVE uint32_t *sw_display_seq(void) { return (uint32_t *)&display_seq; }
EMSCRIPTEN_KEEPALIVE uint8_t *sw_leds(void) { return leds; }
EMSCRIPTEN_KEEPALIVE uint32_t *sw_leds_seq(void) { return (uint32_t *)&leds_seq; }
EMSCRIPTEN_KEEPALIVE uint8_t *sw_led_rgb(void) { return led_rgb; }
EMSCRIPTEN_KEEPALIVE int16_t *sw_audio_ring(void) { return audio_ring; }
EMSCRIPTEN_KEEPALIVE uint32_t *sw_audio_ring_ctl(void) { return audio_ctl; }
EMSCRIPTEN_KEEPALIVE uint32_t *sw_ext_ring(void) { return (uint32_t *)ext_ring; }
EMSCRIPTEN_KEEPALIVE uint32_t *sw_ext_w(void) { return (uint32_t *)&ext_w; }
EMSCRIPTEN_KEEPALIVE void sw_set_pad_layout(int track, int drums) { if (track >= 0 && track < 4) { vm_layout[track] = drums ? 1 : 0; vm_relight = 1; } }
EMSCRIPTEN_KEEPALIVE int sw_get_track(void) { return vm_track; }
EMSCRIPTEN_KEEPALIVE int sw_get_pad_layout(int track) { return (track >= 0 && track < 4) ? vm_layout[track] : 0; }
EMSCRIPTEN_KEEPALIVE void sw_set_bpm(float bpm) { if (bpm >= 20 && bpm <= 300) vm_bpm = bpm; }
EMSCRIPTEN_KEEPALIVE void sw_transport(int playing) { vm_playing_req = playing ? 1 : 0; }
EMSCRIPTEN_KEEPALIVE void sw_set_latency_blocks(int n) { if (n >= 1 && n < RING_BLOCKS) audio_ctl[4] = (uint32_t)n; }
EMSCRIPTEN_KEEPALIVE int sw_stat(int which) {
    if (which == 0) return (int)stats[0];
    if (which == 1) return (int)stats[1];
    if (which == 2) return (int)stats[2];
    if (which == 3) return (int)audio_ctl[3];
    if (which == 4) return (int)audio_ctl[5];
    if (which == 5) return (int)display_seq;
    if (which == 6) return (int)stats[3];
    if (which == 7) return (int)stats[4];
    if (which == 8) { int v = (int)stats[5]; stats[5] = 0; return v; }
    return 0;
}
