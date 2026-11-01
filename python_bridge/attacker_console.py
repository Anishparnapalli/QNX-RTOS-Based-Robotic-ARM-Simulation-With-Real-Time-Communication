"""
attacker_console.py — M.A.T.R.I.X. TLS SHIELD demo: standalone intrusion tool
═══════════════════════════════════════════════════════════════════════
This is a SEPARATE program from bridge.py and the Communication Website.
It is the "attacker" side of the TLS Shield demonstration: it connects to
bridge.py's deliberately insecure legacy port (:8767, PLAINTEXT — no TLS)
and launches real intrusion attempts against the real bridge.

WHAT IT DOES
────────────
  - Requires the same shared OBSERVABILITY TOKEN as the Communication
    Website/Robotic Dashboard to even be accepted by the bridge. This
    models a demo operator's own key, not an open door — only someone
    who already has the token can run this tool at all.
  - Once connected, it waits at an interactive prompt. Typing one of the
    intrusion commands below launches a REAL attack against the bridge:
      packet_loss [rate%]   — drop a fraction of bridge→browser packets
      delay [ms]            — delay bridge→browser packets
      corrupt [rate%]       — corrupt bridge→browser joint data
      spoof                 — inject fabricated (but safe-range) joint
                               telemetry straight to browser clients
      replay                — rebroadcast a frozen, stale real pose
                               repeatedly (replay/duplication attack)
    Every attack runs for at most 45 seconds, or until you type `end`.
  - WHAT YOU WILL NEVER SEE HERE: whether the attack was blocked or
    succeeded. That is entirely intentional — this console only attacks;
    only the Communication Website's Security Center shows the outcome.
    This mirrors how a real attacker has no idea whether a defended
    target actually accepted their traffic.

WHAT IT NEVER DOES
──────────────────
  - Never touches the QNX TCP link (:12345) — it doesn't even know it
    exists.
  - Never sends anything that could read as an emergency/safety message.
  - Never bans or targets anything other than the bridge's legacy port.

USAGE
─────
    cd python_bridge
    python attacker_console.py --token <OBSERVABILITY_TOKEN> [--host localhost] [--name ghost]

The token is the SAME value printed once by generate_token.py and used
as OBSERVABILITY_TOKEN in com_dashboard/app.js.
"""

import argparse
import asyncio
import json
import queue
import threading
import time

import websockets

ROGUE_PORT = 8767
ATTACK_DURATION_S = 45

ATTACKS = {
    "packet_loss": "Drop a fraction of bridge→browser packets",
    "delay":       "Delay bridge→browser packets",
    "corrupt":     "Corrupt bridge→browser joint data",
    "spoof":       "Inject fabricated (safe-range) joint telemetry",
    "replay":      "Rebroadcast a frozen, stale real pose repeatedly",
}


# ────────────────────────────────────────────────────────────────────
#  Background network thread — owns the one asyncio event loop and the
#  one WebSocket connection. The main thread (interactive prompt) talks
#  to it only through thread-safe send_* calls below.
# ────────────────────────────────────────────────────────────────────
class ConsoleLink:
    def __init__(self, host, token, name):
        self.host = host
        self.token = token
        self.name = name
        self.loop = None
        self.ws = None
        self.ready = threading.Event()
        self.auth_ok = None   # None = unknown yet, True/False once known
        self.closed = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True, name="ConsoleLink")

    def start(self):
        self._thread.start()
        self.ready.wait(timeout=15)

    def _run(self):
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        try:
            self.loop.run_until_complete(self._main())
        except Exception:
            pass
        finally:
            self.closed.set()

    async def _main(self):
        uri = f"ws://{self.host}:{ROGUE_PORT}"
        try:
            async with websockets.connect(uri) as ws:
                self.ws = ws
                await ws.send(json.dumps({"type": "auth", "token": self.token, "name": self.name}))
                raw = await asyncio.wait_for(ws.recv(), timeout=10)
                reply = json.loads(raw)
                self.auth_ok = bool(reply.get("ok"))
                self.ready.set()
                if not self.auth_ok:
                    return
                # Drain incoming messages for the rest of the session.
                # Every reply from the bridge here is deliberately a
                # generic {"type":"cmd_received"} with no verdict info —
                # this loop exists only to keep the socket alive and
                # drained, never to learn anything about outcomes.
                async for _ in ws:
                    pass
        except Exception:
            self.auth_ok = False
            self.ready.set()
        finally:
            self.closed.set()

    def send(self, obj):
        if not self.loop or self.closed.is_set():
            return
        async def _send():
            try:
                await self.ws.send(json.dumps(obj))
            except Exception:
                pass
        try:
            asyncio.run_coroutine_threadsafe(_send(), self.loop)
        except Exception:
            pass


# ────────────────────────────────────────────────────────────────────
#  Continuous stdin reader thread — avoids overlapping blocking input()
#  calls between the "waiting for next command" prompt and the
#  "type end to stop early" sub-loop.
# ────────────────────────────────────────────────────────────────────
class StdinReader:
    def __init__(self):
        self._q = queue.Queue()
        self._thread = threading.Thread(target=self._run, daemon=True, name="StdinReader")
        self._thread.start()

    def _run(self):
        while True:
            try:
                line = input()
            except EOFError:
                self._q.put(None)
                return
            self._q.put(line)

    def readline(self, timeout=None):
        """Blocks up to `timeout` seconds for a line. Returns the line,
        or None on timeout / EOF."""
        try:
            return self._q.get(timeout=timeout)
        except queue.Empty:
            return None


def parse_attack_command(cmd_line):
    parts = cmd_line.strip().split()
    if not parts:
        return None, {}
    name = parts[0].lower()
    if name not in ATTACKS:
        return None, {}
    params = {}
    if name == "packet_loss":
        params["rate_pct"] = float(parts[1]) if len(parts) > 1 else 30
    elif name == "corrupt":
        params["rate_pct"] = float(parts[1]) if len(parts) > 1 else 40
    elif name == "delay":
        params["delay_ms"] = float(parts[1]) if len(parts) > 1 else 500
    return name, params


def print_banner():
    print("=" * 66)
    print("  M.A.T.R.I.X. — INTRUSION CONSOLE (demo attacker tool)")
    print("=" * 66)
    print("  Connected to the bridge's legacy (plaintext) port.")
    print("  This console NEVER shows whether an attack was blocked or")
    print("  succeeded — only the Communication Website's Security")
    print("  Center shows that. Check it there.")
    print()
    print("  Commands:")
    for k, v in ATTACKS.items():
        print(f"    {k:<12} — {v}")
    print(f"    end          — stop the current attack early")
    print(f"    help         — show this list again")
    print(f"    quit / exit  — disconnect and close this console")
    print()
    print(f"  Each attack runs for up to {ATTACK_DURATION_S}s, or until you type 'end'.")
    print("=" * 66)
    print()


def main():
    ap = argparse.ArgumentParser(description="M.A.T.R.I.X. TLS Shield demo — standalone attacker console")
    ap.add_argument("--host", default="localhost", help="Bridge host (default: localhost)")
    ap.add_argument("--token", required=True, help="The shared OBSERVABILITY_TOKEN (required to attack at all)")
    ap.add_argument("--name", default="", help="Optional self-declared alias shown in the Security Center (unverified)")
    args = ap.parse_args()

    print(f"[*] Connecting to ws://{args.host}:{ROGUE_PORT} (plaintext legacy port) ...")
    link = ConsoleLink(args.host, args.token, args.name)
    link.start()

    if link.auth_ok is not True:
        print("[!] Authentication failed — token was rejected, or the bridge is unreachable.")
        print("[!] This console cannot attack without a valid token. Exiting.")
        return

    print("[*] Authenticated on the legacy port. Console is live.\n")
    print_banner()

    stdin = StdinReader()

    while True:
        print("matrix-intrude> ", end="", flush=True)
        line = stdin.readline()
        if line is None:
            print("\n[*] Input closed. Exiting.")
            break
        cmd_raw = line.strip()
        if not cmd_raw:
            continue
        low = cmd_raw.lower()

        if low in ("quit", "exit"):
            print("[*] Disconnecting.")
            break
        if low == "help":
            print_banner()
            continue

        attack, params = parse_attack_command(cmd_raw)
        if attack is None:
            print(f"[!] Unknown command '{cmd_raw}'. Type 'help' for the list.")
            continue

        link.send({"type": "attack_start", "attack": attack, "params": params})
        print(f"[+] Launching '{attack}' ... running for up to {ATTACK_DURATION_S}s.")
        print("    Type 'end' at any time to stop it early. Outcome is not shown here —")
        print("    check the Communication Website's Security Center.")

        deadline = time.monotonic() + ATTACK_DURATION_S
        stopped_early = False
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            sub = stdin.readline(timeout=remaining)
            if sub is None:
                continue
            if sub.strip().lower() == "end":
                stopped_early = True
                break
            elif sub.strip():
                print("    (attack in progress — type 'end' to stop early, or wait for auto-stop)")

        link.send({"type": "attack_end"})
        if stopped_early:
            print("[+] Attack stopped by operator. Back to command prompt.\n")
        else:
            print("[+] Attack auto-stopped after 45s. Back to command prompt.\n")

    link.send({"type": "attack_end"})


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[*] Interrupted. Exiting.")