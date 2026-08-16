/* Minimal C wrapper around speexdsp's echo canceller (MDF adaptive filter)
 * + preprocessor (residual echo suppression), for a standalone-WASM build
 * instantiated inside an AudioWorklet.
 *
 * Contract (all int16 mono):
 *   aec_init(frame, filter_len, rate) -> 1 ok / 0 fail
 *   write near-end (raw mic) samples at aec_near(), far-end (speaker
 *   reference) at aec_far(), call aec_process(), read cleaned frame at
 *   aec_out(). One call = one frame of `frame` samples.
 */
#include <stdlib.h>
#include "speex/speex_echo.h"
#include "speex/speex_preprocess.h"

static SpeexEchoState *st = 0;
static SpeexPreprocessState *den = 0;
static spx_int16_t *near_buf = 0, *far_buf = 0, *out_buf = 0;
static int frame_size = 0;

__attribute__((used)) int aec_init(int frame, int filter_len, int rate) {
  if (st) { speex_echo_state_destroy(st); st = 0; }
  if (den) { speex_preprocess_state_destroy(den); den = 0; }
  free(near_buf); free(far_buf); free(out_buf);
  frame_size = frame;
  near_buf = malloc(frame * sizeof(spx_int16_t));
  far_buf  = malloc(frame * sizeof(spx_int16_t));
  out_buf  = malloc(frame * sizeof(spx_int16_t));
  st = speex_echo_state_init(frame, filter_len);
  if (!st || !near_buf || !far_buf || !out_buf) return 0;
  speex_echo_ctl(st, SPEEX_ECHO_SET_SAMPLING_RATE, &rate);
  den = speex_preprocess_state_init(frame, rate);
  if (den) {
    int on = 1;
    speex_preprocess_ctl(den, SPEEX_PREPROCESS_SET_ECHO_STATE, st);
    speex_preprocess_ctl(den, SPEEX_PREPROCESS_SET_DENOISE, &on);
  }
  return 1;
}

__attribute__((used)) spx_int16_t *aec_near(void) { return near_buf; }
__attribute__((used)) spx_int16_t *aec_far(void)  { return far_buf; }
__attribute__((used)) spx_int16_t *aec_out(void)  { return out_buf; }

__attribute__((used)) void aec_process(void) {
  speex_echo_cancellation(st, near_buf, far_buf, out_buf);
  if (den) speex_preprocess_run(den, out_buf);
}

__attribute__((used)) void aec_reset(void) {
  if (st) speex_echo_state_reset(st);
}
