# OSHAL Home — Samsung TV (Tizen) app

A **Tizen TV web app** that turns a Samsung Smart TV into an **OSHAL Jarvis + Smart Home** surface.

A Samsung TV app *is* a web app, so — unlike Roku — this mirrors the [Fire TV](../oshal-firetv/)
approach closely: it loads the already-built OSHAL web surfaces and adds remote navigation. Because
there's no native WebView wrapper and the Google OIDC login refuses to render inside an iframe, this
app is a thin **launcher shell** that navigates the **top window** to a surface:

- **Open Jarvis (primary)** → `/api/jarvis/tv` — the full Jarvis TV experience: animated assistant,
  live conversation, a **scan-to-talk QR** for the phone push-to-talk remote, and **spoken answers**
  (browser/native TTS). Talk from your phone; it shows and speaks on the TV.
- **Smart Home (secondary)** → `/api/home/ui?tv=1` — the device dashboard from the store-side Smart
  Home package; `?tv=1` turns on the dashboard's self-contained **D-pad spatial navigation**.

Both run top-level, so the OIDC login works as a normal page. It is a **surface** (ADR-047): it
stores only the host URL (localStorage); all reasoning and aggregation live on the OSHAL host.

## Files

| File | Role |
|---|---|
| `config.xml` | Tizen widget manifest (app id, tv profile, privileges, allow-navigation). |
| `index.html` | Launcher shell (host display + "Open Jarvis" / "Smart Home" / "Change host"). |
| `js/main.js` | Host read/save, TV Return-key handling, top-window redirect to the chosen surface. |
| `css/style.css` | Brand-styled launcher with a visible focus ring. |
| `icon.png` | **Placeholder** 117×117 app icon — replace with branded artwork before submission. |

## Remote mapping

- On the launcher: **D-pad** moves between buttons, **OK** selects, **RETURN** closes the host editor.
- On the dashboard (after opening): **D-pad** spatial-navigates the scene tiles / device toggles /
  schedule controls; **OK/Enter** activates the focused control (this is the `?tv=1` script).

## Configure the host + room

Defaults to `https://oshal.agenticfederal.us`. Pick **Settings** on the launcher to set the host
(e.g. `http://192.168.1.20:5000` for LAN/dev) and the **Room** name (default `Living Room`). Both
are stored in localStorage. The room lets the phone push-to-talk remote **target this TV**: Jarvis
opens as `/api/jarvis/tv?room=<room>`, and the phone's "send to" selector lists active rooms — so
with two TVs, only the one you pick shows and speaks the reply (no echo).

## Prerequisites to build / package

> Authored here but **not packaged on a Tizen toolchain in this repo** (same stance as the Fire TV
> APK). Build the `.wgt` on a machine with the tools below.

- **Tizen Studio** (with the **TV Extensions**) or the **Tizen CLI** (`tizen` on PATH).
- A **Samsung author certificate** + a **distributor certificate** (created in Tizen Studio's
  Certificate Manager — see the registration runbook). Sideloading to a real TV requires the TV's
  Developer Mode IP allow-listed and a distributor cert that includes that TV's DUID.

## Build + sideload

1. **Enable Developer Mode on the TV:** Apps → type `12345` on the remote → toggle Developer Mode
   ON → enter your dev PC's IP → restart the TV.
2. **Connect** the TV in Tizen Studio's **Device Manager** (or `sdb connect <tv-ip>`).
3. **Package** (CLI):
   ```bash
   cd packages/oshal-samsung-tv
   tizen build-web -- .
   tizen package -t wgt -s <your-cert-profile> -- .buildResult
   ```
   …or in Tizen Studio: import as a **TV Web Application**, then **Run As → Tizen Web Application**.
4. **Install + launch:** `tizen install -n OshalHome.wgt -t <device-id>` (Studio's *Run* does this
   for you). The launcher appears; press **Open Smart Home** and complete Google login on the TV.

## Publishing

See the registration + publishing runbook:
[`docs/tv-surfaces/roku-and-samsung-registration.md`](../../docs/tv-surfaces/roku-and-samsung-registration.md).

## Scope / non-goals

- Surface only — no inference, no tokens on the TV beyond the host URL, no device aggregation.
- The full dashboard (scenes, devices, schedules, assistant bar) is the OSHAL-served page; this app
  adds only the launcher + TV navigation. A native (non-web) Tizen build is unnecessary here.
