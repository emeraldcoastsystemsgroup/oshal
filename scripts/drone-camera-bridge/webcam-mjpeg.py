#!/usr/bin/env python3
"""
Camera -> MJPEG bridge for OSHAL's drone Live-camera card.

Captures a video SOURCE with OpenCV and re-serves it as an HTTP MJPEG stream
(multipart/x-mixed-replace) that the drone Live-camera card renders directly in
an <img>. One capture thread feeds many stream clients.

The SOURCE is either:
  - a local camera INDEX  (e.g. 0 = the default webcam; a GoPro in USB "webcam
    mode" appears as another index), or
  - a URL that OpenCV can open (rtsp://..., http://.../mjpeg, udp://@:8554 for a
    GoPro Wi-Fi preview, etc.) — this bridge re-wraps it as browser-friendly MJPEG.

Usage:
  python webcam-mjpeg.py <source> <port> [label]
    <source>  camera index (int) or a capture URL      (default 0)
    <port>    HTTP port to serve MJPEG on              (default 8090)
    [label]   text burned into the frame corner        (default "OSHAL camera")

Then point a drone node at it:
  DRONE_VIDEO_URL=http://127.0.0.1:<port>/video ... npm run drone:node
and its Live-camera card shows the real feed. See camera-bridge.sh for the
one-command version that starts both.
"""
import cv2
import threading
import time
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else "0"
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8090
LABEL = sys.argv[3] if len(sys.argv) > 3 else "OSHAL camera"
SOURCE = int(SRC) if SRC.isdigit() else SRC

from flask import Flask, Response

app = Flask(__name__)
_lock = threading.Lock()
_frame = None


def _open():
    # CAP_DSHOW is the reliable backend for local webcams on Windows; URL sources
    # use OpenCV's default (ffmpeg) backend.
    if isinstance(SOURCE, int):
        cap = cv2.VideoCapture(SOURCE, cv2.CAP_DSHOW)
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
    else:
        cap = cv2.VideoCapture(SOURCE)
    return cap


def capture_loop():
    global _frame
    cap = _open()
    for _ in range(5):  # warm up — the first frames after open are often junk
        cap.read()
        time.sleep(0.05)
    while True:
        ok, f = cap.read()
        if not ok or f is None:
            time.sleep(0.2)
            # A URL source can drop; try to reopen rather than die.
            if not isinstance(SOURCE, int):
                cap.release()
                cap = _open()
            continue
        stamp = LABEL + "  " + time.strftime("%Y-%m-%d %H:%M:%S")
        cv2.putText(f, stamp, (10, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 120), 2)
        ok2, jpg = cv2.imencode(".jpg", f, [cv2.IMWRITE_JPEG_QUALITY, 75])
        if ok2:
            with _lock:
                _frame = jpg.tobytes()


def gen():
    while True:
        with _lock:
            fr = _frame
        if fr is not None:
            yield (b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                   + str(len(fr)).encode() + b"\r\n\r\n" + fr + b"\r\n")
        time.sleep(1 / 15)  # ~15 fps is plenty for a monitoring card


@app.route("/")
def index():
    return ('<html><body style="margin:0;background:#000">'
            '<img src="/video" style="width:100%"></body></html>')


@app.route("/video")
def video():
    return Response(gen(), mimetype="multipart/x-mixed-replace; boundary=frame")


if __name__ == "__main__":
    threading.Thread(target=capture_loop, daemon=True).start()
    time.sleep(1.5)
    print(f"MJPEG bridge on http://0.0.0.0:{PORT}/video  (source={SOURCE})", flush=True)
    app.run(host="0.0.0.0", port=PORT, threaded=True)
