/**
 * Every sound in the game, synthesized with WebAudio — no sample files.
 *
 * Block sounds are shaped noise, tuned per material (stone clicks bright and
 * short, wood knocks low, gravel crunches, glass rings), mobs are small
 * oscillator voices, and the music is a slow generative piano on a pentatonic
 * scale that plays now and then and leaves long silences, the way the
 * original's score does. Sounds are placed by distance and stereo pan from the
 * listener; a full HRTF panner per footstep costs more than it adds.
 *
 * Browsers only start audio after a user gesture, so the context is created
 * lazily and resumed on the first click or key.
 */
import type { Material } from "./engine/blocks";


const MATERIAL_TONE: Record<Material, { freq: number; q: number; len: number; type: BiquadFilterType; gain: number }> = {
  stone: { freq: 2200, q: 1.2, len: 0.09, type: "bandpass", gain: 0.7 },
  wood: { freq: 700, q: 2.5, len: 0.12, type: "bandpass", gain: 0.9 },
  dirt: { freq: 900, q: 0.8, len: 0.1, type: "lowpass", gain: 0.8 },
  grass: { freq: 3500, q: 0.6, len: 0.1, type: "highpass", gain: 0.45 },
  sand: { freq: 1600, q: 0.7, len: 0.12, type: "bandpass", gain: 0.6 },
  gravel: { freq: 1300, q: 0.9, len: 0.14, type: "bandpass", gain: 0.75 },
  glass: { freq: 4200, q: 3, len: 0.18, type: "bandpass", gain: 0.6 },
  wool: { freq: 600, q: 0.5, len: 0.12, type: "lowpass", gain: 0.5 },
  metal: { freq: 3000, q: 6, len: 0.2, type: "bandpass", gain: 0.6 },
  plant: { freq: 4000, q: 0.5, len: 0.08, type: "highpass", gain: 0.35 },
  leaves: { freq: 3000, q: 0.5, len: 0.1, type: "highpass", gain: 0.4 },
  snow: { freq: 1800, q: 0.5, len: 0.12, type: "lowpass", gain: 0.5 },
  water: { freq: 900, q: 1, len: 0.2, type: "lowpass", gain: 0.5 },
  lava: { freq: 400, q: 1, len: 0.3, type: "lowpass", gain: 0.6 },
  none: { freq: 1000, q: 1, len: 0.05, type: "lowpass", gain: 0 },
};

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private music!: GainNode;
  private reverb!: ConvolverNode;
  private noise!: AudioBuffer;
  private rainNode: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private listener = { x: 0, y: 0, z: 0, yaw: 0 };
  private nextMusic = 60;
  private musicPlaying = false;
  volumes = { master: 0.8, sfx: 1, music: 0.5 };
  enabled = true;

  /** Must be called from a user gesture the first time. */
  unlock(): void {
    if (!this.enabled) return;
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) { this.enabled = false; return; }
      this.ctx = new AC();
      const ctx = this.ctx;
      this.master = ctx.createGain();
      this.master.connect(ctx.destination);
      this.sfx = ctx.createGain();
      this.sfx.connect(this.master);
      this.music = ctx.createGain();
      this.reverb = ctx.createConvolver();
      this.reverb.buffer = this.impulse(3.5);
      this.music.connect(this.reverb);
      this.reverb.connect(this.master);
      this.music.connect(this.master);
      this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.applyVolumes();
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  applyVolumes(): void {
    if (!this.ctx) return;
    this.master.gain.value = this.volumes.master;
    this.sfx.gain.value = this.volumes.sfx;
    this.music.gain.value = this.volumes.music * 0.5;
  }

  private impulse(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    return buf;
  }

  setListener(x: number, y: number, z: number, yaw: number): void {
    this.listener.x = x; this.listener.y = y; this.listener.z = z; this.listener.yaw = yaw;
  }

  /** A node chain that places a sound in the world: distance fade and stereo pan. */
  private placed(x: number | null, y: number, z: number, volume: number, range = 16): AudioNode | null {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    let gain = volume;
    let pan = 0;
    if (x !== null) {
      const dx = x - this.listener.x, dy = y - this.listener.y, dz = z - this.listener.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > range) return null;
      gain *= Math.max(0, 1 - dist / range) ** 1.5;
      // Right of the listener is +x rotated by yaw.
      const rx = Math.cos(this.listener.yaw), rz = -Math.sin(this.listener.yaw);
      pan = Math.max(-1, Math.min(1, (dx * rx + dz * rz) / Math.max(1, dist)));
    }
    g.gain.value = gain;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan * 0.8;
      g.connect(p);
      p.connect(this.sfx);
    } else g.connect(this.sfx);
    return g;
  }

  private noiseBurst(out: AudioNode, t: number, len: number, filter: BiquadFilterType, freq: number, q: number, gain: number, sweep = 1): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.setValueAtTime(freq, t);
    if (sweep !== 1) f.frequency.exponentialRampToValueAtTime(Math.max(40, freq * sweep), t + len);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    src.connect(f); f.connect(g); g.connect(out);
    src.start(t, Math.random() * 0.5, len + 0.05);
  }

  private tone(out: AudioNode, t: number, type: OscillatorType, from: number, to: number, len: number, gain: number, attack = 0.01): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + len);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g); g.connect(out);
    o.start(t);
    o.stop(t + len + 0.05);
  }

  /** A block sound: kind is dig (a mining tick), break, place or step. */
  block(material: Material, kind: "dig" | "break" | "place" | "step", x: number, y: number, z: number): void {
    if (!this.ready()) return;
    const tone = MATERIAL_TONE[material] ?? MATERIAL_TONE.stone;
    const vol = kind === "step" ? 0.18 : kind === "dig" ? 0.25 : 0.5;
    const out = this.placed(x, y, z, vol * tone.gain);
    if (!out) return;
    const t = this.ctx!.currentTime;
    const len = tone.len * (kind === "break" ? 1.8 : kind === "step" ? 0.8 : 1);
    this.noiseBurst(out, t, len, tone.type, tone.freq * (0.9 + Math.random() * 0.2), tone.q, 0.9);
    if (material === "wood" || material === "dirt") this.tone(out, t, "sine", 160, 90, len, 0.4);
    if (material === "glass" && kind === "break") {
      for (let i = 0; i < 4; i++) this.tone(out, t + i * 0.03, "sine", 2400 + Math.random() * 1800, 1800, 0.25, 0.15);
    }
    if (material === "metal") this.tone(out, t, "triangle", 1400, 1300, 0.25, 0.2);
    if (kind === "break") this.noiseBurst(out, t + 0.03, len, tone.type, tone.freq * 0.7, tone.q, 0.6);
  }

  play(name: string, x: number | null = null, y = 0, z = 0, volume = 1, pitch = 1): void {
    if (!this.ready()) return;
    const out = this.placed(x, y, z, volume, name === "explode" || name === "thunder" ? 64 : 16);
    if (!out) return;
    const t = this.ctx!.currentTime;
    const p = pitch;
    switch (name) {
      case "pop": this.tone(out, t, "sine", 500 * p, 900 * p, 0.08, 0.35); break;
      case "orb": this.tone(out, t, "sine", 1300 * p, 1700 * p, 0.12, 0.2); this.tone(out, t + 0.05, "sine", 2000 * p, 2400 * p, 0.1, 0.1); break;
      case "levelup":
        [523, 659, 784, 1047].forEach((f, i) => this.tone(out, t + i * 0.09, "triangle", f, f, 0.35, 0.25));
        break;
      case "hurt": this.tone(out, t, "triangle", 260 * p, 150 * p, 0.18, 0.5); this.noiseBurst(out, t, 0.08, "lowpass", 800, 1, 0.3); break;
      case "eat": for (let i = 0; i < 2; i++) this.noiseBurst(out, t + i * 0.07, 0.06, "bandpass", 1800 + Math.random() * 800, 1.5, 0.5); break;
      case "burp": this.tone(out, t, "sawtooth", 140, 90, 0.35, 0.3); break;
      case "bow": this.tone(out, t, "triangle", 420 * p, 180, 0.2, 0.4); this.noiseBurst(out, t, 0.12, "highpass", 3000, 1, 0.3); break;
      case "arrow_hit": this.noiseBurst(out, t, 0.08, "bandpass", 900, 2, 0.6); this.tone(out, t, "sine", 180, 90, 0.1, 0.3); break;
      case "fizz": this.noiseBurst(out, t, 0.4, "highpass", 4000, 0.7, 0.5, 0.5); break;
      case "splash": this.noiseBurst(out, t, 0.5, "bandpass", 1400, 0.8, 0.8, 0.4); break;
      case "swim": this.noiseBurst(out, t, 0.25, "lowpass", 900, 0.8, 0.3, 0.6); break;
      case "explode":
        this.noiseBurst(out, t, 1.6, "lowpass", 900, 0.8, 1, 0.15);
        this.tone(out, t, "sine", 90, 30, 1.2, 0.9);
        break;
      case "thunder":
        this.noiseBurst(out, t, 3.5, "lowpass", 400, 0.5, 1, 0.3);
        this.noiseBurst(out, t + 0.3, 2.5, "lowpass", 250, 0.5, 0.8, 0.5);
        break;
      case "fuse": case "creeper_hiss": this.noiseBurst(out, t, 1.5, "highpass", 2500, 0.8, 0.6, 1.2); break;
      case "door_open": case "door_close":
        this.noiseBurst(out, t, 0.12, "bandpass", name === "door_open" ? 600 : 450, 3, 0.8);
        this.tone(out, t, "sine", 150, 80, 0.12, 0.4);
        break;
      case "chest_open": this.tone(out, t, "sawtooth", 90, 140, 0.4, 0.15, 0.05); this.noiseBurst(out, t, 0.2, "bandpass", 700, 4, 0.3); break;
      case "chest_close": this.noiseBurst(out, t, 0.1, "bandpass", 500, 3, 0.8); this.tone(out, t, "sine", 120, 70, 0.1, 0.5); break;
      case "click": this.tone(out, t, "square", 900, 800, 0.03, 0.12); break;
      case "shear": this.noiseBurst(out, t, 0.06, "highpass", 5000, 1, 0.6); this.noiseBurst(out, t + 0.08, 0.06, "highpass", 5000, 1, 0.6); break;
      case "milk": this.noiseBurst(out, t, 0.4, "lowpass", 1200, 1, 0.4, 0.5); break;
      case "note": {
        const f = 185 * Math.pow(2, (pitch - 1) * 2);
        this.tone(out, t, "triangle", f, f, 0.6, 0.4);
        this.tone(out, t, "sine", f * 2, f * 2, 0.4, 0.15);
        break;
      }
      case "leaves": this.noiseBurst(out, t, 0.15, "highpass", 3000, 0.6, 0.3); break;
      case "chicken_egg": this.tone(out, t, "sine", 300, 200, 0.1, 0.3); break;
      case "bucket_fill": this.noiseBurst(out, t, 0.3, "bandpass", 1000, 1.2, 0.6, 1.6); break;
      case "bucket_empty": this.noiseBurst(out, t, 0.35, "bandpass", 1400, 1.2, 0.6, 0.5); break;
      case "fire": this.noiseBurst(out, t, 0.3, "bandpass", 1200, 0.8, 0.4, 0.8); break;
      case "ignite": this.noiseBurst(out, t, 0.2, "highpass", 3000, 1, 0.5); this.tone(out, t, "square", 1500, 1000, 0.05, 0.1); break;
      case "drink": this.noiseBurst(out, t, 0.12, "lowpass", 500, 1.5, 0.35, 0.7); this.tone(out, t, "sine", 180 * p, 120 * p, 0.1, 0.2); break;
      case "brew":
        for (let i = 0; i < 5; i++) this.tone(out, t + i * 0.07, "sine", 300 + Math.random() * 400, 200 + Math.random() * 200, 0.06, 0.12);
        break;
      case "glass_break":
        this.noiseBurst(out, t, 0.25, "highpass", 3500, 0.7, 0.5);
        for (let i = 0; i < 4; i++) this.tone(out, t + i * 0.03, "triangle", 2400 + i * 500, 1800 + i * 400, 0.08, 0.1);
        break;
      case "enchant":
        // A rising shimmer: the table's pages turning into light.
        [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(out, t + i * 0.06, "sine", f, f * 1.01, 0.5, 0.12));
        break;
      case "anvil_use": this.tone(out, t, "square", 1100 * p, 1050 * p, 0.25, 0.18); this.tone(out, t, "triangle", 2250 * p, 2200 * p, 0.35, 0.12); this.noiseBurst(out, t, 0.05, "highpass", 4000, 1, 0.3); break;
      case "anvil_break": this.noiseBurst(out, t, 0.5, "bandpass", 900, 0.8, 0.6); this.tone(out, t, "square", 400, 150, 0.4, 0.2); break;
      // A struck bell: two inharmonic partials ringing out over two seconds.
      case "bell":
        this.tone(out, t, "sine", 880 * p, 878 * p, 2.2, 0.35);
        this.tone(out, t, "sine", 2270 * p, 2265 * p, 1.2, 0.12);
        this.tone(out, t, "triangle", 440 * p, 439 * p, 1.6, 0.1);
        break;
      case "compost": this.noiseBurst(out, t, 0.18, "lowpass", 900 * p, 1.2, 0.5, 0.7); break;
      // The portal: a low hum swelling as the four seconds run, and a rushing whoosh on the way through.
      case "portal_trigger":
        this.tone(out, t, "sine", 110, 220, 3.8, 0.18, 1.2);
        this.tone(out, t, "sine", 165, 330, 3.8, 0.1, 1.2);
        break;
      case "portal_travel": this.noiseBurst(out, t, 1.6, "bandpass", 600, 0.5, 0.7, 0.8); this.tone(out, t, "sawtooth", 80, 400, 1.4, 0.12, 0.3); break;
      case "fire_charge": this.noiseBurst(out, t, 0.35, "bandpass", 1500, 0.8, 0.6, 0.6); break;
      default:
        this.mob(name, out, t, p);
    }
  }

  private mob(name: string, out: AudioNode, t: number, p: number): void {
    // "iron_golem_hurt" is the golem's, not an "iron" mob's: two-word kinds are matched whole.
    const long = ["iron_golem", "zombified_piglin", "magma_cube", "wither_skeleton"].find((k) => name.startsWith(`${k}_`) || name === k);
    const [kind, what] = long ? [long, name.slice(long.length + 1)] : name.split("_");
    const death = what === "death";
    const low = death ? 0.75 : 1;
    switch (kind) {
      case "pig": this.tone(out, t, "sawtooth", 320 * p * low, 200 * p * low, 0.22, 0.25); this.tone(out, t + 0.12, "sawtooth", 300 * p * low, 180 * p * low, 0.18, 0.2); break;
      case "cow": this.tone(out, t, "sawtooth", 150 * p * low, 110 * p * low, 0.8, 0.25, 0.1); break;
      case "sheep": {
        const ctx = this.ctx!;
        const o = ctx.createOscillator();
        o.type = "sawtooth";
        o.frequency.setValueAtTime(420 * p * low, t);
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 18;
        const depth = ctx.createGain();
        depth.gain.value = 25;
        lfo.connect(depth); depth.connect(o.frequency);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.2, t + 0.05);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
        const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 1400;
        o.connect(f); f.connect(g); g.connect(out);
        o.start(t); lfo.start(t); o.stop(t + 0.65); lfo.stop(t + 0.65);
        break;
      }
      case "chicken": for (let i = 0; i < 3; i++) this.tone(out, t + i * 0.08, "square", 900 * p * low, 700 * p * low, 0.05, 0.12); break;
      case "zombie": this.tone(out, t, "sawtooth", 110 * p * low, 80 * p * low, 0.9, 0.3, 0.2); this.noiseBurst(out, t, 0.8, "lowpass", 500, 1, 0.2); break;
      case "skeleton": for (let i = 0; i < 4; i++) this.noiseBurst(out, t + i * 0.05, 0.03, "bandpass", 2500, 4, 0.5); break;
      case "creeper": this.noiseBurst(out, t, 0.4, "highpass", 2000, 0.8, 0.4); break;
      case "spider": this.noiseBurst(out, t, 0.3, "bandpass", 1600, 3, 0.4, 0.6); this.tone(out, t, "square", 200, 150, 0.2, 0.1); break;
      // A wet slap: a low thump under a short band of noise, pitched by the slime's size.
      case "slime": this.tone(out, t, "sine", 180 * p * low, 90 * p * low, 0.15, 0.4); this.noiseBurst(out, t, 0.12, "bandpass", 700 * p, 2, 0.35, 0.8); break;
      // The villager's "hmm": a nasal hum that rises for yes, falls for no, and wobbles otherwise.
      case "villager": {
        const [from, to] = what === "yes" ? [190, 260] : what === "no" ? [230, 150] : [210 * low, 180 * low];
        this.tone(out, t, "sawtooth", from * p, to * p, what === "death" ? 0.6 : 0.35, 0.18, 0.05);
        this.tone(out, t, "square", from * 2 * p, to * 2 * p, 0.3, 0.05, 0.05);
        break;
      }
      // Piglins snort; the zombified ones grunt lower and wetter.
      case "piglin": case "zombified_piglin": {
        const z = kind === "zombified_piglin" ? 0.7 : 1;
        const f = (what === "admire" ? 1.3 : 1) * z * p * low;
        this.tone(out, t, "sawtooth", 260 * f, 170 * f, 0.18, 0.22);
        this.tone(out, t + 0.1, "sawtooth", 230 * f, 150 * f, 0.16, 0.18);
        this.noiseBurst(out, t, 0.15, "lowpass", 700 * z, 1, 0.25);
        break;
      }
      case "hoglin": this.tone(out, t, "sawtooth", 110 * p * low, 70 * p * low, 0.4, 0.3, 0.05); this.noiseBurst(out, t, 0.3, "lowpass", 400, 1, 0.3); break;
      case "wither_skeleton": for (let i = 0; i < 4; i++) this.noiseBurst(out, t + i * 0.06, 0.04, "bandpass", 1400, 4, 0.5); break;
      // A ghast's long mournful cry; a shriek when hurt; a cough of fire when it spits.
      case "ghast":
        if (what === "shoot") { this.noiseBurst(out, t, 0.5, "lowpass", 1200, 0.8, 0.6, 0.7); this.tone(out, t, "sawtooth", 160, 60, 0.4, 0.3); }
        else if (what === "warn" || what === "hurt") this.tone(out, t, "triangle", 900 * p, 1300 * p, 0.6, 0.25, 0.05);
        else { this.tone(out, t, "sine", 520 * p * low, 380 * p * low, 1.6, 0.18, 0.3); this.tone(out, t + 0.2, "sine", 780 * p * low, 540 * p * low, 1.4, 0.08, 0.3); }
        break;
      // Blazes breathe in rasps of fire.
      case "blaze":
        if (what === "shoot") this.noiseBurst(out, t, 0.3, "bandpass", 1800, 0.8, 0.5, 0.4);
        else if (what === "charge") this.noiseBurst(out, t, 0.8, "highpass", 2500, 0.6, 0.35, 1.2);
        else { this.noiseBurst(out, t, 0.6, "bandpass", 700, 1.5, 0.35, 0.8); this.tone(out, t, "square", 120 * p, 90 * p, 0.3, 0.08); }
        break;
      case "magma": case "magma_cube":
        this.tone(out, t, "sine", 120 * p * low, 60 * p * low, 0.2, 0.45);
        this.noiseBurst(out, t, 0.15, "lowpass", 500 * p, 2, 0.4, 0.8);
        break;
      // Clanking iron: a hollow knock under metallic ringing.
      case "iron_golem":
        this.tone(out, t, "square", 90 * low, 60 * low, 0.3, 0.3);
        this.noiseBurst(out, t, 0.25, "bandpass", 1800, 5, 0.4);
        this.tone(out, t, "sine", 1250 * p, 1240 * p, 0.5, 0.08);
        break;
    }
  }

  /** Ongoing rain, 0..1. */
  setRain(level: number): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    if (level > 0 && !this.rainNode) {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = "lowpass"; f.frequency.value = 2200;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(f); f.connect(g); g.connect(this.sfx);
      src.start();
      this.rainNode = { src, gain: g };
    }
    if (this.rainNode) {
      this.rainNode.gain.gain.setTargetAtTime(level * 0.12, ctx.currentTime, 0.5);
      if (level <= 0.001) {
        const node = this.rainNode;
        setTimeout(() => { try { node.src.stop(); } catch { /* already stopped */ } }, 2000);
        this.rainNode = null;
      }
    }
  }

  /** Called every second or so; starts a short generative piece now and then. */
  tickMusic(dt: number, calm: boolean): void {
    if (!this.ready() || this.volumes.music <= 0) return;
    this.nextMusic -= dt;
    if (this.nextMusic > 0 || this.musicPlaying) return;
    this.nextMusic = 180 + Math.random() * 240;
    this.playPiece(calm);
  }

  private playPiece(calm: boolean): void {
    const ctx = this.ctx!;
    this.musicPlaying = true;
    const roots = calm ? [196, 220, 261.6, 174.6] : [146.8, 164.8];
    const root = roots[Math.floor(Math.random() * roots.length)];
    const scale = [0, 2, 4, 7, 9, 12, 14, 16, 19];
    let t = ctx.currentTime + 0.5;
    const notes = 24 + Math.floor(Math.random() * 16);
    let idx = Math.floor(Math.random() * 4);
    for (let i = 0; i < notes; i++) {
      idx = Math.max(0, Math.min(scale.length - 1, idx + Math.floor(Math.random() * 5) - 2));
      const f = root * Math.pow(2, scale[idx] / 12);
      this.pianoNote(f, t, 0.12 + Math.random() * 0.06);
      if (i % 4 === 0) this.pianoNote(root / 2 * Math.pow(2, scale[Math.floor(Math.random() * 3)] / 12), t, 0.08);
      t += [0.6, 0.9, 1.2, 1.8][Math.floor(Math.random() * 4)];
    }
    setTimeout(() => { this.musicPlaying = false; }, (t - ctx.currentTime + 4) * 1000);
  }

  private pianoNote(freq: number, t: number, gain: number): void {
    const ctx = this.ctx!;
    for (const [mult, g0, type] of [[1, 1, "triangle"], [2, 0.3, "sine"], [3, 0.1, "sine"]] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq * mult;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain * g0, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 2.8);
      o.connect(g); g.connect(this.music);
      o.start(t); o.stop(t + 3);
    }
  }

  private ready(): boolean {
    return this.enabled && !!this.ctx && this.ctx.state === "running";
  }

  dispose(): void {
    if (this.rainNode) { try { this.rainNode.src.stop(); } catch { /* stopped */ } }
    void this.ctx?.close();
    this.ctx = null;
  }
}

