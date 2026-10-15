/* The handful of shell commands Schwung runs, done in-process.
 *
 * On the device, js_host_common.c and shadow_ui.c fork/exec mkdir, rm, cp,
 * mv, tar and friends (all from fixed argv or an allowlisted command line).
 * A browser has no processes, so the patched callers come here instead.
 * Unsupported commands return 127, as a missing binary would. */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

int schwung_wasm_untar(const char *tgz, const char *dest, int strip);

static int mkdir_p(const char *path) {
    char buf[1024];
    snprintf(buf, sizeof buf, "%s", path);
    for (char *p = buf + 1; *p; p++) {
        if (*p == '/') {
            *p = 0;
            if (mkdir(buf, 0755) != 0 && errno != EEXIST) return -1;
            *p = '/';
        }
    }
    if (mkdir(buf, 0755) != 0 && errno != EEXIST) return -1;
    return 0;
}

static int rm_rf(const char *path) {
    struct stat st;
    if (lstat(path, &st) != 0) return 0;
    if (S_ISDIR(st.st_mode)) {
        DIR *d = opendir(path);
        if (d) {
            struct dirent *e;
            char child[1024];
            while ((e = readdir(d))) {
                if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
                snprintf(child, sizeof child, "%s/%s", path, e->d_name);
                rm_rf(child);
            }
            closedir(d);
        }
        return rmdir(path);
    }
    return unlink(path);
}

static int copy_file(const char *src, const char *dst) {
    FILE *in = fopen(src, "rb");
    if (!in) return -1;
    FILE *out = fopen(dst, "wb");
    if (!out) { fclose(in); return -1; }
    char buf[65536];
    size_t n;
    while ((n = fread(buf, 1, sizeof buf, in)) > 0) fwrite(buf, 1, n, out);
    fclose(in);
    fclose(out);
    return 0;
}

static int copy_r(const char *src, const char *dst) {
    struct stat st;
    if (stat(src, &st) != 0) return -1;
    if (!S_ISDIR(st.st_mode)) return copy_file(src, dst);
    if (mkdir_p(dst) != 0) return -1;
    DIR *d = opendir(src);
    if (!d) return -1;
    struct dirent *e;
    char a[1024], b[1024];
    int rc = 0;
    while ((e = readdir(d))) {
        if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
        snprintf(a, sizeof a, "%s/%s", src, e->d_name);
        snprintf(b, sizeof b, "%s/%s", dst, e->d_name);
        rc |= copy_r(a, b);
    }
    closedir(d);
    return rc;
}

/* cp/mv into an existing directory keep the source's basename. */
static void dest_path(const char *src, const char *dst, char *out, size_t n) {
    struct stat st;
    if (stat(dst, &st) == 0 && S_ISDIR(st.st_mode)) {
        const char *base = strrchr(src, '/');
        snprintf(out, n, "%s/%s", dst, base ? base + 1 : src);
    } else {
        snprintf(out, n, "%s", dst);
    }
}

int schwung_wasm_run(const char *const argv[]) {
    int argc = 0;
    while (argv[argc]) argc++;
    if (argc == 0) return 127;
    const char *cmd = strrchr(argv[0], '/') ? strrchr(argv[0], '/') + 1 : argv[0];
    /* operands: everything that is not an option */
    const char *ops[32];
    int nops = 0, recursive = 0, strip = 0;
    const char *tar_file = NULL, *tar_dir = ".";
    for (int i = 1; i < argc && nops < 32; i++) {
        const char *a = argv[i];
        if (!strcmp(cmd, "tar")) {
            if (!strcmp(a, "-C") && i + 1 < argc) { tar_dir = argv[++i]; continue; }
            if (!strncmp(a, "--strip-components=", 19)) { strip = atoi(a + 19); continue; }
            if (a[0] == '-') { if (strchr(a, 'f') && i + 1 < argc) tar_file = argv[++i]; continue; }
            continue;
        }
        if (a[0] == '-' && a[1]) { if (strpbrk(a + 1, "rRa")) recursive = 1; continue; }
        ops[nops++] = a;
    }
    if (!strcmp(cmd, "mkdir")) {
        int rc = 0;
        for (int i = 0; i < nops; i++) rc |= mkdir_p(ops[i]);
        return rc ? 1 : 0;
    }
    if (!strcmp(cmd, "rm")) {
        for (int i = 0; i < nops; i++) rm_rf(ops[i]);
        return 0;
    }
    if (!strcmp(cmd, "cp") && nops >= 2) {
        int rc = 0;
        char d[1024];
        for (int i = 0; i < nops - 1; i++) {
            dest_path(ops[i], ops[nops - 1], d, sizeof d);
            rc |= recursive ? copy_r(ops[i], d) : copy_file(ops[i], d);
        }
        return rc ? 1 : 0;
    }
    if (!strcmp(cmd, "mv") && nops >= 2) {
        int rc = 0;
        char d[1024];
        for (int i = 0; i < nops - 1; i++) {
            dest_path(ops[i], ops[nops - 1], d, sizeof d);
            if (rename(ops[i], d) != 0) rc |= copy_r(ops[i], d) || rm_rf(ops[i]);
        }
        return rc ? 1 : 0;
    }
    if (!strcmp(cmd, "chmod") || !strcmp(cmd, "sync") || !strcmp(cmd, "true")) return 0;
    if (!strcmp(cmd, "ls")) return nops && access(ops[0], F_OK) != 0 ? 2 : 0;
    if (!strcmp(cmd, "test") && argc >= 3) {
        struct stat st;
        if (stat(argv[2], &st) != 0) return 1;
        if (!strcmp(argv[1], "-d")) return S_ISDIR(st.st_mode) ? 0 : 1;
        if (!strcmp(argv[1], "-f")) return S_ISREG(st.st_mode) ? 0 : 1;
        return 0;
    }
    if (!strcmp(cmd, "tar") && tar_file) return schwung_wasm_untar(tar_file, tar_dir, strip) ? 1 : 0;
    fprintf(stderr, "schwung-wasm: no '%s' in the browser\n", cmd);
    return 127;
}

/* A command line from host_system_cmd: split on whitespace with single and
 * double quotes, run each `&&`-joined part in order. */
int schwung_wasm_system(const char *line) {
    char buf[2048];
    snprintf(buf, sizeof buf, "%s", line);
    char *p = buf;
    int rc = 0;
    while (*p) {
        const char *argv[64];
        int argc = 0;
        int stop = 0;
        while (*p && argc < 63 && !stop) {
            while (*p == ' ' || *p == '\t') p++;
            if (!*p) break;
            if (p[0] == '&' && p[1] == '&') { p += 2; stop = 1; break; }
            if (*p == ';') { p++; stop = 1; break; }
            char *out = p, *start = p;
            while (*p && *p != ' ' && *p != '\t' && *p != ';' && !(p[0] == '&' && p[1] == '&')) {
                if (*p == '\'' || *p == '"') {
                    char q = *p++;
                    while (*p && *p != q) *out++ = *p++;
                    if (*p) p++;
                } else {
                    *out++ = *p++;
                }
            }
            char next = *p;
            *out = 0;
            if (next == ' ' || next == '\t') p++;
            else if (next == ';') { p++; stop = 1; }
            else if (next == '&' && p[1] == '&') { p += 2; stop = 1; }
            if (!strcmp(start, "2>/dev/null") || !strcmp(start, ">/dev/null") || !strcmp(start, "2>&1")) continue;
            argv[argc++] = start;
        }
        argv[argc] = NULL;
        if (argc) {
            rc = schwung_wasm_run(argv);
            if (rc != 0) return rc;
        }
    }
    return rc;
}
