"""
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                                      | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | Added an opt-in real-audio service smoke test.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import urllib.request
from pathlib import Path


def arguments() -> argparse.Namespace:
    """Parse explicit service, credential, and local-audio inputs."""
    parser = argparse.ArgumentParser(description="Smoke the local OSHAL diarization service")
    parser.add_argument("--url", required=True, help="Service base URL")
    parser.add_argument("--key", required=True, help="X-Speaker-Service-Key value")
    parser.add_argument("--audio", required=True, type=Path, help="Local file containing real speech")
    return parser.parse_args()


def post_audio(url: str, key: str, audio_path: Path) -> dict:
    """Post one raw audio body and return the decoded response."""
    if not audio_path.is_file():
        raise RuntimeError(f"Audio file does not exist: {audio_path}")
    content_type = mimetypes.guess_type(audio_path.name)[0] or "application/octet-stream"
    request = urllib.request.Request(
        f"{url.rstrip('/')}/v1/diarize",
        data=audio_path.read_bytes(),
        method="POST",
        headers={"Content-Type": content_type, "X-Speaker-Service-Key": key},
    )
    with urllib.request.urlopen(request, timeout=180) as response:
        return json.load(response)


def validate(payload: dict) -> None:
    """Fail unless real inference produced usable turns and embeddings."""
    turns = payload.get("turns") or []
    speakers = payload.get("speakers") or []
    if not turns:
        raise RuntimeError("Smoke failed: no speaker turns returned")
    if not speakers:
        raise RuntimeError("Smoke failed: no speakers returned")
    if any(not speaker.get("embedding") for speaker in speakers):
        raise RuntimeError("Smoke failed: at least one speaker embedding is empty")


def main() -> None:
    """Run the actual HTTP/model smoke and print only response metadata."""
    args = arguments()
    payload = post_audio(args.url, args.key, args.audio)
    validate(payload)
    print(json.dumps({
        "ok": True,
        "modelId": payload.get("modelId"),
        "durationSeconds": payload.get("durationSeconds"),
        "turns": len(payload["turns"]),
        "speakers": len(payload["speakers"]),
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()
