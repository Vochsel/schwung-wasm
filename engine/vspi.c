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
#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/stat.h>

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

/* Audio input (the Move's line-in/mic) from the page: same block ring shape,
 * written by the worklet, read once per block into the mailbox's RX audio. */
static int16_t in_ring[RING_BLOCKS * FRAMES * 2] __attribute__((aligned(16)));
static uint32_t in_ctl[4] __attribute__((aligned(16)));   /* [0] write, [1] read, [2] capacity */

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
/* Queued MIDI_OUT packets. Notes and clock go first; LED updates fill the
 * rest of the 20-packet frame and spill into later frames. */
static uint32_t vm_out[64];              /* notes, clock */
static int vm_out_n;
static uint32_t vm_led_out[512];         /* LED updates */
static int vm_led_n;
static uint8_t vm_display[1024];
static int vm_display_idx;               /* slice index Move must answer */

/* Scales for melodic pad layouts (Move offers the same set). Rows step by a
 * fourth: 3 degrees for 7-note scales, 2 for pentatonics, 5 semitones for
 * chromatic. */
typedef struct { const char *name; int n; int deg[12]; } scale_t;
static const scale_t scales[] = {
    {"major", 7, {0, 2, 4, 5, 7, 9, 11}},       {"minor", 7, {0, 2, 3, 5, 7, 8, 10}},
    {"dorian", 7, {0, 2, 3, 5, 7, 9, 10}},      {"phrygian", 7, {0, 1, 3, 5, 7, 8, 10}},
    {"lydian", 7, {0, 2, 4, 6, 7, 9, 11}},      {"mixolydian", 7, {0, 2, 4, 5, 7, 9, 10}},
    {"locrian", 7, {0, 1, 3, 5, 6, 8, 10}},     {"harm minor", 7, {0, 2, 3, 5, 7, 8, 11}},
    {"maj pent", 5, {0, 2, 4, 7, 9}},           {"min pent", 5, {0, 3, 5, 7, 10}},
    {"chromatic", 12, {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11}},
};
#define N_SCALES ((int)(sizeof scales / sizeof scales[0]))
static const char *note_names[12] = {"C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"};

static void vm_queue(uint8_t cable, uint8_t st, uint8_t d1, uint8_t d2) {
    uint8_t cin = (st >= 0xF8) ? 0x0F : (st >> 4);
    uint32_t pk = ((uint32_t)((cable << 4) | cin) << 24) | ((uint32_t)st << 16) | ((uint32_t)d1 << 8) | d2;
    if (cable == 0 && st < 0xF8) {           /* surface LED */
        for (int i = 0; i < vm_led_n; i++)   /* newest value for a light wins */
            if ((vm_led_out[i] & 0xFFFF0000u) == (pk & 0xFFFF0000u) && ((vm_led_out[i] >> 8) & 0xFF) == d1) { vm_led_out[i] = pk; return; }
        if (vm_led_n < 512) vm_led_out[vm_led_n++] = pk;
        return;
    }
    if (vm_out_n < 64) vm_out[vm_out_n++] = pk;
}

/* Move's pad layouts. Melodic: in key (C major), rows a fourth apart.
 * Drums: a 4x4 drum rack on the left half from note 36, bottom-left up; the
 * right half continues from 52 so every pad sounds. */
static int vm_octave_of(int t);
static void vm_scale_of(int t, int *root, int *sc);
static int vm_pad_to_note(int pad) {
    int idx = pad - 68;
    int row = idx / 8, col = idx % 8;   /* row 0 is the bottom row */
    if (vm_layout[vm_track & 3]) return col < 4 ? 36 + row * 4 + col : 52 + row * 4 + (col - 4);
    int t = vm_track & 3, root, sc;
    vm_scale_of(t, &root, &sc);
    const scale_t *S = &scales[sc];
    int oct = vm_octave_of(t);
    if (S->n == 12) return 48 + root + 12 * oct + col + row * 5;
    int degree = col + row * (S->n == 7 ? 3 : 2);
    return 48 + root + 12 * oct + S->deg[degree % S->n] + 12 * (degree / S->n);
}

static uint8_t vm_pad_colour(int pad) {
    int n = vm_pad_to_note(pad);
    if (vm_layout[vm_track & 3]) return ((pad - 68) % 8) < 4 ? 125 : 124;
    int root, sc;
    vm_scale_of(vm_track & 3, &root, &sc);
    return ((n - root) % 12 == 0) ? 125 : 124;
}

/* Pads Move would light: drum-rack half or roots brighter. */
static void vm_light_pads(void) {
    for (int p = 68; p < 100; p++)
        vm_queue(0, 0x90, (uint8_t)p, vm_pad_note[p] ? 120 : vm_pad_colour(p));
}


/* ---- Virtual Move's step sequencer ----------------------------------------
 * Move's own sequencer is firmware; this plays like it, minus clips:
 *   - one pattern per track, up to 4 pages of 16 steps; Loop + step sets its
 *     length, Left/Right page through it;
 *   - Play/Rec; pads recorded quantised to 16ths while recording;
 *   - a step button toggles the last pad's note; hold a step and tap pads to
 *     set exactly which notes it plays; Delete + step clears it;
 *   - Mute + Track mutes a track; Up/Down shift melodic tracks by octaves;
 *   - an optional metronome mixed into Move's own audio.
 * Its notes go out on MIDI_OUT cable 2 on the track's channel, exactly as
 * Move's playback would, so Schwung's slots play them. Patterns are saved in
 * the user FS. */
#define SEQ_STEPS 64
#define SEQ_POLY 6
typedef struct { uint8_t note[SEQ_POLY], vel[SEQ_POLY], n; } seq_step_t;
typedef struct { seq_step_t step[SEQ_STEPS]; uint8_t len, muted; int8_t octave; uint8_t root, scale, _r[3]; } seq_track_t;
static seq_track_t seq[4];
static uint8_t seq_skip[4][SEQ_STEPS][SEQ_POLY];   /* just-recorded notes already heard live */
static uint8_t seq_sounding[4][SEQ_POLY], seq_sounding_n[4];
static int vm_rec, vm_delete_held, vm_loop_held, vm_mute_held, vm_shift_held, vm_tick, vm_pos = -1;
static int vm_page[4];
static int vm_held_step = -1, vm_held_step_edited;
static int vm_last_note[4] = {36, 48, 48, 48};
static int seq_dirty, seq_led_key = -1;
static double seq_dirty_at;
static _Atomic int vm_metronome;
static _Atomic int vm_swing;          /* 0..60: % of a 16th the off-beats are late */
static double vm_swing_wait = -1;     /* samples until a delayed off-beat fires */
static int vm_click_left, vm_click_accent;
#define SEQ_PATH "/data/UserData/schwung-wasm/sequencer-v3.bin"

static int vm_octave_of(int t) { return seq[t].octave; }
static void vm_scale_of(int t, int *root, int *sc) { *root = seq[t].root % 12; *sc = seq[t].scale < N_SCALES ? seq[t].scale : 0; }
static int seq_len(int t) { return seq[t].len ? seq[t].len : 16; }
static int seq_track_pos(int t) { return vm_pos < 0 ? -1 : vm_pos % seq_len(t); }
static void seq_touch(void) { seq_dirty = 1; seq_dirty_at = emscripten_get_now(); seq_led_key = -1; }

static void seq_load(void) {
    FILE *f = fopen(SEQ_PATH, "rb");
    if (!f) return;
    if (fread(seq, sizeof seq, 1, f) != 1) memset(seq, 0, sizeof seq);
    fclose(f);
}

static void seq_save(void) {
    mkdir("/data/UserData/schwung-wasm", 0755);
    FILE *f = fopen(SEQ_PATH, "wb");
    if (f) { fwrite(seq, sizeof seq, 1, f); fclose(f); }
    seq_dirty = 0;
}

static int seq_has(int t, int step, int note) {
    seq_step_t *s = &seq[t].step[step];
    for (int i = 0; i < s->n; i++) if (s->note[i] == note) return i;
    return -1;
}

static void seq_add(int t, int step, int note, int vel, int heard) {
    seq_step_t *s = &seq[t].step[step];
    int i = seq_has(t, step, note);
    if (i >= 0) { s->vel[i] = (uint8_t)vel; return; }
    if (s->n >= SEQ_POLY) return;
    seq_skip[t][step][s->n] = (uint8_t)heard;
    s->note[s->n] = (uint8_t)note; s->vel[s->n] = (uint8_t)vel; s->n++;
    seq_touch();
}

static void seq_remove(int t, int step, int i) {
    seq_step_t *s = &seq[t].step[step];
    for (int k = i; k < s->n - 1; k++) { s->note[k] = s->note[k + 1]; s->vel[k] = s->vel[k + 1]; }
    s->n--;
    seq_touch();
}

static void seq_track_off(int t) {
    for (int i = 0; i < seq_sounding_n[t]; i++) vm_queue(2, 0x80 | t, seq_sounding[t][i], 0);
    seq_sounding_n[t] = 0;
}

static void seq_all_off(void) { for (int t = 0; t < 4; t++) seq_track_off(t); }

/* One 16th: end each track's previous notes, start this step's. */
static void seq_sixteenth(void) {
    for (int t = 0; t < 4; t++) {
        seq_track_off(t);
        int step = seq_track_pos(t);
        seq_step_t *s = &seq[t].step[step];
        for (int i = 0; i < s->n; i++) {
            if (seq_skip[t][step][i]) { seq_skip[t][step][i] = 0; continue; }
            if (seq[t].muted) continue;
            vm_queue(2, 0x90 | t, s->note[i], s->vel[i]);
            seq_sounding[t][seq_sounding_n[t]++] = s->note[i];
        }
    }
}

/* Step LEDs: the selected track's current page; lit steps have notes, the
 * playhead is bright, steps past the loop end are dark, a held step pulses. */
static void seq_light_steps(void) {
    int t = vm_track, page = vm_page[t], pos = vm_playing ? seq_track_pos(t) : -1;
    uint32_t h = (uint32_t)(t * 131 + page * 17 + (pos + 1) * 7919 + seq_len(t) * 31 + vm_held_step * 3);
    for (int i = 0; i < 16; i++) h = h * 31 + seq[t].step[page * 16 + i].n;
    if ((int)h == seq_led_key) return;
    seq_led_key = (int)h;
    for (int i = 0; i < 16; i++) {
        int st = page * 16 + i;
        uint8_t v = st >= seq_len(t) ? 0 : st == pos ? 120 : seq[t].step[st].n ? 125 : 16;
        vm_queue(0, 0x90 | (st == vm_held_step ? 8 : 0), (uint8_t)(16 + i), v);
    }
    /* Left/Right lit when there is another page to go to */
    vm_queue(0, 0xB0, 62, page > 0 ? 127 : 16);
    vm_queue(0, 0xB0, 63, (page + 1) * 16 < seq_len(t) ? 127 : 16);
}

static void seq_on_tick(void) {
    if (vm_metronome && vm_tick % 24 == 0) {
        vm_click_left = sample_rate / 40;              /* 25 ms */
        vm_click_accent = (vm_tick / 24) % 4 == 0;
    }
    if (vm_tick % 6 == 0) {
        vm_pos = vm_tick / 6;
        if ((vm_pos & 1) && vm_swing > 0) vm_swing_wait = (sample_rate * 60.0 / (vm_bpm * 4.0)) * vm_swing / 100.0;
        else seq_sixteenth();
        /* follow the playhead's page on the selected track while playing */
        int p = seq_track_pos(vm_track) / 16;
        if (vm_held_step < 0 && p != vm_page[vm_track] && seq_len(vm_track) > 16) { vm_page[vm_track] = p; seq_led_key = -1; }
    }
    vm_tick++;
}

static void seq_record_pad(int note, int vel) {
    if (vm_held_step >= 0) {                       /* step held: pads edit that step */
        int i = seq_has(vm_track, vm_held_step, note);
        if (i >= 0) seq_remove(vm_track, vm_held_step, i);
        else seq_add(vm_track, vm_held_step, note, vel, 0);
        vm_held_step_edited = 1;
        return;
    }
    if (!vm_rec || !vm_playing) return;
    int t = vm_track, len = seq_len(t);
    int pos = (vm_tick - 1) % 6;                    /* ticks into the current 16th */
    int cur = seq_track_pos(t) < 0 ? 0 : seq_track_pos(t);
    if (pos >= 3) seq_add(t, (cur + 1) % len, note, vel, 1);   /* early for the next one */
    else seq_add(t, cur, note, vel, 0);                         /* late for this one */
}

static void vm_track_leds(void) {
    for (int t = 0; t < 4; t++)
        vm_queue(0, 0xB0, (uint8_t)(43 - t), seq[t].muted ? 0 : t == vm_track ? 127 : 16);
}

/* Metronome click, written where MoveOriginal writes its own audio. */
static void vm_click(int16_t *out) {
    if (!vm_click_left) return;
    static double ph;
    double f = vm_click_accent ? 1760.0 : 1320.0;
    int total = sample_rate / 40;
    for (int i = 0; i < FRAMES && vm_click_left; i++, vm_click_left--) {
        double env = (double)vm_click_left / total;
        int16_t v = (int16_t)(sin(ph) * env * env * 9000.0);
        ph += 2 * M_PI * f / sample_rate;
        out[i * 2] = v; out[i * 2 + 1] = v;
    }
    if (!vm_click_left) ph = 0;
}

/* What Move itself does with the input the shim let through. */
static void vm_on_midi_in(uint8_t cable, uint8_t st, uint8_t d1, uint8_t d2) {
    if (cable != 0) return;
    uint8_t type = st & 0xF0;
    int on = (type == 0x90 && d2 > 0);
    if ((type == 0x90 || type == 0x80) && d1 >= 68 && d1 < 100) {            /* pads */
        uint8_t ch = (uint8_t)(vm_track & 0x0F);
        atomic_fetch_add(&stats[3], 1);
        if (on) {
            int n = vm_pad_to_note(d1);
            atomic_fetch_add(&stats[4], 1);
            vm_pad_note[d1] = n + 1;
            vm_last_note[vm_track & 3] = n;
            if (!seq[vm_track].muted) vm_queue(2, 0x90 | ch, (uint8_t)n, d2);
            vm_queue(0, 0x90, d1, 120);
            seq_record_pad(n, d2);
        } else if (vm_pad_note[d1]) {
            vm_queue(2, 0x80 | ch, (uint8_t)(vm_pad_note[d1] - 1), 0);
            vm_pad_note[d1] = 0;
            vm_queue(0, 0x90, d1, vm_pad_colour(d1));
        }
        return;
    }
    if (type == 0xA0 && d1 >= 68 && d1 < 100 && vm_pad_note[d1]) {
        vm_queue(2, 0xA0 | (vm_track & 0x0F), (uint8_t)(vm_pad_note[d1] - 1), d2);
        return;
    }
    if ((type == 0x90 || type == 0x80) && d1 >= 16 && d1 < 32) {             /* steps */
        int t = vm_track, step = vm_page[t] * 16 + (d1 - 16);
        if (on) {
            if (vm_loop_held) { seq[t].len = (uint8_t)(step + 1); seq_touch(); return; }
            if (vm_delete_held) { seq[t].step[step].n = 0; seq_touch(); return; }
            vm_held_step = step; vm_held_step_edited = 0; seq_led_key = -1;
        } else if (vm_held_step == step) {
            /* a plain tap toggles; a hold that edited with pads already did its work */
            if (!vm_held_step_edited) {
                if (seq[t].step[step].n) { seq[t].step[step].n = 0; seq_touch(); }
                else if (step < seq_len(t)) seq_add(t, step, vm_last_note[t], 100, 0);
            }
            vm_held_step = -1; seq_led_key = -1;
        }
        return;
    }
    if (type != 0xB0) return;
    if (d1 == 119) { vm_delete_held = d2 >= 64; return; }
    if (d1 == 58) { vm_loop_held = d2 >= 64; return; }
    if (d1 == 88) { vm_mute_held = d2 >= 64; return; }
    if (d1 == 49) { vm_shift_held = d2 >= 64; return; }
    if (d2 != 127) return;
    int t = vm_track;
    if (d1 == 86) {                       /* Rec: arm; Delete+Rec clears the track */
        if (vm_delete_held) { memset(&seq[t].step, 0, sizeof seq[t].step); seq_touch(); return; }
        vm_rec = !vm_rec;
        vm_queue(0, 0xB0, 86, vm_rec ? 127 : 0);
        if (vm_rec && !vm_playing) vm_playing_req = 1;   /* Move starts recording on Rec */
    } else if (d1 >= 40 && d1 <= 43) {   /* track buttons, 43 = Track 1; Mute+Track mutes */
        int tt = 43 - d1;
        if (vm_mute_held) { seq[tt].muted = !seq[tt].muted; if (seq[tt].muted) seq_track_off(tt); seq_touch(); }
        else { vm_track = tt; vm_relight = 1; seq_led_key = -1; }
        vm_track_leds();
    } else if (d1 == 85) {                /* Play */
        vm_playing_req = !vm_playing;
    } else if ((d1 == 62 || d1 == 63) && vm_loop_held) {   /* Loop + Left/Right: length by a page */
        int len = seq_len(t) + (d1 == 63 ? 16 : -16);
        if (len >= 16 && len <= SEQ_STEPS) { seq[t].len = (uint8_t)len; if (vm_page[t] * 16 >= len) vm_page[t] = len / 16 - 1; seq_touch(); }
    } else if (d1 == 62 || d1 == 63) {    /* Left / Right: pattern page */
        int pages = (seq_len(t) + 15) / 16;
        int p = vm_page[t] + (d1 == 63 ? 1 : -1);
        if (p >= 0 && p < pages) { vm_page[t] = p; seq_led_key = -1; }
    } else if ((d1 == 55 || d1 == 54) && !vm_layout[t]) {   /* Up / Down: octave */
        int o = seq[t].octave + (d1 == 55 ? 1 : -1);
        if (o >= -3 && o <= 3) { seq[t].octave = (int8_t)o; vm_relight = 1; seq_touch(); }
    }
}

static void vm_transport(void) {
    if (atomic_exchange(&vm_relight, 0)) vm_light_pads();
    int req = atomic_exchange(&vm_playing_req, -1);
    if (req >= 0 && req != vm_playing) {
        vm_playing = req;
        vm_clock_acc = 0;
        vm_queue(0, req ? 0xFA : 0xFC, 0, 0);
        vm_queue(0, 0xB0, 85, req ? 127 : 0);
        if (req) { vm_tick = 0; vm_queue(0, 0xF8, 0, 0); seq_on_tick(); }
        else {
            seq_all_off(); vm_pos = -1; seq_led_key = -1;
            if (vm_rec) { vm_rec = 0; vm_queue(0, 0xB0, 86, 0); }
            if (seq_dirty) seq_save();
        }
    }
    seq_light_steps();
    if (!vm_playing) {
        if (seq_dirty && emscripten_get_now() - seq_dirty_at > 1500) seq_save();
        return;
    }
    if (vm_swing_wait >= 0) {
        vm_swing_wait -= FRAMES;
        if (vm_swing_wait < 0) seq_sixteenth();
    }
    double per_tick = sample_rate * 60.0 / (vm_bpm * 24.0);
    vm_clock_acc += FRAMES;
    while (vm_clock_acc >= per_tick) {
        vm_clock_acc -= per_tick;
        vm_queue(0, 0xF8, 0, 0);
        seq_on_tick();
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
    if (vm_layout[vm_track & 3]) vm_text(0, 33, "Drum rack", 1);
    else {
        int root, sc; vm_scale_of(vm_track, &root, &sc);
        snprintf(buf, sizeof buf, "%s %s  oct %+d", note_names[root], scales[sc].name, seq[vm_track].octave);
        vm_text(0, 33, buf, 1);
    }
    snprintf(buf, sizeof buf, "%d steps%s%s", seq_len(vm_track), vm_metronome ? " click" : "", vm_swing ? " swing" : "");
    vm_text(0, 45, buf, 1);
    if (vm_rec) vm_text(128 - vm_text_w("REC", 2), 14, "REC", 2);
    else if (vm_playing && vm_pos >= 0) {
        int p = seq_track_pos(vm_track);
        snprintf(buf, sizeof buf, "%d.%d.%d", p / 16 + 1, (p % 16) / 4 + 1, p % 4 + 1);
        vm_text(128 - vm_text_w(buf, 1), 18, buf, 1);
    }
    if (seq[vm_track].muted) vm_text(128 - vm_text_w("MUTED", 1), 33, "MUTED", 1);
    vm_text(0, 55, "Shift+Vol+Trk:Schwung", 1);
}

static int vm_screen_key = -1;

static void vm_update_screen(void) {
    int p = vm_playing ? seq_track_pos(vm_track) : -1;
    int key = vm_track | (vm_layout[vm_track & 3] << 2) | (vm_playing << 3) | (vm_rec << 4) | ((p + 1) << 5) |
              (seq[vm_track].muted << 12) | ((seq[vm_track].octave + 4) << 13) | (seq_len(vm_track) << 16) |
              (vm_metronome << 23) | ((int)(vm_bpm * 10) << 24) ^ (seq[vm_track].root * 7 + seq[vm_track].scale * 131 + vm_swing * 977);
    if (key != vm_screen_key) { vm_screen_key = key; vm_draw_screen(); }
}

/* MoveOriginal's half of the frame, before the shim's pre callback: fresh
 * MIDI_OUT, its own display slice, silence for its audio. */
static void vm_write_tx(uint8_t *sh) {
    vm_update_screen();
    memset(sh + SCHWUNG_OFF_OUT_MIDI, 0, SCHWUNG_MIDI_OUT_MAX * 4);
    /* leave room for the shim's own LED queue, as Move does */
    int n = vm_out_n < SCHWUNG_MIDI_OUT_MAX ? vm_out_n : SCHWUNG_MIDI_OUT_MAX;
    int nl = vm_led_n < 12 - n ? vm_led_n : (12 - n > 0 ? 12 - n : 0);
    for (int i = 0; i < n + nl; i++) {
        uint32_t p = i < n ? vm_out[i] : vm_led_out[i - n];
        sh[i * 4 + 0] = (uint8_t)(p >> 24);
        sh[i * 4 + 1] = (uint8_t)(p >> 16);
        sh[i * 4 + 2] = (uint8_t)(p >> 8);
        sh[i * 4 + 3] = (uint8_t)p;
    }
    memmove(vm_out, vm_out + n, (size_t)(vm_out_n - n) * sizeof vm_out[0]);
    vm_out_n -= n;
    memmove(vm_led_out, vm_led_out + nl, (size_t)(vm_led_n - nl) * sizeof vm_led_out[0]);
    vm_led_n -= nl;

    uint32_t idx = (uint32_t)vm_display_idx;
    if (idx >= 1 && idx <= 6) {
        int len = idx == 6 ? 1024 - 5 * 172 : 172;
        memcpy(sh + SCHWUNG_OFF_OUT_DISP_STAT, &idx, 4);
        memset(sh + SCHWUNG_OFF_OUT_DISP_DATA, 0, 172);
        memcpy(sh + SCHWUNG_OFF_OUT_DISP_DATA, vm_display + (idx - 1) * 172, (size_t)len);
    }
    memset(sh + SCHWUNG_OFF_OUT_AUDIO, 0, FRAMES * 4);
    vm_click((int16_t *)(sh + SCHWUNG_OFF_OUT_AUDIO));
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

    /* RX: audio in from the page, if it is sending any (zero otherwise) */
    {
        uint32_t w = __atomic_load_n(&in_ctl[0], __ATOMIC_ACQUIRE), r = in_ctl[1];
        if (w - r > 8) r = w - 2;                     /* fell behind: keep latency bounded */
        if (w != r) {
            memcpy(hw + SCHWUNG_OFF_IN_AUDIO, in_ring + (r % RING_BLOCKS) * FRAMES * 2, FRAMES * 4);
            __atomic_store_n(&in_ctl[1], r + 1, __ATOMIC_RELEASE);
        }
    }

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
    seq_load();
    uint8_t *sh = schwung_spi_wasm_shadow();
    double last_read_change = now_ms();
    uint32_t last_read = 0;
    vm_light_pads();
    vm_track_leds();
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
EMSCRIPTEN_KEEPALIVE int16_t *sw_in_ring(void) { in_ctl[2] = RING_BLOCKS; return in_ring; }
EMSCRIPTEN_KEEPALIVE uint32_t *sw_in_ctl(void) { in_ctl[2] = RING_BLOCKS; return in_ctl; }
EMSCRIPTEN_KEEPALIVE uint32_t *sw_ext_ring(void) { return (uint32_t *)ext_ring; }
EMSCRIPTEN_KEEPALIVE uint32_t *sw_ext_w(void) { return (uint32_t *)&ext_w; }
EMSCRIPTEN_KEEPALIVE void sw_set_pad_layout(int track, int drums) { if (track >= 0 && track < 4) { vm_layout[track] = drums ? 1 : 0; vm_relight = 1; } }
EMSCRIPTEN_KEEPALIVE int sw_get_track(void) { return vm_track; }
EMSCRIPTEN_KEEPALIVE int sw_get_pad_layout(int track) { return (track >= 0 && track < 4) ? vm_layout[track] : 0; }
EMSCRIPTEN_KEEPALIVE void sw_set_scale(int track, int root, int scale) {
    if (track < 0 || track > 3) return;
    seq[track].root = (uint8_t)(((root % 12) + 12) % 12);
    seq[track].scale = (uint8_t)(scale >= 0 && scale < N_SCALES ? scale : 0);
    vm_relight = 1; seq_dirty = 1;
}
EMSCRIPTEN_KEEPALIVE int sw_get_scale(int track) { return (track >= 0 && track < 4) ? seq[track].root | (seq[track].scale << 8) : 0; }
EMSCRIPTEN_KEEPALIVE const char *sw_scale_name(int i) { return i >= 0 && i < N_SCALES ? scales[i].name : ""; }
EMSCRIPTEN_KEEPALIVE int sw_scale_count(void) { return N_SCALES; }
EMSCRIPTEN_KEEPALIVE void sw_set_swing(int pct) { vm_swing = pct < 0 ? 0 : pct > 60 ? 60 : pct; }
EMSCRIPTEN_KEEPALIVE int sw_get_swing(void) { return vm_swing; }
EMSCRIPTEN_KEEPALIVE void sw_set_metronome(int on) { vm_metronome = on ? 1 : 0; }
EMSCRIPTEN_KEEPALIVE int sw_get_metronome(void) { return vm_metronome; }
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
