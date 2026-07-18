#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: transcribe-audio [options] AUDIO_FILE [OUTPUT.txt]

Convert an audio file to a plain-text transcript with ffmpeg and whisper.cpp.
The output defaults to AUDIO_FILE with its extension replaced by .txt.

Options:
  --model PATH       whisper.cpp GGML model (or set WHISPER_MODEL)
  --language CODE    Spoken language (default: en)
  --prompt TEXT      Names or vocabulary to help transcription
  --srt              Also write a timestamped .srt transcript
  -h, --help         Show this help

Dependencies (macOS): brew install ffmpeg whisper-cpp
Default model location: ~/Library/Caches/whisper.cpp/ggml-large-v3-turbo-q5_0.bin
EOF
}

model="${WHISPER_MODEL:-}"
language="en"
prompt=""
write_srt=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)
      [[ $# -ge 2 ]] || { echo "error: --model requires a path" >&2; exit 2; }
      model="$2"
      shift 2
      ;;
    --language)
      [[ $# -ge 2 ]] || { echo "error: --language requires a code" >&2; exit 2; }
      language="$2"
      shift 2
      ;;
    --prompt)
      [[ $# -ge 2 ]] || { echo "error: --prompt requires text" >&2; exit 2; }
      prompt="$2"
      shift 2
      ;;
    --srt)
      write_srt=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "error: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      break
      ;;
  esac
done

[[ $# -ge 1 && $# -le 2 ]] || { usage >&2; exit 2; }
input="$1"
output="${2:-${input%.*}.txt}"
[[ "$output" == *.txt ]] || output="${output}.txt"
output_base="${output%.txt}"

[[ -f "$input" ]] || { echo "error: audio file not found: $input" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "error: ffmpeg is required" >&2; exit 1; }
command -v whisper-cli >/dev/null || { echo "error: whisper-cli is required (brew install whisper-cpp)" >&2; exit 1; }

if [[ -z "$model" ]]; then
  candidates=(
    "$HOME/Library/Caches/whisper.cpp/ggml-large-v3-turbo-q5_0.bin"
    "$HOME/.cache/whisper.cpp/ggml-large-v3-turbo-q5_0.bin"
    "$HOME/Library/Caches/whisper.cpp/ggml-large-v3-turbo.bin"
    "$HOME/.cache/whisper.cpp/ggml-large-v3-turbo.bin"
  )
  for candidate in "${candidates[@]}"; do
    if [[ -f "$candidate" ]]; then
      model="$candidate"
      break
    fi
  done
fi

if [[ -z "$model" || ! -f "$model" ]]; then
  cat >&2 <<'EOF'
error: no whisper.cpp model found.
Download a GGML model from https://huggingface.co/ggerganov/whisper.cpp/tree/main
and pass it with --model PATH or set WHISPER_MODEL.
EOF
  exit 1
fi

mkdir -p "$(dirname "$output")"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/transcribe-audio.XXXXXX")"
child_pid=""
cleanup() {
  if [[ -n "$child_pid" ]]; then
    kill -TERM "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp_dir"
}
trap 'exit 130' INT
trap 'exit 143' TERM
trap cleanup EXIT

run_child() {
  "$@" &
  child_pid=$!
  local status
  if wait "$child_pid"; then status=0; else status=$?; fi
  child_pid=""
  return "$status"
}

wav="$tmp_dir/audio.wav"
result_base="$tmp_dir/transcript"

echo "Preparing audio..." >&2
run_child ffmpeg -hide_banner -loglevel error -y -i "$input" -vn -ac 1 -ar 16000 -c:a pcm_s16le "$wav"

args=(-m "$model" -f "$wav" -l "$language" -t "${WHISPER_THREADS:-8}" -otxt -of "$result_base")
$write_srt && args+=(-osrt)
[[ -n "$prompt" ]] && args+=(--prompt "$prompt")

echo "Transcribing with $(basename "$model")..." >&2
run_child whisper-cli "${args[@]}"
mv "$result_base.txt" "$output"
if $write_srt; then
  mv "$result_base.srt" "$output_base.srt"
fi

echo "Transcript: $output" >&2
$write_srt && echo "Subtitles:  $output_base.srt" >&2
