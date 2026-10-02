#!/usr/bin/env bash
# Ingest one uploaded video into the showcase.
#   ./scripts/ingest.sh <raw-file> <slug> "Display Title" ["caption"]
# Produces: public/videos/<slug>.mp4, public/posters/<slug>.jpg, appends to videos.json
set -euo pipefail

export PATH="/home/mm/.hermes/tools/ffmpeg-9.0.1-linux-x64/bin:$PATH"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SRC="${1:?source video required}"
SLUG="${2:?slug required}"
TITLE="${3:-$SLUG}"
CAPTION="${4:-}"

mkdir -p "$ROOT/public/videos" "$ROOT/public/posters"

# Web encode: 720p max, H.264 high, AAC 128k, faststart for progressive playback.
ffmpeg -v error -y -i "$SRC" \
  -vf "scale='min(1280,iw)':-2:flags=lanczos" \
  -c:v libx264 -profile:v high -preset slow -crf 25 \
  -pix_fmt yuv420p -movflags +faststart \
  -c:a aac -b:a 128k -ac 2 \
  "$ROOT/public/videos/$SLUG.mp4"

# Poster: frame at ~1.5s (past any black lead-in), 1280 wide.
ffmpeg -v error -y -ss 1.5 -i "$SRC" -frames:v 1 \
  -vf "scale='min(1280,iw)':-2" -q:v 4 \
  "$ROOT/public/posters/$SLUG.jpg"

DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$SRC" | cut -d. -f1)
INSIZE=$(du -h "$SRC" | cut -f1)
OUTSIZE=$(du -h "$ROOT/public/videos/$SLUG.mp4" | cut -f1)

python3 - "$ROOT/public/videos.json" "$SLUG" "$TITLE" "$CAPTION" "$DUR" <<'PY'
import json, sys, pathlib
path, slug, title, caption, dur = sys.argv[1:6]
p = pathlib.Path(path)
data = json.loads(p.read_text()) if p.exists() and p.stat().st_size else {"videos": []}
data["videos"] = [v for v in data["videos"] if v["slug"] != slug]
data["videos"].append({
    "slug": slug, "title": title, "caption": caption,
    "src": f"videos/{slug}.mp4", "poster": f"posters/{slug}.jpg",
    "duration": int(dur),
})
p.write_text(json.dumps(data, indent=2) + "\n")
print(f"manifest: {len(data['videos'])} video(s)")
PY

echo "OK  $SLUG  ${DUR}s  in=${INSIZE} -> out=${OUTSIZE}"
