/* tar -xzf for module installs (host_extract_tar*), with zlib. */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <zlib.h>

static int mkdirs_for(const char *path) {
    char buf[1024];
    snprintf(buf, sizeof buf, "%s", path);
    for (char *p = buf + 1; *p; p++)
        if (*p == '/') { *p = 0; mkdir(buf, 0755); *p = '/'; }
    return 0;
}

static unsigned long octal(const char *s, int n) {
    unsigned long v = 0;
    for (int i = 0; i < n && s[i]; i++)
        if (s[i] >= '0' && s[i] <= '7') v = v * 8 + (unsigned long)(s[i] - '0');
    return v;
}

static const char *strip_path(const char *name, int strip) {
    while (strip-- > 0) {
        const char *s = strchr(name, '/');
        if (!s) return NULL;
        name = s + 1;
    }
    return *name ? name : NULL;
}

int schwung_wasm_untar(const char *tgz, const char *dest, int strip) {
    gzFile g = gzopen(tgz, "rb");
    if (!g) return -1;
    char hdr[512], longname[1024] = {0}, full[2048];
    int rc = 0;
    for (;;) {
        if (gzread(g, hdr, 512) != 512) break;
        if (!hdr[0]) break;                     /* end-of-archive block */
        unsigned long size = octal(hdr + 124, 12);
        char type = hdr[156];
        char name[512];
        if (longname[0]) { snprintf(name, sizeof name, "%s", longname); longname[0] = 0; }
        else if (!memcmp(hdr + 257, "ustar", 5) && hdr[345]) snprintf(name, sizeof name, "%.155s/%.100s", hdr + 345, hdr);
        else snprintf(name, sizeof name, "%.100s", hdr);
        unsigned long padded = (size + 511) & ~511UL;
        if (type == 'L') {                      /* GNU long name: next entry's name */
            unsigned long n = size < sizeof longname - 1 ? size : sizeof longname - 1;
            gzread(g, longname, (unsigned)n); longname[n] = 0;
            if (padded > n) gzseek(g, (z_off_t)(padded - n), SEEK_CUR);
            continue;
        }
        const char *rel = strip_path(name[0] == '.' && name[1] == '/' ? name + 2 : name, strip);
        if (type == 'x' || type == 'g' || !rel) { gzseek(g, (z_off_t)padded, SEEK_CUR); continue; }
        snprintf(full, sizeof full, "%s/%s", dest, rel);
        if (type == '5') { mkdirs_for(full); mkdir(full, 0755); continue; }
        if (type != '0' && type != 0) { gzseek(g, (z_off_t)padded, SEEK_CUR); continue; }  /* links etc. */
        mkdirs_for(full);
        FILE *f = fopen(full, "wb");
        char buf[65536];
        unsigned long left = size;
        while (left) {
            unsigned n = left > sizeof buf ? (unsigned)sizeof buf : (unsigned)left;
            if (gzread(g, buf, n) != (int)n) { rc = -1; break; }
            if (f) fwrite(buf, 1, n, f);
            left -= n;
        }
        if (f) fclose(f); else rc = -1;
        if (padded > size) gzseek(g, (z_off_t)(padded - size), SEEK_CUR);
    }
    gzclose(g);
    return rc;
}
