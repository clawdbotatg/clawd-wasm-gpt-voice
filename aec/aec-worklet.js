/* AudioWorkletProcessor wrapping speexdsp's echo canceller (aec.wasm).
 *
 * Inputs:  0 = near end (raw mic, echoCancellation:false)
 *          1 = far end (reference tap of the assistant's audio, pre-speaker)
 * Output:  0 = cleaned mic
 *
 * The wasm bytes arrive via processorOptions.wasmBytes (fetched on the main
 * thread — a worklet can't fetch). Until instantiation completes the output
 * is silence, never raw mic: leaking un-cancelled echo at session start is
 * worse than a muted first ~50ms.
 *
 * speex wants fixed frames (10ms); the render quantum is 128 samples — ring
 * buffers bridge the two. Near and far are buffered identically so their
 * relative alignment is preserved; the acoustic + output-path delay is left
 * to the adaptive filter's tail (default 200ms).
 */
class AecProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const po = (options && options.processorOptions) || {};
    this.frame = po.frame || Math.round(sampleRate / 100);        // 10ms
    const tailMs = po.tailMs || 200;
    this.tail = Math.max(this.frame * 2, Math.round(sampleRate * tailMs / 1000 / this.frame) * this.frame);
    this.bypass = !!po.bypass;
    this.ready = false;
    this.dead = false;

    const CAP = sampleRate; // 1s of buffer, power-of-two not required
    this.nearQ = new Float32Array(CAP); this.nearW = 0; this.nearR = 0;
    this.farQ = new Float32Array(CAP); this.farW = 0; this.farR = 0;
    this.outQ = new Float32Array(CAP); this.outW = 0; this.outR = 0;
    this.primed = false;

    // metrics (energies while far end is active)
    this.mNear = 0; this.mOut = 0; this.mFar = 0; this.mFrames = 0; this.lastPost = 0;

    // delay tracking: 1kHz amplitude envelopes of the PAIRED near/far frames,
    // posted to the main thread (aec-align.js) which cross-correlates and
    // commands farDelay shifts. farDelay = extra samples of delay applied to
    // the far reference so it coincides with the echo in the mic signal.
    this.ENVD = 48;                       // 48 samples/env point = 1kHz
    this.ENVLEN = 1400;                   // 1.4s of envelope history
    this.envN = new Float32Array(this.ENVLEN);
    this.envF = new Float32Array(this.ENVLEN);
    this.envW = 0; this.envSincePost = 0;
    this.farDelay = 0;                    // samples
    this.MAXDELAY = Math.floor(sampleRate * 0.7);

    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.type === 'reset' && this.ready) this.E.aec_reset();
      if (d.type === 'bypass') this.bypass = !!d.on;
      if (d.type === 'farDelay') {        // residual lag measured on the paired envelopes
        const delta = Math.round((d.ms || 0) * sampleRate / 1000);
        const target = Math.min(this.MAXDELAY, Math.max(0, this.farDelay + delta));
        if (Math.abs(target - this.farDelay) >= sampleRate * 0.003) {
          this.farDelay = target;
          // big realignment invalidates the learned response — converge fresh
          if (this.ready) this.E.aec_reset();
        }
      }
    };

    if (po.wasmBytes) this._instantiate(po.wasmBytes);
    else { this.dead = true; this.port.postMessage({ type: 'error', error: 'no wasmBytes' }); }
  }

  async _instantiate(bytes) {
    try {
      const stubs = { proc_exit: () => {}, fd_close: () => 0, fd_write: () => 0, fd_seek: () => 0 };
      const { instance } = await WebAssembly.instantiate(bytes, { wasi_snapshot_preview1: stubs });
      this.E = instance.exports;
      this.E._initialize();
      if (!this.E.aec_init(this.frame, this.tail, sampleRate)) throw new Error('aec_init failed');
      this.heap = new Int16Array(this.E.memory.buffer);
      this.nearPtr = this.E.aec_near() >> 1;
      this.farPtr = this.E.aec_far() >> 1;
      this.outPtr = this.E.aec_out() >> 1;
      this.ready = true;
      this.port.postMessage({ type: 'ready', frame: this.frame, tail: this.tail, sampleRate });
    } catch (err) {
      this.dead = true;
      this.port.postMessage({ type: 'error', error: String(err) });
    }
  }

  _push(q, wKey, data) {
    let w = this[wKey];
    for (let i = 0; i < data.length; i++) { q[w % q.length] = data[i]; w++; }
    this[wKey] = w;
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    const near = inputs[0] && inputs[0][0];
    const far = inputs[1] && inputs[1][0];

    if (this.dead) { // unrecoverable: pass mic through rather than kill audio
      if (near && out) out.set(near);
      return true;
    }
    // near and far are one timeline: every quantum near advances, far MUST
    // advance by the same amount, zero-padded when the far input is empty
    // (unconnected yet, or an inactive-input hiccup — iOS Safari does this a
    // lot). The first cut instead skipped far pushes and "resynced" later,
    // which shifted the alignment on every hiccup and forced the adaptive
    // filter to re-converge from scratch — measured on iPhone as ERLE
    // sawtoothing 1→26→1 dB. Never advance one queue without the other.
    if (near && near.length) {
      this._push(this.nearQ, 'nearW', near);
      if (far && far.length) {
        this._push(this.farQ, 'farW', far);
      } else {
        if (!this._zeros || this._zeros.length !== near.length) this._zeros = new Float32Array(near.length);
        this._push(this.farQ, 'farW', this._zeros);
      }
    }

    if (this.ready) {
      const F = this.frame, h = this.heap;
      while (this.nearW - this.nearR >= F) {
        for (let i = 0; i < F; i++) {
          const n = this.nearQ[(this.nearR + i) % this.nearQ.length];
          const fi = this.farR + i - this.farDelay; // delayed reference
          const f = (fi >= 0 && fi < this.farW) ? this.farQ[fi % this.farQ.length] : 0;
          h[this.nearPtr + i] = Math.max(-32768, Math.min(32767, (n * 32767) | 0));
          h[this.farPtr + i] = Math.max(-32768, Math.min(32767, (f * 32767) | 0));
        }
        this.nearR += F;
        this.farR += F; // lockstep with nearR by construction
        // paired-envelope accumulation for the delay tracker
        for (let b = 0; b + this.ENVD <= F; b += this.ENVD) {
          let an = 0, af = 0;
          for (let i = b; i < b + this.ENVD; i++) {
            an += Math.abs(h[this.nearPtr + i]); af += Math.abs(h[this.farPtr + i]);
          }
          this.envN[this.envW % this.ENVLEN] = an / (this.ENVD * 32768);
          this.envF[this.envW % this.ENVLEN] = af / (this.ENVD * 32768);
          this.envW++; this.envSincePost++;
        }
        if (this.envSincePost >= 3000 && this.envW >= this.ENVLEN) { // every 3s, once warm
          this.envSincePost = 0;
          const nOut = new Float32Array(this.ENVLEN), fOut = new Float32Array(this.ENVLEN);
          for (let t = 0; t < this.ENVLEN; t++) {
            const src = (this.envW - this.ENVLEN + t) % this.ENVLEN;
            nOut[t] = this.envN[src]; fOut[t] = this.envF[src];
          }
          this.port.postMessage({ type: 'env', near: nOut, far: fOut }, [nOut.buffer, fOut.buffer]);
        }
        this.E.aec_process();
        let en = 0, eo = 0, ef = 0;
        for (let i = 0; i < F; i++) {
          const o = this.bypass ? h[this.nearPtr + i] : h[this.outPtr + i];
          this.outQ[this.outW % this.outQ.length] = o / 32768;
          this.outW++;
          en += h[this.nearPtr + i] ** 2; eo += o ** 2; ef += h[this.farPtr + i] ** 2;
        }
        if (ef / F > 1000) { this.mNear += en; this.mOut += eo; this.mFrames++; } // far active
        this.mFar += ef;
      }
    } else {
      this.nearR = this.nearW; this.farR = this.farW; // drop while loading
    }

    if (!this.primed && this.outW - this.outR >= 128 * 3) this.primed = true;
    if (out) {
      if (this.primed && this.outW - this.outR >= out.length) {
        for (let i = 0; i < out.length; i++) { out[i] = this.outQ[this.outR % this.outQ.length]; this.outR++; }
      } else {
        out.fill(0);
      }
    }

    // ~1/s metrics
    if (currentTime - this.lastPost > 1) {
      this.lastPost = currentTime;
      const erle = this.mFrames ? 10 * Math.log10(this.mNear / Math.max(this.mOut, 1e-9)) : null;
      this.port.postMessage({
        type: 'stats', ready: this.ready, erleDb: erle,
        farActiveFrames: this.mFrames,
        farRms: Math.sqrt(this.mFar / Math.max(1, this.frame * this.mFrames)) | 0,
        farDelayMs: +(this.farDelay * 1000 / sampleRate).toFixed(1),
      });
      this.mNear = 0; this.mOut = 0; this.mFar = 0; this.mFrames = 0;
    }
    return true;
  }
}
registerProcessor('aec-processor', AecProcessor);
