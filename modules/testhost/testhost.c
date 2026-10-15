/* schwung-wasm module test host.
 *
 * A tiny Emscripten MAIN_MODULE that loads one Schwung module side module with
 * the real dlopen(), exactly like the chain host does on the device, drives it
 * for a few seconds and writes the result as a WAV.
 *
 *   testhost <component_type> <dsp.so> <module_dir> <out.wav> [seconds] [transport] [threaded]
 *
 * transport=1 runs Move's transport: 0xFA then 24-PPQN 0xF8 at 120 BPM, as
 * 1-byte messages (the way the chain forwards them), clock status RUNNING and
 * a live beat position. Default 0 (stopped, beat position -1).
 *
 * component_type: sound_generator | audio_fx | midi_fx
 *
 * The last stdout line is "@@RESULT {json}" with rms/peak/etc. for
 * scripts/test-module.mjs to parse. Exit code 0 = ran to completion (the
 * pass/fail decision is made by the caller from the JSON).
 *
 * The host API mirrors what the chain hands a sub-plugin: 44100 Hz, 128-frame
 * blocks, a zeroed 4 KB mailbox as mapped_memory, BPM 120, clock stopped,
 * reserved[] all NULL.
 */
#include <dlfcn.h>
#include <pthread.h>
#include <semaphore.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "plugin_api_v1.h"
#include "audio_fx_api_v2.h"
#include "midi_fx_api_v1.h"

#define SR 44100
#define BLOCK 128

static uint8_t g_mailbox[4096];
static double g_beat = -1.0;
static int g_log_count = 0;

static void th_log(const char *msg) {
    if (g_log_count++ < 200) printf("[module] %s\n", msg ? msg : "(null)");
}
static int th_midi_send(const uint8_t *msg, int len) { (void)msg; return len; }
static int g_transport = 0;
static int th_clock_status(void) { return g_transport ? MOVE_CLOCK_STATUS_RUNNING : MOVE_CLOCK_STATUS_STOPPED; }
static float th_get_bpm(void) { return 120.0f; }
static double th_beat_pos(void) { return g_beat; }
static int th_slot_recv(void *inst) { (void)inst; return -1; }
static int th_inject(const uint8_t *msg, int len) { (void)msg; (void)len; return 0; }

static host_api_v1_t g_host; /* static => reserved[] zeroed */

static void init_host(void) {
    memset(&g_host, 0, sizeof(g_host));
    g_host.api_version = MOVE_PLUGIN_API_VERSION;
    g_host.sample_rate = SR;
    g_host.frames_per_block = BLOCK;
    g_host.mapped_memory = g_mailbox;
    g_host.audio_out_offset = MOVE_AUDIO_OUT_OFFSET;
    g_host.audio_in_offset = MOVE_AUDIO_IN_OFFSET;
    g_host.log = th_log;
    g_host.midi_send_internal = th_midi_send;
    g_host.midi_send_external = th_midi_send;
    g_host.get_clock_status = th_clock_status;
    g_host.get_bpm = th_get_bpm;
    g_host.midi_inject_to_move = th_inject;
    g_host.slot_recv_channel = th_slot_recv;
    g_host.get_beat_position = th_beat_pos;
}

/* ---- test stimulus ----------------------------------------------------- */

typedef struct { double t; uint8_t m[3]; } ev_t;
/* Notes cover drum-map (36..51) and melodic ranges. */
static const ev_t g_events[] = {
    {0.00, {0x90, 36, 110}}, {0.00, {0x90, 48, 100}},
    {0.25, {0x90, 38, 100}}, {0.25, {0x90, 55, 100}},
    {0.50, {0x90, 42, 100}}, {0.50, {0x90, 60, 100}},
    {0.75, {0x90, 64, 100}}, {0.75, {0x90, 67, 100}},
    {0.40, {0x80, 36, 0}},   {0.40, {0x80, 38, 0}},  {0.60, {0x80, 42, 0}},
    {1.00, {0x90, 72, 110}},
    {1.40, {0x80, 48, 0}}, {1.40, {0x80, 55, 0}}, {1.40, {0x80, 60, 0}},
    {1.40, {0x80, 64, 0}}, {1.40, {0x80, 67, 0}}, {1.40, {0x80, 72, 0}},
};
#define N_EVENTS (int)(sizeof(g_events) / sizeof(g_events[0]))

/* A trivial sine poly synth to make midi_fx output audible. */
typedef struct { int note; double phase; float amp; int on; } voice_t;
static voice_t g_voices[16];
static int g_fx_note_ons = 0, g_fx_msgs = 0;

static void sine_midi(const uint8_t *m, int len) {
    if (len < 3) return;
    g_fx_msgs++;
    uint8_t st = m[0] & 0xF0;
    if (st == 0x90 && m[2] > 0) {
        g_fx_note_ons++;
        for (int i = 0; i < 16; i++) if (!g_voices[i].on) {
            g_voices[i] = (voice_t){m[1], 0, m[2] / 127.0f * 0.2f, 1};
            return;
        }
    } else if (st == 0x80 || (st == 0x90 && m[2] == 0)) {
        for (int i = 0; i < 16; i++)
            if (g_voices[i].on && g_voices[i].note == m[1]) g_voices[i].on = 0;
    }
}
static void sine_render(int16_t *buf, int frames) {
    for (int f = 0; f < frames; f++) {
        float s = 0;
        for (int i = 0; i < 16; i++) if (g_voices[i].on) {
            voice_t *v = &g_voices[i];
            s += v->amp * (float)sin(v->phase);
            v->phase += 2 * M_PI * 440.0 * pow(2.0, (v->note - 69) / 12.0) / SR;
            if (v->phase > 2 * M_PI) v->phase -= 2 * M_PI;
        }
        int16_t x = (int16_t)(fmaxf(-1, fminf(1, s)) * 32767);
        buf[2 * f] = buf[2 * f + 1] = x;
    }
}

/* ---- wav ----------------------------------------------------------------- */

static void put32(FILE *f, uint32_t v) { fwrite(&v, 4, 1, f); }
static void put16(FILE *f, uint16_t v) { fwrite(&v, 2, 1, f); }
static int write_wav(const char *path, const int16_t *pcm, int frames) {
    FILE *f = fopen(path, "wb");
    if (!f) return -1;
    uint32_t data = (uint32_t)frames * 4;
    fwrite("RIFF", 1, 4, f); put32(f, 36 + data); fwrite("WAVEfmt ", 1, 8, f);
    put32(f, 16); put16(f, 1); put16(f, 2); put32(f, SR); put32(f, SR * 4);
    put16(f, 4); put16(f, 16); fwrite("data", 1, 4, f); put32(f, data);
    fwrite(pcm, 4, frames, f);
    fclose(f);
    return 0;
}

static void fail(const char *stage, const char *why) {
    printf("@@RESULT {\"ok\":false,\"stage\":\"%s\",\"error\":\"", stage);
    for (const char *p = why ? why : "?"; *p; p++)
        putchar(*p == '"' || *p == '\\' ? '\'' : (*p == '\n' ? ' ' : *p));
    printf("\"}\n");
    fflush(stdout);
    exit(2);
}

/* ---- render (on the main thread, or on a separate long-lived thread) ---- */

static int kind, total_blocks;
static plugin_api_v2_t *sg;
static audio_fx_api_v2_t *fx;
/* Like chain_fx_load.c: FX MIDI comes from the optional dlsym'd export,
 * never from the struct's on_midi (older modules' structs end before it). */
static void (*fx_on_midi)(void *, const uint8_t *, int, int);
static midi_fx_api_v1_t *mf;
static void *inst;
static int16_t *out;
static double diff_sum; /* FX: energy of (out - dry in) */

static void render_all(void) {
    int next_ev = 0;
    double saw = 0;
    /* events are not sorted; fire each once when its time passes */
    char fired[N_EVENTS];
    memset(fired, 0, sizeof fired);
    (void)next_ev;

    for (int b = 0; b < total_blocks; b++) {
        double t0 = (double)b * BLOCK / SR, t1 = (double)(b + 1) * BLOCK / SR;
        g_beat = g_transport ? t0 * 2.0 : -1.0; /* 120 BPM */
        if (g_transport) {
            /* Start on the first block, then every clock due before t1. */
            static long clocks_sent = 0;
            uint8_t rt[3] = {0, 0, 0};
            for (;;) {
                if (b == 0 && clocks_sent == 0) { rt[0] = 0xFA; }
                else if ((double)(clocks_sent - 1) / 48.0 < t1) rt[0] = 0xF8;
                else break;
                clocks_sent++;
                if (kind == 0) sg->on_midi(inst, rt, 1, MOVE_MIDI_SOURCE_INTERNAL);
                else if (kind == 1) { if (fx_on_midi) fx_on_midi(inst, rt, 1, MOVE_MIDI_SOURCE_INTERNAL); }
                else {
                    uint8_t o[MIDI_FX_MAX_OUT_MSGS][3]; int ol[MIDI_FX_MAX_OUT_MSGS];
                    int n = mf->process_midi(inst, rt, 1, o, ol, MIDI_FX_MAX_OUT_MSGS);
                    for (int i = 0; i < n && i < MIDI_FX_MAX_OUT_MSGS; i++) sine_midi(o[i], ol[i]);
                }
            }
        }
        for (int e = 0; e < N_EVENTS; e++) {
            if (fired[e] || g_events[e].t >= t1) continue;
            fired[e] = 1;
            const uint8_t *m = g_events[e].m;
            if (kind == 0) sg->on_midi(inst, m, 3, MOVE_MIDI_SOURCE_INTERNAL);
            else if (kind == 1) { if (fx_on_midi) fx_on_midi(inst, m, 3, MOVE_MIDI_SOURCE_INTERNAL); }
            else {
                uint8_t o[MIDI_FX_MAX_OUT_MSGS][3]; int ol[MIDI_FX_MAX_OUT_MSGS];
                int n = mf->process_midi(inst, m, 3, o, ol, MIDI_FX_MAX_OUT_MSGS);
                for (int i = 0; i < n && i < MIDI_FX_MAX_OUT_MSGS; i++) sine_midi(o[i], ol[i]);
            }
        }
        int16_t *blk = out + (size_t)b * BLOCK * 2;
        if (kind == 0) {
            sg->render_block(inst, blk, BLOCK);
        } else if (kind == 1) {
            /* 110 Hz saw at -6 dBFS for the first 1.5 s, then silence (tail). */
            for (int f = 0; f < BLOCK; f++) {
                double t = t0 + (double)f / SR;
                int16_t s = 0;
                if (t < 1.5) {
                    s = (int16_t)((saw * 2.0 - 1.0) * 16000.0);
                    saw += 110.0 / SR;
                    if (saw >= 1.0) saw -= 1.0;
                }
                blk[2 * f] = blk[2 * f + 1] = s;
            }
            /* audio-in mailbox gets the same signal, for modules that read it */
            memcpy(g_mailbox + MOVE_AUDIO_IN_OFFSET, blk, MOVE_AUDIO_BYTES_PER_BLOCK);
            int16_t dry[BLOCK * 2];
            memcpy(dry, blk, sizeof dry);
            fx->process_block(inst, blk, BLOCK);
            for (int i = 0; i < BLOCK * 2; i++) { double d = (double)blk[i] - dry[i]; diff_sum += d * d; }
        } else {
            if (mf->tick) {
                uint8_t o[MIDI_FX_MAX_OUT_MSGS][3]; int ol[MIDI_FX_MAX_OUT_MSGS];
                int n = mf->tick(inst, BLOCK, SR, o, ol, MIDI_FX_MAX_OUT_MSGS);
                for (int i = 0; i < n && i < MIDI_FX_MAX_OUT_MSGS; i++) sine_midi(o[i], ol[i]);
            }
            sine_render(blk, BLOCK);
        }
    }
}

/* --threaded: the render thread exists BEFORE the module is dlopen()ed on the
 * main ("loader") thread, and only then starts calling into it, which is the
 * shape of the engine (slot loader thread vs. SPI/audio thread). Emscripten
 * must sync the new side module into the already-running thread. */
static sem_t g_go;
static void *render_thread(void *arg) {
    (void)arg;
    sem_wait(&g_go);
    printf("[testhost] rendering on a separate pthread\n");
    render_all();
    return NULL;
}

int main(int argc, char **argv) {
    if (argc < 5) {
        fprintf(stderr, "usage: testhost <type> <dsp.so> <module_dir> <out.wav> [seconds]\n");
        return 1;
    }
    const char *type = argv[1], *so = argv[2], *dir = argv[3], *wav = argv[4];
    double seconds = argc > 5 ? atof(argv[5]) : 2.0;
    g_transport = argc > 6 ? atoi(argv[6]) : 0;
    int threaded = argc > 7 ? atoi(argv[7]) : 0;
    total_blocks = (int)(seconds * SR / BLOCK);
    int total_frames = total_blocks * BLOCK;
    init_host();
    setvbuf(stdout, NULL, _IOLBF, 0);

    out = calloc((size_t)total_frames * 2, sizeof(int16_t));
    pthread_t render_tid;
    if (threaded) {
        sem_init(&g_go, 0, 0);
        if (pthread_create(&render_tid, NULL, render_thread, NULL) != 0) fail("pthread", "pthread_create failed");
    }

    void *h = dlopen(so, RTLD_NOW | RTLD_LOCAL);
    if (!h) fail("dlopen", dlerror());

    kind = !strcmp(type, "sound_generator") ? 0 : !strcmp(type, "audio_fx") ? 1
             : !strcmp(type, "midi_fx") ? 2 : -1;
    if (kind < 0) fail("args", "unknown component_type");


    if (kind == 0) {
        move_plugin_init_v2_fn init = (move_plugin_init_v2_fn)dlsym(h, MOVE_PLUGIN_INIT_V2_SYMBOL);
        if (!init) fail("dlsym", "move_plugin_init_v2 missing");
        sg = init(&g_host);
        if (!sg || sg->api_version != MOVE_PLUGIN_API_VERSION_2) fail("init", "bad v2 api");
        inst = sg->create_instance(dir, NULL);
        if (!inst) fail("create_instance", "returned NULL");
    } else if (kind == 1) {
        audio_fx_init_v2_fn init = (audio_fx_init_v2_fn)dlsym(h, AUDIO_FX_INIT_V2_SYMBOL);
        if (!init) fail("dlsym", "move_audio_fx_init_v2 missing");
        fx = init(&g_host);
        if (!fx || !fx->create_instance || !fx->process_block) fail("init", "bad fx v2 api");
        inst = fx->create_instance(dir, NULL);
        if (!inst) fail("create_instance", "returned NULL");
        fx_on_midi = (void (*)(void *, const uint8_t *, int, int))dlsym(h, "move_audio_fx_on_midi");
    } else {
        midi_fx_init_fn init = (midi_fx_init_fn)dlsym(h, MIDI_FX_INIT_SYMBOL);
        if (!init) fail("dlsym", "move_midi_fx_init missing");
        mf = init((const struct host_api_v1 *)&g_host);
        if (!mf || mf->api_version != MIDI_FX_API_VERSION) fail("init", "bad midi fx api");
        inst = mf->create_instance(dir, NULL);
        if (!inst) fail("create_instance", "returned NULL");
    }
    printf("[testhost] loaded %s as %s\n", so, type);

    if (threaded) { sem_post(&g_go); pthread_join(render_tid, NULL); }
    else render_all();

    /* stats */
    double sum = 0; int peak = 0; long railed = 0;
    for (long i = 0; i < (long)total_frames * 2; i++) {
        int v = out[i];
        sum += (double)v * v;
        if (abs(v) > peak) peak = abs(v);
        if (v >= 32767 || v <= -32767) railed++;
    }
    double rms = sqrt(sum / ((double)total_frames * 2)) / 32768.0;
    /* For FX: input is live until 1.5 s; a dead-zero 1.0-1.5 s stretch after
     * earlier output usually means NaN poisoned a filter state (wasm float->int
     * conversion saturates NaN to 0). */
    int nan_suspect = 0;
    if (kind == 1) {
        long a = (long)(1.0 * SR) * 2, z = (long)(1.5 * SR) * 2, nz = 0;
        for (long i = a; i < z && i < (long)total_frames * 2; i++) if (out[i]) nz++;
        if (nz == 0 && peak > 0) nan_suspect = 1;
    }
    double diff_rms = sqrt(diff_sum / ((double)total_frames * 2)) / 32768.0;
    double railed_frac = (double)railed / ((double)total_frames * 2);

    char gp[256] = "";
    if (kind == 0 && sg->get_param) {
        char tmp[200];
        if (sg->get_param(inst, "preset_name", tmp, sizeof tmp) > 0) snprintf(gp, sizeof gp, "%s", tmp);
    }

    if (kind == 0) sg->destroy_instance(inst);
    else if (kind == 1) fx->destroy_instance(inst);
    else mf->destroy_instance(inst);

    if (write_wav(wav, out, total_frames) != 0) fail("wav", "cannot write wav");
    for (char *p = gp; *p; p++) if (*p == '"' || *p == '\\' || (unsigned char)*p < 32) *p = '_';
    printf("@@RESULT {\"ok\":true,\"rms\":%.6f,\"rms_dbfs\":%.2f,\"peak\":%d,\"railed_frac\":%.4f,"
           "\"nan_suspect\":%s,\"transport\":%d,\"threaded\":%d,\"frames\":%d,\"midi_out_msgs\":%d,\"midi_out_note_ons\":%d,\"preset_name\":\"%s\",\"fx_diff_dbfs\":%.2f}\n",
           rms, rms > 0 ? 20 * log10(rms) : -999.0, peak, railed_frac, nan_suspect ? "true" : "false", g_transport, threaded,
           total_frames, g_fx_msgs, g_fx_note_ons, gp, diff_rms > 0 ? 20 * log10(diff_rms) : -999.0);
    fflush(stdout);
    free(out);
    return 0;
}
