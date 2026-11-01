# M.A.T.R.I.X. — Motion Articulation & Telemetric Real-time Interface eXecution

A three-part robotics demonstration stack: a QNX 8.0 RTOS arm controller, a Python bridge/gateway, a Three.js robotic-arm operator dashboard, and a real-time "Communication Website" that observes and visualizes everything happening between them — including, as of this revision, a substantially redesigned **Card 3 (QNX RTOS)** observability view.

```
QNX_Robotic_ARM (C, QNX 8.0, SCHED_FIFO)
        │  TCP :12345
python_bridge (bridge.py)
        │  WSS :8765 (control)          │  WSS :8766 (observability)
robot_dashboard (operator control UI)   com_dashboard (Communication Website)
```

---

## 1. What's in this archive

| Folder | What it is | Changed in this revision? |
|---|---|---|
| `QNX_Robotic_ARM/src/MATRIX_Robotic_ARM.c` | The real-time controller: RECV thread (normal scheduling), MOTION task (`SCHED_FIFO`, priority 10), SAFETY task (`SCHED_FIFO`, priority 20) | **Yes** — added minimal, safe `THREAD_STATUS:<T>:<S>` self-reporting |
| `python_bridge/bridge.py` | TCP↔WebSocket gateway, auth, IDS, fault injection Test Lab, observability envelope broadcaster | **Yes** — parses and forwards the new `THREAD_STATUS` line |
| `robot_dashboard/` | The operator-facing 3D control dashboard (upload models, teach & record poses, RTOS/NON-RTOS/MANUAL modes, emergency stop) | No — preserved as-is |
| `com_dashboard/` | The **Communication Website**: three observability cards (Robotic Dashboard, Python Bridge, QNX RTOS) | **Yes** — Card 3 redesigned end-to-end (see §3) |

Not included: `fault_layer.py`, `security_monitor.py`, `generate_token.py`, and TLS certs. These are real parts of the running system (imported by `bridge.py`) but their source was never provided to this exercise, so they can't be reconstructed or verified here — see **Limitations**.

---

## 2. Running it

1. **QNX side** — build `MATRIX_Robotic_ARM.c` in QNX Momentics (`LIBS += -lsocket -lm`), set `BRIDGE_IP` to your host's address, run it on the QNX VM/target.
2. **Bridge** — on the host: `python generate_token.py` once (creates `gateway_config.json` + a self-signed TLS cert), then `python bridge.py`. It listens on TCP `:12345` (QNX), WSS `:8765` (control), WSS `:8766` (observability).
3. **Robotic Dashboard** — open `robot_dashboard/index.html` (Live Server or similar), upload your `.obj`/`.stl` parts (or let it fall back to procedural primitives), calibrate axes, launch.
4. **Communication Website** — open `com_dashboard/index.html`. It authenticates to `:8766` with the same shared token and starts rendering real traffic immediately. No QNX/dashboard connection is required for it to load — it will simply show "OFFLINE"/"WAITING" states honestly until traffic arrives.

Both dashboards currently ship with the **same placeholder shared token** (`aEam6N5RQnkDF0Ew-IDpXPWFZAW3uNQzcUvIh7O1LYM`) hard-coded near the top of their respective `app.js` files — replace both with the token your own `generate_token.py` run prints before deploying anywhere real.

---

## 3. Card 3 — what changed and why

The starting point was `CARD_3_FINAL_UI_UX_IMPLEMENTATION_PLAN.md`. That document is treated as a **requirements/intent source**, not a pixel spec — the wireframes in it are approximate; the actual layout below is my own UI/UX judgment applied to those requirements, built and fitted into the existing MATRIX visual language (Orbitron/Share Tech Mono, the `--bg0…--bg4`/cyan/green/amber/red/purple token system already used across the app).

This went through **two implementation passes**. The first pass changed the underlying data (real QNX thread-status instrumentation) but largely kept the old visual structure — three status cards, a detached priority chart, a generic multi-tab event filter. That was correctly rejected as not actually matching the plan's information architecture, and — worse — a real rendered-browser check surfaced a genuine layout bug: the Selected Thread inspector's content was visually overlapping the Execution/Event Flow section beneath it. The second pass (this one) is a genuine structural rebuild, verified against real screenshots at every step, not just source review.

### 3.1 Real thread data instead of pure inference (kept from pass 1)

The plan explicitly allows (§20): *"Minimal QNX instrumentation may be added if necessary and technically safe... `THREAD_STATUS:RECV:WAITING` style messages... but do not modify the QNX controller merely for cosmetic purposes."*

- `send_thread_status(name, state)` in the QNX source — one `snprintf` + the existing thread-safe `safe_send()`. **No timing, scheduling, or control logic was touched.**
- Each of the three real threads reports its own state **only at genuine transition points**, never on a timer/poll: `RECV` → `WAITING`/`RECEIVING`; `MOTION` → `IDLE`/`CYCLING`/`EMERGENCY_HALT`; `SAFETY` → `MONITORING`/`EMERGENCY`.
- `bridge.py` parses `THREAD_STATUS:<THREAD>:<STATE>` and forwards it to the observability channel only (`:8766`) as a new `thread_status` envelope category — the browser control channel (`:8765`) never sees it.
- `com_dashboard` prefers real reports the instant they arrive, and falls back to inference (from other real, already-observable protocol events) only until a thread has reported for real this session. Every thread inspector shows an explicit **`● QNX-REPORTED (REAL)`** or **`◐ INFERRED FROM PROTOCOL EVENTS`** tag.

### 3.2 The actual structural rebuild (pass 2)

**Overview — the architecture *is* the card now, not a decoration on top of stat tiles.**
A single visual composition: a small "⚙ QNX RTOS CONTROLLER" label, a thin SVG connector fanning out to the three real thread cards (each now carrying its own scheduling/priority fact inline — `Normal scheduling` / `SCHED_FIFO · priority 10` / `SCHED_FIFO · priority 20` — so the old detached priority bar chart is gone entirely, its information folded into the architecture itself), converging back down through another connector into a real "QNX → TCP → BRIDGE · CONNECTED/DISCONNECTED" caption. Below that: a compact SAFETY chip and the last-event line — genuinely secondary, not three equal-weight tiles. **An active emergency replaces that secondary line outright** with a full-width red banner; it's the single most important fact this card can ever show and is never sized like a routine counter.

The old "huge unexplained empty space" had a concrete root cause, confirmed by comparing real screenshots before/after: `.cards-grid` used CSS Grid's default `align-items: stretch`, which force-stretched every card to match Card 1's height (tallest, due to its 3D robot canvas) even when Card 3's real content was much shorter. Changed to `align-items: start` — each card now takes only the height its own real content needs.

**Expanded — four honestly-separated regions, not "big panel + another panel + event list."**
1. **Thread Architecture** — the same three cards, selectable, each showing passive "story" emphasis (whichever thread is currently the interesting one — an active emergency, then active cycling, then active receiving, in that priority order) plus a distinct "selected" indicator (blue) so a manual click and passive emphasis are never visually confused with each other.
2. **Selected Thread | QNX → Bridge Output** — a two-column split. The left panel is now **facts only** (state/scheduler/priority/role/last-command — different fields per thread, never forcing identical fields where they aren't meaningful) — no diagram lives here anymore. The right panel is unchanged in content (Robot State / Motion Events / Safety Events / Thread Self-Reports, each with a real "last seen Xs ago" or an honest "Not observed this session").
3. **QNX Execution / Event Flow** — a new, full-width, dedicated region holding an actual diagram for whichever thread is selected: Motion gets a vertical stepper (`SEQUENCE READY → POSE EXECUTION → JOINT STATE/TELEMETRY → POSE_DONE → NEXT POSE → CYCLE_DONE`, current stage highlighted only from real state, plus a live joint-angle snapshot inline) with an honest empty state when idle; Safety gets a two-branch NORMAL/EMERGENCY diagram plus one factual sentence on why priority 20 always preempts priority 10; Recv gets a linear `PYTHON BRIDGE → TCP RECEIVE → RECV THREAD → COMMAND PARSING → CONTROLLER STATE` pipeline, honestly highlighting only "RECV THREAD" when actually receiving. **This entirely replaces the old generic `ALL/TELEMETRY/POSE/CYCLE/SAFETY/THREADS/SYSTEM` filter-tab bar**, which is exactly the "still feels like a telemetry/event viewer" complaint from the redesign brief.
4. **Recent QNX Events** — a plain, bounded, chronological list. No filter tabs. Rapid low-marginal-value repeats (specifically `pose_advance` bursts) coalesce into one `×N` row; safety/system/ack/thread-status events are never coalesced.

**The overlap/clipping bug itself — root cause and real fix.**
The previous pass's Selected-Thread panel used `display:flex;flex-direction:column;flex:1` nested inside a CSS Grid cell (`.c3-split-left`, itself `align-items:stretch`), with the stepper/branch diagram living inside that same panel. Real rendered screenshots showed the panel's own box stopping short while its text content visibly continued past it into the section below — a confirmed, real instance of nested `flex:1`-in-grid-item breaking Chromium's intrinsic content-height measurement for Grid's auto-row-sizing pass. The fix was architectural, not a CSS patch: the diagrams moved out into their own dedicated Region 3 (so Region 2's panels never need to grow that tall), and the remaining panels dropped the flex-column-stretch nesting entirely in favor of plain block flow, with the single outer `.c3-detail{overflow-y:auto}` container as the *only* scroll boundary for the whole expanded view — no nested scroll containers with their own bounded heights to fight over.

**A second real, screenshot-confirmed bug found and fixed during this pass:** at narrow (phone-width) viewports, `#panel-center` kept its normal `overflow:hidden` while the mobile breakpoint gave it a `min-height:70vh` floor — the same `overflow:hidden` that's correct in the desktop 3-pane row layout silently *clipped* Card 2 and Card 3 entirely in the narrow stacked layout instead of letting them scroll into view, verified by a real screenshot showing Card 1 followed immediately by the right-hand Packet Inspector panel, with Cards 2 and 3 invisible in between. Fixed by letting `#panel-center` take its natural content height in that breakpoint and relying solely on the outer `#content{overflow-y:auto}` for scrolling — one scroll container, not two fighting each other.

### 3.3 Layout/responsiveness verified this pass

Unlike the previous revision, this one was verified against **real rendered Chromium screenshots**, not just source review (see §4). Confirmed clean at 1600×950, 1366×800, 1024×768, 820×1180 (tablet portrait), and 430×932/390×844 (phone) — including scrolling the internal `.c3-detail` region and the outer mobile-stacked shell all the way to their real bottoms to confirm nothing is clipped, just below an initial viewport fold.

---

## 4. Testing performed

This revision specifically added **real headless-browser visual verification**, which the previous revision lacked (that gap was flagged as a limitation last time, and is why this pass caught the overlap bug the first pass missed by source-review alone).

1. **Real rendered screenshots** — `@sparticuz/chromium` (a portable, prebuilt Chromium binary distributed via npm) + `puppeteer-core` gave a genuine headless Chromium in this sandbox. Three.js and OrbitControls were fetched for real from npm (`three@0.128.0`, matching the CDN version the app already uses) and served locally, since the CDN itself is outside this sandbox's network allowlist. A scripted scenario fed the app real-shaped envelopes identical to what `bridge.py` actually emits (QNX/browser connect, real `THREAD_STATUS` reports for all three threads, an RTOS sequence dispatch, pose/cycle events, a real emergency and recovery) and screenshotted: the overview close-up, the full expanded view, each of the three thread selections, the emergency state (both overview banner and expanded branch diagram), and five responsive breakpoints — with the internal scroll regions explicitly scrolled to their real bottoms and re-screenshotted to distinguish "below the viewport fold" from "actually clipped by CSS." This is how the two real bugs described in §3.2 were found and confirmed fixed.
2. **Static correctness** — `node --check` on every JS file, `gcc -fsyntax-only` on the QNX C source (POSIX feature-test macros set to match what QNX exposes by default), `python3 -m py_compile` on `bridge.py`, CSS brace-balance and HTML tag-balance checks.
3. **Cross-reference audit** — every `getElementById`/`onclick` reference in JS checked against actual HTML ids and function definitions; zero misses.
4. **Functional simulation (jsdom)** — loads the real `index.html`/`app.js` as a browser would (real `<script>` execution, matching production scoping exactly), replays a realistic `bridge.py` event sequence including real `THREAD_STATUS` reports, a real emergency, and a burst of rapid `pose_advance` events, while clicking through all three expanded views via real DOM clicks. Confirmed from actual rendered DOM text: real thread reports correctly override inference and show the real/inferred tag, the emergency banner and branch diagram correctly reflect state, the stepper correctly highlights the active step, five rapid pose events correctly coalesce into one `×5` row, and passive "story" emphasis lands on exactly the right thread. Zero runtime errors.

---

## 5. Genuine remaining limitations

- The visual verification in this pass is real (headless Chromium, real screenshots), which is a meaningful upgrade over the previous revision — but it's still this sandbox's Chromium, not the exact browser/OS combination an end user will run. The CSS techniques used (Grid, Flexbox, `min-height:0` scroll chains) are standard and well-supported, so cross-browser risk is low, but a first real-device pass is still worth doing before shipping.
- `fault_layer.py`, `security_monitor.py`, `generate_token.py`, and the TLS certs referenced by `bridge.py` are not part of this archive — they were never provided as source.
- Real hardware-in-the-loop timing for `THREAD_STATUS` sends was reasoned about (single `safe_send()` at existing, already-synchronous transition points, same primitive already used for every other outbound message), not measured on real QNX hardware.
- The 860px shell-stacking breakpoint intentionally stacks rather than redesigns each rail for mobile — a fuller mobile-first pass across all three cards (per the earlier design-spec document from an earlier session) is still future work.

---

## 6. Credits / provenance

Built iteratively on top of the existing MATRIX Phase 2/3 codebase and the `CARD_3_FINAL_UI_UX_IMPLEMENTATION_PLAN.md` specification document, across two implementation passes — the second a genuine structural rebuild driven by real rendered-browser feedback, not a CSS patch over the first. All runtime values shown anywhere in Card 3 are real or clearly derived from real protocol events — nothing is fabricated, consistent with the plan's core, non-negotiable requirement.


WuQ8Ie9QfNGj_KCcEAtxSJTrZH32rp9evKfW0NkU6rE