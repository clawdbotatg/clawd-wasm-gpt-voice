#!/bin/bash
# Build speexdsp's echo canceller to standalone WASM for the AudioWorklet.
# Needs emscripten (brew install emscripten) + a speexdsp checkout.
# The built aec.wasm is committed, so this only needs re-running to change the C.
set -euo pipefail
cd "$(dirname "$0")"

SPEEXDSP=${SPEEXDSP:-./speexdsp}
if [ ! -d "$SPEEXDSP" ]; then
  git clone --depth 1 https://github.com/xiph/speexdsp.git "$SPEEXDSP"
fi
# configure-generated types header (we skip autotools)
cat > "$SPEEXDSP/include/speex/speexdsp_config_types.h" <<'EOF'
#ifndef __SPEEX_TYPES_H__
#define __SPEEX_TYPES_H__
#include <stdint.h>
typedef int16_t spx_int16_t;
typedef uint16_t spx_uint16_t;
typedef int32_t spx_int32_t;
typedef uint32_t spx_uint32_t;
#endif
EOF

L="$SPEEXDSP/libspeexdsp"
emcc -O3 -DFLOATING_POINT -DUSE_KISS_FFT -DEXPORT= \
  -I "$SPEEXDSP/include" -I "$L" \
  aec.c "$L/mdf.c" "$L/preprocess.c" "$L/filterbank.c" \
  "$L/fftwrap.c" "$L/kiss_fft.c" "$L/kiss_fftr.c" \
  --no-entry -sSTANDALONE_WASM=1 -sALLOW_MEMORY_GROWTH=0 -sINITIAL_MEMORY=33554432 \
  -sEXPORTED_FUNCTIONS=_aec_init,_aec_near,_aec_far,_aec_out,_aec_process,_aec_reset \
  -o aec.wasm
ls -la aec.wasm
