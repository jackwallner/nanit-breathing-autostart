#!/usr/bin/env bash
# Builds the small LGPL ffmpeg the app ships: just enough to read Nanit's RTMPS stream, decode
# H.264 and write raw frames and PNGs. TLS comes from the operating system (Secure Transport on
# macOS, SChannel on Windows), so certificates are checked against the system's own roots.
#
#   scripts/build-ffmpeg.sh mac-arm64   (on a Mac)
#   scripts/build-ffmpeg.sh mac-x64     (on a Mac; needs nasm)
#   scripts/build-ffmpeg.sh win-x64     (on Linux; needs mingw-w64, nasm and libz-mingw-w64-dev)
#
# Output: vendor/ffmpeg/<target>/ffmpeg[.exe]
set -euo pipefail

VERSION=8.1.3
TARGET=${1:?usage: build-ffmpeg.sh mac-arm64|mac-x64|win-x64}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$ROOT/vendor/ffmpeg/$TARGET"
WORK="${FFMPEG_WORK:-$ROOT/.ffmpeg-build}/$TARGET"
JOBS=$( (sysctl -n hw.ncpu 2>/dev/null || nproc) )

mkdir -p "$WORK" "$OUT"
cd "$WORK"
if [ ! -d "ffmpeg-$VERSION" ]; then
  curl -fsSLO "https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz"
  tar xf "ffmpeg-$VERSION.tar.xz"
fi
cd "ffmpeg-$VERSION"

common=(
  --disable-everything --disable-autodetect --disable-doc --disable-debug
  --disable-programs --enable-ffmpeg --disable-avdevice --disable-swresample
  --enable-network --enable-pthreads --enable-zlib --enable-swscale
  --enable-protocol=file,pipe,tcp,tls,rtmp,rtmps
  --enable-demuxer=flv,live_flv,rawvideo
  --enable-parser=h264
  --enable-decoder=h264,rawvideo
  --enable-encoder=png,rawvideo
  --enable-muxer=rawvideo,image2pipe
  --enable-filter=scale,fps,format,null
)

case "$TARGET" in
  mac-arm64)
    flags="-arch arm64 -mmacosx-version-min=11.0"
    ./configure "${common[@]}" --enable-securetransport --arch=arm64 --target-os=darwin --enable-cross-compile \
      --extra-cflags="$flags" --extra-ldflags="$flags" ;;
  mac-x64)
    flags="-arch x86_64 -mmacosx-version-min=11.0"
    ./configure "${common[@]}" --enable-securetransport --arch=x86_64 --target-os=darwin --enable-cross-compile \
      --extra-cflags="$flags" --extra-ldflags="$flags" ;;
  win-x64)
    ./configure "${common[@]}" --enable-schannel --enable-w32threads --disable-pthreads \
      --arch=x86_64 --target-os=mingw32 --cross-prefix=x86_64-w64-mingw32- \
      --extra-ldflags="-static -static-libgcc" ;;
  *) echo "Unknown target $TARGET" >&2; exit 1 ;;
esac

make -j"$JOBS" ffmpeg >/dev/null
bin=ffmpeg; [ "$TARGET" = win-x64 ] && bin=ffmpeg.exe
cp "$bin" "$OUT/$bin"
case "$TARGET" in
  win-x64) x86_64-w64-mingw32-strip "$OUT/$bin" ;;
  *) strip "$OUT/$bin" ;;
esac
cp COPYING.LGPLv2.1 "$OUT/LICENSE.txt"
echo "ffmpeg $VERSION ($TARGET, LGPL) built from https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz" > "$OUT/SOURCE.txt"
echo "Built $OUT/$bin"
