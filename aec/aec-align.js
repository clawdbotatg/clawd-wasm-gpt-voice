/* Delay tracker for the AEC worklet (main-thread side).
 *
 * The worklet posts {type:'env', near, far} — 1kHz amplitude envelopes of the
 * last ~1.2s. We cross-correlate to find how far the echo in the near signal
 * lags the far reference (speaker output latency + acoustics + capture
 * pipeline — on iOS this is large AND drifts), and command the worklet to
 * shift its far-queue read pointer so near/far are aligned to within a few
 * ms. The adaptive filter then only models a stable residual instead of
 * chasing a moving delay (measured on iPhone as ERLE sawtoothing).
 *
 * Usage: node.port.onmessage = e => { if (AecAlign.handle(node, e.data)) return; ...your stats... }
 */
const AecAlign = {
  // returns true if the message was an env frame (consumed)
  handle(node, d) {
    if (!d || d.type !== 'env') return false;
    const near = d.near, far = d.far; // Float32Array, 1kHz env, same length
    const n = Math.min(near.length, far.length);
    const MAXLAG = Math.min(700, n - 300); // ms; need 300ms of overlap
    const MINLAG = -200;                   // negative = non-causal (echo before reference)
    if (MAXLAG < 50) return true;
    // means over the compared region
    let fVar = 0, fMean = 0, nMean = 0;
    for (let t = 0; t < n; t++) { fMean += far[t]; nMean += near[t]; }
    fMean /= n; nMean /= n;
    for (let t = 0; t < n; t++) fVar += (far[t] - fMean) ** 2;
    if (fVar / n < 1e-8) return true; // far basically silent — nothing to align to
    let bestLag = 0, bestScore = -1;
    for (let lag = MINLAG; lag <= MAXLAG; lag++) {
      let num = 0, dn = 0, df = 0;
      const t0 = Math.max(0, lag), t1 = Math.min(n, n + lag);
      for (let t = t0; t < t1; t++) {
        const a = near[t] - nMean, b = far[t - lag] - fMean;
        num += a * b; dn += a * a; df += b * b;
      }
      const score = num / Math.sqrt(Math.max(dn * df, 1e-12));
      if (score > bestScore) { bestScore = score; bestLag = lag; }
    }
    if (bestScore < 0.6) return true; // no confident echo peak (double-talk, noise)
    if (AecAlign.onLag) AecAlign.onLag(bestLag, bestScore);
    // Deadband: residuals comfortably inside the filter tail are the MDF's
    // job — shifting for them just re-shocks a converged filter (measured:
    // a 50ms static delay cancels at 44dB untouched, 3dB when "helpfully"
    // shifted every 3s). Act only when the echo sits outside what the filter
    // can model: far beyond the tail start, or NON-CAUSAL (lag < 0, which no
    // causal filter can represent). Land it at +40ms for jitter margin.
    if (bestLag > 60 || bestLag < -10) {
      node.port.postMessage({ type: 'farDelay', ms: bestLag - 40, score: +bestScore.toFixed(2) });
    }
    return true;
  },
  onLag: null,
};
if (typeof window !== 'undefined') window.AecAlign = AecAlign;
