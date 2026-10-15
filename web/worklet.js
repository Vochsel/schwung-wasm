// AudioWorkletProcessor: pulls interleaved stereo int16 blocks out of the
// engine's ring in shared wasm memory (docs/ENGINE-INTERFACE.md "Worklet").
//
// ctl (u32 at byte offset `ctl`):
//   [0] write_block  (engine)   [1] read_block (us)
//   [2] capacity     (engine)   [3] underruns  (us)
// Counters increase monotonically; slot = counter % capacity. Each slot is
// BLOCK frames x 2 channels of int16. After consuming a block we advance [1]
// and Atomics.notify it so a device thread parked in Atomics.wait (ring full)
// renders the next one. Nothing on this path uses postMessage.

const BLOCK = 128;
const INV = 1 / 32768;

class SchwungRingProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ready = false;
    this.cursor = BLOCK;      // frame index inside the current block (BLOCK = need a new one)
    this.slot = null;         // Int16Array view of the current block
    this.lastReport = 0;
    this.consumed = 0;
    this.port.onmessage = (e) => this.init(e.data);
  }

  init(msg) {
    if (msg.type === 'record') { this.recording = msg.on; this.rec = []; if (!msg.on) this.flushRec(true); return; }
    const { memory, ring, ctl, inRing, inCtl } = msg;
    // A WebAssembly.Memory (shared) or a bare SharedArrayBuffer both work.
    this.buffer = memory instanceof WebAssembly.Memory ? memory.buffer : memory;
    this.ringOff = ring;
    this.ctl32 = new Int32Array(this.buffer, ctl, 4);
    // Optional audio input (Move's line-in): the engine reads one block per
    // frame from this ring into the mailbox's RX audio.
    if (inRing) { this.inOff = inRing; this.inCtl = new Int32Array(this.buffer, inCtl, 4); this.inFill = 0; this.inBlock = new Int16Array(BLOCK * 2); }
    this.ready = true;
    this.port.postMessage({ type: 'ready', sampleRate });
  }

  nextBlock() {
    const c = this.ctl32;
    const w = Atomics.load(c, 0) >>> 0;
    const r = Atomics.load(c, 1) >>> 0;
    if (((w - r) >>> 0) === 0 || ((w - r) >>> 0) > 0x7fffffff) return false;
    const cap = (Atomics.load(c, 2) >>> 0) || 1;
    const idx = r % cap;
    this.slot = new Int16Array(this.buffer, this.ringOff + idx * BLOCK * 4, BLOCK * 2);
    return true;
  }

  release() {
    const c = this.ctl32;
    Atomics.store(c, 1, (Atomics.load(c, 1) + 1) | 0);
    Atomics.notify(c, 1);
    this.consumed++;
  }

  pushInput(input) {
    if (!this.inCtl || !input || input.length === 0 || !input[0]) return;
    const L = input[0], R = input[1] || input[0];
    for (let i = 0; i < L.length; i++) {
      const b = this.inBlock, k = this.inFill * 2;
      b[k] = Math.max(-1, Math.min(1, L[i])) * 32767;
      b[k + 1] = Math.max(-1, Math.min(1, R[i])) * 32767;
      if (++this.inFill === BLOCK) {
        const w = Atomics.load(this.inCtl, 0) >>> 0, cap = (Atomics.load(this.inCtl, 2) >>> 0) || 16;
        new Int16Array(this.buffer, this.inOff + (w % cap) * BLOCK * 4, BLOCK * 2).set(b);
        Atomics.store(this.inCtl, 0, (w + 1) | 0);
        this.inFill = 0;
      }
    }
  }

  // Recording the output: copy each quantum, hand chunks to the page.
  flushRec(final) {
    if (this.rec && this.rec.length) { const c = this.rec; this.rec = []; this.port.postMessage({ type: 'rec', chunks: c, final }); }
    else if (final) this.port.postMessage({ type: 'rec', chunks: [], final });
  }

  process(inputs, outputs) {
    this.pushInput(inputs[0]);
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const L = out[0], R = out[1] || out[0];
    const n = L.length;
    if (!this.ready) { L.fill(0); if (R !== L) R.fill(0); return true; }

    let i = 0;
    while (i < n) {
      if (this.cursor >= BLOCK) {
        if (this.slot) { this.release(); this.slot = null; }
        if (!this.nextBlock()) {
          // Underrun: silence for the rest of this quantum, count once.
          Atomics.add(this.ctl32, 3, 1);
          for (; i < n; i++) { L[i] = 0; R[i] = 0; }
          break;
        }
        this.cursor = 0;
      }
      const s = this.slot;
      let k = this.cursor * 2;
      const take = Math.min(n - i, BLOCK - this.cursor);
      for (let j = 0; j < take; j++, i++, k += 2) {
        L[i] = s[k] * INV;
        R[i] = s[k + 1] * INV;
      }
      this.cursor += take;
    }
    // Release a fully played block now rather than at the next quantum, so the
    // engine sees the free slot as early as possible.
    if (this.cursor >= BLOCK && this.slot) { this.release(); this.slot = null; }

    if (this.recording) { this.rec.push([L.slice(), R.slice()]); if (this.rec.length >= 344) this.flushRec(false); }

    if (currentTime - this.lastReport > 0.5) {
      this.lastReport = currentTime;
      this.port.postMessage({ type: 'stat', consumed: this.consumed });
    }
    return true;
  }
}

registerProcessor('schwung-ring', SchwungRingProcessor);
