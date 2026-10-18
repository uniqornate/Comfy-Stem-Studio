const bounded = (value, max) => Math.max(0, Math.min(Number.isFinite(value) ? value : 0, max));
import { audibleSegments } from './clip-edits.mjs';

// Video presentation time is the single transport authority. AudioBufferSources
// share one AudioContext start/offset and are re-aligned only on seek or drift.
export class MediaTransport {
  constructor(options = {}) {
    this.requestFrame = options.requestFrame || (callback => requestAnimationFrame(callback));
    this.cancelFrame = options.cancelFrame || (id => cancelAnimationFrame(id));
    this.video = null; this.context = null; this.tracks = []; this.mix = {};
    this.sources = []; this.gains = new Map(); this.listeners = new Set(); this.events = [];
    this.frame = null; this.generation = 0; this.buffering = false; this.mode = 'original'; this.error = '';
    this.anchor = null; this.scrubTarget = null; this.master = 1; this.playPending = false; this.selection = null; this.loopLocked = false; this.wantsPlayback = false;
  }
  snapshot() {
    if (this.pendingRestore) return { ...this.pendingRestore, playing: false, buffering: false, mode: this.mode, error: this.error };
    const duration = Number.isFinite(this.video?.duration) ? this.video.duration : 0;
    return { position: bounded(this.scrubTarget ?? (this.video?.currentTime || 0), duration), duration, playing: !!this.video && !this.video.paused && !this.video.ended, buffering: this.buffering, mode: this.mode, error: this.error, selection: this.selection ? { ...this.selection } : null, loopLocked: this.loopLocked };
  }
  subscribe(callback) { this.listeners.add(callback); callback(this.snapshot()); return () => this.listeners.delete(callback); }
  emit() { const value = this.snapshot(); this.listeners.forEach(callback => callback(value)); }
  attachVideo(video) {
    if (this.video === video) return;
    this.pause(); this.events.forEach(([name, fn]) => this.video?.removeEventListener(name, fn)); this.events = [];
    this.video = video; this.scrubTarget = null; this.error = ''; this.buffering = false; this.selection = null; this.loopLocked = false;
    if (video) {
      const listen = (name, fn) => { video.addEventListener(name, fn); this.events.push([name, fn]); };
      listen('loadedmetadata', () => { this.applyRestore(); this.emit(); }); listen('durationchange', () => { this.applyRestore(); this.emit(); });
      listen('play', () => { this.emit(); this.loop(); });
      listen('playing', () => { this.buffering = false; this.alignAudio(); this.emit(); this.loop(); });
      listen('pause', () => { this.stopAudio(); this.stopLoop(); this.emit(); });
      listen('ended', () => { this.stopAudio(); this.stopLoop(); if (this.loopLocked && this.selection && this.wantsPlayback) { this.seek(this.selection.start); void this.play(); } else this.emit(); });
      listen('seeking', () => { this.stopAudio(); this.emit(); });
      listen('seeked', () => { if (this.scrubTarget !== null) { this.flushScrub(); return; } if (!video.paused) this.alignAudio(); this.emit(); });
      listen('waiting', () => { this.buffering = true; this.stopAudio(); this.emit(); });
      listen('ratechange', () => { if (!video.paused) this.alignAudio(); this.emit(); });
      listen('error', () => { this.scrubTarget = null; this.pause(); this.error = 'Video playback failed.'; this.emit(); });
      video.muted = this.mode === 'stems';
    }
    this.emit();
  }
  restore(state = {}) {
    this.pause();
    this.pendingRestore = { position: Math.max(0, Number(state.position) || 0), duration: Math.max(0, Number(state.duration) || 0), selection: state.selection || null, loopLocked: !!state.loopLocked };
    this.applyRestore(); this.emit();
  }
  applyRestore() {
    if (!this.pendingRestore || !this.video || !Number.isFinite(this.video.duration) || this.video.duration <= 0) return;
    const state = this.pendingRestore; this.pendingRestore = null;
    this.selection = null; this.loopLocked = false;
    if (state.selection) this.setSelection(state.selection.start, state.selection.end);
    this.loopLocked = !!state.loopLocked && !!this.selection;
    this.seek(state.position);
  }
  setAudio(context, tracks, mix) {
    this.stopAudio(); this.context = context; this.tracks = tracks; this.mix = mix;
    this.mode = tracks.length ? 'stems' : 'original';
    if (this.video) this.video.muted = this.mode === 'stems';
    if (this.video && !this.video.paused) this.alignAudio();
    this.emit();
  }
  setMix(mix) {
    this.mix = mix;
    const anySolo = Object.values(mix).some(value => value.solo);
    for (const [id, gain] of this.gains) {
      const state = mix[id];
      gain.gain.setTargetAtTime(state && !state.mute && (!anySolo || state.solo) ? state.level * this.master : 0, this.context.currentTime, 0.012);
    }
  }
  // Loudness compensation for A/B comparison; scales every channel without touching the mixer state.
  setMaster(gain) {
    this.master = Number.isFinite(gain) ? Math.max(0, Math.min(4, gain)) : 1;
    if (this.context) this.setMix(this.mix);
  }
  setEdits(edits) { this.edits = edits; if (this.video && !this.video.paused) this.alignAudio(); }
  setMode(mode) {
    if (mode === 'stems' && !this.tracks.length) return;
    this.mode = mode; this.video && (this.video.muted = mode === 'stems');
    this.alignAudio(); this.emit();
  }
  stopAudio() {
    this.sources.forEach(source => { try { source.stop(); } catch {} source.disconnect(); });
    this.sources = []; this.gains.forEach(gain => gain.disconnect()); this.gains.clear(); this.anchor = null;
  }
  alignAudio() {
    this.stopAudio();
    const ctx = this.context; const video = this.video;
    if (!ctx || ctx.state !== 'running' || !video || video.paused || video.ended || video.seeking || this.buffering || this.mode !== 'stems') return;
    const at = ctx.currentTime; const offset = video.currentTime; const rate = video.playbackRate || 1;
    this.anchor = { at, offset, rate };
    const anySolo = Object.values(this.mix).some(value => value.solo);
    for (const { stem, buffer } of this.tracks) {
      if (offset >= buffer.duration) continue;
      const gain = ctx.createGain(); const state = this.mix[stem.id];
      gain.gain.value = state && !state.mute && (!anySolo || state.solo) ? state.level * this.master : 0;
      gain.connect(ctx.destination); this.gains.set(stem.id, gain);
      if (!this.edits?.[stem.id]) {
        const source = ctx.createBufferSource(); source.buffer = buffer; source.playbackRate.value = rate; source.connect(gain);
        if (this.loopLocked && this.selection) source.start(at, offset, Math.max(0, this.selection.end - offset)); else source.start(at, offset);
        this.sources.push(source); continue;
      }
      for (const segment of audibleSegments(this.edits[stem.id], buffer.duration, offset, this.loopLocked && this.selection ? this.selection.end : buffer.duration)) {
        const source = ctx.createBufferSource(), envelope = ctx.createGain(); source.buffer = buffer; source.playbackRate.value = rate;
        envelope.gain.value = segment.gain; source.connect(envelope); envelope.connect(gain);
        source.onended = () => envelope.disconnect();
        source.start(at + (segment.start - offset) / rate, segment.start, segment.end - segment.start); this.sources.push(source);
      }
    }
  }
  async play() {
    const video = this.video; if (!video) return;
    const generation = ++this.generation; this.error = ''; this.playPending = true; this.wantsPlayback = true;
    try {
      if (this.context) await this.context.resume();
      if (generation !== this.generation || video !== this.video) return;
      if (this.loopLocked && this.selection && (video.currentTime < this.selection.start || video.currentTime >= this.selection.end)) this.seek(this.selection.start);
      else if (video.ended || video.currentTime >= video.duration) this.seek(0);
      await video.play();
      if (generation !== this.generation || video !== this.video) return;
      this.playPending = false; this.alignAudio(); this.emit(); this.loop();
    } catch (error) { if (generation === this.generation) { this.pause(); this.error = error.message; this.emit(); } }
  }
  pause() { this.generation++; this.playPending = false; this.wantsPlayback = false; this.video?.pause(); this.stopAudio(); this.stopLoop(); this.emit(); }
  toggle() { return (this.playPending || (this.video && !this.video.paused)) ? this.pause() : this.play(); }
  // Dragging a slider fires far more seeks than a video can decode. Only the newest target is kept while a seek is
  // in flight, so frames keep appearing during the drag instead of only after it stops.
  scrub(value) {
    if (!this.video) return;
    let position = bounded(value, this.snapshot().duration);
    if (this.loopLocked && this.selection && (position < this.selection.start || position >= this.selection.end)) position = this.selection.start;
    this.stopAudio(); this.scrubTarget = position;
    if (!this.video.seeking) this.flushScrub();
    this.emit();
  }
  flushScrub() {
    if (this.scrubTarget === null || !this.video) return;
    const target = this.scrubTarget; this.scrubTarget = null;
    this.video.currentTime = target; this.emit();
  }
  seek(value) {
    if (!this.video) return;
    this.scrubTarget = null;
    let position = bounded(value, this.snapshot().duration);
    if (this.loopLocked && this.selection && (position < this.selection.start || position >= this.selection.end)) position = this.selection.start;
    this.stopAudio(); this.video.currentTime = position;
    if (!this.video.paused && !this.video.seeking) this.alignAudio();
    this.emit();
  }
  setSelection(from, to) {
    if (!Number.isFinite(from) || !Number.isFinite(to)) return;
    const duration = this.snapshot().duration;
    const start = bounded(Math.min(from, to), duration), end = bounded(Math.max(from, to), duration);
    const wasLocked = this.loopLocked;
    this.selection = end - start >= 0.02 ? { start, end } : null; this.loopLocked = false;
    if (wasLocked) this.alignAudio(); this.emit();
  }
  commitSelection() { if (!this.selection) return; this.setLoopLocked(true); return this.play(); }
  clearSelection() { this.selection = null; this.loopLocked = false; this.alignAudio(); this.emit(); }
  setLoopLocked(locked) {
    this.loopLocked = !!locked && !!this.selection;
    if (this.loopLocked) this.seek(this.selection.start); else { this.alignAudio(); this.emit(); }
  }
  loop() {
    if (this.frame !== null || !this.video || this.video.paused || this.video.ended) return;
    this.frame = this.requestFrame(() => { this.frame = null; this.tick(); this.loop(); });
  }
  tick() {
    if (this.loopLocked && this.selection && this.video && !this.video.paused && !this.video.seeking && (this.video.currentTime >= this.selection.end || this.video.currentTime < this.selection.start)) { this.seek(this.selection.start); return; }
    if (this.anchor && this.context && this.video && !this.video.paused && !this.video.seeking && !this.buffering) {
      const expected = this.anchor.offset + (this.context.currentTime - this.anchor.at) * this.anchor.rate;
      if (Math.abs(expected - this.video.currentTime) > 0.08) this.alignAudio();
    }
    this.emit();
  }
  stopLoop() { if (this.frame !== null) this.cancelFrame(this.frame); this.frame = null; }
  dispose() { this.attachVideo(null); this.listeners.clear(); }
}
