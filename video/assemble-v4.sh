#!/usr/bin/env bash
# Cipher Pol — Demo Video v4
# 10 segments, 1:1 audio clip mapping. Audio drives every duration.
# No sub-splits, no ratio math. Terminal footage for proof, website for brand.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUDIO="$SCRIPT_DIR/audio"
SITE="$SCRIPT_DIR/site-screenshots"
OUT="$SCRIPT_DIR/cipher-pol-demo-v11.mp4"
SRT="$SCRIPT_DIR/captions/cipher-pol-demo-v2.srt"
TITLE_HTML="$SCRIPT_DIR/title-card.html"
PROBLEM_HTML="$SCRIPT_DIR/problem-card.html"
CLOSING_HTML="$SCRIPT_DIR/closing-card.html"
DEMO_RAW="$SCRIPT_DIR/demo-raw.mp4"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

TMP="$SCRIPT_DIR/tmp-v11"
mkdir -p "$TMP"

for f in "$AUDIO"/0{1..9}-*.mp3; do
  [[ -f "$f" ]] || { echo "Missing audio: $f"; exit 1; }
done
[[ -f "$DEMO_RAW" ]] || { echo "Missing demo-raw.mp4"; exit 1; }
[[ -f "$SRT" ]] || { echo "Missing $SRT"; exit 1; }

dur() { ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$1"; }

# Ken Burns on a PNG. Scale to 8000px wide so zoompan has room to move.
# y_frac: 0.0=top, 0.5=center, 1.0=bottom focus (clamped to valid range)
# spd: zoom speed per frame at 30fps
kb_seg() {
  local in="$1" out="$2" dur="$3" yfrac="${4:-0.45}" spd="${5:-0.0002}"
  ffmpeg -y -loglevel error \
    -loop 1 -i "$in" \
    -vf "scale=8000:-1,zoompan=z='min(zoom+${spd},1.04)':x='iw/2-(iw/zoom/2)':y='min(max(0,ih*${yfrac}-ih/zoom/2),ih-ih/zoom)':d=1:s=1920x1080:fps=30" \
    -c:v libx264 -t "$dur" -pix_fmt yuv420p "$out"
}

# Slow-motion live terminal: extract t_start→t_end, stretch to target_dur.
# Uses 2x zoom (crop top half where all VHS text lives) + slowdown via PTS.
live_terminal() {
  local in="$1" t_start="$2" t_end="$3" target_dur="$4" out="$5"
  local clip_dur stretch
  clip_dur=$(echo "scale=6; $t_end - $t_start" | bc)
  stretch=$(echo "scale=6; $target_dur / $clip_dur" | bc)
  ffmpeg -y -loglevel error \
    -ss "$t_start" -i "$in" \
    -vf "trim=0:${clip_dur},setpts=${stretch}*PTS,crop=1920:540:0:0,scale=1920:1080:flags=lanczos,fps=30" \
    -an -c:v libx264 -pix_fmt yuv420p -t "$target_dur" "$out"
}

# Freeze terminal: extract one frame with 2x zoom, then gentle Ken Burns.
# y_frac targets the vertical region of interest within the 2x-zoomed image.
freeze_terminal() {
  local in="$1" t="$2" out="$3" dur="$4" yfrac="${5:-0.5}" crop_y="${6:-0}"
  local png="$TMP/freeze_$(basename "$out" .mp4).png"
  ffmpeg -y -loglevel error -ss "$t" -i "$in" -vframes 1 \
    -vf "crop=1920:540:0:${crop_y},scale=1920:1080:flags=lanczos" "$png"
  kb_seg "$png" "$out" "$dur" "$yfrac" 0.0001
}

# ── Audio durations (from actual files) ──────────────────────────────────────
D01=$(dur "$AUDIO/01-problem.mp3")   # ~20.3s
D02=$(dur "$AUDIO/02-solution.mp3")  # ~11.5s
D03=$(dur "$AUDIO/03-deposit.mp3")   # ~17.8s
D04=$(dur "$AUDIO/04-proof.mp3")     # ~11.7s
D05=$(dur "$AUDIO/05-payment.mp3")   # ~18.1s
D06=$(dur "$AUDIO/06-withdrawal.mp3") # ~12.9s
D07=$(dur "$AUDIO/07-bounties.mp3")  # ~14.4s
D08=$(dur "$AUDIO/08-implication.mp3") # ~8.2s
D09=$(dur "$AUDIO/09-close.mp3")     # ~5.3s
TITLE_DUR=3   # 3s silent title (SRT subtitles start at t=3s, must match)
CLOSE_HOLD=2  # 2s silence after final line

echo "────────────────────────────────────────────────────────────"
echo "Cipher Pol Demo v11 — 10 segments, audio-driven"
echo "────────────────────────────────────────────────────────────"
echo ""

# ── Phase 1: Render HTML cards ─────────────────────────────────────────────
echo "[1/6] Rendering HTML cards..."
"$CHROME" --headless=new --disable-gpu \
  --screenshot="$TMP/title.png" --window-size=1920,1080 \
  --default-background-color=05050800 "file://$TITLE_HTML" 2>/dev/null
echo "  ✓ title"

"$CHROME" --headless=new --disable-gpu \
  --screenshot="$TMP/problem.png" --window-size=1920,1080 \
  --default-background-color=05050800 "file://$PROBLEM_HTML" 2>/dev/null
echo "  ✓ problem card"

"$CHROME" --headless=new --disable-gpu \
  --screenshot="$TMP/closing.png" --window-size=1920,1080 \
  --default-background-color=05050800 "file://$CLOSING_HTML" 2>/dev/null
echo "  ✓ closing card"

# ── Phase 2: Build 10 segments ─────────────────────────────────────────────
echo ""
echo "[2/6] Building 10 segments..."

# ── A: Title (3s silent) ─────────────────────────────────────────────────────
ffmpeg -y -loglevel error -loop 1 -i "$TMP/title.png" \
  -c:v libx264 -t "$TITLE_DUR" -vf "scale=1920:1080,fps=30" \
  -pix_fmt yuv420p "$TMP/seg_A.mp4"
echo "  ✓ A: title (${TITLE_DUR}s silent)"

# ── 01: Problem (~20s) — problem-card.html ───────────────────────────────────
# Slow Ken Burns toward the EXPOSED transaction badges (upper-center area).
kb_seg "$TMP/problem.png" "$TMP/seg_01.mp4" "$D01" 0.4 0.00015
echo "  ✓ 01: problem card (${D01}s) — slow KB toward EXPOSED badges"

# ── 02: Solution (~12s) — hero.png ───────────────────────────────────────────
# "Cryptographic guarantee. Not a promise." First sight of the product.
kb_seg "$SITE/hero.png" "$TMP/seg_02.mp4" "$D02" 0.45 0.0003
echo "  ✓ 02: hero (${D02}s) — KB zoom in on tagline"

# ── 03: Deposit (~18s) — demo-raw t=3.5→8.5s, 3.6x slowdown ─────────────────
# "deposits into a pool on Starknet" — terminal shows it happening live.
# t=3.5-8.5s: "Depositing..." → commitment → tx sleeps → "✓ Deposit confirmed" → Merkle root
live_terminal "$DEMO_RAW" 3.5 8.5 "$D03" "$TMP/seg_03.mp4"
echo "  ✓ 03: terminal deposit live t=3.5→8.5s → ${D03}s ($(echo "scale=1; $D03/5" | bc)x stretch)"

# ── 04: Proof (~12s) — freeze at t=10s, KB ───────────────────────────────────
# "builds a ZK proof locally... takes about 3 seconds"
# Frame shows: "Generating zero-knowledge proof... ✓ Proof generated (3.6s)"
# Text is in lower portion of the 2x-zoomed top-half → y_frac=0.75
freeze_terminal "$DEMO_RAW" 10 "$TMP/seg_04.mp4" "$D04" 0.75
echo "  ✓ 04: proof freeze t=10s KB (${D04}s) — proof generation text in focus"

# ── 05: Payment (~18s) — demo-raw t=10→14s, 4.5x slowdown ───────────────────
# "server sends 402... returns 200... doesn't know who paid"
# t=10-14s: proof text showing → 402 appears → "Attaching ZK proof" → 200 OK → "Server gets paid"
live_terminal "$DEMO_RAW" 10 14 "$D05" "$TMP/seg_05.mp4"
echo "  ✓ 05: terminal payment live t=10→14s → ${D05}s ($(echo "scale=1; $D05/4" | bc)x stretch)"

# ── 06: Withdrawal (~13s) — freeze at t=21s, KB ──────────────────────────────
# "withdrawal queue... same note cannot be spent twice"
# Frame shows: withdrawal queue + nullifier + "Same note cannot be spent twice." (in bottom half)
# crop_y=540 captures bottom 540px where withdrawal queue text lives
freeze_terminal "$DEMO_RAW" 21 "$TMP/seg_06.mp4" "$D06" 0.15 540
echo "  ✓ 06: withdrawal freeze t=21s bottom-half KB (${D06}s) — withdrawal queue + nullifier"

# ── 07: Integrations (~14s) — specs.png ──────────────────────────────────────
# "Starknet, Lit Protocol, x402" — protocol table shows Starknet + x402 explicitly.
kb_seg "$SITE/specs.png" "$TMP/seg_07.mp4" "$D07" 0.35 0.0002
echo "  ✓ 07: specs table (${D07}s)"

# ── 08: Implication (~8s) — how-zk-steps.png ─────────────────────────────────
# "service sees proof, not address" — diagram shows STEP 03 "depositor: HIDDEN"
# and STEP 04 "link to deposit: SEVERED". Gentle KB on full diagram.
kb_seg "$SITE/how-zk-steps.png" "$TMP/seg_08.mp4" "$D08" 0.35 0.0003
echo "  ✓ 08: how-zk-steps KB (${D08}s) — HIDDEN/SEVERED labels visible"

# ── 09: Close (~5s + 2s hold) — closing-card.html, static ───────────────────
# "That's Cipher Pol." — no motion. Let it land.
SEG09=$(echo "$D09 + $CLOSE_HOLD" | bc)
ffmpeg -y -loglevel error -loop 1 -i "$TMP/closing.png" \
  -c:v libx264 -t "$SEG09" -vf "scale=1920:1080,fps=30" \
  -pix_fmt yuv420p "$TMP/seg_09.mp4"
echo "  ✓ 09: closing card static (${SEG09}s)"

# ── Phase 3: Concatenate video ─────────────────────────────────────────────
echo ""
echo "[3/6] Concatenating video..."
cat > "$TMP/concat.txt" << EOF
file '${TMP}/seg_A.mp4'
file '${TMP}/seg_01.mp4'
file '${TMP}/seg_02.mp4'
file '${TMP}/seg_03.mp4'
file '${TMP}/seg_04.mp4'
file '${TMP}/seg_05.mp4'
file '${TMP}/seg_06.mp4'
file '${TMP}/seg_07.mp4'
file '${TMP}/seg_08.mp4'
file '${TMP}/seg_09.mp4'
EOF
ffmpeg -y -loglevel error -f concat -safe 0 -i "$TMP/concat.txt" -c copy "$TMP/video_silent.mp4"
echo "  ✓ concatenated ($(dur "$TMP/video_silent.mp4" | xargs printf "%.1f")s)"

# ── Phase 4: Concatenate audio ─────────────────────────────────────────────
echo "[4/6] Concatenating audio..."
cat > "$TMP/audio_concat.txt" << EOF
file '${AUDIO}/01-problem.mp3'
file '${AUDIO}/02-solution.mp3'
file '${AUDIO}/03-deposit.mp3'
file '${AUDIO}/04-proof.mp3'
file '${AUDIO}/05-payment.mp3'
file '${AUDIO}/06-withdrawal.mp3'
file '${AUDIO}/07-bounties.mp3'
file '${AUDIO}/08-implication.mp3'
file '${AUDIO}/09-close.mp3'
EOF
ffmpeg -y -loglevel error -f concat -safe 0 -i "$TMP/audio_concat.txt" -c copy "$TMP/voiceover.mp3"
echo "  ✓ voiceover concatenated ($(dur "$TMP/voiceover.mp3" | xargs printf "%.1f")s)"

# ── Phase 5: Mux — pad audio by TITLE_DUR seconds of silence ───────────────
echo ""
echo "[5/6] Muxing audio (${TITLE_DUR}s silent title pad + voiceover)..."
ffmpeg -y -loglevel error \
  -f lavfi -t "$TITLE_DUR" -i "aevalsrc=0:c=stereo:s=44100" \
  -i "$TMP/voiceover.mp3" \
  -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1[a]" \
  -map "[a]" "$TMP/voiceover_padded.mp3"

ffmpeg -y -loglevel error \
  -i "$TMP/video_silent.mp4" \
  -i "$TMP/voiceover_padded.mp3" \
  -c:v copy -c:a aac -b:a 192k \
  "$TMP/video_with_audio.mp4"
echo "  ✓ muxed"

# ── Phase 6: Burn subtitles ────────────────────────────────────────────────
echo ""
echo "[6/6] Burning subtitles..."
python3 "$SCRIPT_DIR/burn-subs.py" "$TMP/video_with_audio.mp4" "$SRT" "$OUT"

echo ""
echo "────────────────────────────────────────────────────────────"
echo "Done: $OUT"
du -sh "$OUT" | cut -f1 | xargs echo "Size:"
dur "$OUT" | xargs printf "Duration: %.1fs\n"
echo "────────────────────────────────────────────────────────────"
