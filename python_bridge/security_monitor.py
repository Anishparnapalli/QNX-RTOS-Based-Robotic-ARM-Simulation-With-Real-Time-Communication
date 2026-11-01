"""
security_monitor.py — MATRIX Phase 2 Firewall / IDS
═══════════════════════════════════════════════════════════════════════
Detects repeated failed-authentication and malformed-traffic attempts
against the observability (:8766) and control (:8765) channels, logs
and alerts on them, and applies a temporary in-memory cooldown block
against the offending IP.

This is intentionally a simple, transparent, in-memory design (a dict
with a lock) — appropriate for a course project demonstrating the
concept, not a production-grade distributed firewall. It is real,
working logic: it actually rejects connections while a block is active,
actually counts real failed attempts, and actually expires blocks.
"""

import threading
import time

_lock = threading.Lock()

# ip -> {"failures": int, "window_start": monotonic time, "blocked_until": monotonic time}
_records = {}

FAILURE_THRESHOLD = 4        # failures allowed within WINDOW_S before a block
WINDOW_S = 30.0               # sliding window for counting failures
BLOCK_COOLDOWN_S = 60.0       # how long a block lasts

# Alerts waiting to be broadcast to observers (bridge.py drains this)
_pending_alerts = []


def _now():
    return time.monotonic()


def is_blocked(ip: str):
    with _lock:
        rec = _records.get(ip)
        if not rec:
            return False, 0.0
        blocked_until = rec.get("blocked_until", 0.0)
        if blocked_until > _now():
            return True, round(blocked_until - _now(), 1)
        return False, 0.0


def record_failure(ip: str, reason: str, channel: str):
    """Call this whenever an auth attempt fails or malformed traffic is
    seen from `ip`. Returns True if this failure just triggered a new
    block (so the caller can log distinctly)."""
    now = _now()
    just_blocked = False
    with _lock:
        rec = _records.setdefault(ip, {"failures": 0, "window_start": now, "blocked_until": 0.0})

        # Reset the counting window if it's expired
        if now - rec["window_start"] > WINDOW_S:
            rec["failures"] = 0
            rec["window_start"] = now

        rec["failures"] += 1

        if rec["failures"] >= FAILURE_THRESHOLD and rec["blocked_until"] <= now:
            rec["blocked_until"] = now + BLOCK_COOLDOWN_S
            just_blocked = True

        alert = {
            "ip": ip,
            "reason": reason,
            "channel": channel,
            "failures_in_window": rec["failures"],
            "blocked": just_blocked,
            "blocked_until_s": round(rec["blocked_until"] - now, 1) if rec["blocked_until"] > now else 0.0,
        }
        _pending_alerts.append(alert)

    return just_blocked


def record_success(ip: str):
    """A successful auth clears the failure count for that IP (does NOT
    lift an already-active block — a block still runs its full cooldown
    even if a later attempt happens to present a valid token, since a
    burst of failures followed by one success is still suspicious)."""
    with _lock:
        rec = _records.get(ip)
        if rec and rec.get("blocked_until", 0.0) <= _now():
            rec["failures"] = 0


def drain_alerts():
    """Returns and clears all alerts queued since the last call."""
    with _lock:
        alerts = list(_pending_alerts)
        _pending_alerts.clear()
    return alerts


def snapshot():
    """For the Test Lab UI — current block/failure state per IP."""
    with _lock:
        now = _now()
        out = {}
        for ip, rec in _records.items():
            out[ip] = {
                "failures_in_window": rec["failures"],
                "blocked": rec["blocked_until"] > now,
                "blocked_remaining_s": round(max(0.0, rec["blocked_until"] - now), 1),
            }
        return out
