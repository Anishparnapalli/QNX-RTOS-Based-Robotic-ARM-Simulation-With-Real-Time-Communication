"""
bridge.py  —  M.A.T.R.I.X. Communication Bridge
═══════════════════════════════════════════════════════════════════════
Phase 2/3. Full RTOS / NON-RTOS simulation protocol, secured control
channel, observability gateway, TLS SHIELD intrusion-detection demo,
and IDS.

ARCHITECTURE
────────────
  Browser (WSS :8765, token-authenticated)
       ↕
  bridge.py  ←— runs on Windows host
       ↕
  QNX Robotic_ARM  (TCP :12345, unchanged since Phase 1 — never touched
                     by the Shield demo or auth; QNX has no concept of
                     the browser-side security layer at all)
       ↕
  Communication Website (WSS :8766, token-authenticated, observability
                          + Security Center command channel)
       ↕
  attacker_console.py  (WS, PLAINTEXT, :8767 — a deliberately insecure
                         "legacy" port. A standalone, token-gated demo
                         tool launches real intrusion attempts here.
                         Whether they land depends ONLY on the TLS
                         SHIELD toggle — see below.)

WHAT THIS BRIDGE DOES
──────────────────────
  1. TCP server on port 12345  — QNX connects here (protocol from
     Phase 1: angle CSV, EMERGENCY_STOP, WATCHDOG_HIT, POSE_DONE,
     CYCLE_DONE, SEQ_COMPLETE — plus Phase 3's THREAD_STATUS:<T>:<S>,
     a real per-thread self-report used only by Card 3's observability
     view; see send_thread_status() in the QNX source)

  2. WSS server on port 8765  — Browser dashboard connects here.
     Requires the same shared token as the observability channel,
     presented as the client's first message, before any other traffic
     is accepted or the initial state snapshot is sent.

  3. WSS server on port 8766  — Communication Website connects here.
     Token-authenticated. Replays recent events on connect/reconnect
     (so brief disconnects don't hide important events like
     emergencies), and exposes a Security Center command surface
     (TLS Shield on/off) for already-authenticated clients only.

  4. WS (plaintext, no TLS) server on port 8767  — the "legacy" rogue
     port. A standalone attacker console (attacker_console.py) connects
     here and must present the SAME shared token as :8765/:8766 just to
     be accepted at all (it models a demo operator's own key — not a
     real-world open door). Once accepted, every attack command it
     sends is logged with full attacker telemetry (IP:port, attempt
     rate, declared alias, threat score, payload) and broadcast to the
     Communication Website as a security event.

       • TLS SHIELD ON  (default) — the injected/untrusted traffic from
         :8767 is accepted for logging/alerting ONLY. It is never
         applied to real bridge→browser traffic. Verdict: BLOCKED.
       • TLS SHIELD OFF — the same traffic IS applied for real: packet
         loss / delay / corruption on the real bridge→browser broadcast
         (via fault_layer.py, exactly like the old Test Lab), or
         directly-injected spoofed/replayed telemetry broadcast to
         browser clients. Verdict: SUCCEEDED.

     In both cases the attacker console itself is told NOTHING about
     the verdict — only the Communication Website shows whether an
     attack was blocked or got through. This never touches the QNX TCP
     link, never bans an IP (the Shield blocks the *data*, not the
     attacker), and never touches emergency-typed messages — hard
     exclusions enforced the same way fault_layer.py always enforced
     them.

  5. IDS/firewall (security_monitor.py) tracks failed auth attempts per
     IP across :8765 and :8766 and applies a temporary block. This is
     unrelated to the Shield — it still protects the real control/
     observability channels exactly as before.

Run first:
  python bridge.py

Ports:
  12345  TCP   ← QNX connects here (unchanged)
  8765   WSS   ← Browser connects here (token required)
  8766   WSS   ← Communication Website connects here (token required)
  8767   WS    ← attacker_console.py connects here (token required,
                 PLAINTEXT by design — this is the insecure legacy
                 surface the Shield defends)
"""

import asyncio
import socket
import threading
import json
import time
import queue
import websockets

import hashlib
import hmac
import ssl
import itertools
import pathlib
import collections
import random
from contextlib import AsyncExitStack

import fault_layer
import security_monitor

# ────────────────────────────────────────────────────────────────────
#  Configuration
# ────────────────────────────────────────────────────────────────────
TCP_HOST = "0.0.0.0"
TCP_PORT = 12345
WS_HOST  = "localhost"
WS_PORT  = 8765
ROGUE_PORT = 8767   # deliberately insecure (NO TLS) legacy port — see
                     # module docstring. This is what attacker_console.py
                     # connects to; the TLS SHIELD decides whether what
                     # arrives here is ever allowed to affect real traffic.

HERE                = pathlib.Path(__file__).resolve().parent
GATEWAY_CONFIG_PATH = HERE / "gateway_config.json"

# ────────────────────────────────────────────────────────────────────
#  Shared state  (TCP thread ↔ WS coroutines)
# ────────────────────────────────────────────────────────────────────
state = {
    "angles":        [0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    "emergency":     False,
    "qnx_connected": False,
    "packets":       0,
    "mode":          "manual",
    "pose_idx":      0,
    # Phase 2 addition (Bug 3): tracks whether QNX is currently executing
    # an active RTOS motion sequence vs streaming idle/health telemetry.
    # Set True right when a sequence is dispatched to QNX, cleared on
    # SEQ_COMPLETE or EMERGENCY_STOP. Used only to tag telemetry
    # envelopes for the observability UI — never affects QNX control.
    "motion_active": False,
}
state_lock = threading.Lock()

# Queue for commands to send TO QNX (written by WS coroutines, read by TCP thread)
to_qnx_queue = queue.Queue()

# All connected, AUTHENTICATED WebSocket browser clients
ws_clients     = set()
ws_clients_lock = threading.Lock()

# asyncio loop (set when WS server starts)
ws_loop = None

# ════════════════════════════════════════════════════════════════════
#  TLS SHIELD  —  single source of truth for whether rogue-port (:8767)
#  traffic is allowed to touch real bridge→browser output. Default ON.
#  Turning the shield OFF never changes QNX/control-channel behavior —
#  it only changes what happens to traffic arriving on the insecure
#  legacy port.
# ════════════════════════════════════════════════════════════════════
_shield_lock = threading.Lock()
_shield_state = {"on": True}


def shield_is_on() -> bool:
    with _shield_lock:
        return _shield_state["on"]


def set_shield(on: bool):
    with _shield_lock:
        _shield_state["on"] = bool(on)
    if on:
        # Turning the shield back on immediately neutralizes whatever
        # rogue effect is currently in flight — the window closes right
        # away rather than riding out its remaining duration.
        _stop_rogue_effect(reason="shield_enabled")


# ════════════════════════════════════════════════════════════════════
#  ROGUE ATTACK STATE  —  tracks the single currently-active effect
#  originating from the :8767 legacy port (only one at a time, which
#  matches attacker_console.py only ever running one attack at once).
# ════════════════════════════════════════════════════════════════════
_rogue_lock = threading.Lock()
_rogue_state = {
    "active": False,
    "attack_type": None,     # packet_loss | delay | corrupt | spoof | replay
    "verdict": None,         # "blocked" | "succeeded"
    "attacker": None,        # profile dict, see _build_attacker_profile()
    "params": {},
    "payload_sample": None,
    "payload_size_bytes": 0,
    "threat_score": 0,
    "started_at": 0.0,       # monotonic
    "expires_at": 0.0,       # monotonic
    "duration_s": 0,
    "task": None,            # background asyncio task (spoof/replay only)
}

# ip -> list[monotonic timestamps] of attack attempts (for attempt-rate
# display only — NEVER used to block anything; no IP banning here).
_rogue_attempts = collections.defaultdict(list)
_rogue_attempts_lock = threading.Lock()

ROGUE_ATTACK_DURATION_S = 45       # same fixed duration the old Test Lab used
_THREAT_BASE = {"packet_loss": 35, "delay": 30, "corrupt": 45, "spoof": 75, "replay": 60}


def load_gateway_config():
    if not GATEWAY_CONFIG_PATH.exists():
        return None
    try:
        with open(GATEWAY_CONFIG_PATH) as f:
            return json.load(f)
    except Exception as e:
        print(f"[OBS]  Failed to read gateway_config.json: {e}")
        return None


_gateway_config = load_gateway_config()


def build_obs_ssl_context(cfg):
    """Build a TLS server context, shared by both the :8765 control
    channel and the :8766 observability channel (same shared-secret
    model, same self-signed localhost cert — see PROJECT_DESCRIPTION.md
    Section 5)."""
    if not cfg:
        return None
    cert_path = HERE / cfg.get("tls_cert_path", "certs/localhost.crt")
    key_path  = HERE / cfg.get("tls_key_path", "certs/localhost.key")
    if not cert_path.exists() or not key_path.exists():
        print(f"[OBS]  TLS cert/key not found ({cert_path} / {key_path}).")
        print("[OBS]  Run `python generate_token.py` once to generate them.")
        return None
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(certfile=str(cert_path), keyfile=str(key_path))
    return ctx


def _check_token(token: str) -> bool:
    if not token:
        return False
    presented_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    expected_hash  = (_gateway_config or {}).get("observability_token_hash", "")
    if not expected_hash:
        return False
    return hmac.compare_digest(presented_hash, expected_hash)


def _client_ip(websocket) -> str:
    try:
        return websocket.remote_address[0]
    except Exception:
        return "unknown"


# ════════════════════════════════════════════════════════════════════
#  Observability gateway: envelopes, recent-event buffer, broadcast
# ════════════════════════════════════════════════════════════════════

obs_clients      = set()
obs_clients_lock = threading.Lock()

_packet_id_counter = itertools.count(1)
_packet_id_lock     = threading.Lock()

# ── Bug 4 fix: recent-event ring buffer for reconnect replay ──────────
# Bounded history of the last N enveloped events, so an observer that
# connects (or reconnects after a brief drop) immediately gets caught up
# on anything important it missed — most notably an emergency stop that
# happened while the observability socket itself was cycling. This never
# touches the real QNX/bridge control path; it only affects what a
# reconnecting *observer* sees.
_RECENT_EVENTS_MAXLEN = 150
_recent_events = collections.deque(maxlen=_RECENT_EVENTS_MAXLEN)
_recent_events_lock = threading.Lock()


def wrap_envelope(direction: str, category: str, payload: dict, transport: str) -> dict:
    """
    direction : "qnx_to_bridge" | "bridge_to_qnx" |
                "browser_to_bridge" | "bridge_to_browser"
    category  : "telemetry" | "command" | "ack" | "sequence" |
                "emergency" | "system_status" | "error" | "security" |
                "thread_status"
    payload   : JSON-serializable event data
    transport : "tcp" | "websocket"
    """
    with _packet_id_lock:
        pid = next(_packet_id_counter)
    size_bytes = len(json.dumps(payload).encode("utf-8"))
    return {
        "packet_id":    pid,
        "timestamp_ns": time.monotonic_ns(),
        "direction":    direction,
        "category":     category,
        "transport":    transport,
        "payload":      payload,
        "size_bytes":   size_bytes,
        "real":         True,
    }


async def _broadcast_obs(message: str):
    with obs_clients_lock:
        targets = set(obs_clients)
    if not targets:
        return
    await asyncio.gather(*[ws.send(message) for ws in targets], return_exceptions=True)


def broadcast_to_observers(envelope: dict):
    """Thread-safe. Also appends to the recent-event ring buffer so a
    reconnecting observer can be caught up (Bug 4 fix)."""
    with _recent_events_lock:
        _recent_events.append(envelope)
    if ws_loop and not ws_loop.is_closed():
        message = json.dumps(envelope)
        asyncio.run_coroutine_threadsafe(_broadcast_obs(message), ws_loop)


def _drain_security_alerts_to_observers():
    """Turn any queued IDS alerts into security-category envelopes."""
    for alert in security_monitor.drain_alerts():
        broadcast_to_observers(wrap_envelope("bridge_to_browser", "security", alert, "websocket"))


async def obs_ws_handler(websocket):
    """Handler for the observability WSS server (:8766).
    Phase 1: read-only, token-authenticated.
    Phase 2 additions:
      - IDS check before auth is even attempted (blocked IPs rejected
        immediately)
      - failed auth attempts are recorded with the IDS
      - on successful auth, recent event history is replayed
      - authenticated clients may now send Test Lab commands
        (fault injection config, kill switch, IDS status query) —
        still cannot send anything that reaches QNX or the control
        channel; this remains a strictly separate command surface.
    """
    client_addr = websocket.remote_address
    ip = _client_ip(websocket)

    blocked, remaining = security_monitor.is_blocked(ip)
    if blocked:
        print(f"[IDS]  ✗ Rejected {client_addr} — IP blocked for {remaining}s more")
        try:
            await websocket.close(code=4429, reason="temporarily blocked")
        except Exception:
            pass
        return

    try:
        raw = await asyncio.wait_for(websocket.recv(), timeout=10)
    except (asyncio.TimeoutError, websockets.exceptions.ConnectionClosed):
        print(f"[OBS]  ✗ {client_addr} — no auth message within 10s, closing")
        security_monitor.record_failure(ip, "auth_timeout", "observability")
        try:
            await websocket.close(code=4001, reason="auth timeout")
        except Exception:
            pass
        return

    try:
        auth_data = json.loads(raw)
    except json.JSONDecodeError:
        print(f"[OBS]  ✗ {client_addr} — malformed auth payload, closing")
        security_monitor.record_failure(ip, "malformed_auth", "observability")
        await websocket.close(code=4002, reason="bad auth payload")
        return

    if auth_data.get("type") != "auth" or not auth_data.get("token"):
        print(f"[OBS]  ✗ {client_addr} — first message was not a valid auth request")
        security_monitor.record_failure(ip, "missing_token", "observability")
        await websocket.close(code=4003, reason="auth required")
        return

    if not _check_token(auth_data["token"]):
        just_blocked = security_monitor.record_failure(ip, "invalid_token", "observability")
        print(f"[OBS]  ✗ Auth REJECTED from {client_addr}"
              + ("  — IP now BLOCKED" if just_blocked else ""))
        try:
            await websocket.send(json.dumps({"type": "auth_result", "ok": False}))
            await websocket.close(code=4004, reason="invalid token")
        except Exception:
            pass
        if just_blocked:
            _drain_security_alerts_to_observers()
        return

    security_monitor.record_success(ip)

    with obs_clients_lock:
        obs_clients.add(websocket)
    print(f"[OBS]  ✔ Observer authenticated {client_addr}  (total: {len(obs_clients)})")

    await websocket.send(json.dumps({"type": "auth_result", "ok": True}))

    with state_lock:
        current = dict(state)
    await websocket.send(json.dumps(wrap_envelope(
        "bridge_to_browser", "system_status",
        {
            "qnx_connected": current["qnx_connected"],
            "mode":          current["mode"],
            "packets":       current["packets"],
            "emergency":     current["emergency"],
            "motion_active": current["motion_active"],
        },
        "websocket"
    )))

    # ── Bug 4 fix: replay recent event history on connect/reconnect ──
    with _recent_events_lock:
        backlog = list(_recent_events)
    if backlog:
        replay_msg = json.dumps({"type": "event_replay", "events": [
            {**env, "replayed": True} for env in backlog
        ]})
        try:
            await websocket.send(replay_msg)
        except Exception:
            pass

    # Send current Shield + active-intrusion status so the Security
    # Center UI reflects reality immediately on connect (e.g. after a
    # page reload while an attack was still in flight).
    try:
        await websocket.send(json.dumps({
            "type": "shield_status",
            "on":   shield_is_on(),
            "rogue": _rogue_status(),
            "ids":  security_monitor.snapshot(),
        }))
    except Exception:
        pass

    try:
        async for raw_msg in websocket:
            try:
                msg = json.loads(raw_msg)
            except json.JSONDecodeError:
                continue
            await _handle_obs_command(websocket, msg)
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        with obs_clients_lock:
            obs_clients.discard(websocket)
        print(f"[OBS]  Observer disconnected {client_addr}  (total: {len(obs_clients)})")


async def _broadcast_shield_status():
    """Push fresh shield+rogue status to every connected+authenticated
    observer right now. Used so every open Security Center panel updates
    immediately when the Shield is toggled or an attack starts/stops —
    not just the tab that triggered the change."""
    msg = json.dumps({
        "type": "shield_status",
        "on":   shield_is_on(),
        "rogue": _rogue_status(),
        "ids":  security_monitor.snapshot(),
    })
    with obs_clients_lock:
        targets = set(obs_clients)
    if targets:
        await asyncio.gather(*[ws.send(msg) for ws in targets], return_exceptions=True)


async def _handle_obs_command(websocket, msg: dict):
    """Security Center command surface. Only reachable after successful
    auth (this coroutine is only invoked from inside obs_ws_handler's
    post-auth loop). Cannot reach QNX or the control channel — it can
    only flip the TLS Shield and query its status."""
    msg_type = msg.get("type")

    if msg_type == "shield_set":
        on = bool(msg.get("on", True))
        set_shield(on)
        print(f"[SHIELD] {'ENABLED' if on else 'DISABLED'} by operator via Security Center")
        await websocket.send(json.dumps({"type": "shield_ack", "ok": True, "on": on}))
        await _broadcast_shield_status()

    elif msg_type == "shield_status_query":
        await websocket.send(json.dumps({
            "type": "shield_status",
            "on":   shield_is_on(),
            "rogue": _rogue_status(),
            "ids":  security_monitor.snapshot(),
        }))
    # Anything else on this channel is silently ignored — no command
    # surface into QNX or the robotic control path exists here.


# ════════════════════════════════════════════════════════════════════
#  TLS SHIELD DEMO — the rogue (:8767) listener, attacker telemetry,
#  and the real/blocked effects an attack can have.
#
#  SAFETY MODEL (same hard guarantees as the old Test Lab):
#    1. Never touches the QNX TCP link (:12345) — nothing in this
#       section ever writes to to_qnx_queue or the QNX socket.
#    2. Never applies to `emergency`-typed messages — packet_loss/
#       delay/corrupt still route through fault_layer.maybe_apply(),
#       which hard-excludes them; spoof/replay never fabricate an
#       `emergency` type message (checked explicitly below too).
#    3. Spoofed telemetry is always clamped to a safe joint range.
#    4. The Shield blocks DATA, never an IP — attackers can always
#       retry; there is no ban/unblock concept here.
# ════════════════════════════════════════════════════════════════════

def _build_attacker_profile(ip: str, port, alias: str) -> dict:
    """Only fields that are realistically knowable about a real network
    peer are included here — no fabricated "real identity"."""
    now = time.monotonic()
    with _rogue_attempts_lock:
        hist = _rogue_attempts[ip]
        hist.append(now)
        # keep a bounded window so this can't grow forever in a long demo
        cutoff = now - 300
        while hist and hist[0] < cutoff:
            hist.pop(0)
        attempts_total = len(hist)
        attempts_window_30s = sum(1 for t in hist if t >= now - 30)

    alias = (alias or "").strip()[:32] or "UNDECLARED"
    fingerprint = hashlib.sha1(f"{ip}:{alias}:{port}".encode("utf-8")).hexdigest()[:10]

    return {
        "ip": ip,
        "port": port,
        "alias": alias,                 # self-declared via --name, NOT verified
        "fingerprint": fingerprint,      # spoofable — derived from ip+alias+port
        "token_valid": True,             # only true callers ever reach here
        "tls": "NONE — plaintext legacy port (:8767)",
        "geo": "N/A (local)" if ip in ("127.0.0.1", "::1", "localhost") else "unresolved (local network only)",
        "attempts_total": attempts_total,
        "attempts_window_30s": attempts_window_30s,
    }


def _threat_score(attack_type: str, attacker: dict) -> int:
    base = _THREAT_BASE.get(attack_type, 30)
    score = base + min(attacker.get("attempts_window_30s", 0), 10) * 4
    return max(0, min(100, int(score)))


def _rogue_status() -> dict:
    with _rogue_lock:
        now = time.monotonic()
        active = _rogue_state["active"] and _rogue_state["expires_at"] > now
        remaining = max(0.0, _rogue_state["expires_at"] - now) if active else 0.0
        return {
            "active":             active,
            "attack_type":        _rogue_state["attack_type"] if active else None,
            "verdict":            _rogue_state["verdict"] if active else None,
            "attacker":           _rogue_state["attacker"] if active else None,
            "params":             _rogue_state["params"] if active else {},
            "payload_sample":     _rogue_state["payload_sample"] if active else None,
            "payload_size_bytes": _rogue_state["payload_size_bytes"] if active else 0,
            "threat_score":       _rogue_state["threat_score"] if active else 0,
            "duration_s":         _rogue_state["duration_s"] if active else 0,
            "remaining_s":        round(remaining, 1),
        }


def _broadcast_intrusion_event(phase: str, attack_type: str, verdict, attacker: dict,
                                params: dict, payload_sample, payload_size: int, threat_score: int,
                                duration_s=0, remaining_s=0):
    """Every attacker-originated event (start/blocked/succeeded/ended/
    auto_expired) is reported to the Communication Website as a single
    consistent 'security' envelope shape, so the Security Center can
    render it without special-casing each phase."""
    broadcast_to_observers(wrap_envelope("bridge_to_browser", "security", {
        "type":               "intrusion",
        "phase":              phase,
        "attack_type":        attack_type,
        "shield_on":          shield_is_on(),
        "verdict":            verdict,
        "attacker":           attacker,
        "params":             params,
        "payload_sample":     payload_sample,
        "payload_size_bytes": payload_size,
        "threat_score":       threat_score,
        "duration_s":         duration_s,
        "remaining_s":        remaining_s,
    }, "websocket"))


def _stop_rogue_effect(reason: str = "ended"):
    """Synchronous-safe cleanup: clears any fault_layer config this
    rogue session armed and cancels any running spoof/replay task.
    Safe to call even if nothing is active."""
    with _rogue_lock:
        was_active = _rogue_state["active"]
        attack_type = _rogue_state["attack_type"]
        verdict = _rogue_state["verdict"]
        attacker = _rogue_state["attacker"]
        params = _rogue_state["params"]
        task = _rogue_state["task"]
        _rogue_state["active"] = False
        _rogue_state["task"] = None

    if not was_active:
        return

    if attack_type in ("packet_loss", "delay", "corrupt"):
        fault_layer.clear()
    if task is not None and not task.done():
        task.cancel()

    if verdict == "succeeded":
        print(f"[SHIELD] Intrusion effect ended ({reason}): {attack_type} from "
              f"{attacker.get('ip') if attacker else '?'}")
        _broadcast_intrusion_event(reason, attack_type, "ended", attacker, params, None, 0, 0)


def _safe_spoof_angles():
    """Clamped-safe fabricated joint angles — same visible range as a
    normal pose, never anything that could read as a fault/emergency
    state in its own right."""
    base = [random.uniform(20.0, 160.0) for _ in range(5)]
    grip = random.uniform(0.0, 100.0)
    return [round(v, 2) for v in base] + [round(grip, 2)]


async def _spoof_task(duration_s: float):
    """Shield-OFF effect: periodically broadcasts fabricated telemetry
    straight to browser dashboard clients, indistinguishable on the wire
    from real QNX telemetry — this is the point of the demonstration.
    Never emits an `emergency`-typed message."""
    try:
        end = time.monotonic() + duration_s
        while time.monotonic() < end:
            with _rogue_lock:
                still_active = _rogue_state["active"] and _rogue_state["attack_type"] == "spoof"
            if not still_active:
                break
            angles = _safe_spoof_angles()
            payload = {"type": "angles", "angles": angles, "packets": -1, "pose_idx": -1, "_spoofed": True}
            await _broadcast(json.dumps(payload))
            await asyncio.sleep(1.4)
    except asyncio.CancelledError:
        pass


async def _replay_task(duration_s: float):
    """Shield-OFF effect: repeatedly re-broadcasts the last known REAL
    telemetry packet (a frozen, stale pose) to browser clients, as a
    replay/duplication attack. Never emits an `emergency`-typed message
    and never touches QNX or state['emergency']."""
    try:
        with state_lock:
            stale_angles = list(state["angles"])
        end = time.monotonic() + duration_s
        while time.monotonic() < end:
            with _rogue_lock:
                still_active = _rogue_state["active"] and _rogue_state["attack_type"] == "replay"
            if not still_active:
                break
            payload = {"type": "angles", "angles": stale_angles, "packets": -1, "pose_idx": -1, "_replayed": True}
            await _broadcast(json.dumps(payload))
            await asyncio.sleep(1.0)
    except asyncio.CancelledError:
        pass


async def _handle_rogue_attack_start(websocket, msg: dict, attacker: dict):
    attack_type = msg.get("attack", "")
    raw_params = msg.get("params") or {}

    if attack_type not in ("packet_loss", "delay", "corrupt", "spoof", "replay"):
        return  # unknown command — silently ignored, no feedback leaked

    # Clamp/derive the rate the same way the old Test Lab UI did.
    if attack_type == "packet_loss":
        rate = max(0.0, min(1.0, float(raw_params.get("rate_pct", 30)) / 100.0))
        params = {"rate_pct": raw_params.get("rate_pct", 30)}
    elif attack_type == "corrupt":
        rate = max(0.0, min(1.0, float(raw_params.get("rate_pct", 40)) / 100.0))
        params = {"rate_pct": raw_params.get("rate_pct", 40)}
    elif attack_type == "delay":
        ms = float(raw_params.get("delay_ms", 500))
        rate = max(0.0, min(1.0, ms / 1000.0))
        params = {"delay_ms": raw_params.get("delay_ms", 500)}
    else:
        rate = 0.0
        params = {}

    payload_sample = json.dumps(params) if params else f"{attack_type} (no params)"
    payload_size = len(json.dumps(params).encode("utf-8"))
    threat_score = _threat_score(attack_type, attacker)
    duration_s = ROGUE_ATTACK_DURATION_S
    on = shield_is_on()
    verdict = "blocked" if on else "succeeded"

    # Stop whatever rogue effect (if any) was previously active before
    # starting this one — only one attack runs at a time.
    _stop_rogue_effect(reason="superseded")

    task = None
    if not on:
        if attack_type in ("packet_loss", "delay", "corrupt"):
            fault_layer.configure(mode=attack_type, rate=rate, duration_s=duration_s,
                                   source=f"attacker:{attacker['ip']}:{attacker['port']}")
        elif attack_type == "spoof":
            task = asyncio.create_task(_spoof_task(duration_s))
        elif attack_type == "replay":
            task = asyncio.create_task(_replay_task(duration_s))

    with _rogue_lock:
        _rogue_state.update({
            "active": True,
            "attack_type": attack_type,
            "verdict": verdict,
            "attacker": attacker,
            "params": params,
            "payload_sample": payload_sample,
            "payload_size_bytes": payload_size,
            "threat_score": threat_score,
            "started_at": time.monotonic(),
            "expires_at": time.monotonic() + duration_s,
            "duration_s": duration_s,
            "task": task,
        })

    print(f"[SHIELD] {attack_type} attack from {attacker['ip']}:{attacker['port']} "
          f"(alias={attacker['alias']}) — shield={'ON' if on else 'OFF'} -> {verdict.upper()}")
    _broadcast_intrusion_event("start", attack_type, verdict, attacker, params,
                                payload_sample, payload_size, threat_score,
                                duration_s, duration_s)
    await _broadcast_shield_status()

    # Auto-expire after duration_s even if the console never sends
    # attack_end (e.g. it crashed or was killed).
    async def _auto_expire():
        await asyncio.sleep(duration_s + 0.3)
        with _rogue_lock:
            same_attack = (_rogue_state["active"]
                           and _rogue_state["attacker"] == attacker
                           and _rogue_state["attack_type"] == attack_type)
        if same_attack:
            _stop_rogue_effect(reason="auto_expired")
            await _broadcast_shield_status()
    asyncio.create_task(_auto_expire())

    # Nothing revealing is ever sent back to the attacker — a generic,
    # identical ack regardless of the verdict.
    try:
        await websocket.send(json.dumps({"type": "cmd_received"}))
    except Exception:
        pass


async def _handle_rogue_attack_end(websocket):
    _stop_rogue_effect(reason="operator_ended")
    await _broadcast_shield_status()
    try:
        await websocket.send(json.dumps({"type": "cmd_received"}))
    except Exception:
        pass


async def rogue_ws_handler(websocket):
    """Handler for the deliberately insecure (:8767) legacy port.
    Requires the SAME shared token as :8765/:8766 to be accepted at all
    — this models a demo operator's own key, not an open door. Once
    accepted, attack commands are logged/broadcast with full attacker
    telemetry and either blocked or actually applied depending on the
    TLS Shield — see the module docstring for the full model."""
    client_addr = websocket.remote_address
    ip = _client_ip(websocket)
    port = client_addr[1] if isinstance(client_addr, (tuple, list)) and len(client_addr) > 1 else "?"

    try:
        raw = await asyncio.wait_for(websocket.recv(), timeout=10)
        auth_data = json.loads(raw)
        if auth_data.get("type") != "auth" or not _check_token(auth_data.get("token", "")):
            raise ValueError("bad token")
    except Exception:
        print(f"[ROGUE] ✗ {client_addr} — rejected (missing/invalid token on legacy port)")
        try:
            await websocket.send(json.dumps({"type": "auth_result", "ok": False}))
            await websocket.close(code=4004, reason="invalid token")
        except Exception:
            pass
        return

    alias = str(auth_data.get("name") or "")[:32]
    print(f"[ROGUE] ✔ Attacker console authenticated from {client_addr} (alias={alias or 'UNDECLARED'})")
    await websocket.send(json.dumps({"type": "auth_result", "ok": True}))

    try:
        async for raw_msg in websocket:
            try:
                msg = json.loads(raw_msg)
            except json.JSONDecodeError:
                continue
            msg_type = msg.get("type")
            if msg_type == "attack_start":
                attacker = _build_attacker_profile(ip, port, alias)
                await _handle_rogue_attack_start(websocket, msg, attacker)
            elif msg_type == "attack_end":
                await _handle_rogue_attack_end(websocket)
            # Anything else is ignored — this socket cannot reach QNX,
            # the control channel, or any other command surface.
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        # If this console disconnected mid-attack, clean up so the
        # Security Center doesn't show a phantom ongoing intrusion.
        with _rogue_lock:
            was_this_attacker = (_rogue_state["active"] and _rogue_state["attacker"]
                                  and _rogue_state["attacker"].get("ip") == ip
                                  and _rogue_state["attacker"].get("port") == port)
        if was_this_attacker:
            _stop_rogue_effect(reason="attacker_disconnected")
            await _broadcast_shield_status()
        print(f"[ROGUE] Attacker console disconnected {client_addr}")


async def _rogue_status_ticker():
    """Runs for the lifetime of the bridge. Pushes shield/rogue status
    every second while an attack is actively in flight, so the Security
    Center's countdown (and impact meters, when shield is off) move
    live instead of only updating on the next explicit event."""
    was_active = False
    while True:
        await asyncio.sleep(1)
        active_now = _rogue_status()["active"]
        if active_now or was_active:
            await _broadcast_shield_status()
        was_active = active_now


# ────────────────────────────────────────────────────────────────────
#  Broadcast helpers (browser control channel, :8765)
# ────────────────────────────────────────────────────────────────────
async def _broadcast(message: str):
    """Bridge → all authenticated browser dashboard clients. This is the
    ONLY place fault injection is applied (Test Lab scope, see
    fault_layer.py's module docstring for the full safety model)."""
    with ws_clients_lock:
        targets = set(ws_clients)
    if not targets:
        return

    try:
        decoded = json.loads(message)
    except json.JSONDecodeError:
        decoded = None

    if decoded is not None:
        action, arg = fault_layer.maybe_apply(decoded)
        if action == "drop":
            return
        if action == "delay":
            await asyncio.sleep(min(arg, 3.0))
            out_message = message
        elif action == "corrupt":
            out_message = json.dumps(arg)
        else:
            out_message = message
    else:
        out_message = message

    await asyncio.gather(*[ws.send(out_message) for ws in targets], return_exceptions=True)


def broadcast_from_thread(message: str):
    if ws_loop and not ws_loop.is_closed():
        asyncio.run_coroutine_threadsafe(_broadcast(message), ws_loop)


# ────────────────────────────────────────────────────────────────────
#  TCP Server  — runs in its own daemon thread (QNX link, UNCHANGED
#  protocol from Phase 1 — Test Lab fault injection never touches this)
# ────────────────────────────────────────────────────────────────────
def _categorize_qnx_command(cmd: str) -> str:
    """Best-effort category for a raw command block about to be sent to
    QNX, purely for observability envelope tagging (Card 2's pipeline)."""
    first_line = cmd.strip().split("\n", 1)[0]
    if first_line.startswith("SEQ_START"):
        return "sequence"
    if first_line in ("EMERGENCY_STOP", "RESET_EMERGENCY"):
        return "emergency"
    if first_line == "SEQ_STOP":
        return "command"
    return "command"


def tcp_server_thread():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((TCP_HOST, TCP_PORT))
    srv.listen(1)
    print(f"[TCP]  Listening on {TCP_HOST}:{TCP_PORT}  ← waiting for QNX")

    while True:
        conn, addr = srv.accept()
        conn.settimeout(0.05)
        print(f"[TCP]  QNX connected from {addr}")

        with state_lock:
            state["qnx_connected"] = True
            state["emergency"]     = False

        broadcast_from_thread(json.dumps({
            "type":          "status",
            "qnx_connected": True,
            "addr":          f"{addr[0]}:{addr[1]}"
        }))
        broadcast_to_observers(wrap_envelope("bridge_to_browser", "system_status", {
            "type":          "status",
            "qnx_connected": True,
            "addr":          f"{addr[0]}:{addr[1]}"
        }, "websocket"))

        buf = ""
        try:
            while True:
                # ── Drain outgoing queue (browser → QNX) ──────────────
                disconnected_on_send = False
                while not to_qnx_queue.empty():
                    try:
                        cmd = to_qnx_queue.get_nowait()
                        conn.sendall(cmd.encode("utf-8"))
                        broadcast_to_observers(wrap_envelope(
                            "bridge_to_qnx", _categorize_qnx_command(cmd),
                            {"type": "qnx_tx", "lines": cmd.strip().split("\n")},
                            "tcp"
                        ))
                    except (BrokenPipeError, ConnectionResetError, OSError) as e:
                        print(f"[TCP]  Send error (treating as disconnect): {e}")
                        disconnected_on_send = True
                        break
                    except Exception as e:
                        print(f"[TCP]  Send error: {e}")
                if disconnected_on_send:
                    break

                # ── Receive from QNX ───────────────────────────────────
                # Bug 2 fix: distinguish "no data yet" (socket.timeout,
                # expected every ~50ms while idle) from a genuine EOF
                # (conn.recv() returning b"" with NO exception, which
                # means the peer performed an orderly TCP close — i.e.
                # QNX terminated or the VM/network link dropped). The
                # previous version conflated both cases into the same
                # "raw == ''" check and therefore never detected a real
                # disconnect: it just kept spin-looping against a dead
                # socket, so qnx_connected stayed True forever.
                try:
                    raw_bytes = conn.recv(4096)
                except socket.timeout:
                    time.sleep(0.005)
                    continue
                except (ConnectionResetError, OSError) as e:
                    print(f"[TCP]  Recv error (treating as disconnect): {e}")
                    break

                if raw_bytes == b"":
                    print("[TCP]  QNX closed the connection (EOF)")
                    break

                raw = raw_bytes.decode("utf-8", errors="ignore")
                buf += raw

                while "\n" in buf:
                    line, buf = buf.split("\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    _handle_qnx_line(line)

        except Exception as e:
            print(f"[TCP]  Connection error: {e}")
        finally:
            conn.close()
            with state_lock:
                state["qnx_connected"] = False
                state["motion_active"] = False
            print("[TCP]  QNX disconnected. Waiting for reconnect…")
            broadcast_from_thread(json.dumps({
                "type":          "status",
                "qnx_connected": False,
                "addr":          "—"
            }))
            broadcast_to_observers(wrap_envelope("bridge_to_browser", "system_status", {
                "type":          "status",
                "qnx_connected": False,
                "addr":          "—"
            }, "websocket"))


def _handle_qnx_line(line: str):
    """Parse one line received from QNX and broadcast to browser."""

    # ── EMERGENCY_STOP ───────────────────────────────────────────
    if line == "EMERGENCY_STOP":
        with state_lock:
            state["emergency"] = True
            state["motion_active"] = False
        print("[TCP]  ⚠ EMERGENCY_STOP received from QNX!")
        broadcast_from_thread(json.dumps({
            "type":   "emergency",
            "source": "qnx"
        }))
        broadcast_to_observers(wrap_envelope("qnx_to_bridge", "emergency", {
            "type":   "emergency",
            "source": "qnx"
        }, "tcp"))
        return

    # ── EMERGENCY_CLEARED (Item 6: QNX-confirmed recovery) ────────
    # QNX only ever sends this in direct response to a RESET_EMERGENCY
    # it actually processed. This is the ONLY place bridge.py clears
    # state["emergency"] — never implicitly, never from the browser side
    # alone. Only after this arrives does the dashboard get told it's
    # safe to allow motion commands again.
    if line == "EMERGENCY_CLEARED":
        with state_lock:
            state["emergency"] = False
        print("[TCP]  ✔ EMERGENCY_CLEARED — QNX confirmed recovery, motion re-armed")
        broadcast_from_thread(json.dumps({"type": "emergency_cleared"}))
        broadcast_to_observers(wrap_envelope("qnx_to_bridge", "emergency", {
            "type": "emergency_cleared"
        }, "tcp"))
        return

    # ── WATCHDOG_HIT:<ms_over> ───────────────────────────────────
    if line.startswith("WATCHDOG_HIT:"):
        try:
            ms_over = float(line.split(":", 1)[1])
        except Exception:
            ms_over = 0.0
        print(f"[TCP]  ⏱ Watchdog: deadline missed by {ms_over:.1f}ms")
        broadcast_from_thread(json.dumps({
            "type":      "watchdog",
            "missed_ms": ms_over
        }))
        broadcast_to_observers(wrap_envelope("qnx_to_bridge", "error", {
            "type":      "watchdog",
            "missed_ms": ms_over
        }, "tcp"))
        return

    # ── POSE_DONE:<pose_idx> ─────────────────────────────────────
    if line.startswith("POSE_DONE:"):
        try:
            idx = int(line.split(":", 1)[1])
        except Exception:
            idx = 0
        with state_lock:
            state["pose_idx"] = idx
        print(f"[TCP]  ✔ Pose #{idx+1} done")
        broadcast_from_thread(json.dumps({
            "type":     "pose_advance",
            "pose_idx": idx + 1
        }))
        broadcast_to_observers(wrap_envelope("qnx_to_bridge", "telemetry", {
            "type":     "pose_advance",
            "pose_idx": idx + 1,
        }, "tcp"))
        return

    # ── CYCLE_DONE:<n> ────────────────────────────────────────────
    if line.startswith("CYCLE_DONE:"):
        try:
            cycle_num = int(line.split(":", 1)[1])
        except Exception:
            cycle_num = 0
        print(f"[TCP]  🔁 Cycle #{cycle_num} complete")
        broadcast_from_thread(json.dumps({
            "type":      "cycle_done",
            "cycle_num": cycle_num
        }))
        broadcast_to_observers(wrap_envelope("qnx_to_bridge", "telemetry", {
            "type":      "cycle_done",
            "cycle_num": cycle_num,
        }, "tcp"))
        return

    # ── THREAD_STATUS:<T>:<S> ─────────────────────────────────────
    # Real, event-driven self-report from one of QNX's three actual
    # threads (see send_thread_status() in the QNX source). Purely
    # observational -- never touches control/safety state. Forwarded
    # only to the observability channel (:8766 / Card 3); the browser
    # control channel (:8765) has no use for it, same separation
    # already used for every other observability-only envelope here.
    if line.startswith("THREAD_STATUS:"):
        parts = line.split(":", 2)
        if len(parts) == 3:
            _, thread_name, thread_state = parts
            broadcast_to_observers(wrap_envelope("qnx_to_bridge", "thread_status", {
                "type":   "thread_status",
                "thread": thread_name,
                "state":  thread_state,
            }, "tcp"))
        return

    # ── SEQ_COMPLETE ─────────────────────────────────────────────
    if line == "SEQ_COMPLETE":
        with state_lock:
            state["motion_active"] = False
        print("[TCP]  ✔ RTOS cycling stopped — SEQ_COMPLETE")
        broadcast_from_thread(json.dumps({"type": "seq_complete"}))
        broadcast_to_observers(wrap_envelope("qnx_to_bridge", "ack", {"type": "seq_complete"}, "tcp"))
        return

    # ── ANGLES: "j0,j1,j2,j3,j4" or "j0,j1,j2,j3,j4,j5" ────────
    # QNX now only ever sends these while actively executing a recorded
    # RTOS sequence (idle heartbeat telemetry was removed — see the QNX
    # source). So every angle packet reaching here is real motion data;
    # no idle/motion "phase" tag is needed anymore.
    parts = line.split(",")
    if len(parts) in (5, 6):
        try:
            angles = [float(p) for p in parts]
            if len(angles) == 5:
                angles.append(0.0)

            with state_lock:
                state["angles"]    = angles
                # NOTE: emergency is intentionally NOT cleared here.
                # It is cleared in exactly one place — on receiving
                # EMERGENCY_CLEARED from QNX, itself only sent after QNX
                # processes an explicit RESET_EMERGENCY request. Clearing
                # it implicitly just because telemetry resumed would let
                # the safety lock be bypassed without operator
                # confirmation, which defeats the point of Item 6.
                state["packets"]  += 1
                pkt   = state["packets"]
                pidx  = state["pose_idx"]

            angle_payload = {
                "type":     "angles",
                "angles":   angles,
                "packets":  pkt,
                "pose_idx": pidx
            }
            broadcast_from_thread(json.dumps(angle_payload))
            broadcast_to_observers(wrap_envelope("qnx_to_bridge", "telemetry", angle_payload, "tcp"))
        except ValueError:
            print(f"[TCP]  Bad packet: {line}")


# ────────────────────────────────────────────────────────────────────
#  WebSocket Server  — async, main thread (browser control channel)
# ────────────────────────────────────────────────────────────────────
async def ws_handler(websocket):
    """Phase 2: now requires the same shared token as the observability
    channel, presented as the client's FIRST message, before the initial
    state snapshot is sent or any other traffic is processed. After
    authentication, behavior is identical to Phase 1 — same message
    types, same semantics, same QNX routing."""
    client_addr = websocket.remote_address
    ip = _client_ip(websocket)

    blocked, remaining = security_monitor.is_blocked(ip)
    if blocked:
        print(f"[IDS]  ✗ Rejected browser {client_addr} — IP blocked for {remaining}s more")
        try:
            await websocket.close(code=4429, reason="temporarily blocked")
        except Exception:
            pass
        return

    try:
        raw = await asyncio.wait_for(websocket.recv(), timeout=10)
        auth_data = json.loads(raw)
        if auth_data.get("type") != "auth" or not _check_token(auth_data.get("token", "")):
            raise ValueError("bad token")
    except (asyncio.TimeoutError, websockets.exceptions.ConnectionClosed):
        print(f"[WS]   ✗ {client_addr} — no auth within 10s")
        security_monitor.record_failure(ip, "auth_timeout", "control")
        try:
            await websocket.close(code=4001, reason="auth timeout")
        except Exception:
            pass
        return
    except (json.JSONDecodeError, ValueError):
        just_blocked = security_monitor.record_failure(ip, "invalid_token", "control")
        print(f"[WS]   ✗ Auth REJECTED from {client_addr}"
              + ("  — IP now BLOCKED" if just_blocked else ""))
        try:
            await websocket.send(json.dumps({"type": "auth_result", "ok": False}))
            await websocket.close(code=4004, reason="invalid token")
        except Exception:
            pass
        if just_blocked:
            _drain_security_alerts_to_observers()
        return

    security_monitor.record_success(ip)
    await websocket.send(json.dumps({"type": "auth_result", "ok": True}))

    with ws_clients_lock:
        ws_clients.add(websocket)
        browser_count = len(ws_clients)
    print(f"[WS]   Browser connected  {client_addr}  (total: {browser_count})")

    # Item 1: real connection-status event, independent of traffic —
    # observers use this (not "recent packet seen") to decide BR ONLINE.
    broadcast_to_observers(wrap_envelope("bridge_to_browser", "system_status", {
        "type": "browser_status", "browser_connected": True, "count": browser_count
    }, "websocket"))

    with state_lock:
        current = dict(state)
    await websocket.send(json.dumps({
        "type":          "init",
        "angles":        current["angles"],
        "emergency":     current["emergency"],
        "qnx_connected": current["qnx_connected"],
        "packets":       current["packets"],
    }))

    try:
        async for message in websocket:
            try:
                data = json.loads(message)
            except json.JSONDecodeError:
                continue

            msg_type = data.get("type", "")

            # ── RTOS Sequence: browser → bridge → QNX ──────────────
            if msg_type == "rtos_sequence":
                with state_lock:
                    locked = state["emergency"]
                if locked:
                    print("[WS]   ✗ rtos_sequence rejected — EMERGENCY LOCK active")
                    await websocket.send(json.dumps({
                        "type": "seq_ack", "ok": False,
                        "msg":  "Rejected — system is EMERGENCY LOCKED. Send RESET_EMERGENCY first."
                    }))
                    continue

                seq     = data.get("sequence", [])
                dur_ms  = data.get("pose_duration_ms", 1000)
                n_poses = len(seq)
                if n_poses == 0:
                    continue

                print(f"[WS]   RTOS sequence: {n_poses} poses, {dur_ms}ms/pose → QNX")

                lines = [f"SEQ_START:{n_poses}:{dur_ms}"]
                for idx, pose in enumerate(seq):
                    csv = ",".join(f"{v:.2f}" for v in pose)
                    lines.append(f"POSE:{idx}:{csv}")
                lines.append("SEQ_END")
                block = "\n".join(lines) + "\n"

                with state_lock:
                    state["motion_active"] = True

                to_qnx_queue.put(block)
                broadcast_to_observers(wrap_envelope("browser_to_bridge", "sequence", {
                    "type":             "rtos_sequence",
                    "sequence":         seq,
                    "total_poses":      n_poses,
                    "pose_duration_ms": dur_ms
                }, "websocket"))

                await websocket.send(json.dumps({
                    "type": "seq_ack",
                    "msg":  f"RTOS sequence ({n_poses} poses @ {dur_ms}ms) sent to QNX"
                }))
                broadcast_to_observers(wrap_envelope("bridge_to_browser", "ack", {
                    "type": "seq_ack",
                    "msg":  f"RTOS sequence ({n_poses} poses @ {dur_ms}ms) sent to QNX"
                }, "websocket"))

            # ── Legacy sequence send ────────────────────────────────
            elif msg_type == "send_sequence":
                seq = data.get("sequence", [])
                n   = len(seq)
                if n == 0:
                    continue
                dur_ms = 1000
                lines  = [f"SEQ_START:{n}:{dur_ms}"]
                for idx, pose in enumerate(seq):
                    csv = ",".join(f"{v:.2f}" for v in pose)
                    lines.append(f"POSE:{idx}:{csv}")
                lines.append("SEQ_END")
                with state_lock:
                    state["motion_active"] = True
                to_qnx_queue.put("\n".join(lines) + "\n")
                broadcast_to_observers(wrap_envelope("browser_to_bridge", "sequence", {
                    "type":     "send_sequence",
                    "sequence": seq,
                    "total_poses": n
                }, "websocket"))
                await websocket.send(json.dumps({
                    "type": "seq_ack",
                    "msg":  f"Sequence ({n} poses) queued for QNX"
                }))

            # ── Emergency from browser → QNX ───────────────────────
            elif msg_type == "emergency":
                with state_lock:
                    state["emergency"] = True
                to_qnx_queue.put("EMERGENCY_STOP\n")
                print("[WS]   ⚠ Emergency from browser → QNX")
                broadcast_to_observers(wrap_envelope("browser_to_bridge", "emergency", {
                    "type": "emergency", "source": "browser"
                }, "websocket"))
                await _broadcast(json.dumps({"type": "emergency", "source": "browser"}))

            # ── Explicit, operator-confirmed recovery (Item 6) ──────
            # Bridge does NOT clear state["emergency"] here — only QNX's
            # EMERGENCY_CLEARED confirmation does that (see
            # _handle_qnx_line). This just forwards the request and lets
            # the real recovery happen on the QNX side.
            elif msg_type == "reset_emergency":
                to_qnx_queue.put("RESET_EMERGENCY\n")
                print("[WS]   🔓 RESET_EMERGENCY requested by browser → QNX")
                broadcast_to_observers(wrap_envelope("browser_to_bridge", "emergency", {
                    "type": "reset_emergency"
                }, "websocket"))
                await websocket.send(json.dumps({
                    "type": "reset_emergency_ack",
                    "msg":  "Reset request sent to QNX — waiting for confirmation"
                }))

            # ── Stop cycling: finish current pass then halt ─────────
            elif msg_type == "stop_cycle":
                to_qnx_queue.put("SEQ_STOP\n")
                print("[WS]   SEQ_STOP → QNX  (will stop after current pass)")
                broadcast_to_observers(wrap_envelope("browser_to_bridge", "command", {
                    "type": "stop_cycle"
                }, "websocket"))
                await websocket.send(json.dumps({
                    "type": "stop_cycle_ack",
                    "msg":  "Stop requested — arm will finish current cycle then halt"
                }))

            # ── Mode change (informational) ─────────────────────────
            elif msg_type == "set_mode":
                mode = data.get("mode", "manual")
                with state_lock:
                    state["mode"] = mode
                print(f"[WS]   Mode → {mode.upper()}")
                broadcast_to_observers(wrap_envelope("browser_to_bridge", "command", {
                    "type": "set_mode", "mode": mode
                }, "websocket"))

            else:
                print(f"[WS]   From browser: {data}")

    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        with ws_clients_lock:
            ws_clients.discard(websocket)
            browser_count = len(ws_clients)
        print(f"[WS]   Browser disconnected {client_addr}  (total: {browser_count})")
        broadcast_to_observers(wrap_envelope("bridge_to_browser", "system_status", {
            "type": "browser_status", "browser_connected": browser_count > 0, "count": browser_count
        }, "websocket"))


# ────────────────────────────────────────────────────────────────────
#  Main
# ────────────────────────────────────────────────────────────────────
async def main():
    global ws_loop
    ws_loop = asyncio.get_running_loop()

    t = threading.Thread(target=tcp_server_thread, daemon=True, name="TCP-Server")
    t.start()

    asyncio.create_task(_rogue_status_ticker())

    ssl_ctx = build_obs_ssl_context(_gateway_config)
    obs_port = (_gateway_config or {}).get("observability_port", 8766)

    secured = bool(_gateway_config and ssl_ctx)
    # The rogue/legacy port only needs the token hash (no TLS), so it can
    # come up as soon as gateway_config.json exists — independent of
    # whether a cert was generated for the secured channels.
    rogue_available = bool(_gateway_config and _gateway_config.get("observability_token_hash"))

    async with AsyncExitStack() as stack:
        if secured:
            await stack.enter_async_context(websockets.serve(ws_handler, WS_HOST, WS_PORT, ssl=ssl_ctx))
            await stack.enter_async_context(websockets.serve(obs_ws_handler, WS_HOST, obs_port, ssl=ssl_ctx))
        else:
            # No token/cert configured yet — bridge still runs, but both
            # secured channels are disabled until `generate_token.py` is
            # run once. (Nothing to connect to on 8765/8766 in this
            # state; QNX's TCP link on :12345 is unaffected either way.)
            print("[SEC]  No gateway_config.json / TLS cert found.")
            print("[SEC]  Run `python generate_token.py` once (in python_bridge/) "
                  "to enable the secured control (:8765) and observability (:8766) channels.")

        if rogue_available:
            await stack.enter_async_context(websockets.serve(rogue_ws_handler, WS_HOST, ROGUE_PORT))

        if secured:
            print(f"[WS]   Secured control channel on wss://{WS_HOST}:{WS_PORT}  (token required)")
            print(f"[OBS]  Observability WSS server on wss://{WS_HOST}:{obs_port}  (token required)")
        if rogue_available:
            print(f"[ROGUE] Legacy (plaintext) attacker-console port on ws://{WS_HOST}:{ROGUE_PORT}  (token required)")
        print()
        print("═" * 60)
        print("  M.A.T.R.I.X. Bridge  —  RUNNING")
        print()
        print("  1. Open dashboard/index.html with Live Server in VS Code")
        print("  2. Start QNX VM and run ./Robotic_ARM")
        print()
        print(f"  TLS SHIELD:  {'ON' if shield_is_on() else 'OFF'}  (default ON — toggle from the")
        print("               Communication Website's Security Center)")
        print()
        print("  Ports:  TCP :12345  ← QNX")
        if secured:
            print("          WSS :8765   ← Browser (token required)")
            print(f"          WSS :{obs_port}   ← Communication Website (token required)")
        if rogue_available:
            print(f"          WS  :{ROGUE_PORT}   ← attacker_console.py (token required, PLAINTEXT by design)")
        print("═" * 60)
        print()
        await asyncio.Future()   # run forever


if __name__ == "__main__":
    asyncio.run(main())