"""
fault_layer.py — MATRIX Phase 2 Test Lab fault injection middleware
═══════════════════════════════════════════════════════════════════════
SAFETY MODEL (read this before touching anything else in this file)
──────────────────────────────────────────────────────────────────
Fault injection in this project is deliberately scoped to be incapable
of compromising the real robotic-arm safety path:

  1. It NEVER touches the QNX TCP link (:12345). QNX <-> bridge traffic
     (including EMERGENCY_STOP in both directions, and the real motion
     protocol) is not passed through this module at all. Only bridge.py's
     browser-facing broadcast (`_broadcast`, the :8765 fan-out to browser
     dashboard tabs) calls into this module.
  2. It NEVER applies to `emergency`-typed messages, even on the browser
     channel — checked explicitly in `maybe_apply()` by message content,
     not just by category, as a hard exclusion that callers cannot
     override.
  3. It is OFF by default and self-expires: every configured fault has a
     `duration_s`, enforced by comparing wall-clock time on every call —
     there is no background timer to fail to fire; an expired fault is
     inert the next time it's checked, with no way to leave it "on"
     accidentally.
  4. `clear()` is an explicit, synchronous kill switch: it always
     succeeds immediately, regardless of what's configured.

This module is intentionally simple (no threads, no queues) so its
behavior is easy to verify by reading it.
"""

import random
import time
import threading

_lock = threading.Lock()

_state = {
    "mode": None,        # None | "packet_loss" | "delay" | "corrupt"
    "rate": 0.0,          # 0..1, meaning depends on mode
    "delay_s": 0.0,
    "expires_at": 0.0,    # monotonic time; 0 = inactive
    "configured_by": None,
    "configured_at": 0.0,
}

MAX_DURATION_S = 120       # hard ceiling — Test Lab UI enforces a lower default (30s)
VALID_MODES = ("packet_loss", "delay", "corrupt")


def configure(mode: str, rate: float, duration_s: float, source: str = "test_lab"):
    """Arm a fault. Validates and clamps inputs; never raises for bad
    input from the network — callers should treat a False return as
    'rejected, nothing changed'."""
    if mode not in VALID_MODES:
        return False, f"unknown mode '{mode}'"
    try:
        rate = float(rate)
        duration_s = float(duration_s)
    except (TypeError, ValueError):
        return False, "rate/duration must be numeric"
    rate = max(0.0, min(1.0, rate))
    duration_s = max(0.0, min(MAX_DURATION_S, duration_s))
    if duration_s <= 0:
        return False, "duration_s must be > 0"

    with _lock:
        _state["mode"] = mode
        _state["rate"] = rate
        _state["delay_s"] = rate * 1.5 if mode == "delay" else 0.0
        _state["expires_at"] = time.monotonic() + duration_s
        _state["configured_by"] = source
        _state["configured_at"] = time.monotonic()
    return True, f"{mode} armed @ rate={rate} for {duration_s}s"


def clear():
    """Kill switch — always succeeds, immediately."""
    with _lock:
        _state["mode"] = None
        _state["rate"] = 0.0
        _state["delay_s"] = 0.0
        _state["expires_at"] = 0.0


def status():
    with _lock:
        now = time.monotonic()
        active = _state["mode"] is not None and _state["expires_at"] > now
        remaining = max(0.0, _state["expires_at"] - now) if active else 0.0
        return {
            "active": active,
            "mode": _state["mode"] if active else None,
            "rate": _state["rate"] if active else 0.0,
            "remaining_s": round(remaining, 1),
            "configured_by": _state["configured_by"],
        }


def _is_emergency_message(payload_dict) -> bool:
    """Hard exclusion check. Looks at message content, not just caller
    intent, so a mistake elsewhere in the codebase can't accidentally
    route an emergency message through fault injection."""
    try:
        return payload_dict.get("type") == "emergency"
    except AttributeError:
        return False


def maybe_apply(message_dict):
    """
    Given a decoded browser-bound message (dict, already parsed from the
    JSON that bridge.py was about to send), decide what to do with it.

    Returns one of:
      ("send", message_dict)   — send unmodified (also used whenever
                                   inactive, expired, or the message is
                                   an emergency message)
      ("drop", None)           — silently drop (packet_loss mode)
      ("delay", delay_seconds) — caller should await this delay, then
                                   send the message unmodified
      ("corrupt", mutated_dict)— send a corrupted copy

    This function never mutates the caller's original dict in place.
    """
    if _is_emergency_message(message_dict):
        return ("send", message_dict)

    with _lock:
        now = time.monotonic()
        if _state["mode"] is None or _state["expires_at"] <= now:
            return ("send", message_dict)
        mode = _state["mode"]
        rate = _state["rate"]
        delay_s = _state["delay_s"]

    if mode == "packet_loss":
        if random.random() < rate:
            return ("drop", None)
        return ("send", message_dict)

    if mode == "delay":
        return ("delay", delay_s)

    if mode == "corrupt":
        if random.random() < rate:
            corrupted = dict(message_dict)
            # Corrupt in a way that's visibly wrong but still valid JSON,
            # so the browser doesn't just crash — it should visibly show
            # implausible data, which is the point of the demonstration.
            if "angles" in corrupted and isinstance(corrupted["angles"], list):
                corrupted["angles"] = [
                    round(a + random.uniform(-999, 999), 2) for a in corrupted["angles"]
                ]
            corrupted["_fault_injected"] = True
            return ("corrupt", corrupted)
        return ("send", message_dict)

    return ("send", message_dict)
