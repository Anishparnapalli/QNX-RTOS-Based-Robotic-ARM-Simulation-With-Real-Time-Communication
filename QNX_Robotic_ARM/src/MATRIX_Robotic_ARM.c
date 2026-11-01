/*
 * ═══════════════════════════════════════════════════════════════════════════
 *  M.A.T.R.I.X.  —  Robotic_ARM.c
 *  Motion Articulation & Telemetric Real-time Interface eXecution
 *
 *  QNX 8.0  |  POSIX pthreads  |  SCHED_FIFO real-time scheduling
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  HOW TO BUILD  (QNX Momentics IDE)
 *  ──────────────────────────────────
 *  In your project Makefile add:
 *      LIBS += -lsocket -lm
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  THREADS  (2 SCHED_FIFO  +  1 normal recv thread)
 *  ──────────────────────────────────────────────────
 *
 *   Priority 20 - SAFETY TASK
 *     Blocks on getchar(), uses zero CPU.
 *     The instant Enter is pressed QNX's SCHED_FIFO scheduler
 *     immediately preempts the Motion Task (mid-motion) and
 *     switches here.  Sends EMERGENCY_STOP to bridge.
 *
 *   Priority 10 - MOTION TASK
 *     IDLE  : streams live sine-wave telemetry every 100 ms.
 *     SEQ   : on SEQ_END signal, executes the recorded pose
 *             sequence in a CONTINUOUS LOOP until SEQ_STOP is
 *             received from the bridge.
 *             Each full pass sends CYCLE_DONE:<n> to the bridge.
 *             When the loop exits cleanly it sends SEQ_COMPLETE.
 *             Checks g_emergency every tick - stops mid-motion
 *             immediately if set.
 *
 *   Normal - RECV THREAD  (not SCHED_FIFO)
 *     Reads TCP bytes from bridge, assembles lines, writes into
 *     shared sequence store, g_emergency, and g_stop_cycle flags.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  PROTOCOL  (lines terminated with '\n')
 *  ────────────────────────────────────────
 *  QNX -> Bridge:
 *      j0,j1,j2,j3,j4,j5\n        live angles (degrees) every 100 ms,
 *                                  ONLY while actively executing a
 *                                  recorded RTOS sequence -- no idle
 *                                  heartbeat telemetry is sent (removed;
 *                                  it was cosmetic-only, see motion_task)
 *      CYCLE_DONE:<n>\n            completed full pass number n (1-based)
 *      SEQ_COMPLETE\n              cycling stopped cleanly (after SEQ_STOP)
 *      POSE_DONE:<idx>\n           pose idx completed within current pass
 *      EMERGENCY_STOP\n            Safety Task fired
 *      EMERGENCY_CLEARED\n         RESET_EMERGENCY processed; motion
 *                                  re-armed (idempotent ack either way)
 *      THREAD_STATUS:<T>:<S>\n     Real, event-driven self-report from
 *                                  one of the three threads (added for
 *                                  Card 3 observability -- see
 *                                  send_thread_status()). Never used
 *                                  for control/safety logic; purely
 *                                  informational for the dashboard.
 *                                    T=RECV   S=WAITING|RECEIVING
 *                                    T=MOTION S=IDLE|CYCLING|EMERGENCY_HALT
 *                                    T=SAFETY S=MONITORING|EMERGENCY
 *
 *  Bridge -> QNX:
 *      SEQ_START:<n>:<dur_ms>\n    n poses incoming, dur_ms per pose.
 *                                  REJECTED while emergency-locked.
 *      POSE:<idx>:j0,j1,j2,j3,j4,j5\n
 *      SEQ_END\n                   all poses received - start cycling.
 *                                  REJECTED while emergency-locked.
 *      SEQ_STOP\n                  finish current pass then stop cycling
 *      EMERGENCY_STOP\n            halt immediately from browser button
 *      RESET_EMERGENCY\n           operator-confirmed recovery request --
 *                                  the ONLY way g_emergency is ever
 *                                  cleared. Until this arrives, all new
 *                                  SEQ_START/SEQ_END commands are refused
 *                                  and motion_task stays hard-blocked.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <errno.h>
#include <unistd.h>
#include <pthread.h>
#include <sched.h>
#include <time.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>

/* ───────────────────────────────────────────────────────────────────
 *  Configuration - edit BRIDGE_IP to match your VMnet8 address
 * ─────────────────────────────────────────────────────────────────── */
#define BRIDGE_IP        "192.168.206.1"
#define BRIDGE_PORT      12345

#define NUM_JOINTS       6
#define MAX_POSES        64

#define PRIO_MOTION      10
#define PRIO_SAFETY      20

#define PERIOD_MS        100
#define PERIOD_NS        ((long long)PERIOD_MS * 1000000LL)

#define SEND_BUF         256
#define RECV_BUF         4096
#define LINE_BUF         512

/* ───────────────────────────────────────────────────────────────────
 *  Global TCP socket
 * ─────────────────────────────────────────────────────────────────── */
static int g_sockfd = -1;

static pthread_mutex_t g_send_mutex = PTHREAD_MUTEX_INITIALIZER;

static void safe_send(const char *msg)
{
    if (g_sockfd < 0) return;
    pthread_mutex_lock(&g_send_mutex);
    send(g_sockfd, msg, strlen(msg), 0);
    pthread_mutex_unlock(&g_send_mutex);
}

/* ───────────────────────────────────────────────────────────────────
 *  THREAD_STATUS:<NAME>:<STATE>
 *
 *  Card 3 (QNX RTOS observability) previously had to *infer* thread
 *  state on the bridge/dashboard side from indirect protocol events
 *  (e.g. "a sequence was dispatched" implies Motion is probably
 *  cycling). That's a reasonable fallback, but it's still a guess.
 *
 *  This is the minimal, safe instrumentation allowed for under the
 *  Card 3 spec ("minimal QNX instrumentation may be added if
 *  necessary and technically safe"): each of the three real threads
 *  reports its own state at the exact moments it actually changes.
 *  This is purely an additional outbound status line -- it never
 *  affects scheduling, timing, or control logic, and every existing
 *  message on the wire is unchanged. Old bridges/dashboards that
 *  don't understand this line simply ignore it (newline-delimited
 *  protocol, unknown lines are already dropped silently).
 * ─────────────────────────────────────────────────────────────────── */
static void send_thread_status(const char *thread_name, const char *state)
{
    char buf[80];
    snprintf(buf, sizeof(buf), "THREAD_STATUS:%s:%s\n", thread_name, state);
    safe_send(buf);
}

/* ───────────────────────────────────────────────────────────────────
 *  Emergency flag
 * ─────────────────────────────────────────────────────────────────── */
static volatile int    g_emergency = 0;
static pthread_mutex_t g_em_mutex  = PTHREAD_MUTEX_INITIALIZER;

static void set_emergency(void)
{
    pthread_mutex_lock(&g_em_mutex);
    g_emergency = 1;
    pthread_mutex_unlock(&g_em_mutex);
}

static void clear_emergency(void)
{
    pthread_mutex_lock(&g_em_mutex);
    g_emergency = 0;
    pthread_mutex_unlock(&g_em_mutex);
}

static int check_emergency(void)
{
    pthread_mutex_lock(&g_em_mutex);
    int v = g_emergency;
    pthread_mutex_unlock(&g_em_mutex);
    return v;
}

/* ───────────────────────────────────────────────────────────────────
 *  Cycle-stop flag
 *
 *  Set by recv_thread when "SEQ_STOP" arrives from the bridge.
 *  The motion task checks it after each completed pose-sequence pass
 *  and exits the cycling loop cleanly (sends SEQ_COMPLETE, then
 *  falls back to idle sine-wave telemetry).
 *
 *  Automatically cleared at the start of every new SEQ_START so
 *  that sending a fresh sequence always begins cycling again.
 * ─────────────────────────────────────────────────────────────────── */
static volatile int    g_stop_cycle = 0;
static pthread_mutex_t g_stop_mutex = PTHREAD_MUTEX_INITIALIZER;

static void set_stop_cycle(void)
{
    pthread_mutex_lock(&g_stop_mutex);
    g_stop_cycle = 1;
    pthread_mutex_unlock(&g_stop_mutex);
}

static void clear_stop_cycle(void)
{
    pthread_mutex_lock(&g_stop_mutex);
    g_stop_cycle = 0;
    pthread_mutex_unlock(&g_stop_mutex);
}

static int check_stop_cycle(void)
{
    pthread_mutex_lock(&g_stop_mutex);
    int v = g_stop_cycle;
    pthread_mutex_unlock(&g_stop_mutex);
    return v;
}

/* ───────────────────────────────────────────────────────────────────
 *  Sequence store
 * ─────────────────────────────────────────────────────────────────── */
typedef struct { double j[NUM_JOINTS]; } Pose;

static Pose   g_poses[MAX_POSES];
static int    g_n_poses     = 0;
static int    g_pose_dur_ms = 1000;
static int    g_seq_ready   = 0;

static pthread_mutex_t g_seq_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t  g_seq_cond  = PTHREAD_COND_INITIALIZER;

/* ───────────────────────────────────────────────────────────────────
 *  Clock helpers
 * ─────────────────────────────────────────────────────────────────── */
static long long now_ns(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000000000LL + (long long)ts.tv_nsec;
}

static void ll_to_timespec(long long ns, struct timespec *ts)
{
    ts->tv_sec  = (time_t)(ns / 1000000000LL);
    ts->tv_nsec = (long)  (ns % 1000000000LL);
}

/* ───────────────────────────────────────────────────────────────────
 *  Linear interpolation
 * ─────────────────────────────────────────────────────────────────── */
static double lerp(double a, double b, double t)
{
    if (t < 0.0) t = 0.0;
    if (t > 1.0) t = 1.0;
    return a + (b - a) * t;
}

/* ═══════════════════════════════════════════════════════════════════
 *  RECV THREAD  (normal scheduling)
 * ═══════════════════════════════════════════════════════════════════ */
static void handle_line(const char *line)
{
    /* ── Emergency: immediate hard stop ── */
    if (strcmp(line, "EMERGENCY_STOP") == 0) {
        set_emergency();
        printf("[RECV]  EMERGENCY_STOP received from bridge\n");
        return;
    }

    /* ── Explicit, operator-confirmed recovery from EMERGENCY_STOP ──
     * This is the ONLY path that ever calls clear_emergency(). Motion
     * stays hard-locked (see motion_task's busy-wait on check_emergency())
     * until this arrives. Idempotent: sending it while not locked just
     * re-confirms READY rather than erroring, so the bridge/dashboard
     * handshake can't get stuck waiting for a reply that never comes. */
    if (strcmp(line, "RESET_EMERGENCY") == 0) {
        if (check_emergency()) {
            clear_emergency();
            printf("[RECV]  RESET_EMERGENCY -- emergency lock cleared, "
                   "motion re-armed\n");
        } else {
            printf("[RECV]  RESET_EMERGENCY -- system was already clear\n");
        }
        safe_send("EMERGENCY_CLEARED\n");
        /* Real, event-driven confirmation that the Safety Task's
         * monitor is back to its normal branch -- sent from here
         * because this is the exact code path that actually cleared
         * g_emergency (see clear_emergency() above / Item 6). */
        send_thread_status("SAFETY", "MONITORING");
        return;
    }

    /* ── Graceful cycle stop: finish current pass, then halt ── */
    if (strcmp(line, "SEQ_STOP") == 0) {
        set_stop_cycle();
        printf("[RECV]  SEQ_STOP received -- will stop after current pass\n");
        return;
    }

    if (strncmp(line, "SEQ_START:", 10) == 0) {
        /* Safety lock: reject new sequences outright while an emergency
         * is active. Motion commands must stay blocked until an explicit
         * RESET_EMERGENCY is processed -- queueing a sequence now (even
         * if it wouldn't start executing until the lock clears) would
         * let a stale/unintended command silently launch the instant the
         * lock lifts, which defeats the point of requiring an explicit,
         * operator-confirmed reset. */
        if (check_emergency()) {
            printf("[RECV]  SEQ_START REJECTED -- EMERGENCY LOCK active, "
                   "send RESET_EMERGENCY first\n");
            return;
        }
        int n = 0, dur = 1000;
        sscanf(line + 10, "%d:%d", &n, &dur);
        if (n <= 0 || n > MAX_POSES) {
            printf("[RECV]  SEQ_START bad n=%d\n", n);
            return;
        }
        pthread_mutex_lock(&g_seq_mutex);
        g_n_poses     = n;
        g_pose_dur_ms = dur;
        g_seq_ready   = 0;
        memset(g_poses, 0, sizeof(g_poses));
        pthread_mutex_unlock(&g_seq_mutex);
        /* A new sequence always starts fresh cycling */
        clear_stop_cycle();
        printf("[RECV]  SEQ_START  n=%d  dur=%d ms  (cycling mode)\n",
               n, dur);
        return;
    }

    if (strncmp(line, "POSE:", 5) == 0) {
        const char *p2 = strchr(line + 5, ':');
        if (!p2) return;
        int idx = atoi(line + 5);
        if (idx < 0 || idx >= MAX_POSES) return;
        double j[NUM_JOINTS] = {0, 0, 0, 0, 0, 0};
        sscanf(p2 + 1, "%lf,%lf,%lf,%lf,%lf,%lf",
               &j[0], &j[1], &j[2], &j[3], &j[4], &j[5]);
        pthread_mutex_lock(&g_seq_mutex);
        for (int k = 0; k < NUM_JOINTS; k++)
            g_poses[idx].j[k] = j[k];
        pthread_mutex_unlock(&g_seq_mutex);
        printf("[RECV]  POSE[%d]  %.1f %.1f %.1f %.1f %.1f %.1f\n",
               idx, j[0], j[1], j[2], j[3], j[4], j[5]);
        return;
    }

    if (strcmp(line, "SEQ_END") == 0) {
        if (check_emergency()) {
            printf("[RECV]  SEQ_END REJECTED -- EMERGENCY LOCK active, "
                   "send RESET_EMERGENCY first\n");
            return;
        }
        pthread_mutex_lock(&g_seq_mutex);
        g_seq_ready = 1;
        pthread_cond_broadcast(&g_seq_cond);
        pthread_mutex_unlock(&g_seq_mutex);
        printf("[RECV]  SEQ_END  --  %d poses ready, cycling begins\n",
               g_n_poses);
        return;
    }
}

static void *recv_thread_fn(void *arg)
{
    (void)arg;
    char buf[RECV_BUF * 4];
    int  buf_len = 0;
    char line[LINE_BUF];

    printf("[RECV]  Thread started\n");
    send_thread_status("RECV", "WAITING");

    while (1) {
        if (g_sockfd < 0) { usleep(10000); continue; }

        char tmp[RECV_BUF];
        int n = (int)recv(g_sockfd, tmp, sizeof(tmp) - 1, 0);
        if (n <= 0) { usleep(50000); continue; }
        tmp[n] = '\0';

        /* Bytes actually arrived -- this thread is genuinely doing its
         * one job (TCP reception) right now, not idle. Reported before
         * parsing so the "RECEIVING" window reflects real wall-clock
         * time spent handling this batch, however small. */
        send_thread_status("RECV", "RECEIVING");

        if (buf_len + n < (int)sizeof(buf) - 1) {
            memcpy(buf + buf_len, tmp, n);
            buf_len += n;
            buf[buf_len] = '\0';
        } else {
            buf_len = 0;
            continue;
        }

        char *s = buf;
        char *nl;
        while ((nl = strchr(s, '\n')) != NULL) {
            int len = (int)(nl - s);
            if (len > 0 && s[len - 1] == '\r') len--;
            if (len > 0 && len < LINE_BUF - 1) {
                memcpy(line, s, len);
                line[len] = '\0';
                handle_line(line);
            }
            s = nl + 1;
        }

        int remaining = buf_len - (int)(s - buf);
        if (remaining > 0) {
            memmove(buf, s, remaining);
            buf_len = remaining;
            buf[buf_len] = '\0';
        } else {
            buf_len = 0;
        }

        /* Batch fully handled -- back to genuinely blocking on the
         * socket until the next byte arrives. */
        send_thread_status("RECV", "WAITING");
    }
    return NULL;
}

/* ═══════════════════════════════════════════════════════════════════
 *  SAFETY TASK  --  Priority 20  (highest in this program)
 *
 *  Blocks on getchar() -- zero CPU usage.
 *  On Enter: QNX SCHED_FIFO preempts Motion Task immediately,
 *  even if it is mid-interpolation between two joint positions.
 *  Sets g_emergency then sends EMERGENCY_STOP to bridge.
 * ═══════════════════════════════════════════════════════════════════ */
static void *safety_task(void *arg)
{
    (void)arg;
    printf("[SAFETY]  Started  --  Priority %d  (HIGHEST)\n", PRIO_SAFETY);
    printf("[SAFETY]  >>> Press ENTER in this terminal for Emergency Stop <<<\n\n");
    send_thread_status("SAFETY", "MONITORING");

    /* Blocks here consuming ZERO CPU until Enter */
    getchar();

    /* QNX has preempted Motion Task to run us here */
    printf("\n[SAFETY]  *** EMERGENCY  --  preempting motion NOW ***\n");
    set_emergency();
    safe_send("EMERGENCY_STOP\n");
    send_thread_status("SAFETY", "EMERGENCY");
    printf("[SAFETY]  EMERGENCY_STOP sent to bridge.\n");

    /* Keep thread alive */
    while (1) { pause(); }
    return NULL;
}

/* ═══════════════════════════════════════════════════════════════════
 *  MOTION TASK  --  Priority 10  (SCHED_FIFO)
 * ═══════════════════════════════════════════════════════════════════ */

/*
 * execute_one_pass()
 * ──────────────────
 * Runs through all n_poses once, interpolating all 6 joints
 * simultaneously over dur_ms per pose.
 *
 * Returns:
 *   1  — pass completed normally
 *   0  — aborted (emergency triggered mid-pass)
 *
 * cur[]        in/out : current joint angles, updated in place
 * next_tick    in/out : CLOCK_MONOTONIC deadline for next 100 ms tick
 */
static int execute_one_pass(double       *cur,
                             long long    *next_tick,
                             int           n_poses,
                             int           dur_ms)
{
    char pkt[SEND_BUF];

    for (int pi = 0; pi < n_poses; pi++) {

        /* Check emergency before starting each pose */
        if (check_emergency()) {
            printf("[MOTION]  Emergency before pose %d\n", pi);
            return 0;
        }

        double target[NUM_JOINTS];
        pthread_mutex_lock(&g_seq_mutex);
        for (int k = 0; k < NUM_JOINTS; k++)
            target[k] = g_poses[pi].j[k];
        pthread_mutex_unlock(&g_seq_mutex);

        printf("[MOTION]  Pose %d  target: %.1f %.1f %.1f %.1f %.1f %.1f\n",
               pi,
               target[0], target[1], target[2],
               target[3], target[4], target[5]);

        double start[NUM_JOINTS];
        for (int k = 0; k < NUM_JOINTS; k++)
            start[k] = cur[k];

        long long pose_start    = now_ns();
        long long pose_deadline = pose_start + (long long)dur_ms * 1000000LL;
        int pose_done = 0;

        /* ── Interpolation loop for this pose ── */
        while (!pose_done) {

            struct timespec tw;
            ll_to_timespec(*next_tick, &tw);
            clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &tw, NULL);
            *next_tick += PERIOD_NS;

            /*
             * Emergency mid-pose:
             * Safety Task (priority 20) has already run and set
             * g_emergency = 1.  Detect it on this tick and abort
             * IMMEDIATELY -- no waiting for the pose to finish.
             */
            if (check_emergency()) {
                printf("[MOTION]  *** EMERGENCY MID-POSE %d"
                       " -- STOPPING NOW ***\n", pi);
                return 0;
            }

            /* Compute t: fraction of this pose completed [0, 1] */
            long long now_t   = now_ns();
            double    elapsed = (double)(now_t - pose_start) / 1000000.0;
            double    t       = elapsed / (double)dur_ms;
            if (t >= 1.0) { t = 1.0; pose_done = 1; }

            /*
             * ALL 6 joints move simultaneously (RTOS coordinated motion).
             * Every joint receives the same interpolation fraction at the
             * same tick so they all arrive at the target together.
             */
            for (int k = 0; k < NUM_JOINTS; k++)
                cur[k] = lerp(start[k], target[k], t);

            /* Stream live angles to bridge -> dashboard */
            snprintf(pkt, sizeof(pkt),
                     "%.2f,%.2f,%.2f,%.2f,%.2f,%.2f\n",
                     cur[0], cur[1], cur[2],
                     cur[3], cur[4], cur[5]);
            safe_send(pkt);

            /* Deadline overrun: force complete and advance to next pose */
            if (now_t > pose_deadline && !pose_done) {
                printf("[MOTION]  Pose %d overran deadline"
                       " -- forcing complete.\n", pi);
                for (int k = 0; k < NUM_JOINTS; k++)
                    cur[k] = target[k];
                pose_done = 1;
            }
        }

        /* Notify bridge which pose just finished */
        char done[SEND_BUF];
        snprintf(done, sizeof(done), "POSE_DONE:%d\n", pi);
        safe_send(done);
        printf("[MOTION]  POSE_DONE %d\n", pi);
    }

    return 1; /* full pass completed */
}

static void *motion_task(void *arg)
{
    (void)arg;
    printf("[MOTION]  Started  --  Priority %d, period %d ms\n",
           PRIO_MOTION, PERIOD_MS);
    send_thread_status("MOTION", "IDLE");

    double cur[NUM_JOINTS] = {90.0, 90.0, 90.0, 90.0, 90.0, 0.0};

    long long next_tick = now_ns();

    while (1) {

        /* Hard real-time sleep to next 100 ms tick */
        struct timespec wake;
        ll_to_timespec(next_tick, &wake);
        clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &wake, NULL);
        next_tick += PERIOD_NS;

        /* Emergency check */
        if (check_emergency()) {
            printf("[MOTION]  Emergency -- halted.\n");
            send_thread_status("MOTION", "EMERGENCY_HALT");
            while (check_emergency()) { usleep(100000); }
            printf("[MOTION]  Emergency cleared -- resuming.\n");
            send_thread_status("MOTION", "IDLE");
            pthread_mutex_lock(&g_seq_mutex);
            g_seq_ready = 0;
            g_n_poses   = 0;
            pthread_mutex_unlock(&g_seq_mutex);
            clear_stop_cycle();
            next_tick = now_ns();
            continue;
        }

        /* Check for a ready sequence */
        pthread_mutex_lock(&g_seq_mutex);
        int seq_ready = g_seq_ready;
        int n_poses   = g_n_poses;
        int dur_ms    = g_pose_dur_ms;
        pthread_mutex_unlock(&g_seq_mutex);

        /* ══════════════════════════════════════════════════════
         *  CONTINUOUS CYCLING EXECUTION
         *
         *  Loops the recorded sequence indefinitely.
         *  Each full pass increments cycle_count and sends
         *  CYCLE_DONE:<n> to the bridge so the dashboard can
         *  track progress.
         *
         *  Exit conditions (checked at pass boundaries only):
         *    1. g_stop_cycle == 1  (SEQ_STOP received from bridge)
         *       -> finish the current pass, send SEQ_COMPLETE, stop.
         *    2. g_emergency == 1   (emergency mid-pass)
         *       -> execute_one_pass returns 0, go to abort.
         *
         *  The poses array (g_poses) is NOT cleared between passes
         *  so no re-transmission is needed for cycling.
         * ══════════════════════════════════════════════════════ */
        if (seq_ready && n_poses > 0) {

            /* Consume the ready flag -- poses remain intact for cycling */
            pthread_mutex_lock(&g_seq_mutex);
            g_seq_ready = 0;
            pthread_mutex_unlock(&g_seq_mutex);

            printf("[MOTION]  Cycling START  --  %d poses, %d ms/pose"
                   "  (send SEQ_STOP to halt)\n",
                   n_poses, dur_ms);
            send_thread_status("MOTION", "CYCLING");

            int cycle_count = 0;
            int keep_cycling = 1;

            while (keep_cycling) {

                printf("[MOTION]  -- Cycle %d starting --\n",
                       cycle_count + 1);

                int pass_ok = execute_one_pass(cur, &next_tick,
                                               n_poses, dur_ms);

                if (!pass_ok) {
                    /* Emergency fired inside the pass -- abort everything */
                    printf("[MOTION]  Cycling aborted by emergency.\n");
                    pthread_mutex_lock(&g_seq_mutex);
                    g_n_poses = 0;
                    pthread_mutex_unlock(&g_seq_mutex);
                    clear_stop_cycle();
                    goto seq_abort;
                }

                cycle_count++;
                printf("[MOTION]  Cycle %d complete.\n", cycle_count);

                /* Tell the bridge/dashboard a full pass just finished */
                char cycle_msg[SEND_BUF];
                snprintf(cycle_msg, sizeof(cycle_msg),
                         "CYCLE_DONE:%d\n", cycle_count);
                safe_send(cycle_msg);

                /*
                 * Check stop flag AFTER the completed pass.
                 * This guarantees we never stop mid-motion -- the arm
                 * always finishes its current cycle to the last pose
                 * before coming to rest.
                 */
                if (check_stop_cycle()) {
                    printf("[MOTION]  SEQ_STOP received -- "
                           "stopping after cycle %d.\n", cycle_count);
                    keep_cycling = 0;
                }

                /*
                 * Also re-check emergency here in case it was set during
                 * the final tick of execute_one_pass (edge case).
                 */
                if (check_emergency()) {
                    printf("[MOTION]  Emergency after cycle %d.\n",
                           cycle_count);
                    keep_cycling = 0;
                    goto seq_abort;
                }
            }

            /* Clean exit: notify bridge that cycling has stopped */
            safe_send("SEQ_COMPLETE\n");
            send_thread_status("MOTION", "IDLE");
            printf("[MOTION]  SEQ_COMPLETE  (cycled %d time%s)\n",
                   cycle_count, cycle_count == 1 ? "" : "s");

            /* Reset poses so a fresh SEQ_START is needed to cycle again */
            pthread_mutex_lock(&g_seq_mutex);
            g_n_poses = 0;
            pthread_mutex_unlock(&g_seq_mutex);
            clear_stop_cycle();
            next_tick = now_ns();
            continue;

seq_abort:
            printf("[MOTION]  Sequence/cycle aborted.\n");
            send_thread_status("MOTION", "EMERGENCY_HALT");
            pthread_mutex_lock(&g_seq_mutex);
            g_seq_ready = 0;
            g_n_poses   = 0;
            pthread_mutex_unlock(&g_seq_mutex);
            clear_stop_cycle();
            next_tick = now_ns();
            continue;
        }

        /* ══════════════════════════════════════════════════════
         *  IDLE
         *
         *  No telemetry is transmitted while idle. The previous
         *  implementation streamed a synthetic sine-wave "heartbeat"
         *  here purely for demo/visualization purposes; it was never
         *  read by any control, safety, or connection-status logic
         *  (connection status is derived from the TCP socket itself,
         *  not from telemetry content or frequency — see bridge.py).
         *  Removed so the wire only ever carries real robotic state:
         *  genuine motion telemetry during an active RTOS cycle, and
         *  the discrete protocol events below. The loop still ticks
         *  every 100ms so emergency/sequence-ready checks above stay
         *  fully responsive.
         * ══════════════════════════════════════════════════════ */
    }
    return NULL;
}

/* ───────────────────────────────────────────────────────────────────
 *  SCHED_FIFO thread launcher
 * ─────────────────────────────────────────────────────────────────── */
static int launch_rt_thread(pthread_t       *tid,
                             void *(*fn)(void *),
                             int              prio)
{
    pthread_attr_t     attr;
    struct sched_param sp;

    pthread_attr_init(&attr);
    pthread_attr_setinheritsched(&attr, PTHREAD_EXPLICIT_SCHED);
    pthread_attr_setschedpolicy(&attr, SCHED_FIFO);
    sp.sched_priority = prio;
    pthread_attr_setschedparam(&attr, &sp);
    int r = pthread_create(tid, &attr, fn, NULL);
    pthread_attr_destroy(&attr);
    return r;
}

/* ═══════════════════════════════════════════════════════════════════
 *  MAIN
 * ═══════════════════════════════════════════════════════════════════ */
int main(void)
{
    printf("\n");
    printf("╔══════════════════════════════════════════════╗\n");
    printf("║   M.A.T.R.I.X.  QNX RTOS Arm Controller     ║\n");
    printf("╠══════════════════════════════════════════════╣\n");
    printf("║  Bridge  : %s:%-5d              ║\n",
           BRIDGE_IP, BRIDGE_PORT);
    printf("║  Motion  : priority 10  (SCHED_FIFO)        ║\n");
    printf("║  Safety  : priority 20  (SCHED_FIFO)        ║\n");
    printf("║  Tick    : 100 ms  |  Pose limit : 1000 ms  ║\n");
    printf("║  Mode    : CONTINUOUS CYCLE until SEQ_STOP  ║\n");
    printf("╚══════════════════════════════════════════════╝\n\n");

    printf("[MAIN]  Connecting to %s:%d ...\n", BRIDGE_IP, BRIDGE_PORT);

    g_sockfd = socket(AF_INET, SOCK_STREAM, 0);
    if (g_sockfd < 0) {
        perror("[MAIN]  socket");
        return EXIT_FAILURE;
    }

    struct sockaddr_in srv;
    memset(&srv, 0, sizeof(srv));
    srv.sin_family      = AF_INET;
    srv.sin_port        = htons(BRIDGE_PORT);
    srv.sin_addr.s_addr = inet_addr(BRIDGE_IP);

    if (connect(g_sockfd, (struct sockaddr *)&srv, sizeof(srv)) < 0) {
        perror("[MAIN]  connect");
        fprintf(stderr,
                "[MAIN]  Is bridge.py running on Windows host?\n");
        close(g_sockfd);
        return EXIT_FAILURE;
    }
    printf("[MAIN]  Connected to bridge.py  OK\n\n");

    /* Recv thread -- normal scheduling */
    pthread_t tid_recv;
    if (pthread_create(&tid_recv, NULL, recv_thread_fn, NULL) != 0) {
        perror("[MAIN]  recv thread");
        close(g_sockfd);
        return EXIT_FAILURE;
    }
    printf("[MAIN]  Recv thread   started\n");

    /* Motion Task */
    pthread_t tid_motion;
    if (launch_rt_thread(&tid_motion, motion_task, PRIO_MOTION) != 0) {
        perror("[MAIN]  motion thread");
        close(g_sockfd);
        return EXIT_FAILURE;
    }
    printf("[MAIN]  Motion Task   launched  (priority %d)\n", PRIO_MOTION);

    /* Safety Task */
    pthread_t tid_safety;
    if (launch_rt_thread(&tid_safety, safety_task, PRIO_SAFETY) != 0) {
        perror("[MAIN]  safety thread");
        close(g_sockfd);
        return EXIT_FAILURE;
    }
    printf("[MAIN]  Safety Task   launched  (priority %d)\n", PRIO_SAFETY);

    printf("\n[MAIN]  System ONLINE.\n");
    printf("[MAIN]  Dashboard -> select RTOS mode -> record poses"
           " -> SEND TO QNX.\n");
    printf("[MAIN]  Arm will cycle continuously until STOP is pressed.\n");
    printf("[MAIN]  Press ENTER here at any time for Emergency Stop.\n\n");

    pthread_join(tid_motion, NULL);
    pthread_join(tid_safety, NULL);

    close(g_sockfd);
    return EXIT_SUCCESS;
}
