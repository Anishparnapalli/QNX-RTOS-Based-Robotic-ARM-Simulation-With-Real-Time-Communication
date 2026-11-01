"""
generate_token.py  —  One-time MATRIX Communication Gateway setup script
═══════════════════════════════════════════════════════════════════════
This is a DEVELOPER TOOL. It is not imported or run by bridge.py at
runtime — you run it once (or whenever you want to rotate the token)
to produce:

  1. gateway_config.json   — holds only the SHA-256 HASH of the
                              observability token, plus TLS cert/key
                              paths and the observability port.
                              No plaintext token is ever written here.

  2. certs/localhost.crt / certs/localhost.key
                            — a self-signed TLS certificate for
                              localhost, used by the gateway's WSS
                              (wss://) observability server on :8766.

USAGE
─────
    cd python_bridge
    python generate_token.py

The script prints the PLAINTEXT token to your terminal exactly once.
Copy it into comm-dashboard/app.js (the OBSERVABILITY_TOKEN constant)
so the Communication Website can authenticate to the gateway.

SECURITY NOTE (see PROJECT_DESCRIPTION.md, Section 5)
──────────────────────────────────────────────────────
This token is a shared secret that will live in the Communication
Website's own client-side JavaScript source. That is a deliberate,
documented design choice: its purpose is to let the gateway tell
MATRIX-trusted clients apart from clients that are not, not to
withstand an adversary reading the trusted client's own source.
The gateway still does real, meaningful verification: TLS in transit,
and a constant-time hash comparison (hmac.compare_digest) so the
check itself can't be timing-attacked.
"""

import hashlib
import json
import os
import secrets
import subprocess
import sys

HERE        = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "gateway_config.json")
CERTS_DIR   = os.path.join(HERE, "certs")
CERT_PATH   = os.path.join(CERTS_DIR, "localhost.crt")
KEY_PATH    = os.path.join(CERTS_DIR, "localhost.key")

OBSERVABILITY_PORT = 8766


def generate_token() -> str:
    """32 bytes of CSPRNG randomness, URL-safe base64 text."""
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def ensure_certs():
    """Generate a self-signed localhost cert/key pair via openssl if missing."""
    os.makedirs(CERTS_DIR, exist_ok=True)
    if os.path.exists(CERT_PATH) and os.path.exists(KEY_PATH):
        print(f"[certs]  Found existing cert/key — leaving them in place.")
        print(f"         {CERT_PATH}")
        print(f"         {KEY_PATH}")
        return

    print("[certs]  Generating self-signed TLS certificate for localhost …")
    cmd = [
        "openssl", "req", "-x509", "-newkey", "rsa:2048",
        "-keyout", KEY_PATH, "-out", CERT_PATH,
        "-days", "365", "-nodes",
        "-subj", "/C=IN/ST=TamilNadu/L=Kattankulathur/O=MATRIX/CN=localhost",
        "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True)
        print(f"[certs]  Wrote {CERT_PATH}")
        print(f"[certs]  Wrote {KEY_PATH}")
    except FileNotFoundError:
        print("[certs]  ERROR: 'openssl' was not found on PATH.")
        print("         Install OpenSSL, or supply your own cert/key at:")
        print(f"           {CERT_PATH}")
        print(f"           {KEY_PATH}")
        sys.exit(1)
    except subprocess.CalledProcessError as e:
        print("[certs]  ERROR: openssl failed:")
        print(e.stderr)
        sys.exit(1)


def write_config(token_hash: str):
    config = {
        "observability_token_hash": token_hash,
        "tls_cert_path": "certs/localhost.crt",
        "tls_key_path":  "certs/localhost.key",
        "observability_port": OBSERVABILITY_PORT,
    }
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH) as f:
                existing = json.load(f)
            print("[config] Existing gateway_config.json found — token hash will be replaced.")
            config = {**existing, **config}
        except Exception:
            pass
    with open(CONFIG_PATH, "w") as f:
        json.dump(config, f, indent=2)
    print(f"[config] Wrote {CONFIG_PATH}")


def main():
    print("═" * 66)
    print("  MATRIX Communication Gateway — one-time setup")
    print("═" * 66)

    token = generate_token()
    token_hash = hash_token(token)

    write_config(token_hash)
    ensure_certs()

    print()
    print("═" * 66)
    print("  OBSERVABILITY TOKEN (copy this into comm-dashboard/app.js)")
    print("═" * 66)
    print()
    print(f"    {token}")
    print()
    print("  This is shown ONCE. It is not stored in plaintext anywhere.")
    print("  gateway_config.json only stores its SHA-256 hash.")
    print("═" * 66)


if __name__ == "__main__":
    main()
