#!/usr/bin/env bash
# Télécharge / compile les binaires embarqués du module vidéo dans resources/bin :
#   yt-dlp       (binaire autonome Linux)
#   ffmpeg       (build statique johnvansickle, seulement le binaire ffmpeg)
#   whisper-cli  (whisper.cpp lié ENTIÈREMENT en statique (-static : glibc + libstdc++ incluses), sans
#                 instructions CPU natives → tourne sur n'importe quel Linux x86_64, quelle que soit sa glibc)
# Ne touche pas à resources/bin/piper* (module TTS).
# Usage : bash scripts/fetch-binaries.sh [--force [yt-dlp|ffmpeg|whisper-cli]…]
#   --force seul : tout re-télécharger / recompiler ; --force whisper-cli : seulement whisper-cli.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$ROOT/resources/bin"
# glibc maximale tolérée pour un binaire lié dynamiquement (Debian 10 / RHEL 8 = 2.28).
MAX_GLIBC="2.28"
FORCE_ALL=0
FORCE_ONLY=" "
if [[ "${1:-}" == "--force" ]]; then
  shift
  if [[ $# -eq 0 ]]; then FORCE_ALL=1; else FORCE_ONLY=" $* "; fi
fi
forced() { [[ $FORCE_ALL == 1 || "$FORCE_ONLY" == *" $1 "* ]]; }
mkdir -p "$BIN"
WORK="$(mktemp -d -t om-bin-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

dl() { # url dest
  curl -fL --retry 3 --retry-delay 2 -o "$2" "$1"
}

# Plus haute version de glibc requise par un binaire ELF ("static" s'il est lié statiquement).
max_glibc() {
  if file -b "$1" | grep -Eq 'statically linked|static-pie linked'; then echo static; return; fi
  objdump -T "$1" 2>/dev/null | grep -o 'GLIBC_[0-9.]*' | sed 's/GLIBC_//' | sort -Vu | tail -n1
}
glibc_ok() { # binaire → 0 si statique ou glibc requise <= MAX_GLIBC
  local v
  v="$(max_glibc "$1")"
  [[ "$v" == static || -z "$v" ]] && return 0
  [[ "$(printf '%s\n%s\n' "$v" "$MAX_GLIBC" | sort -V | tail -n1)" == "$MAX_GLIBC" ]]
}

# ---------- yt-dlp ----------
if forced yt-dlp || [[ ! -x "$BIN/yt-dlp" ]]; then
  echo "==> yt-dlp"
  dl "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux" "$WORK/yt-dlp"
  chmod +x "$WORK/yt-dlp"
  mv "$WORK/yt-dlp" "$BIN/yt-dlp"
else
  echo "==> yt-dlp déjà présent ($("$BIN/yt-dlp" --version 2>/dev/null || echo '?'))"
fi

# ---------- ffmpeg (statique) ----------
if forced ffmpeg || [[ ! -x "$BIN/ffmpeg" ]]; then
  echo "==> ffmpeg statique"
  dl "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz" "$WORK/ffmpeg.tar.xz"
  mkdir -p "$WORK/ff"
  tar -xJf "$WORK/ffmpeg.tar.xz" -C "$WORK/ff" --wildcards '*/ffmpeg'
  FF="$(find "$WORK/ff" -type f -name ffmpeg | head -n1)"
  [[ -n "$FF" ]] || { echo "ffmpeg introuvable dans l'archive" >&2; exit 1; }
  install -m 755 "$FF" "$BIN/ffmpeg"
else
  echo "==> ffmpeg déjà présent"
fi

# ---------- whisper.cpp → whisper-cli ----------
if [[ -x "$BIN/whisper-cli" ]] && ! glibc_ok "$BIN/whisper-cli"; then
  echo "==> whisper-cli présent mais exige glibc $(max_glibc "$BIN/whisper-cli") (> $MAX_GLIBC) : recompilation en statique"
  FORCE_ONLY="$FORCE_ONLY whisper-cli "
fi
if forced whisper-cli || [[ ! -x "$BIN/whisper-cli" ]]; then
  echo "==> whisper.cpp (compilation statique, quelques minutes)"
  command -v cmake >/dev/null || { echo "cmake requis pour compiler whisper.cpp" >&2; exit 1; }
  # Lien 100 % statique si la glibc statique (libc.a, paquet libc6-dev) est disponible ; sinon libstdc++/libgcc
  # statiques seulement (le binaire dépend alors de la glibc de la machine de compilation → vérifié plus bas).
  LIBC_A="$(${CC:-cc} -print-file-name=libc.a 2>/dev/null || true)"
  if [[ -n "$LIBC_A" && -f "$LIBC_A" ]]; then
    LDFLAGS_STATIC="-static"
  else
    echo "   libc.a introuvable : lien semi-statique (-static-libstdc++ -static-libgcc)" >&2
    LDFLAGS_STATIC="-static-libstdc++ -static-libgcc"
  fi
  SRC="$WORK/whisper.cpp"
  if ! git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$SRC" 2>/dev/null; then
    echo "   git clone impossible, tarball codeload"
    dl "https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/refs/heads/master" "$WORK/whisper.tar.gz"
    mkdir -p "$SRC" && tar -xzf "$WORK/whisper.tar.gz" -C "$SRC" --strip-components=1
  fi
  cmake -S "$SRC" -B "$SRC/build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF \
    -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_SDL2=OFF -DWHISPER_CURL=OFF -DGGML_OPENMP=OFF \
    -DGGML_BACKEND_DL=OFF -DCMAKE_POSITION_INDEPENDENT_CODE=OFF -DCMAKE_EXE_LINKER_FLAGS="$LDFLAGS_STATIC"
  cmake --build "$SRC/build" --config Release -j"$(nproc)" --target whisper-cli
  OUT="$SRC/build/bin/whisper-cli"
  strip "$OUT" 2>/dev/null || true
  "$OUT" --help >/dev/null 2>&1 || { echo "whisper-cli compilé mais ne démarre pas" >&2; exit 1; }
  if ! glibc_ok "$OUT"; then
    echo "whisper-cli exige glibc $(max_glibc "$OUT") (> $MAX_GLIBC) : il ne tournerait pas sur Ubuntu 20.04/22.04, Debian 11/12…" >&2
    echo "Installe libc6-dev (libc.a) pour un lien statique, ou compile dans un conteneur ancien (ex. docker run ubuntu:18.04)." >&2
    exit 1
  fi
  install -m 755 "$OUT" "$BIN/whisper-cli"
  echo "   whisper-cli : glibc requise = $(max_glibc "$BIN/whisper-cli")"
else
  echo "==> whisper-cli déjà présent"
fi

echo "==> Binaires dans $BIN (glibc maximale requise) :"
for b in yt-dlp ffmpeg whisper-cli; do
  [[ -x "$BIN/$b" ]] && printf '   %-12s %8s  glibc %s\n' "$b" "$(du -h "$BIN/$b" | cut -f1)" "$(max_glibc "$BIN/$b")"
done
