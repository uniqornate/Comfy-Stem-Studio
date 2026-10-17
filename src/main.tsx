import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AudioLines, ArrowLeft, Mic, SlidersHorizontal, Sparkles, ArrowUpRight, Check, Clapperboard, FolderOpen, Link2, LoaderCircle, Plus, Save, Settings2, ShieldCheck, Play, Pause, ZoomIn, ZoomOut, X } from 'lucide-react';
import type { Connection, Profile, Source, ProxyState, Engine, StemJob, ExportState, Stem, SAMGuidance, ProjectInfo, ProjectSession, ProjectPayload, TimelineView, ReferenceAudio } from './types';
import './styles.css';
const comfyWordmark = new URL('./assets/comfy/comfy-wordmark.svg', import.meta.url).href;
const comfyIcon = comfyWordmark;
import { DetailPicker, type DetailRequest } from './DetailPicker';
import { StemTimeline } from './StemTimeline';
import { workspaceTop } from './timeline-geometry.mjs';
import { preferences } from './workspace-preferences.mjs';
import { ResourceMonitor } from './ResourceMonitor';
import { MediaTransport } from './media-transport.mjs';
import { TooltipLayer } from './Tooltip';
import { PreviewFooter } from './PreviewFooter';
import { useCoarsePlayback } from './usePlayback';
import { ModelPicker } from './ModelPicker';
import { ModelModal } from './ModelModal';
import { MODELS, modelName } from './models.mjs';
import { SAMPrepare, SAMVariantSwitch, useSAMStatus } from './SAMPrepare';
import { SAMGuidanceEditor } from './SAMGuidanceEditor';
import { GuideSepPanel, useGuideSepStatus } from './GuideSepPanel';
import { normalizeGuidance } from './sam-guidance.mjs';
const STEM_MODELS = ['mrx', 'bandit', 'sfc'];
const AUDIO_SOURCE = /\.(mp3|wav|flac|m4a|aac|ogg|opus)$/i;

const initial: Profile = { comfyUrl: 'http://127.0.0.1:8188', proxyUrl: 'http://127.0.0.1:8189', installation: '', managedProxy: false, setupComplete: false };
function App() {
  const [remembered] = useState(() => { try { return preferences(localStorage.getItem('workspacePreferences')); } catch { return preferences(null); } });
  const [profile, setProfile] = useState(initial);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [settings, setSettings] = useState(true);
  const [busy, setBusy] = useState(false);
  const [proxyState, setProxyState] = useState<ProxyState | null>(null);
  const [preparingProxy, setPreparingProxy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveNotice, setSaveNotice] = useState('');
  const [error, setError] = useState('');
  const [source, setSource] = useState<Source | null>(null);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [recent, setRecent] = useState<ProjectInfo[]>([]);
  const [projectName, setProjectName] = useState('');
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectStatus, setProjectStatus] = useState('Loading project…');
  const timelines = useRef<Record<string, TimelineView>>({});
  const session = useRef<ProjectPayload | null>(null);
  const switching = useRef(false);
  const pendingTransport = useRef<ProjectSession['view']['transport'] | null>(null);
  const [mediaError, setMediaError] = useState(false);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [job, setJob] = useState<StemJob>({ phase: 'idle', message: '', stems: [], canCancel: false });
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const [workspaceShare, setWorkspaceShare] = useState(0.46);
  const [workspaceAvailable, setWorkspaceAvailable] = useState(Math.max(0, window.innerHeight - 80));
  const workspaceMain = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!workspaceMain.current) return;
    const observer = new ResizeObserver(entries => setWorkspaceAvailable(entries[0].contentRect.height));
    observer.observe(workspaceMain.current); return () => observer.disconnect();
  }, []);
  const topHeight = workspaceTop(workspaceAvailable, workspaceAvailable * workspaceShare);
  function resizeWorkspace(delta: number) { setWorkspaceShare(previous => workspaceAvailable ? workspaceTop(workspaceAvailable, workspaceTop(workspaceAvailable, workspaceAvailable * previous) + delta) / workspaceAvailable : previous); }
  const [layoutZoom, setLayoutZoom] = useState(() => { const value = Number(localStorage.getItem('layoutZoom')); return Number.isFinite(value) && value >= 0.6 && value <= 1.5 ? value : 1; });
  useEffect(() => { if (window.desktop) void window.desktop.setLayoutZoom(layoutZoom).then(() => localStorage.setItem('layoutZoom', String(layoutZoom))).catch(cause => setError(String(cause))); }, [layoutZoom]);
  const [exportOpen, setExportOpen] = useState(false);
  const [videoExporting, setVideoExporting] = useState(false);
  const [exportMode, setExportMode] = useState<'mix' | 'tracks'>('mix');
  const [exportState, setExportState] = useState<ExportState>({ phase: 'idle', progress: 0, message: '' });
  const exportMix = useRef<Record<string, { mute: boolean; solo: boolean; level: number }>>({});
  useEffect(() => {
    if (!videoExporting || !window.desktop) return;
    let active = true;
    const timer = setInterval(() => { void window.desktop!.exportStatus().then(value => { if (active) setExportState(value); }).catch(() => {}); }, 400);
    return () => { active = false; clearInterval(timer); };
  }, [videoExporting]);
  const [exporting, setExporting] = useState(false);
  const [activeOperation, setActiveOperation] = useState<'stems' | 'uss'>(remembered.activeOperation);
  const [model, setModel] = useState(remembered.model);
  const [runs, setRuns] = useState<StemJob[]>([]);
  const [selectedRun, setSelectedRun] = useState('');
  const [detailRequest, setDetailRequest] = useState<DetailRequest | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const detailShortcut = useRef(() => {});
  const [lastGuidance, setLastGuidance] = useState<SAMGuidance | undefined>(undefined);
  const [samVariant, setSAMVariant] = useState<'small-tv' | 'large-tv'>('small-tv');
  const [detailMode, setDetailMode] = useState<'uss' | 'sam'>('uss');
  const [modelModal, setModelModal] = useState<'sam' | 'guidesep' | null>(null);
  const [sourceGuidance, setSourceGuidance] = useState<SAMGuidance>({});
  const [reference, setReference] = useState<ReferenceAudio | null>(null);
  const [sam, setSAM] = useSAMStatus(profile, samVariant);
  const [guide, setGuide] = useGuideSepStatus(profile);
  const [floatPosition, setFloatPosition] = useState({ x: Math.max(8, window.innerWidth - 340), y: 90 });
  const [floatSize, setFloatSize] = useState({ width: 320, height: 180 });
  const floatResize = useRef<{ edge: string; x: number; y: number; width: number; height: number; left: number; top: number } | null>(null);
  function resizeFloat(event: React.PointerEvent<HTMLDivElement>) {
    const d = floatResize.current; if (!d) return; event.preventDefault(); event.stopPropagation();
    const dx = event.clientX-d.x, dy=event.clientY-d.y;
    const width = Math.max(180,Math.min(window.innerWidth-16,d.width+(d.edge.includes('w')?-dx:d.edge.includes('e')?dx:0)));
    const height = Math.max(100,Math.min(window.innerHeight-70,d.height+(d.edge.includes('n')?-dy:d.edge.includes('s')?dy:0)));
    setFloatSize({width,height});setFloatPosition({x:Math.max(0,Math.min(window.innerWidth-width,d.left+(d.edge.includes('w')?d.width-width:0))),y:Math.max(0,Math.min(window.innerHeight-height,d.top+(d.edge.includes('n')?d.height-height:0)))}); floatMoved.current=true;
  }
  const floatDrag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const floatMoved = useRef(false);
  const [target, setTarget] = useState(remembered.target);
  const [autoThreshold] = useState(remembered.autoThreshold);
  const [threshold] = useState(remembered.threshold);
  useEffect(() => { const available = engine?.models; if (STEM_MODELS.includes(model) && available?.length && !available.includes(model)) setModel(['mrx', 'bandit', 'sfc'].find(key => available.includes(key)) || available[0]); }, [engine?.models, model]);
  useEffect(() => { try { localStorage.setItem('workspacePreferences', JSON.stringify({ model, activeOperation, target, autoThreshold, threshold })); } catch {} }, [model, activeOperation, target, autoThreshold, threshold]);
  const currentRun = runs.find(run => run.runId === selectedRun) || runs.at(-1);
  const shownStems = currentRun?.stems || job.stems;
  const modelNames: Record<string, string> = Object.fromEntries(MODELS.map(item => [item.id, item.name]));
  const modelKind = MODELS.find(item => item.id === model)?.kind || 'stems';
  const sourceIsAudio = !!source && AUDIO_SOURCE.test(source.name);
  const [transport] = useState(() => new MediaTransport());
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const playback = useCoarsePlayback(transport);
  useEffect(() => { transport.attachVideo(video); return () => transport.attachVideo(null); }, [transport, video]);
  const keyboardActions = useRef({ toggle: () => {}, extract: () => {} });
  keyboardActions.current = { toggle: () => { void transport.toggle(); }, extract: () => { if (settings || exportOpen || projectsOpen) return; if (modelModal) { if (canSeparate && modelReady) { setModelModal(null); void separate(); } return; } if (detailOpen) { detailShortcut.current(); return; } if (activeOperation === 'uss' && detailRequest) void extractDetail(detailRequest, detailMode, target, lastGuidance); else void separate(); } };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.code === 'Space' && event.target instanceof HTMLTextAreaElement && event.target.classList.contains('sam-target-description')) || (event.target instanceof HTMLInputElement && event.target.classList.contains('project-name-input'))) return;
      const action = event.code === 'Space' ? 'toggle' : event.ctrlKey && event.key === 'Enter' ? 'extract' : null;
      if (!action) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (!event.repeat && !event.isComposing) keyboardActions.current[action]();
    };
    window.addEventListener('keydown', keydown, true);
    return () => window.removeEventListener('keydown', keydown, true);
  }, []);
  const input = useRef<HTMLInputElement>(null);
  const projectInitialized = useRef(false);
  function hydrateProject(value: ProjectSession) {
    transport.pause();
    timelines.current = value.view.timelines || {};
    pendingTransport.current = value.view.transport || { position: 0, duration: 0, selection: null, loopLocked: false };
    setProject(value.info); setProjectName(value.info.name); setSource(value.source); setRuns(value.runs); setJob(value.job);
    setSelectedRun(value.runs.find(run => run.runId === value.view.selectedRun)?.runId || value.runs.at(-1)?.runId || '');
    setMediaError(false); setDetailRequest(null); setDetailOpen(false);
    const prefs = preferences(JSON.stringify(value.view));
    setModel(prefs.model); setActiveOperation(prefs.activeOperation); setTarget(prefs.target);
    setSAMVariant(value.view.samVariant === 'large-tv' ? 'large-tv' : 'small-tv');
    setDetailMode(value.view.detailMode === 'sam' ? 'sam' : 'uss'); setLastGuidance(value.view.lastGuidance);
    const detail = value.view.detailRequest, restoredStem = value.runs.flatMap(run => run.stems).find(stem => stem.id === detail?.stem.id);
    if (detail && restoredStem && !restoredStem.missing) setDetailRequest({ ...detail, stem: restoredStem });
    const z = value.view.layoutZoom; if (typeof z === 'number' && z >= 0.6 && z <= 1.5) setLayoutZoom(z);
    const share = value.view.workspaceShare; setWorkspaceShare(typeof share === 'number' ? Math.max(.1, Math.min(.9, share)) : .46);
    setTimelineExpanded(value.view.timelineExpanded === true);
    const floating = value.view.floatPosition; if (floating && Number.isFinite(floating.x) && Number.isFinite(floating.y)) setFloatPosition({ x: Math.max(0, Math.min(window.innerWidth - 100, floating.x)), y: Math.max(0, Math.min(window.innerHeight - 60, floating.y)) });
    if (value.view.floatSize) setFloatSize({width:Math.max(180,Math.min(window.innerWidth-16,value.view.floatSize.width)),height:Math.max(100,Math.min(window.innerHeight-70,value.view.floatSize.height))});
    setExportMode(value.view.exportMode === 'tracks' ? 'tracks' : 'mix');
    setProjectStatus('Saved'); setError(value.warnings.join(' '));
  }
  useEffect(() => {
    if (!window.desktop || projectInitialized.current) return;
    projectInitialized.current = true; switching.current = true;
    void window.desktop.getProject().then(hydrateProject).catch(cause => setError(String(cause))).finally(() => { switching.current = false; });
  }, []);
  useEffect(() => {
    if (pendingTransport.current && (!source?.url || video?.getAttribute('src') === source.url)) { transport.restore(pendingTransport.current); pendingTransport.current = null; }
  }, [project?.id, video, source?.url, transport]);
  session.current = project ? { projectId: project.id, runs, view: { selectedRun, model, activeOperation, target, detailMode, samVariant, lastGuidance, detailRequest, layoutZoom, workspaceShare, timelineExpanded, floatPosition, floatSize, exportMode, transport: pendingTransport.current || transport.snapshot(), timelines: timelines.current } } : null;
  const rememberTimeline = useCallback((value: TimelineView) => { if (selectedRun) timelines.current[selectedRun] = value; }, [selectedRun]);
  const currentPayload = (): ProjectPayload | null => session.current ? { ...session.current, view: { ...session.current.view, transport: pendingTransport.current || transport.snapshot(), timelines: { ...timelines.current } } } : null;
  const savedTransport = useRef<ProjectPayload['view']['transport'] | null>(null);
  async function flushProject() {
    const payload = currentPayload();
    if (!window.desktop || !payload) return;
    // While playing, only the playhead moves; keep the last saved position so autosave stays a no-op.
    if (transport.snapshot().playing && savedTransport.current) payload.view.transport = savedTransport.current; else savedTransport.current = payload.view.transport;
    setProjectStatus('Saving…');
    try { await window.desktop.saveProject(payload); setProjectStatus('Saved'); }
    catch (cause) { setProjectStatus('Save failed'); throw cause; }
  }
  const flushRef = useRef(flushProject); flushRef.current = flushProject;
  useEffect(() => {
    if (!window.desktop) return;
    let saving = false;
    const timer = setInterval(() => { if (!session.current || switching.current || saving) return; saving = true; void flushRef.current().catch(cause => setError(String(cause))).finally(() => { saving = false; }); }, 2000);
    const off = window.desktop.onProjectClose(() => {
      transport.pause();
      const payload = currentPayload();
      if (!payload) { void window.desktop!.closeProject(null).catch(cause => setError(String(cause))); return; }
      void window.desktop!.closeProject(payload).catch(cause => { setProjectStatus('Save failed'); setError(String(cause)); });
    });
    return () => { clearInterval(timer); off(); };
  }, [transport]);
  async function projectAction(action: string, argument?: unknown) {
    if (!window.desktop || !session.current || switching.current) return;
    switching.current = true; setProjectBusy(true); setError(''); transport.pause();
    try {
      await flushProject();
      const value = await window.desktop.projectAction(action, currentPayload()!, argument);
      if (value && 'runs' in value) { hydrateProject(value); setProjectsOpen(false); }
      else if (value?.info) { setProject(value.info); setProjectName(value.info.name); }
      setRecent(await window.desktop.recentProjects());
    } catch (cause) { setError(String(cause)); }
    finally { switching.current = false; setProjectBusy(false); }
  }
  async function showProjects() { setProjectsOpen(true); if (window.desktop) setRecent(await window.desktop.recentProjects()); }
  const initialized = useRef(false);
  useEffect(() => {
    if (!window.desktop || initialized.current) return;
    initialized.current = true;
    (async () => {
      const saved = await window.desktop!.getProfile(); setProfile(saved);
      if (saved.setupComplete) setSettings(false);
      if (saved.managedProxy) {
        setPreparingProxy(true); setBusy(true);
        try {
          setProxyState(await window.desktop!.startProxy(saved));
          const result = await window.desktop!.checkConnection(saved); setConnection(result);
          const audio = await window.desktop!.checkEngine(saved); setEngine(audio);
          if (saved.setupComplete && (!result.comfy || !result.proxy || !audio.ready)) setSettings(true);
        } finally { setPreparingProxy(false); setBusy(false); }
      }
    })().catch(cause => { setError(cause instanceof Error ? cause.message : 'Saved connection could not be prepared.'); setSettings(true); });
  }, []);
  const proxyIdle = !preparingProxy && !['checking', 'downloading', 'installing', 'starting'].includes(proxyState?.phase || '');
  const jobIdle = ['idle', 'complete', 'failed', 'cancelled'].includes(job.phase);
  // Poll quickly only while something is running; unchanged answers never re-render the app.
  useEffect(() => {
    if (!window.desktop) return;
    let active = true;
    const read = () => window.desktop!.proxyStatus().then(value => {
      if (!active) return;
      setProxyState(previous => JSON.stringify(previous) === JSON.stringify(value) ? previous : value);
      if (value.phase === 'error') setConnection(current => current && current.proxy ? { ...current, proxy: false, proxyDetail: value.message } : current);
    }).catch(() => {});
    read(); const timer = setInterval(read, proxyIdle ? 4000 : 1000);
    return () => { active = false; clearInterval(timer); };
  }, [proxyIdle]);
  useEffect(() => {
    if (!window.desktop) return;
    let active = true;
    const read = () => window.desktop!.stemStatus().then(value => { if (active) setJob(previous => JSON.stringify(previous) === JSON.stringify(value) ? previous : value); }).catch(() => {});
    const timer = setInterval(read, jobIdle ? 3000 : 1000);
    return () => { active = false; clearInterval(timer); };
  }, [jobIdle]);
  useEffect(() => () => { if (source?.url.startsWith('blob:')) URL.revokeObjectURL(source.url); }, [source]);
  useEffect(() => {
    if (job.phase !== 'complete' || !job.runId) return;
    if (job.parentId && job.rootRunId) {
      setRuns(values => values.map(value => value.runId === job.rootRunId ? { ...value, stems: [...value.stems, ...job.stems.filter(stem => !value.stems.some(existing => existing.id === stem.id))] } : value));
    } else {
      setRuns(values => values.some(value => value.runId === job.runId) ? values : [...values, job].slice(-12));
      setSelectedRun(job.runId);
    }
  }, [job.runId]);
  const connected = connection?.comfy && connection.proxy;
  const proxyWorking = preparingProxy || ['checking', 'downloading', 'installing', 'starting'].includes(proxyState?.phase || '');
  const jobBusy = !['idle', 'complete', 'failed', 'cancelled'].includes(job.phase);
  const canSeparate = !!window.desktop && !!source && !source.missing && !!connected && !!engine?.ready && !jobBusy && !projectBusy;
  const wholeRange = { start: 0, end: playback.duration };
  let sourceGuidanceError = '';
  if (modelKind === 'prompt') { try { if (!sourceGuidance.visualOnly && !sourceGuidance.description?.trim()) throw Error('Describe the sound you want, or draw a visual target.'); normalizeGuidance(sourceGuidance, wholeRange); } catch (cause) { sourceGuidanceError = cause instanceof Error ? cause.message : String(cause); } }
  const samReady = !!engine?.sam && !!engine?.samPrompts && !!sam?.ready;
  const guideReady = !!engine?.guidesep && !!guide?.ready && !!reference;
  const modelReady = modelKind === 'stems' || (playback.duration > 0 && (modelKind === 'prompt' ? samReady && !sourceGuidanceError : guideReady));
  const runLabel = modelKind === 'stems' ? 'Separate stems' : modelKind === 'prompt' ? 'Extract sound' : 'Separate with reference';
  const separationHint = !source ? 'Choose a source first.' : !connected ? 'Check your ComfyUI and proxy connection first.' : !engine?.ready ? 'Audio engine is not ready. Check connection settings or retry setup.' : modelKind === 'prompt' ? (!samReady ? 'Prepare SAM Audio first.' : sourceGuidanceError || 'SAM Audio pulls the described sound from the whole source.') : modelKind === 'reference' ? (!guideReady ? 'Prepare GuideSep and choose a reference sound first.' : 'GuideSep pulls the instrument that matches your reference.') : 'Three mono stems. The original source stays untouched.';
  async function separate() {
    if (!window.desktop || !source || !canSeparate || !modelReady) return;
    setError(''); setSaveNotice('');
    try {
      if (modelKind === 'prompt') {
        const label = sourceGuidance.visualOnly ? 'Visual target' : sourceGuidance.description!.trim();
        setJob(await window.desktop.separateStems(profile, source.url, { mode: 'sam', samModel: samVariant, target: label, threshold: 0.1, range: wholeRange, sam: sourceGuidance, videoUrl: source.url }));
      } else if (modelKind === 'reference' && reference) {
        setJob(await window.desktop.separateStems(profile, source.url, { mode: 'guidesep', target: reference.name.replace(/\.[^.]+$/, ''), referenceUrl: reference.url, range: wholeRange }));
      } else setJob(await window.desktop.separateStems(profile, source.url, { model, mode: 'stems' }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function extractDetail(request: DetailRequest, mode: 'uss' | 'sam' | 'guidesep' = 'uss', chosen = 'All', guidance?: SAMGuidance, referenceAudio?: ReferenceAudio) {
    if (!window.desktop || !canSeparate || !currentRun?.runId) return;
    if (!shownStems.some(stem => stem.id === request.stem.id)) return;
    setActiveOperation('uss'); setDetailRequest(request); setDetailMode(mode === 'sam' ? 'sam' : 'uss'); setTarget(chosen); setLastGuidance(guidance); setDetailOpen(false);
    setError(''); setSaveNotice('');
    const base = { range: { start: request.start, end: request.end }, parentId: request.stem.id, rootRunId: currentRun.runId, edits: timelines.current[currentRun.runId]?.edits?.[request.stem.id] };
    try {
      if (mode === 'guidesep') setJob(await window.desktop.separateStems(profile, request.stem.url, { ...base, mode: 'guidesep', target: chosen, referenceUrl: referenceAudio?.url }));
      else setJob(await window.desktop.separateStems(profile, request.stem.url, { ...base, mode, samModel: mode === 'sam' ? samVariant : undefined, target: chosen, threshold: 0.1, autoThreshold: mode === 'uss', ...(mode === 'sam' && guidance ? { sam: guidance, videoUrl: source?.url } : {}) }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  function details(stem: Stem, start: number, end: number, picker: boolean) {
    const request = { stem, start, end }; setDetailRequest(request); setActiveOperation('uss');
    if (picker) setDetailOpen(true); else void extractDetail(request);
  }
  async function exportVideo() {
    if (!window.desktop || !source || !shownStems.length || videoExporting) return;
    setVideoExporting(true); setError(''); setExportState({ phase: 'idle', progress: 0, message: 'Choose an export location…' });
    try {
      const path = await window.desktop.exportVideo(profile, { sourceUrl: source.url, stems: shownStems.map(stem => ({ id: stem.id, label: stem.label, edits: timelines.current[currentRun?.runId || ""]?.edits?.[stem.id], ...(exportMix.current[stem.id] || { mute: false, solo: false, level: 1 }) })), mode: exportMode, format: 'mkv', duration: playback.duration });
      if (path) { setSaveNotice(`Video saved to ${path}`); setExportOpen(false); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setVideoExporting(false); }
  }
  async function saveStems(id?: string) {
    if (!window.desktop) return;
    setExporting(true); setError('');
    try { const path = id ? await window.desktop.saveStem(id, timelines.current[currentRun?.runId || ""]?.edits?.[id], profile) : await window.desktop.saveAllStems(shownStems.map(stem => stem.id), timelines.current[currentRun?.runId || ""]?.edits, profile); if (path) setSaveNotice(`Stems saved to ${path}`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setExporting(false); }
  }
  async function prepareProxy() {
    if (!window.desktop) return;
    setPreparingProxy(true); setBusy(true); setError(''); setConnection(null);
    try {
      const status = await window.desktop.startProxy(profile); setProxyState(status);
      setProfile(p => ({ ...p, managedProxy: status.owned }));
      setConnection(await window.desktop.checkConnection(profile));
      setEngine(await window.desktop.checkEngine(profile));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Automatic proxy setup failed.'); }
    finally { setPreparingProxy(false); setBusy(false); }
  }
  async function stopProxy() {
    try { const state = await window.desktop?.stopProxy(); if (state) setProxyState(state); setConnection(null); setProfile(p => ({ ...p, managedProxy: false })); }
    catch (cause) { setError(String(cause)); }
  }
  async function verify() {
    if (!window.desktop) { setError('Open the desktop application to check a local connection. Browser connection support is planned.'); return; }
    setBusy(true); setError(''); setConnection(null); setSaveNotice('');
    try { const result = await window.desktop.checkConnection(profile); setConnection(result); setEngine(await window.desktop.checkEngine(profile)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Connection check failed.'); }
    finally { setBusy(false); }
  }
  async function saveConnection() {
    if (!window.desktop) { setError('Open the desktop application to save a connection profile.'); return; }
    setSaving(true); setError(''); setSaveNotice('');
    try {
      const saved = await window.desktop.saveProfile(profile);
      setProfile(saved);
      setSaveNotice('Connection settings saved. You can use the workspace without a running ComfyUI.');
      setSettings(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Settings could not be saved.'); }
    finally { setSaving(false); }
  }
  async function browse() {
    try { const path = await window.desktop?.chooseInstallation(); if (path) setProfile(p => ({ ...p, installation: path })); }
    catch (cause) { setError(String(cause)); }
  }
  async function openVideo() {
    setError('');
    if (!window.desktop) { input.current?.click(); return; }
    try { const next = await window.desktop.openVideo(); if (next) await projectAction('source', next); } catch (cause) { setError(String(cause)); }
  }
  return <div className="app-shell studio-workspace">
    <TooltipLayer/>
    <header className="topbar"><div className="brand"><img className="primary-comfy-logo" src={comfyWordmark} alt="Comfy"/><span className="stem-wordmark">Stem Studio</span></div><button className="project-switch" onClick={() => void showProjects()} title={project?.path || "Projects"} disabled={!project || projectBusy}><FolderOpen size={14}/><span>{project?.name || "Project"}</span><small>{projectStatus}</small></button><ResourceMonitor profile={profile}/><div className="topbar-right"><div className="layout-zoom" aria-label="Layout scale"><button className="icon-button" aria-label="Zoom layout out" disabled={layoutZoom <= 0.6} onClick={() => setLayoutZoom(value => Math.max(0.6, Math.round((value - 0.1) * 10) / 10))}><ZoomOut size={15}/></button><button className="zoom-reset" title="Reset layout scale" onClick={() => setLayoutZoom(1)}>{Math.round(layoutZoom * 100)}%</button><button className="icon-button" aria-label="Zoom layout in" disabled={layoutZoom >= 1.5} onClick={() => setLayoutZoom(value => Math.min(1.5, Math.round((value + 0.1) * 10) / 10))}><ZoomIn size={15}/></button></div><button className={`connection-pill ${connected ? 'online' : ''}`} onClick={() => setSettings(true)} title="Connection settings" aria-label="Connection settings"><span className="status-dot"/><Settings2 size={16}/></button></div></header>
    <main ref={workspaceMain} className={`workspace-main ${timelineExpanded ? 'timeline-expanded' : ''}`} style={{ '--workspace-height': `${topHeight}px` } as React.CSSProperties}>
      <div className="workspace-grid">
        <aside className="panel controls-panel">
          <div className="panel-heading"><h2>Soundtrack</h2><span className="badge">LOCAL</span></div>
          <div className="control-content" tabIndex={0} aria-label="Soundtrack controls">
            <span className="section-label">SOURCE</span>
            <button className="source-card" onClick={openVideo} disabled={jobBusy || videoExporting || projectBusy || !project}><span className="source-icon"><Clapperboard size={20}/></span><span className="source-description"><strong>{source ? source.name : 'Add video or audio'}</strong><small>{source ? source.missing ? 'Missing video · relink in Projects' : `${(source.size / 1048576).toFixed(1)} MiB · Original source` : 'MP4, MOV, MKV, MP3, WAV, FLAC and more'}</small></span><Plus size={16}/></button>
            <div className={`operation-section ${activeOperation === 'stems' ? 'is-selected' : ''}`} onFocusCapture={() => setActiveOperation('stems')} onPointerDownCapture={() => setActiveOperation('stems')}>
            <div className="section-title"><span className="section-label">STEM SEPARATION</span><span className="subtle">{MODELS.length} MODELS</span></div>
            <ModelPicker value={model} onChange={id => { setModel(id); const kind = MODELS.find(item => item.id === id)?.kind; setModelModal(kind === 'prompt' ? 'sam' : kind === 'reference' ? 'guidesep' : null); }} disabled={jobBusy} installed={{ mrx: engine?.models ? engine.models.includes('mrx') : undefined, bandit: engine?.models ? engine.models.includes('bandit') : undefined, sfc: engine?.models ? engine.models.includes('sfc') : undefined, sam: engine ? !!engine.sam : undefined, guidesep: engine ? !!engine.guidesep : undefined }}/>
            <p className="model-caption">{modelName(model)}</p>
            {modelKind !== 'stems' && <button className="model-summary" disabled={jobBusy} onClick={() => setModelModal(modelKind === 'prompt' ? 'sam' : 'guidesep')} data-tip="Open options"><span>{modelKind === 'prompt' ? `${samVariant === 'small-tv' ? 'Small' : 'Large'} · ${sourceGuidance.visualOnly ? 'Visual target' : sourceGuidance.description?.trim() || 'Describe the sound'}` : reference?.name || 'Choose a reference sound'}</span><SlidersHorizontal size={13}/></button>}
            <button className="primary-button" disabled={modelKind !== 'stems' && !modelReady ? jobBusy : !canSeparate} onClick={() => { if (modelKind !== 'stems' && !modelReady) setModelModal(modelKind === 'prompt' ? 'sam' : 'guidesep'); else void separate(); }} title={separationHint}>{jobBusy ? <LoaderCircle size={17} className="spin"/> : <AudioLines size={17}/>} {jobBusy ? (modelKind === 'stems' ? 'Separating stems' : 'Working…') : modelKind !== 'stems' && !modelReady ? `Set up ${modelKind === 'prompt' ? 'SAM' : 'GuideSep'}` : runLabel}{activeOperation === 'stems' && <kbd>Ctrl ↵</kbd>}<ArrowUpRight size={16}/></button>
            {(jobBusy || job.phase === 'failed' || job.phase === 'cancelled') && <p className="helper" role="status">{job.message}</p>}
            {job.canCancel && <button className="quiet-button" onClick={() => window.desktop?.cancelSeparation().then(setJob).catch(cause => setError(String(cause)))}>Cancel separation</button>}
            </div>

          </div>
        </aside>
        <section className={`panel preview-panel ${timelineExpanded && source ? 'floating-preview' : ''}`} style={timelineExpanded ? { left: floatPosition.x, top: floatPosition.y, width: floatSize.width, height: floatSize.height, maxWidth: "none", aspectRatio: "auto" } : undefined} onClick={() => { if (timelineExpanded && !floatMoved.current) void transport.toggle(); floatMoved.current = false; }}
          onPointerDown={event => { if (!timelineExpanded || !source || event.button !== 0) return; floatMoved.current = false; floatDrag.current = { x: event.clientX, y: event.clientY, left: floatPosition.x, top: floatPosition.y, moved: false }; event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={event => { const drag = floatDrag.current; if (!drag) return; const dx = event.clientX - drag.x, dy = event.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true; if (drag.moved) setFloatPosition({ x: Math.max(0, Math.min(window.innerWidth - event.currentTarget.offsetWidth, drag.left + dx)), y: Math.max(0, Math.min(window.innerHeight - event.currentTarget.offsetHeight, drag.top + dy)) }); }}
          onPointerUp={event => { floatMoved.current = !!floatDrag.current?.moved; floatDrag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { floatDrag.current = null; }} onLostPointerCapture={() => { floatDrag.current = null; }}>{timelineExpanded && ['n','s','e','w','nw','ne','sw','se'].map(edge => <div key={edge} className={`floating-edge floating-edge-${edge}`} onClick={event => event.stopPropagation()} onPointerDown={event => { event.preventDefault();event.stopPropagation();floatResize.current={edge,x:event.clientX,y:event.clientY,...floatSize,left:floatPosition.x,top:floatPosition.y};event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={resizeFloat} onPointerUp={event => {event.stopPropagation();floatResize.current=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}} onPointerCancel={() => {floatResize.current=null;}} onLostPointerCapture={() => {floatResize.current=null;}}/>)}<div className="panel-heading"><h2>Preview</h2></div><div className={`preview-stage ${source ? 'has-source' : ''}`}>{source && !source.missing ? <><video ref={setVideo} key={source.url} src={source.url} onClick={() => { if (!timelineExpanded) void transport.toggle(); }} onError={() => setMediaError(true)}/>{sourceIsAudio && <div className="audio-badge"><AudioLines size={34}/><span>{source.name}</span></div>}{mediaError && <p className="video-error">Unsupported preview codec. Try an H.264 MP4 or a common audio format.</p>}</> : <div className="empty-preview"><button className="secondary-button" onClick={openVideo}><Plus size={16}/> Open video or audio</button></div>}</div><PreviewFooter transport={transport} playback={playback}/></section>
      </div>
      <StemTimeline key={`${project?.id || "scratch"}:${currentRun?.runId || "empty"}`} initialView={timelines.current[currentRun?.runId || ""]} onViewChange={rememberTimeline} details={details} detailBusy={jobBusy || !canSeparate} detailAvailable={!!engine?.detailRange} expanded={timelineExpanded} toggleExpanded={() => setTimelineExpanded(value => !value)} resize={resizeWorkspace} resetSize={() => setWorkspaceShare(0.46)} workspaceHeight={topHeight} resizeBounds={{ min: workspaceTop(workspaceAvailable, 0), max: workspaceTop(workspaceAvailable, Infinity) }} stems={shownStems} save={saveStems} takes={runs.map(run => ({ id: run.runId!, label: modelNames[run.model || ''] || run.model || 'Take' }))} selectedTake={currentRun?.runId || ''} selectTake={id => { setSelectedRun(id); setDetailRequest(null); setDetailOpen(false); }} canExportVideo={!!source && !sourceIsAudio} exporting={exporting || videoExporting} exportVideo={mix => { exportMix.current = mix; setExportState({ phase: 'idle', progress: 0, message: '' }); setError(''); setExportOpen(true); }} independent={(currentRun?.model || job.model) === 'USS · All'} transport={transport} playback={playback}/>
      {playback.error && <p className="error-banner" role="alert">{playback.error}</p>}
      {saveNotice && !settings && <p className="save-notice" role="status"><Check size={14}/>{saveNotice}</p>}
      {error && !settings && <p className="error-banner" role="alert">{error}</p>}
    </main>
    {detailOpen && detailRequest && <DetailPicker variant={samVariant} setVariant={setSAMVariant} sourceUrl={source?.url || ''} submitShortcut={detailShortcut} request={detailRequest} profile={profile} engine={engine} busy={jobBusy} close={() => setDetailOpen(false)} extract={(mode, target, guidance, referenceAudio) => void extractDetail(detailRequest, mode, target, guidance, referenceAudio)}/>}
    {modelModal === 'sam' && <ModelModal icon={<Sparkles size={15}/>} title="SAM Audio" close={() => setModelModal(null)} note={!source ? 'Open a source first' : sourceGuidanceError || (samReady ? 'Pulls the sound from the whole source' : 'Prepare SAM Audio first')} runLabel="Extract sound" runDisabled={!canSeparate || !modelReady} run={() => { setModelModal(null); void separate(); }}>
      <SAMVariantSwitch variant={samVariant} setVariant={setSAMVariant} disabled={jobBusy} largeAvailable={!!engine?.samModels} reset={() => setSAM(null)}/>
      {playback.duration > 0 ? <SAMGuidanceEditor key={`${source?.url}:${playback.duration}`} range={wholeRange} sourceUrl={source?.url || ''} value={sourceGuidance} change={setSourceGuidance} supported={!!engine?.samPrompts} visualSupported={!!engine?.samVisual && !sourceIsAudio}/> : <p className="helper">Open a source to describe the sound you want.</p>}
      <SAMPrepare sam={sam} setSAM={setSAM} profile={profile} variant={samVariant} busy={jobBusy}/>
    </ModelModal>}
    {modelModal === 'guidesep' && <ModelModal icon={<Mic size={15}/>} title="GuideSep" close={() => setModelModal(null)} note={!source ? 'Open a source first' : !reference ? 'Choose a reference sound' : guideReady ? 'Pulls the matching instrument' : 'Prepare GuideSep first'} runLabel="Separate" runDisabled={!canSeparate || !modelReady} run={() => { setModelModal(null); void separate(); }}>
      <GuideSepPanel profile={profile} engine={engine} state={guide} setState={setGuide} reference={reference} setReference={setReference} busy={jobBusy}/>
    </ModelModal>}
    {projectsOpen && <div className="modal-backdrop"><section className="connection-modal projects-modal" role="dialog" aria-modal="true" aria-labelledby="projects-title">
      <div className="modal-top"><span className="eyebrow"><FolderOpen size={14}/> PROJECTS</span><button className="icon-button" disabled={projectBusy} onClick={() => setProjectsOpen(false)} aria-label="Close projects"><X size={17}/></button></div>
      <h2 id="projects-title">Your workspace.</h2>
      <div className="project-current"><input className="project-name-input" aria-label="Project name" maxLength={100} value={projectName} onChange={event => setProjectName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.ctrlKey) void projectAction('rename', projectName); }}/><button className="secondary-button" disabled={projectBusy || !projectName.trim()} onClick={() => void projectAction('rename', projectName)}>Rename</button></div>
      <p className="project-path" title={project?.path}>{project?.path}</p>
      <div className="project-actions"><button disabled={projectBusy || jobBusy || videoExporting} onClick={() => void projectAction('new', 'Untitled project')}><Plus size={14}/> New</button><button disabled={projectBusy || jobBusy || videoExporting} onClick={() => void projectAction('open')}><FolderOpen size={14}/> Open</button><button disabled={projectBusy || jobBusy || videoExporting} onClick={() => void projectAction('copy')}><Save size={14}/> Save as</button><button disabled={projectBusy} onClick={() => void projectAction('folder')}>Show folder</button>{source && <button disabled={projectBusy || jobBusy || videoExporting} onClick={() => void projectAction('relink')}>Relink video</button>}</div>
      <div className="project-recent">{recent.map(item => <button key={item.path} disabled={projectBusy || jobBusy || videoExporting || item.path === project?.path} onClick={() => void projectAction('recent', item.path)}><span><strong>{item.name}</strong><small>{item.path}</small></span><time>{new Date(item.updatedAt).toLocaleDateString()}</time></button>)}</div>
      {error && <p className="error-banner" role="alert">{error}</p>}
      <div className="modal-actions"><span className="subtle">{projectBusy ? 'Preparing project…' : 'Autosave on · resume last project'}</span><button className="primary-button" disabled={projectBusy} onClick={() => { void flushProject().then(() => setProjectsOpen(false)).catch(cause => setError(String(cause))); }}><Save size={14}/> Save</button></div>
    </section></div>}
    {exportOpen && <div className="modal-backdrop"><section className="connection-modal export-modal" role="dialog" aria-modal="true" aria-labelledby="export-title"><div className="modal-top"><span className="eyebrow"><img className="comfy-modal-icon" src={comfyIcon} alt="Comfy"/> VIDEO EXPORT</span><button className="icon-button" disabled={videoExporting} onClick={() => setExportOpen(false)} aria-label="Close export"><X size={18}/></button></div><h2 id="export-title">Keep the picture.</h2><p className="modal-description">Saved by ComfyUI. Original video + lossless FLAC audio.</p><label>Audio<select value={exportMode} disabled={videoExporting} onChange={event => setExportMode(event.target.value as 'mix' | 'tracks')}><option value="mix">Current mix · mute, solo and levels</option><option value="tracks">Separate stem tracks · original levels</option></select></label><p className="helper">{exportMode === 'tracks' ? 'Embeds every stem as a separate selectable audio track. Mixer controls are ignored.' : 'Replaces the source audio with the current stem mix.'} MKV · native ComfyUI SaveVideo.</p>{videoExporting && <div role="status"><progress max="1" value={exportState.progress}/><p className="helper">{exportState.message}</p></div>}{error && <p className="error-banner" role="alert">{error}</p>}<div className="modal-actions">{videoExporting ? <button className="secondary-button" onClick={() => void window.desktop?.cancelExport().catch(cause => setError(String(cause)))}>Cancel export</button> : <button className="secondary-button" onClick={() => setExportOpen(false)}>Cancel</button>}<button className="primary-button" disabled={videoExporting || !playback.duration} onClick={() => void exportVideo()}>{videoExporting ? 'Exporting…' : 'Export video'}</button></div></section></div>}
    <input ref={input} type="file" accept="video/*,audio/*,.mkv,.flac,.opus" hidden onChange={event => { const file = event.target.files?.[0]; if (file) { setMediaError(false); setSource({ name: file.name, size: file.size, url: URL.createObjectURL(file) }); } }}/>
    {settings && <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget && !busy && !saving && !proxyWorking) setSettings(false); }}>
      <section className="connection-modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="connection-title">
        <header><span className="mini-title"><img className="comfy-modal-icon" src={comfyIcon} alt="Comfy"/><strong id="connection-title">Connection</strong></span><button className="icon-button" aria-label="Close connection settings" disabled={busy || saving || proxyWorking} onClick={() => setSettings(false)}><X size={15}/></button></header>
        <div className="settings-grid">
          <label>ComfyUI<input value={profile.comfyUrl} disabled={busy || saving || proxyWorking} spellCheck={false} onChange={e => { setProfile({ ...profile, comfyUrl: e.target.value }); setConnection(null); setError(''); }}/></label>
          <label>API Proxy<input value={profile.proxyUrl} disabled={busy || saving || proxyWorking} spellCheck={false} onChange={e => { setProfile({ ...profile, proxyUrl: e.target.value }); setConnection(null); setError(''); }}/></label>
        </div>
        <div className="settings-folder"><span className="field-label">Folder</span><p title={profile.installation}>{profile.installation || 'No ComfyUI folder selected'}</p><button className="secondary-button" onClick={browse} disabled={!window.desktop || busy || saving}><FolderOpen size={13}/> Browse</button></div>
        <div className="settings-status" role="status" aria-live="polite" aria-busy={busy}>
          <span data-tip={connection?.comfyDetail || 'Not checked yet'}><i className={`status-dot ${connection ? connection.comfy ? 'green' : 'unavailable' : ''}`}/>ComfyUI <em>{busy ? 'Checking…' : connection ? connection.comfy ? 'Reachable' : 'Unavailable' : 'Not checked'}</em></span>
          <span data-tip={connection?.proxyDetail || 'Not checked yet'}><i className={`status-dot ${connection ? connection.proxy ? 'green' : 'unavailable' : ''}`}/>Proxy <em>{busy ? 'Checking…' : connection ? connection.proxy ? 'Reachable' : 'Unavailable' : 'Not checked'}</em></span>
        </div>
        {(error || (connection && !(connection.comfy && connection.proxy))) && <p className="settings-note error-text" role="alert">{error || connection?.message}</p>}
        <div className="settings-proxy">
          <div className="settings-proxy-row">
            <button className="secondary-button" onClick={prepareProxy} disabled={!window.desktop || busy || saving || proxyWorking || (proxyState?.phase === 'running' && proxyState.owned)} data-tip="Prepare and start the official proxy. First use downloads a private Python runtime.">{proxyWorking ? <LoaderCircle size={13} className="spin"/> : <Link2 size={13}/>} {proxyWorking ? 'Preparing' : 'Set up & start proxy'}</button>
            {(proxyState?.owned || proxyWorking) && <button className="quiet-button" onClick={stopProxy}>{proxyWorking ? 'Cancel' : 'Stop'}</button>}
            {(proxyState?.owned || profile.managedProxy) && <label className="proxy-auto"><input type="checkbox" checked={profile.managedProxy} disabled={busy || saving || proxyWorking} onChange={event => setProfile(p => ({ ...p, managedProxy: event.target.checked }))}/> Start with app</label>}
          </div>
          {proxyState?.message && <p className="settings-note" role="status">{proxyWorking && <LoaderCircle size={11} className="spin"/>} {proxyState.message}</p>}
          {proxyState?.detail && <details className="proxy-guide"><summary>Details</summary><pre>{proxyState.detail}</pre></details>}
        </div>
        <footer>
          <button className="quiet-button" onClick={() => setSettings(false)} disabled={busy || saving || proxyWorking}><ArrowLeft size={12}/> Continue without saving</button>
          <span><button className="secondary-button" onClick={verify} disabled={busy || saving || proxyWorking}>{busy ? <LoaderCircle size={13} className="spin"/> : <Link2 size={13}/>} Check</button><button className="primary-button" onClick={saveConnection} disabled={busy || saving || proxyWorking}>{saving ? <LoaderCircle size={13} className="spin"/> : <Save size={13}/>} Save</button></span>
        </footer>
      </section>
    </div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);







