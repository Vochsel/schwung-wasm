#!/usr/bin/env python3
"""Apply schwung-wasm's edits to a copy of the Schwung source (build/schwung).

Each edit is an exact-match replacement with a short reason. An edit whose
anchor is missing fails loudly, so upstream drift shows up as a named failure
rather than a silently wrong build. Everything is behind SCHWUNG_WASM, so the
patched tree still builds for the device unchanged.

Usage: patches/apply.py <schwung-tree>
"""
import sys
from pathlib import Path

ROOT = Path(sys.argv[1])
EDITS = []


def edit(path, old, new, why):
    EDITS.append((path, old, new, why))


# --- plugin_api_v1.h: the +120 layout guard is LP64-only -------------------
edit('src/host/plugin_api_v1.h',
     "_Static_assert(offsetof(host_api_v1_t, reserved) == 120,",
     "/* schwung-wasm: wasm32 has 4-byte pointers; the +120 guard is LP64-only. */\n"
     "#if UINTPTR_MAX > 0xFFFFFFFFu\n"
     "_Static_assert(offsetof(host_api_v1_t, reserved) == 120,",
     'wasm32 pointer size')
edit('src/host/plugin_api_v1.h',
     "capabilities as dlsym'd exports, not as fields here.\");",
     "capabilities as dlsym'd exports, not as fields here.\");\n#endif",
     'wasm32 pointer size (close)')

# --- schwung_shim.c: no LD_PRELOAD, so no libc hooks; init is called --------
edit('src/schwung_shim.c',
     "/* Hook connect() to capture Move's D-Bus socket FD */\nint connect(",
     "#ifndef SCHWUNG_WASM /* schwung-wasm: no LD_PRELOAD, so no libc hooks */\n"
     "/* Hook connect() to capture Move's D-Bus socket FD */\nint connect(",
     'connect/send hooks would replace libc in a static link')
edit('src/schwung_shim.c',
     "    return real_send(sockfd, buf, len, flags);\n}\n",
     "    return real_send(sockfd, buf, len, flags);\n}\n#endif /* SCHWUNG_WASM */\n",
     'close connect/send hooks')
edit('src/schwung_shim.c',
     "__attribute__((constructor))\nstatic void shim_spi_init(void)",
     "#ifdef SCHWUNG_WASM\n/* schwung-wasm: engine/vspi.c calls this once the virtual FS is ready. */\n"
     "void shim_spi_init(void)\n#else\n__attribute__((constructor))\nstatic void shim_spi_init(void)\n#endif",
     'constructor becomes an explicit call')
edit('src/schwung_shim.c',
     '    if (!real_ioctl) {\n        real_ioctl = dlsym(RTLD_NEXT, "ioctl");\n    }\n\n    /* Initialize OTLP',
     '#ifndef SCHWUNG_WASM\n    if (!real_ioctl) {\n        real_ioctl = dlsym(RTLD_NEXT, "ioctl");\n    }\n#endif\n\n    /* Initialize OTLP',
     'no RTLD_NEXT')

# --- schwung_spi_lib.c: virtual transfer instead of hooked ioctl ----------
VSPI = '''#ifdef SCHWUNG_WASM
// ============================================================================
// schwung-wasm: virtual SPI transfer
// ============================================================================
// There is no LD_PRELOAD and no /dev/ablspi0.0. engine/vspi.c owns a 4 KB
// "hardware" page and calls schwung_spi_wasm_transfer() once per 128-frame
// block, which reproduces the hooked ioctl below exactly: pre -> TX copy ->
// the virtual XMOS exchange -> RX copy -> post.
extern void schwung_wasm_hw_exchange(uint8_t *hw);

void schwung_spi_wasm_attach(uint8_t *hw) {
    g_spi.hw = hw;
    g_spi.spi_fd = 1000;
    memset(g_spi.shadow, 0, SCHWUNG_PAGE_SIZE);
    g_spi.ready = 1;
}

void schwung_spi_wasm_transfer(void) {
    if (!g_spi.ready) return;
    if (g_spi.pre_fn)
        g_spi.pre_fn(g_spi.ctx, g_spi.shadow, SCHWUNG_PAGE_SIZE);
    memcpy(g_spi.hw, g_spi.shadow, SCHWUNG_OFF_IN_BASE);
    schwung_wasm_hw_exchange(g_spi.hw);
    memcpy(g_spi.shadow + SCHWUNG_OFF_IN_BASE,
           g_spi.hw + SCHWUNG_OFF_IN_BASE,
           SCHWUNG_PAGE_SIZE - SCHWUNG_OFF_IN_BASE);
    if (g_spi.post_fn)
        g_spi.post_fn(g_spi.ctx, g_spi.shadow, g_spi.hw, SCHWUNG_PAGE_SIZE);
}

uint8_t *schwung_spi_wasm_shadow(void) { return g_spi.shadow; }
#else
static void ensure_real_funcs(void) {'''
edit('src/lib/schwung_spi_lib.c', "static void ensure_real_funcs(void) {", VSPI,
     'virtual SPI transfer replaces the LD_PRELOAD hooks')
edit('src/lib/schwung_spi_lib.c',
     "        if (g_spi.post_fn)\n            g_spi.post_fn(g_spi.ctx, g_spi.shadow, g_spi.hw, SCHWUNG_PAGE_SIZE);\n    }\n\n    return ret;\n}\n",
     "        if (g_spi.post_fn)\n            g_spi.post_fn(g_spi.ctx, g_spi.shadow, g_spi.hw, SCHWUNG_PAGE_SIZE);\n    }\n\n    return ret;\n}\n#endif /* SCHWUNG_WASM */\n",
     'close hooks block')
edit('src/lib/schwung_spi_lib.c',
     "static int (*real_open)(const char *path, int flags, ...) = NULL;\nstatic int (*real_ioctl)(int fd, unsigned long request, ...) = NULL;\nstatic void *(*real_mmap)(void *, size_t, int, int, int, off_t) = NULL;\n",
     "#ifndef SCHWUNG_WASM\nstatic int (*real_open)(const char *path, int flags, ...) = NULL;\nstatic int (*real_ioctl)(int fd, unsigned long request, ...) = NULL;\nstatic void *(*real_mmap)(void *, size_t, int, int, int, off_t) = NULL;\n#endif\n",
     'unused without hooks')

# --- shadow_process.c: shadow_ui is a thread -------------------------------
LAUNCH = '''#ifdef SCHWUNG_WASM
/* schwung-wasm: shadow_ui runs as a pthread in the same wasm program instead
 * of a forked process (engine/shadow_ui_thread.c). Same exit-flag and backoff
 * rules as below; liveness comes from the thread, not /proc. */
extern int  schwung_wasm_shadow_ui_running(void);
extern void schwung_wasm_spawn_shadow_ui(void);
void launch_shadow_ui(void) {
    if (schwung_wasm_shadow_ui_running()) { shadow_ui_started = 1; shadow_ui_pid = 1; return; }
    shadow_ui_started = 0;
    if (shadow_ui_backoff_active) return;
    if (shadow_ui_exit_flag && *shadow_ui_exit_flag) return;
    struct timespec now_ts;
    clock_gettime(CLOCK_MONOTONIC, &now_ts);
    if (shadow_ui_last_launch_sec != 0 &&
        (now_ts.tv_sec - shadow_ui_last_launch_sec) < SHADOW_UI_RAPID_WINDOW_SEC) {
        if (++shadow_ui_rapid_relaunches >= SHADOW_UI_MAX_RAPID_RELAUNCH) { shadow_ui_backoff_active = 1; return; }
    } else {
        shadow_ui_rapid_relaunches = 0;
    }
    shadow_ui_last_launch_sec = now_ts.tv_sec;
    schwung_wasm_spawn_shadow_ui();
    shadow_ui_started = 1;
    shadow_ui_pid = 1;
}
#else
void launch_shadow_ui(void) {
'''
edit('src/host/shadow_process.c', "void launch_shadow_ui(void) {\n", LAUNCH, 'shadow_ui as a thread')
edit('src/host/shadow_process.c',
     "    shadow_ui_started = 1;\n    shadow_ui_pid = pid;\n}\n",
     "    shadow_ui_started = 1;\n    shadow_ui_pid = pid;\n}\n#endif /* SCHWUNG_WASM */\n",
     'close shadow_ui launch')

# --- no processes: shell commands run in-process (engine/exec.c) ----------
edit('src/host/js_host_common.c',
     "int run_command(const char *const argv[]) {\n    pid_t pid = fork();",
     "#ifdef SCHWUNG_WASM\nextern int schwung_wasm_run(const char *const argv[]);\n"
     "int run_command(const char *const argv[]) { return schwung_wasm_run(argv); }\n"
     "static void run_command_background(const char *const argv[]) { (void)schwung_wasm_run(argv); }\n"
     "#else\nint run_command(const char *const argv[]) {\n    pid_t pid = fork();",
     'run_command without fork')
edit('src/host/js_host_common.c',
     "    execvp(argv[0], (char *const *)argv);\n    _exit(127);\n}\n\n/* Helper: validate path",
     "    execvp(argv[0], (char *const *)argv);\n    _exit(127);\n}\n#endif /* SCHWUNG_WASM */\n\n/* Helper: validate path",
     'close run_command')
edit('src/shadow/shadow_ui.c',
     "    pid_t pid = fork();\n    if (pid == -1) {\n        JS_FreeCString(ctx, cmd);\n        return JS_NewInt32(ctx, -1);\n    }",
     "#ifdef SCHWUNG_WASM\n    {\n        extern int schwung_wasm_system(const char *line);\n        int rc = schwung_wasm_system(cmd);\n"
     "        JS_FreeCString(ctx, cmd);\n        return JS_NewInt32(ctx, rc);\n    }\n#endif\n"
     "    pid_t pid = fork();\n    if (pid == -1) {\n        JS_FreeCString(ctx, cmd);\n        return JS_NewInt32(ctx, -1);\n    }",
     'host_system_cmd without fork')

# --- a dev door into the UI's JS context (engine/ui_eval.c) ---------------
edit('src/shadow/shadow_ui.c',
     "        /* Process incoming MIDI BEFORE tick() so that the current frame's\n",
     "#ifdef SCHWUNG_WASM\n        { extern void schwung_wasm_ui_poll(JSContext *ctx); schwung_wasm_ui_poll(ctx); }\n#endif\n"
     "        /* Process incoming MIDI BEFORE tick() so that the current frame's\n",
     'page-queued JS runs on the UI thread, between ticks')


def main():
    failed = 0
    for path, old, new, why in EDITS:
        p = ROOT / path
        s = p.read_text()
        if new in s:
            continue  # already applied
        if s.count(old) != 1:
            print(f'patch FAILED ({why}): {path}: anchor found {s.count(old)}x', file=sys.stderr)
            failed += 1
            continue
        p.write_text(s.replace(old, new, 1))
    print(f'applied {len(EDITS) - failed}/{len(EDITS)} edits')
    sys.exit(1 if failed else 0)


main()
