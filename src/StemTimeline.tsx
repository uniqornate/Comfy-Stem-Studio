import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, Pause, Play, RotateCcw, ZoomIn, ZoomOut, Maximize2, Minimize2, Repeat2, LockKeyhole, X, ChevronDown, ChevronRight, Crosshair, ScanSearch, Film, Scissors } from 'lucide-react';
import { fitEdit as channelEdit, splitEdit, trimEdit, gainEdit, gainAt, type ChannelEdit } from './clip-edits.mjs';
import { pointerTime } from './timeline-geometry.mjs';
import { groupedTracks, initialMix } from './detail-groups.mjs';
import { WaveformKnob } from './WaveformKnob';
import type { Stem, TimelineView } from './types';
import { MediaTransport, type TransportState } from './media-transport.mjs';

type Mix = { mute: boolean; solo: boolean; level: number };
type Track = { stem: Stem; buffer: AudioBuffer; peaks: number[]; path: string };
type Props = { initialView?: TimelineView; onViewChange: (view: TimelineView) => void; stems: Stem[]; save: (id?: string) => void; exporting: boolean; independent?: boolean; transport: MediaTransport; playback: TransportState; exportVideo: (mix: Record<string, Mix>) => void; expanded: boolean; toggleExpanded: () => void; resize: (delta: number) => void; resetSize: () => void; workspaceHeight: number; resizeBounds: { min: number; max: number }; details: (stem: Stem, start: number, end: number, picker: boolean) => void; detailBusy: boolean; detailAvailable: boolean };
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
function peaks(buffer: AudioBuffer) {
  const count = Math.min(2200, buffer.length), result = new Array(count).fill(0);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const pcm = buffer.getChannelData(ch);
    for (let i = 0; i < pcm.length; i++) { const index = Math.min(count - 1, Math.floor(i * count / pcm.length)); result[index] = Math.max(result[index], Math.abs(pcm[i])); }
  }
  return result;
}
export function StemTimeline({ initialView, onViewChange, stems, save, exporting, independent = false, transport, playback, exportVideo, expanded, toggleExpanded, resize, resetSize, workspaceHeight, resizeBounds, details, detailBusy, detailAvailable }: Props) {
  const [tracks, setTracks] = useState<Track[]>([]), [mix, setMix] = useState<Record<string, Mix>>(initialView?.mix || {});
  const mixRef = useRef(mix); mixRef.current = mix;
  const cache = useRef(new Map<string, Track>());
  const [edits, setEdits] = useState<Record<string, ChannelEdit>>(initialView?.edits || {});
  const editsRef = useRef(edits); editsRef.current = edits;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(initialView?.collapsed || []));
  const [menu, setMenu] = useState<{ stem: Stem; at: number; x: number; y: number } | null>(null);
  const [waveHeight, setWaveHeight] = useState(Math.max(.1, Math.min(1, initialView?.waveHeight ?? .7))), [zoom, setZoom] = useState(Math.max(1, Math.min(8, initialView?.zoom || 1)));
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [panning, setPanning] = useState(false);
  const { position, duration, playing, selection, loopLocked } = playback;
  const section = useRef<HTMLElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const viewRef = useRef<TimelineView>({ mix, collapsed: [...collapsed], zoom, waveHeight, scrollLeft: initialView?.scrollLeft || 0, scrollTop: initialView?.scrollTop || 0 });
  viewRef.current = { ...viewRef.current, mix, edits, collapsed: [...collapsed], zoom, waveHeight };
  useEffect(() => { onViewChange(viewRef.current); }, [mix, edits, collapsed, zoom, waveHeight, onViewChange]);
  useEffect(() => { if (scroll.current && !loading) { scroll.current.scrollLeft = viewRef.current.scrollLeft; scroll.current.scrollTop = viewRef.current.scrollTop; } }, [loading]);
  const editDrag = useRef<{ kind: 'gain' | 'start' | 'end'; stem: Stem; id?: string; y: number; db: number; initial: ChannelEdit; rect: DOMRect } | null>(null);
  const [gainDragging, setGainDragging] = useState(false);
  const gesture = useRef<{ kind: 'seek' | 'select'; anchor: number } | null>(null);
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const resizeY = useRef<number | null>(null);
  const rangeStyle = { left: `${duration && selection ? selection.start / duration * 100 : 0}%`, width: `${duration && selection ? (selection.end - selection.start) / duration * 100 : 0}%` };
  const signature = stems.map(stem => stem.id).join(',');
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent) => { if (!(event.target as Element)?.closest('.timeline-context-menu')) setMenu(null); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null); };
    window.addEventListener('pointerdown', dismiss); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', dismiss); window.removeEventListener('keydown', key); };
  }, [menu]);
  useEffect(() => {
    transport.pause(); transport.setAudio(null, [], {}); setTracks([]); setError(''); setMenu(null);
    for (const id of cache.current.keys()) if (!stems.some(stem => stem.id === id)) cache.current.delete(id);
    const previousMix = mixRef.current;
    if (!stems.length) { setLoading(false); setMix({}); return; }
    let disposed = false; const controller = new AbortController(), ctx = new AudioContext(); setLoading(true);
    (async () => {
      const decoded: Track[] = []; let memory = 0;
      for (const stem of stems) {
        if (stem.missing) continue;
        const cached = cache.current.get(stem.id);
        let track = cached;
        if (!track) {
          const response = await fetch(stem.url, { signal: controller.signal });
          if (!response.ok) throw Error(`Could not load ${stem.label} waveform.`);
          const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
          if (disposed) return;
          const data = peaks(buffer), peak = Math.max(0.000001, ...data);
          const path = data.map((value, i) => `M${i},${40 - Math.min(1, value / peak) * 40}v${Math.min(1, value / peak) * 80}`).join(' ');
          track = { stem, buffer, peaks: data, path };
        }
        memory += track.buffer.length * track.buffer.numberOfChannels * 4;
        if (memory > 768 * 1024 * 1024) throw Error('Preview memory limit reached. Download channels instead.');
        cache.current.set(stem.id, track); decoded.push(track);
      }
      if (!disposed) { const next = initialMix(stems, previousMix, independent); setTracks(decoded); setMix(next); transport.setAudio(ctx, decoded, next); }
    })().catch(cause => { if (!disposed) setError(cause.message); }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; controller.abort(); transport.pause(); transport.setAudio(null, [], {}); void ctx.close(); };
  }, [signature, independent, transport]);
  useEffect(() => { transport.setMix(mix); }, [mix, transport]);
  useEffect(() => { transport.setEdits(edits); }, [edits, transport]);
  const splitAll = useRef(() => {});
  splitAll.current = () => setEdits(previous => Object.fromEntries(stems.map(stem => [stem.id, splitEdit(previous[stem.id], transport.snapshot().position, duration)])));
  useEffect(() => { const key = (event: KeyboardEvent) => { if (!event.ctrlKey || event.key.toLowerCase() !== 'b' || event.repeat || document.querySelector('.modal-backdrop')) return; if ((event.target as HTMLElement)?.matches('input,textarea,[contenteditable=true]')) return; event.preventDefault(); splitAll.current(); }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [transport]);
  function editStart(event: React.PointerEvent<HTMLElement>, stem: Stem, kind: 'gain' | 'start' | 'end', id?: string) {
    if (event.button !== 0 || !duration) return;
    event.preventDefault(); event.stopPropagation();
    const lane = event.currentTarget.closest('.waveform-lane') as HTMLElement;
    const initial = channelEdit(editsRef.current[stem.id], duration);
    editDrag.current = { kind, stem, id, y: event.clientY, db: gainAt(initial, selection ? (selection.start + selection.end) / 2 : position), initial, rect: lane.getBoundingClientRect() };
    event.currentTarget.setPointerCapture(event.pointerId); setGainDragging(kind === 'gain');
  }
  function editMove(event: React.PointerEvent<HTMLElement>) {
    const drag = editDrag.current; if (!drag) return; event.stopPropagation();
    const next = drag.kind === 'gain' && selection ? gainEdit(drag.initial, selection.start, selection.end, drag.db + (drag.y - event.clientY) / 2, duration) : trimEdit(drag.initial, drag.id!, drag.kind, pointerTime(event.clientX, drag.rect.left, drag.rect.width, duration), duration);
    setEdits(previous => ({ ...previous, [drag.stem.id]: next }));
  }
  function editEnd(event: React.PointerEvent<HTMLElement>) { if (!editDrag.current) return; event.stopPropagation(); editDrag.current = null; setGainDragging(false); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }
  const seek = (at: number) => transport.seek(at);
  function point(event: React.PointerEvent<HTMLElement>) { const rect = event.currentTarget.getBoundingClientRect(); return pointerTime(event.clientX, rect.left, rect.width, duration); }
  function seekPointer(event: React.PointerEvent<HTMLElement>) {
    if (event.button !== 0 || gesture.current || pan.current || editDrag.current) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    const at = point(event); gesture.current = { kind: event.shiftKey ? 'select' : 'seek', anchor: at };
    if (event.shiftKey) transport.setSelection(at, at); else seek(at);
  }
  function dragSeek(event: React.PointerEvent<HTMLElement>) {
    if (!gesture.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    if (gesture.current.kind === 'select') transport.setSelection(gesture.current.anchor, point(event)); else seek(point(event));
  }
  function endSeek(event: React.PointerEvent<HTMLElement>) {
    if (!gesture.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const selecting = gesture.current.kind === 'select'; dragSeek(event); gesture.current = null; event.currentTarget.releasePointerCapture(event.pointerId);
    if (selecting) void transport.commitSelection();
  }
  function panStart(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 1 || gesture.current || pan.current) return;
    event.preventDefault(); event.stopPropagation(); pan.current = { x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop }; event.currentTarget.setPointerCapture(event.pointerId); setPanning(true);
  }
  function panMove(event: React.PointerEvent<HTMLDivElement>) { if (!pan.current) return; event.preventDefault(); event.stopPropagation(); event.currentTarget.scrollLeft = pan.current.left + pan.current.x - event.clientX; event.currentTarget.scrollTop = pan.current.top + pan.current.y - event.clientY; }
  function panEnd(event: React.PointerEvent<HTMLDivElement>) { if (!pan.current) return; event.preventDefault(); event.stopPropagation(); pan.current = null; setPanning(false); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }
  function lockLoop() { transport.setLoopLocked(!loopLocked); if (!loopLocked && !playing) void transport.play(); }
  function toggle(id: string, key: 'mute' | 'solo') { setMix(values => ({ ...values, [id]: { ...values[id], [key]: !values[id]?.[key] } })); }
  function context(event: React.MouseEvent<HTMLElement>, stem: Stem) { event.preventDefault(); const lane = event.currentTarget.closest('.timeline-track')?.querySelector('.waveform-lane'); const rect = lane?.getBoundingClientRect(); const at = rect && event.currentTarget.classList.contains('waveform-lane') ? pointerTime(event.clientX, rect.left, rect.width, duration) : position; setMenu({ stem, at, x: Math.max(4, Math.min(event.clientX, window.innerWidth - 235)), y: Math.max(4, Math.min(event.clientY, window.innerHeight - 265)) }); }
  const rows = groupedTracks(stems, collapsed).map(row => ({ ...row, track: tracks.find(track => track.stem.id === row.stem.id) })).filter(row => !!row.track);
  const ticks = Array.from({ length: 11 }, (_, i) => duration * i / 10);
  return <section ref={section} style={{ '--wave-height': waveHeight } as React.CSSProperties} className={`panel multitrack ${panning ? 'is-panning' : ''}`} aria-label="Stem timeline">
    {!expanded && <div className="timeline-resize-handle" role="separator" aria-orientation="horizontal" aria-label="Resize timeline" aria-valuemin={Math.round(resizeBounds.min)} aria-valuemax={Math.round(resizeBounds.max)} aria-valuenow={Math.round(workspaceHeight)} tabIndex={0} title="Drag to resize. Double-click to reset."
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); resizeY.current = event.clientY; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (resizeY.current === null) return; const delta = event.clientY - resizeY.current; resizeY.current = event.clientY; resize(delta); }}
      onPointerUp={event => { resizeY.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancel={() => { resizeY.current = null; }} onLostPointerCapture={() => { resizeY.current = null; }} onDoubleClick={resetSize}
      onKeyDown={event => { if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) { event.preventDefault(); resize(event.key === 'Home' ? -100000 : event.key === 'End' ? 100000 : event.key === 'ArrowUp' ? -24 : 24); } }}/>} 
    <div className="timeline-toolbar">
      <div className="toolbar-bank transport-bank"><button className="transport-play" disabled={!duration} onClick={() => void transport.toggle()} aria-label={playing ? 'Pause all tracks' : 'Play all tracks'}>{playing ? <Pause size={15}/> : <Play size={15}/>}</button><button className="icon-button" onClick={() => seek(0)} aria-label="Return to start"><RotateCcw size={14}/></button><output>{clock(position)} <span>/ {clock(duration)}</span></output></div>
      <div className="toolbar-bank range-bank">{selection ? <><output>{clock(selection.start)} → {clock(selection.end)}</output><button className={`icon-button loop-lock ${loopLocked ? 'is-active' : ''}`} aria-label="Loop-lock selection" aria-pressed={loopLocked} title={loopLocked ? 'Unlock loop' : 'Loop selected range'} onClick={lockLoop}><Repeat2 size={14}/>{loopLocked && <LockKeyhole size={9}/>}</button><button className="icon-button" aria-label="Clear selection" onClick={() => transport.clearSelection()}><X size={12}/></button></> : <span className="subtle">Shift + drag to loop</span>}</div>
      <div className="toolbar-bank view-bank"><button className="icon-button timeline-expand" aria-label={expanded ? 'Restore workspace layout' : 'Expand timeline'} aria-pressed={expanded} onClick={toggleExpanded}>{expanded ? <Minimize2 size={15}/> : <Maximize2 size={15}/>}</button><WaveformKnob value={waveHeight} onChange={setWaveHeight} onPreview={value => section.current?.style.setProperty("--wave-height", String(value))}/><span className="tool-divider"/><button className="icon-button" disabled={zoom <= 1} onClick={() => setZoom(value => Math.max(1, value / 2))} aria-label="Zoom out"><ZoomOut size={15}/></button><output>{zoom}×</output><button className="icon-button" disabled={zoom >= 8} onClick={() => setZoom(value => Math.min(8, value * 2))} aria-label="Zoom in"><ZoomIn size={15}/></button></div>
      <div className="toolbar-bank export-bank"><button disabled={exporting || !stems.length} onClick={() => exportVideo(mix)} title="Export video"><Film size={14}/><span>Video</span></button><button disabled={exporting || !stems.length} onClick={() => save()} title="Download all channels"><ArrowDownToLine size={14}/><span>Stems</span></button></div>
    </div>
    <div className="timeline-status"><span>CHANNELS / {stems.length}</span>{loading && <span role="status">Reading waveforms…</span>}</div>
    {stems.some(stem => stem.missing) && <p className="helper" role="status">Missing channels: {stems.filter(stem => stem.missing).map(stem => stem.label).join(", ")}. Project references are retained.</p>}{error && <p className="error-banner" role="alert">{error}</p>}
    {error && !tracks.length && <div className="timeline-export-fallback">{stems.map(stem => <button className="quiet-button" key={stem.id} disabled={exporting} onClick={() => save(stem.id)}><ArrowDownToLine size={13}/>{stem.label}</button>)}</div>}
    <input className="timeline-scrub" type="range" min="0" max={duration || 1} step="0.01" value={position} onChange={event => seek(Number(event.target.value))} aria-label="Timeline playhead"/>
    <div ref={scroll} className="timeline-scroll" onScroll={event => { setMenu(null); viewRef.current = { ...viewRef.current, scrollLeft: event.currentTarget.scrollLeft, scrollTop: event.currentTarget.scrollTop }; onViewChange(viewRef.current); }} onPointerDownCapture={panStart} onPointerMoveCapture={panMove} onPointerUpCapture={panEnd} onPointerCancelCapture={panEnd} onLostPointerCapture={event => { if (event.target === scroll.current) { pan.current = null; setPanning(false); } }} onAuxClick={event => { if (event.button === 1) event.preventDefault(); }}><div className="timeline-grid" style={{ width: `${zoom * 100}%`, minWidth: '100%' }}>
      <div className="track-ruler-label">CHANNEL / MIX</div><div className="track-ruler" onPointerDown={seekPointer} onPointerMove={dragSeek} onPointerUp={endSeek} onPointerCancel={() => { gesture.current = null; }} onLostPointerCapture={() => { gesture.current = null; }}>{selection && <div className="timeline-selection" style={rangeStyle}/>} {ticks.map((value, index) => <span key={index} style={{ left: `${index * 10}%` }}>{clock(value)}</span>)}</div>
      {rows.map(({ stem, track, depth, color }, index) => { const { buffer, peaks: data, path } = track!; const hasChildren = stems.some(child => child.parentId === stem.id); return <div className={`timeline-track track-color-${color} ${depth ? 'is-child' : ''} ${mix[stem.id]?.mute ? 'is-muted' : ''}`} key={stem.id}>
        <div className="track-controls" style={{ paddingLeft: 10 + Math.min(depth, 4) * 12 }} onContextMenu={event => context(event, stem)}><div className="track-name">{hasChildren && <button className="group-fold" aria-label={`${collapsed.has(stem.id) ? 'Expand' : 'Collapse'} ${stem.label} details`} aria-expanded={!collapsed.has(stem.id)} onClick={() => setCollapsed(previous => { const next = new Set(previous); next.has(stem.id) ? next.delete(stem.id) : next.add(stem.id); return next; })}>{collapsed.has(stem.id) ? <ChevronRight size={12}/> : <ChevronDown size={12}/>}</button>}<span className="track-number">{String(index + 1).padStart(2, '0')}</span><strong title={stem.label}>{stem.label}</strong><button className="icon-button" disabled={exporting} onClick={() => save(stem.id)} aria-label={`Download ${stem.label}`}><ArrowDownToLine size={14}/></button></div><div className="track-mix"><button className={mix[stem.id]?.mute ? 'is-active' : ''} aria-pressed={!!mix[stem.id]?.mute} onClick={() => toggle(stem.id, 'mute')} aria-label={`Mute ${stem.label}`}>M</button><button className={mix[stem.id]?.solo ? 'is-active' : ''} aria-pressed={!!mix[stem.id]?.solo} onClick={() => setMix(values => ({ ...values, [stem.id]: { ...values[stem.id], solo: !values[stem.id]?.solo, mute: values[stem.id]?.solo ? values[stem.id].mute : false } }))} aria-label={`Solo ${stem.label}`}>S</button><input type="range" min="0" max="1" step="0.01" value={mix[stem.id]?.level ?? 1} aria-label={`${stem.label} level`} onChange={event => setMix(values => ({ ...values, [stem.id]: { ...values[stem.id], level: Number(event.target.value) } }))}/><small>{buffer.numberOfChannels === 1 ? 'MONO' : `${buffer.numberOfChannels}CH`} · {(buffer.sampleRate / 1000).toFixed(1)}k</small></div></div>
        <div className="waveform-lane" onContextMenu={event => context(event, stem)} onPointerDown={seekPointer} onPointerMove={event => { dragSeek(event); const at=point(event); event.currentTarget.classList.toggle('over-selected',!!selection && at>=selection.start && at<=selection.end); }} onPointerLeave={event => event.currentTarget.classList.remove('over-selected')} onPointerUp={endSeek} onPointerCancel={() => { gesture.current = null; }} onLostPointerCapture={() => { gesture.current = null; }}>
          {channelEdit(edits[stem.id], duration).clips.map(clip => <div key={clip.id} className="waveform-clip editable-clip" style={{ left: `${clip.start / duration * 100}%`, width: `${(clip.end - clip.start) / duration * 100}%` }}><span>{stem.label} · FLAC</span><svg viewBox={`${clip.start / Math.max(buffer.duration,.001) * data.length} 0 ${(clip.end-clip.start) / Math.max(buffer.duration,.001) * data.length} 80`} preserveAspectRatio="none" aria-label={`${stem.label} audio waveform`}><path style={{ transform: 'scaleY(var(--wave-height, .7))', transformOrigin: 'center', transformBox: 'view-box' }} d={path} fill="none" stroke="currentColor" strokeWidth="1"/></svg>{(['start','end'] as const).map(edge => <div key={edge} className={`clip-edge clip-edge-${edge}`} role="separator" aria-label={`Trim ${stem.label} ${edge}`} onPointerDown={event => editStart(event,stem,edge,clip.id)} onPointerMove={editMove} onPointerUp={editEnd} onPointerCancel={editEnd} onLostPointerCapture={editEnd}/>)}</div>)}
          {selection && <><div className="timeline-selection" style={rangeStyle}/><div className={`range-gain ${gainDragging ? 'is-dragging' : ''}`} style={{ ...rangeStyle, top: `${Math.max(14, Math.min(85, 50 - gainAt(edits[stem.id],(selection.start+selection.end)/2))) }%` }} title="Drag vertically to adjust selected range gain. Double-click to reset." onPointerDown={event => editStart(event,stem,'gain')} onPointerMove={editMove} onPointerUp={editEnd} onPointerCancel={editEnd} onLostPointerCapture={editEnd} onDoubleClick={event => { event.stopPropagation(); setEdits(previous => ({ ...previous, [stem.id]: gainEdit(previous[stem.id],selection.start,selection.end,0,duration) })); }}><span>{gainAt(edits[stem.id],(selection.start+selection.end)/2).toFixed(1)} dB</span></div></>}<div className="timeline-playhead" style={{ left: `clamp(0px, ${duration ? Math.min(100, position / duration * 100) : 0}%, calc(100% - 1px))` }}/>
        </div>
      </div>; })}
      {!tracks.length && <p className="timeline-loading">{loading ? 'Preparing waveform lanes…' : 'Separate stems to see waveform lanes.'}</p>}
    </div></div>
    {menu && <div className="timeline-context-menu" role="menu" aria-label={`${menu.stem.label} actions`} style={{ left: menu.x, top: menu.y }}><small>{menu.stem.label}{selection ? ` · ${clock(selection.start)} → ${clock(selection.end)}` : ' · whole channel'}</small><button role="menuitem" disabled={!duration || detailBusy || !detailAvailable} onClick={() => { details(menu.stem, selection?.start || 0, selection?.end || duration, false); setMenu(null); }}><ScanSearch size={14}/> Extract details <span>USS Auto</span></button><button role="menuitem" disabled={!duration || detailBusy || !detailAvailable} onClick={() => { details(menu.stem, selection?.start || 0, selection?.end || duration, true); setMenu(null); }}><Crosshair size={14}/> Extract sound…</button><button role="menuitem" disabled={!duration} onClick={() => { setEdits(previous => ({ ...previous, [menu.stem.id]: splitEdit(previous[menu.stem.id], menu.at, duration) })); setMenu(null); }}><Scissors size={14}/> Split channel <span>{clock(menu.at)}</span></button><button role="menuitem" onClick={() => { setEdits(previous => { const next = { ...previous }; delete next[menu.stem.id]; return next; }); setMenu(null); }}>Reset channel edits</button><button role="menuitem" disabled={exporting} onClick={() => { save(menu.stem.id); setMenu(null); }}><ArrowDownToLine size={14}/> Download channel</button></div>}
  </section>;
}
