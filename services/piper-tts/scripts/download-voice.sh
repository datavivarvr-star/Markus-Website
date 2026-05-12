#!/usr/bin/env bash
set -euo pipefail

VOICE="${1:-en_US-ryan-medium}"
DEST_DIR="${2:-$(cd "$(dirname "$0")/.." && pwd)/voices}"

# Path on the HuggingFace mirror is en/<lang>/<speaker>/<quality>/
case "$VOICE" in
  en_US-ryan-medium)    REL_PATH="en/en_US/ryan/medium" ;;
  en_US-amy-medium)     REL_PATH="en/en_US/amy/medium" ;;
  en_US-lessac-medium)  REL_PATH="en/en_US/lessac/medium" ;;
  en_GB-alan-medium)    REL_PATH="en/en_GB/alan/medium" ;;
  *)
    echo "Unknown voice: $VOICE" >&2
    echo "Edit scripts/download-voice.sh to add it, or download manually from:" >&2
    echo "  https://huggingface.co/rhasspy/piper-voices" >&2
    exit 1
    ;;
esac

BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/${REL_PATH}"

mkdir -p "$DEST_DIR"
echo "Downloading $VOICE to $DEST_DIR ..."
curl -L --fail -o "$DEST_DIR/${VOICE}.onnx"      "$BASE/${VOICE}.onnx"
curl -L --fail -o "$DEST_DIR/${VOICE}.onnx.json" "$BASE/${VOICE}.onnx.json"

echo "Done."
ls -lh "$DEST_DIR/${VOICE}.onnx" "$DEST_DIR/${VOICE}.onnx.json"
