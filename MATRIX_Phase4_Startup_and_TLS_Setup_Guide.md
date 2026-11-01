# MATRIX Phase 4 — Startup & TLS Setup Guide

This records the setup sequence used for a fresh MATRIX Phase 4 project so the same environment can be recreated later.

## 1. Open the project

Extract the latest project ZIP and open the project root in VS Code.

Example project path:

```text
C:\Users\AnishP\Downloads\MATRIX_Phase4
```

Open a PowerShell terminal and enter:

```powershell
cd "C:\Users\AnishP\Downloads\MATRIX_Phase4\python_bridge"


A fresh ZIP may not contain these generated/runtime items:

```text
gateway_config.json
certs/
__pycache__/
```

That is normal.

---

## 2. Check the existing OpenSSL installation

The previous MATRIX setup already had OpenSSL installed.

Search for it:

```powershell
Get-ChildItem "C:\Program Files" -Directory -Filter "*OpenSSL*" -ErrorAction SilentlyContinue

Also check, if needed:

```powershell
Get-ChildItem "C:\Program Files (x86)" -Directory -Filter "*OpenSSL*" -ErrorAction SilentlyContinue


The installation found previously was:

```text
C:\Program Files\OpenSSL-Win64
```

Verify the executable:

```powershell
Test-Path "C:\Program Files\OpenSSL-Win64\bin\openssl.exe"

Expected result:

```text
True
```

---

## 3. Map OpenSSL into PowerShell

If:

```powershell
openssl version

returns:

```text
openssl : The term 'openssl' is not recognized...
```

do NOT reinstall OpenSSL if it is already present.

Add its `bin` directory to the current PowerShell session:

```powershell
$env:Path += ";C:\Program Files\OpenSSL-Win64\bin"

Then verify:

```powershell
openssl version

This PATH change applies to the current PowerShell window. If a new PowerShell window cannot find OpenSSL again, repeat the PATH command.

---

## 4. Generate gateway configuration and TLS certificates

From:

```text
C:\Users\AnishP\Downloads\MATRIX_Phase4\python_bridge


run:

```powershell
python generate_token.py

A successful run creates:

```text
python_bridge/
├── gateway_config.json
└── certs/
    ├── localhost.crt
    └── localhost.key
```

`gateway_config.json` stores the token hash, not the plaintext token.

The script prints the plaintext **OBSERVABILITY TOKEN once**.

---

## 5. Copy the new observability token

Immediately copy the token printed by:

```powershell
python generate_token.py
```

Do not use a token from an older project/setup.

Open the Communication Dashboard JavaScript file, for example:

```text
comm-dashboard/app.js
```

Find:

```javascript
const OBSERVABILITY_TOKEN = "...";
```

Replace the old/placeholder value with the newly generated token.

Save the file.

### Important

Running `generate_token.py` again replaces the gateway token hash. If you regenerate the token, update `app.js` with the newest token again.

Do not put the example/previous token from a terminal transcript into the project.

---

## 6. Start the Python Bridge

Keep the Python Bridge terminal open:

```powershell
cd "C:\Users\AnishP\Downloads\MATRIX_Phase4\python_bridge"
python bridge.py

Leave this terminal running during all MATRIX testing.

---

## 7. Start the Communication Dashboard

Open a second PowerShell terminal.

Run:

```powershell
cd "C:\Users\AnishP\Downloads\MATRIX_Phase4"
python -m http.server 5500 --directory com_dashboard


Keep this terminal running.

Open:

```text
http://localhost:5500


The local HTTP server command above is the method used for the MATRIX Communication Dashboard.

---

## 8. Fix the local WSS certificate warning

The Communication Dashboard connects to the gateway using:

```text
wss://localhost:8766/


Because the certificate is locally generated/self-signed, Chrome may initially show:

```text
ERR_CERT_AUTHORITY_INVALID
```

This is a browser certificate-trust issue, not necessarily a bridge failure.

Open a new Chrome tab:

```text
https://localhost:8766/

Chrome may display:

```text
Your connection is not private
```

Choose:

```text
Advanced
```

and continue to localhost if Chrome provides the option.

If Chrome does not show the proceed option, type this directly on the warning page:

```text
thisisunsafe
```

Nothing will visibly appear while typing.

Then return to:

```text
http://localhost:5500
```

and refresh:

```text
Ctrl + Shift + R
```

The dashboard should now authenticate and show the gateway online.

---

## 9. Ignore the favicon 404

You may see:

```text
GET http://localhost:5500/favicon.ico 404
```

This is unrelated to MATRIX communication.

It only means no favicon file exists.

The important error to resolve is:

```text
wss://localhost:8766/
ERR_CERT_AUTHORITY_INVALID
```

---

## 10. Start the Robotic Dashboard

Open the Robotic Dashboard in VS Code and use Live Server on its `index.html`, as used previously for the project.

Keep:

- Python Bridge running
- Communication Dashboard server running

The Robotic Dashboard should connect to the communication system.

---

## 11. Start QNX Momentics

Open QNX Momentics and use the existing MATRIX QNX target/project configuration.

Run the robotic-arm controller C program from Momentics as normally used by the project.

The QNX controller should establish its TCP connection with the Python Bridge.

Do not invent a new QNX startup procedure if the existing Momentics launch configuration is already working.

---

# 12. Complete live architecture

The intended live chain is:

```text
QNX Momentics
     │
     │ TCP
     ▼
Python Bridge
   bridge.py
     │
     │ WSS
     ▼
Communication Dashboard
   localhost:5500
     │
     │ project WebSocket communication
     ▼
Robotic Dashboard
```

The exact application-level routing remains governed by the current project implementation.

---

# 13. Recommended startup order

For a fresh MATRIX session:

```text
1. Open the project in VS Code
        ↓
2. Open python_bridge terminal
        ↓
3. Check/find OpenSSL
        ↓
4. Add OpenSSL to PATH if necessary
        ↓
5. Run generate_token.py
        ↓
6. Copy the newly printed token
        ↓
7. Update OBSERVABILITY_TOKEN in comm-dashboard/app.js
        ↓
8. Start python bridge.py
        ↓
9. Start Communication Dashboard on port 5500
        ↓
10. Open https://localhost:8766/ once
        ↓
11. Accept the localhost certificate in Chrome
        ↓
12. Refresh http://localhost:5500
        ↓
13. Confirm authentication + gateway online
        ↓
14. Start Robotic Dashboard with Live Server
        ↓
15. Start QNX controller from Momentics
        ↓
16. Confirm QNX connection
        ↓
17. Begin functional testing
```

---

# 14. Normal terminal arrangement

### Terminal 1 — Python Bridge

```powershell
cd "C:\Users\AnishP\Downloads\MATRIX_Phase4\python_bridge"
python bridge.py
```

### Terminal 2 — Communication Dashboard

```powershell
cd "C:\Users\AnishP\Downloads\MATRIX_Phase4"
python -m http.server 5500 --directory comm-dashboard
```

### VS Code — Robotic Dashboard

Open its `index.html` with Live Server.

### QNX Momentics

Run the QNX robotic controller.

---

# 15. Generated/runtime files

After setup, these should exist:

```text
python_bridge/
├── gateway_config.json
└── certs/
    ├── localhost.crt
    └── localhost.key
```

Python may automatically create:

```text
__pycache__/
```

Do not manually create `__pycache__`; Python creates it when needed.

A fresh ZIP may legitimately omit all of these generated/runtime items.

---

# 16. Troubleshooting

## OpenSSL not recognized

Check:

```powershell
Test-Path "C:\Program Files\OpenSSL-Win64\bin\openssl.exe"
```

If `True`:

```powershell
$env:Path += ";C:\Program Files\OpenSSL-Win64\bin"
```

Then:

```powershell
openssl version
```

## Certificates missing

Run:

```powershell
python generate_token.py
```

after confirming OpenSSL works.

## Authentication fails

Confirm that `comm-dashboard/app.js` contains the token printed by the **latest** `generate_token.py` run.

## Gateway offline

Confirm:

```powershell
python bridge.py
```

is still running.

## WSS certificate error

Visit:

```text
https://localhost:8766/
```

accept the localhost certificate, then refresh the dashboard.

## Dashboard cannot connect

Check:

```text
[ ] bridge.py is running
[ ] gateway_config.json exists
[ ] certs/localhost.crt exists
[ ] certs/localhost.key exists
[ ] current token is in app.js
[ ] Chrome accepted the localhost certificate
[ ] Communication Dashboard is running on port 5500
```

---

# 17. Final pre-test checklist

```text
[ ] Project opened in VS Code
[ ] python_bridge located
[ ] OpenSSL installation found
[ ] openssl version works
[ ] gateway_config.json generated
[ ] localhost.crt generated
[ ] localhost.key generated
[ ] New observability token copied
[ ] Token updated in app.js
[ ] Python Bridge running
[ ] Communication Dashboard running on port 5500
[ ] localhost TLS certificate accepted
[ ] Authentication successful
[ ] Gateway online
[ ] Robotic Dashboard connected
[ ] QNX Momentics connected
```

Only after these are confirmed should MATRIX functional testing begin.
