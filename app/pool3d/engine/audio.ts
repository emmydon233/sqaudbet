/**
 * Synthesised pool sounds (WebAudio, no asset files to download). The AudioContext is only created
 * or resumed from `unlock()`, which the game calls from a user gesture, so it respects browser
 * autoplay policies. Every method is a safe no-op while sound is off or locked.
 */
import { safeStorage } from "./common";

type Ctx = AudioContext;

export class PoolAudio {
  private ctx: Ctx | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private enabled: boolean;
  private lastBallClick = 0;

  constructor() {
    const stored = safeStorage()?.getItem("squadbet.pool.sound");
    this.enabled = stored !== "off";
  }

  get isOn() {
    return this.enabled;
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    try { safeStorage()?.setItem("squadbet.pool.sound", on ? "on" : "off"); } catch { /* ignore */ }
    if (on) this.unlock();
  }

  /** Call from a pointer/key handler. */
  unlock() {
    if (!this.enabled) return;
    try {
      if (!this.ctx) {
        const Ctor: typeof AudioContext | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.8;
        this.master.connect(this.ctx.destination);
        const len = Math.floor(this.ctx.sampleRate * 0.4);
        this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const data = this.noise.getChannelData(0);
        for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;
      }
      if (this.ctx.state === "suspended") void this.ctx.resume();
    } catch { /* audio is optional */ }
  }

  private ready(): boolean {
    return this.enabled && !!this.ctx && !!this.master && this.ctx.state === "running";
  }

  private tone(freq: number, dur: number, gain: number, type: OscillatorType = "sine", endFreq?: number, when = 0) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master!);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private burst(dur: number, gain: number, lowpass: number, when = 0) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + when;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = lowpass;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(g).connect(this.master!);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  /** Cue tip striking the cue ball. power 0..1 */
  cue(power: number) {
    if (!this.ready()) return;
    const v = 0.25 + power * 0.6;
    this.burst(0.05, v * 0.5, 2600);
    this.tone(220, 0.09, v * 0.5, "triangle", 120);
  }

  /** Ball-on-ball click. speed = approach speed in table units/s */
  ball(speed: number) {
    if (!this.ready()) return;
    const now = this.ctx!.currentTime;
    if (now - this.lastBallClick < 0.012) return; // avoid stacking identical clicks in one frame
    this.lastBallClick = now;
    const v = Math.min(1, 0.12 + speed / 7);
    this.tone(2300 + Math.random() * 300, 0.06, v * 0.28, "triangle", 1700);
    this.tone(3600, 0.035, v * 0.14, "sine");
    this.burst(0.02, v * 0.14, 6000);
  }

  cushion(speed: number) {
    if (!this.ready()) return;
    const v = Math.min(1, 0.1 + speed / 6);
    this.tone(170, 0.11, v * 0.4, "sine", 90);
    this.burst(0.06, v * 0.2, 900);
  }

  pocket() {
    if (!this.ready()) return;
    this.burst(0.28, 0.32, 700);
    this.tone(210, 0.22, 0.28, "sine", 70);
    this.tone(95, 0.35, 0.22, "sine", 60, 0.12);
  }

  /** Soft rattle of a ball dropping around inside a pocket. */
  rattle() {
    if (!this.ready()) return;
    this.tone(880, 0.05, 0.1, "triangle", 520, 0.05);
    this.tone(640, 0.05, 0.08, "triangle", 420, 0.12);
    this.tone(300, 0.12, 0.1, "sine", 150, 0.18);
  }

  turn() {
    if (!this.ready()) return;
    this.tone(660, 0.16, 0.12, "sine");
    this.tone(880, 0.22, 0.1, "sine", undefined, 0.09);
  }

  foul() {
    if (!this.ready()) return;
    this.tone(220, 0.22, 0.16, "sawtooth", 150);
  }

  win() {
    if (!this.ready()) return;
    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.45, 0.16, "triangle", undefined, i * 0.13));
  }

  lose() {
    if (!this.ready()) return;
    [392, 330, 262].forEach((f, i) => this.tone(f, 0.5, 0.14, "triangle", undefined, i * 0.18));
  }

  dispose() {
    try { void this.ctx?.close(); } catch { /* ignore */ }
    this.ctx = null;
    this.master = null;
  }
}
