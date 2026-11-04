#!/usr/bin/env bash
# Converts the raw Playwright recordings (videos.mjs) into the manual's MP4s and the README GIF.
#
#   docs/manual/scripts/encode.sh                 # reads $RAW_DIR (default <tmp>/qatlas-manual-raw)
#
# MP4: H.264, CRF 28, faststart, no audio, the blank first frames trimmed.
# GIF: walkthrough (a) only, 960 px wide, 10 fps, played at 1.5x so it stays small.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/../video"
RAW_DIR="${RAW_DIR:-${TMPDIR:-/tmp}/qatlas-manual-raw}"
mkdir -p "$OUT"

for name in end-to-end create-and-run-test-case fix-a-failing-test manual-execution; do
  src="$RAW_DIR/$name.webm"
  [[ -f $src ]] || { echo "skip $name (no $src)"; continue; }
  ffmpeg -v error -y -ss 0.5 -i "$src" \
    -c:v libx264 -preset slow -crf 28 -pix_fmt yuv420p -movflags +faststart -an \
    "$OUT/$name.mp4"
  echo "$OUT/$name.mp4 $(du -h "$OUT/$name.mp4" | cut -f1)"
done

# Poster for the README: a frame of the end-to-end walkthrough with a "play" caption.
src="$RAW_DIR/end-to-end.webm"
if [[ -f $src ]]; then
  font="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
  ffmpeg -v error -y -ss 52 -i "$src" -frames:v 1 -vf "scale=1280:-1,\
drawbox=x=0:y=ih-110:w=iw:h=110:color=black@0.72:t=fill,\
drawtext=fontfile=$font:text='▶  Watch the end-to-end demo (1 min 40 s)':fontcolor=white:fontsize=40:x=(w-text_w)/2:y=h-78" \
    "$OUT/end-to-end-poster.png"
  echo "$OUT/end-to-end-poster.png $(du -h "$OUT/end-to-end-poster.png" | cut -f1)"
fi

src="$RAW_DIR/create-and-run-test-case.webm"
if [[ -f $src ]]; then
  palette="$(mktemp --suffix=.png)"
  filters="setpts=PTS/1.5,fps=10,scale=960:-1:flags=lanczos"
  ffmpeg -v error -y -ss 0.5 -i "$src" -vf "$filters,palettegen=max_colors=96:stats_mode=diff" "$palette"
  ffmpeg -v error -y -ss 0.5 -i "$src" -i "$palette" \
    -lavfi "$filters [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
    "$OUT/create-and-run-test-case.gif"
  rm -f "$palette"
  echo "$OUT/create-and-run-test-case.gif $(du -h "$OUT/create-and-run-test-case.gif" | cut -f1)"
fi
