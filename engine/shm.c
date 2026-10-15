/* POSIX shared memory for one wasm program.
 *
 * On the device, the shim and shadow_ui are separate processes that share
 * /dev/shm segments. Here they are threads of one program on one shared
 * WebAssembly.Memory, so a "segment" is just a zeroed heap block looked up by
 * name. shm_open hands out descriptors from a private range; the linker wraps
 * mmap/munmap/ftruncate/fstat/close (-Wl,--wrap=...) so those descriptors map
 * to the block and every other descriptor goes to the real call. Upstream code
 * (shadow_shm_util.c, the shim, shadow_ui.c) runs unchanged. */
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#define SHM_MAX 64
#define SHM_FD_BASE 0x4000

typedef struct {
    char name[64];
    void *mem;
    size_t size;
    int open_fds;
} seg_t;

static seg_t segs[SHM_MAX];
static int nsegs;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;

static seg_t *find(const char *name) {
    for (int i = 0; i < nsegs; i++)
        if (strcmp(segs[i].name, name) == 0) return &segs[i];
    return NULL;
}

static seg_t *seg_of_fd(int fd) {
    int i = fd - SHM_FD_BASE;
    return (i >= 0 && i < nsegs) ? &segs[i] : NULL;
}

/* Grow a segment in place is impossible once mapped, so size it generously on
 * first sight: every Schwung segment is created with its final size. */
static int ensure_size(seg_t *s, size_t size) {
    if (s->mem && size <= s->size) return 0;
    if (s->mem) {
        /* Only legal before anyone mapped it; copy over. */
        void *m = aligned_alloc(64, (size + 63) & ~(size_t)63);
        if (!m) return -1;
        memset(m, 0, size);
        memcpy(m, s->mem, s->size);
        free(s->mem);
        s->mem = m;
    } else {
        s->mem = aligned_alloc(64, (size + 63) & ~(size_t)63);
        if (!s->mem) return -1;
        memset(s->mem, 0, size);
    }
    s->size = size;
    return 0;
}

int __wrap_shm_open(const char *name, int oflag, mode_t mode) {
    (void)mode;
    pthread_mutex_lock(&lock);
    seg_t *s = find(name);
    if (!s) {
        if (!(oflag & O_CREAT) || nsegs >= SHM_MAX) {
            pthread_mutex_unlock(&lock);
            errno = (oflag & O_CREAT) ? ENFILE : ENOENT;
            return -1;
        }
        s = &segs[nsegs++];
        memset(s, 0, sizeof *s);
        strncpy(s->name, name, sizeof s->name - 1);
    }
    s->open_fds++;
    int fd = SHM_FD_BASE + (int)(s - segs);
    pthread_mutex_unlock(&lock);
    return fd;
}

int __wrap_shm_unlink(const char *name) { (void)name; return 0; }

void *__real_mmap(void *, size_t, int, int, int, off_t);
int __real_munmap(void *, size_t);
int __real_ftruncate(int, off_t);
int __real_fstat(int, struct stat *);
int __real_close(int);

void *__wrap_mmap(void *addr, size_t len, int prot, int flags, int fd, off_t off) {
    seg_t *s = seg_of_fd(fd);
    if (!s) return __real_mmap(addr, len, prot, flags, fd, off);
    pthread_mutex_lock(&lock);
    int rc = ensure_size(s, (size_t)off + len);
    pthread_mutex_unlock(&lock);
    if (rc) { errno = ENOMEM; return MAP_FAILED; }
    return (uint8_t *)s->mem + off;
}

static int is_seg_ptr(void *p) {
    for (int i = 0; i < nsegs; i++)
        if (segs[i].mem && (uint8_t *)p >= (uint8_t *)segs[i].mem &&
            (uint8_t *)p < (uint8_t *)segs[i].mem + segs[i].size) return 1;
    return 0;
}

int __wrap_munmap(void *addr, size_t len) {
    if (is_seg_ptr(addr)) return 0;   /* segments live for the program */
    return __real_munmap(addr, len);
}

int __wrap_ftruncate(int fd, off_t len) {
    seg_t *s = seg_of_fd(fd);
    if (!s) return __real_ftruncate(fd, len);
    pthread_mutex_lock(&lock);
    int rc = ensure_size(s, (size_t)len);
    pthread_mutex_unlock(&lock);
    return rc;
}

int __wrap_fstat(int fd, struct stat *st) {
    seg_t *s = seg_of_fd(fd);
    if (!s) return __real_fstat(fd, st);
    memset(st, 0, sizeof *st);
    st->st_size = (off_t)s->size;
    st->st_mode = S_IFREG | 0666;
    return 0;
}

int __wrap_close(int fd) {
    seg_t *s = seg_of_fd(fd);
    if (!s) return __real_close(fd);
    return 0;
}
