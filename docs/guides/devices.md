# Get oshal on your devices — user guide (as-built)

**Where:** the **Get oshal** entry in the bottom section of the cockpit ribbon on a plain
**`/cockpit/`**; the same card under *Your workspace* in a focused app's **Settings** hub; the
**Get oshal on your devices** link under Settings → Global; or the direct URL
`/cockpit/tools/devices.html`. Anyone signed in sees it.

The page is three tiles: **Desktop**, **Phone**, **TV**. The line under the title names the swarm
you are signed in to, and every link and QR on the page points back at that same address. Nothing
here needs an operator.

## Desktop — a Windows PC as a worker node

A worker node is a computer that does work *for* you: the swarm can run a browser on it (the
job-application flow uses this), execute shell tasks, and capture or drive the screen. Work is
dispatched only to the person the computer is bound to, and the node reaches out to the swarm; no
inbound port is opened on the PC.

**Steps**

1. Type a name for the computer (it is how the computer is labelled on this page and in pickers
   such as the Job Board's *On …* menu) and click **Download installer**.
2. A notice says what the file contains before it is created: a credential for that one computer,
   tied to your account. Accept it and `install-oshal-node.cmd` lands in your Downloads folder.
3. Copy the file to the PC if you downloaded it elsewhere, and double-click it. Windows may ask
   whether to run a file from the internet; choose **Run**.
4. Node.js 20 or newer must already be installed on that PC (the LTS build from nodejs.org). The
   installer stops with a clear message if it is missing.
5. The installer pulls the node app from npm (a few minutes; it downloads Electron), binds it to
   your account, and starts it hidden. **Your computers** on the page lists it within about a
   minute, with its status and last heartbeat. The list refreshes on its own.
6. Delete the `.cmd` file afterwards.

**If the download is refused**, the page shows the server's reason. The two you may see: you opened
the cockpit over `localhost`, so the installer would point the new PC at itself (open the cockpit
from the swarm's LAN address or public hostname and try again); or the swarm still accepts its
swarm-wide shared secret for nodes, so a per-device file is not enough on its own (an operator
sets `REMOTE_CLIENT_REQUIRE_NODE_TOKEN=true`).

**Revoking a computer.** The credential in the file is a per-device token in your own token list.
Revoking it disables that one computer and nothing else:

```bash
curl -fsS -b "$OSHAL_COOKIE_JAR" https://<swarm>/api/cli-tokens            # find the "node node-…" entry
curl -fsS -b "$OSHAL_COOKIE_JAR" -X DELETE https://<swarm>/api/cli-tokens/<id>
```

**macOS and Linux.** The tile is honest about this: the one-click installer is Windows-only today.
The same node app (`@oshal/chat` on npm) runs on those platforms, but that path has not been proven
end to end on a Mac or Linux box, so it is not offered as a button.

## Phone — the cockpit as an app

The cockpit is an installable web app. The tile shows a QR code that opens `/cockpit/` on this
swarm; the address is printed under it in case the camera cannot read the screen.

1. Scan the code with the phone's camera and sign in.
2. **iPhone:** in Safari, tap **Share**, then **Add to Home Screen**.
3. **Android:** in Chrome, open the three-dot menu, then **Install app** (older builds say **Add to
   Home screen**).

The icon on the home screen opens the cockpit full-screen, with every app and platform tool you have
here. Signing in on the phone is the same sign-in as on the desktop.

**Your phone as a microphone.** The **Jarvis remote** link on the tile opens a push-to-talk page on
the phone. It is the input half of the TV surface below: the TV shows and speaks, the phone listens.

## TV — OSHAL Home on Fire TV, Roku, or Samsung

OSHAL Home is a big-screen Jarvis: it shows the conversation, reads answers aloud, and lists your
tasks and live bots. A TV cannot hear you (the remote's microphone is reserved for the platform's
own assistant), so the phone remote above is the microphone.

**The TV apps are not in any app store yet.** Each installs in the TV's developer mode from a build
of the app's package in this repository. The steps per platform:

- **Fire TV** (`packages/oshal-firetv`, a native Android app): on the Firestick enable *Developer
  options → ADB debugging*, build the APK with Gradle, then `adb connect <tv-ip>:5555` and
  `adb install -r` the APK. The swarm address it talks to is set on the app's MENU settings screen.
- **Roku** (`packages/oshal-roku`): enable developer mode with the remote key sequence, zip the
  channel folder contents, and upload the zip through the Roku's *Development Application
  Installer* page in a browser.
- **Samsung** (`packages/oshal-samsung-tv`, Tizen): enable Developer Mode on the TV, connect it in
  Tizen Studio's Device Manager, package the `.wgt`, and install it with the `tizen` CLI or
  Studio's *Run*.

Each package's `README.md` has the full command sequence, and
`docs/tv-surfaces/roku-and-samsung-registration.md` covers store registration for when the apps
are published.

**Signing a TV in.** The app shows a short code on the TV (and a QR). Click **Approve a TV code** on
the tile, or open `/tv` on any signed-in device, type the code, and approve it. The TV receives a
signed token tied to your account and stays signed in. To sign every TV out of your account, call
`POST /api/tv/pair/revoke` while signed in.
