#!/usr/bin/env bash
# Optional desktop batch alternative. Requires a system FFmpeg with adeclick,
# afftdn, acompressor, loudnorm and the AAC encoder.
set -euo pipefail
if [[ $# -lt 2 ]]; then echo 'Usage: bash scripts/clean_ffmpeg.sh input.m4a output.m4a [gentle|balanced|strong]' >&2;exit 2;fi
input=$1;output=$2;preset=${3:-balanced}
case "$preset" in
  gentle) noise=8;;balanced) noise=12;;strong) noise=18;;
  *) echo "Unknown preset: $preset" >&2;exit 2;;
esac
ffmpeg -hide_banner -y -i "$input" -vn -ac 1 \
  -af "highpass=f=85,lowpass=f=9000,adeclick,afftdn=nr=${noise}:nf=-30,acompressor=threshold=0.09:ratio=2.8:attack=12:release=180:makeup=1.6,loudnorm=I=-18:TP=-1.5:LRA=11" \
  -ar 32000 -c:a aac -b:a 96k "$output"
echo "Wrote: $output"
