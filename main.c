#include <ApplicationServices/ApplicationServices.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

#define F5 96

static int64_t now_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return (int64_t)ts.tv_sec * 1000000000LL + ts.tv_nsec;
}

int main(int argc, char **argv) {
    if (!CGPreflightPostEventAccess()) {
        CGRequestPostEventAccess();
        fprintf(stderr, "Permission denied\n");
        return 1;
    }

    if (argc != 3) {
        fprintf(stderr, "Usage: %s <target_unix_ms> <offset_ms>\n", argv[0]);
        return 1;
    }

    int64_t target_ms = strtoll(argv[1], NULL, 10);
    double offset_ms = strtod(argv[2], NULL);

    int64_t deadline =
        target_ms * 1000000LL - (int64_t)(offset_ms * 1e6);

    CGEventRef down =
        CGEventCreateKeyboardEvent(NULL, F5, true);
    CGEventRef up =
        CGEventCreateKeyboardEvent(NULL, F5, false);

    if (!down || !up) {
        fprintf(stderr, "Failed to create keyboard events\n");
        if (down) CFRelease(down);
        if (up) CFRelease(up);
        return 1;
    }

    if (deadline <= now_ns()) {
        fprintf(stderr, "Deadline has already passed\n");
        CFRelease(down);
        CFRelease(up);
        return 1;
    }

    while (1) {
        int64_t remaining = deadline - now_ns();
        if (remaining <= 2000000LL)
            break;

        int64_t sleep_ns = remaining - 2000000LL;
        struct timespec delay = {
            .tv_sec = sleep_ns / 1000000000LL,
            .tv_nsec = sleep_ns % 1000000000LL
        };

        nanosleep(&delay, NULL);
    }

    while (now_ns() < deadline) {
    }

    CGEventPost(kCGHIDEventTap, down);
    struct timespec hold = {.tv_sec = 0, .tv_nsec = 20000000};
    while (nanosleep(&hold, &hold) == -1 && errno == EINTR) {
    }
    CGEventPost(kCGHIDEventTap, up);
    struct timespec settle = {.tv_sec = 0, .tv_nsec = 100000000};
    while (nanosleep(&settle, &settle) == -1 && errno == EINTR) {
    }
    fprintf(stderr, "Posted F5 down/up; waited 100 ms before exit.\n");

    CFRelease(down);
    CFRelease(up);

    return 0;
}
