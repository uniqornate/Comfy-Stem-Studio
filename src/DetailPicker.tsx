import { useEffect, useState } from 'react';
import { X, Crosshair, LoaderCircle } from 'lucide-react';
import type { Engine, Profile, SAMState, Stem, SAMGuidance } from './types';
import { SAMGuidanceEditor } from './SAMGuidanceEditor';
import { normalizeGuidance } from './sam-guidance.mjs';
import catalog from './sound-targets.json';
export type DetailRequest = { stem: Stem; start: number; end: number };
const presets: Record<string, string[]> = {
  Actions: ['Walk, footsteps', 'Door', 'Knock', 'Tap', 'Clapping', 'Typing', 'Writing', 'Glass', 'Keys jangling'],
  People: ['Speech', 'Whispering', 'Breathing', 'Cough', 'Laughter', 'Crying, sobbing', 'Sigh'],
  Nature: ['Rain', 'Wind', 'Water', 'Fire', 'Bird', 'Dog', 'Insect', 'Thunder'],
  Machines: ['Car', 'Engine', 'Motorcycle', 'Train', 'Airplane', 'Telephone', 'Alarm', 'Clock', 'Gunshot, gunfire'],
  Music: ['Music', 'Piano', 'Guitar', 'Drum', 'Violin, fiddle', 'Singing'],
};
export function DetailPicker({ request, profile, engine, busy, close, extract, submitShortcut, sourceUrl, variant, setVariant }: { variant: 'small-tv' | 'large-tv'; setVariant: (variant:'small-tv'|'large-tv') => void; request: DetailRequest; profile: Profile; engine: Engine | null; busy: boolean; close: () => void; extract: (mode: 'uss' | 'sam', target: string, guidance?: SAMGuidance) => void; sourceUrl: string; submitShortcut: { current: () => void } }) {
  const [mode, setMode] = useState<'uss' | 'sam'>('sam');
  const [category, setCategory] = useState('Actions');
  const [target, setTarget] = useState('Walk, footsteps');
  const [guidance, setGuidance] = useState<SAMGuidance>({});
  const [filter, setFilter] = useState('');
  const [token, setToken] = useState(''); const [consent, setConsent] = useState(false);
  const [sam, setSAM] = useState<SAMState | null>(null); const [error, setError] = useState('');
  const preparing = !!sam && !['idle', 'complete', 'failed', 'cancelled'].includes(sam.phase);
  useEffect(() => {
    let active = true;
    const poll = () => window.desktop?.samStatus(profile, variant).then(value => { if (active) setSAM(value); }).catch(() => {});
    void poll(); const timer = setInterval(poll, 1000);
    return () => { active = false; clearInterval(timer); };
  }, [profile.installation, profile.comfyUrl, variant]);
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !preparing) close(); }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [close, preparing]);
  const choices = filter ? catalog.filter(name => name.toLowerCase().includes(filter.toLowerCase())) : category === 'All sounds' ? catalog : presets[category].filter(name => catalog.includes(name));
  let guidanceError = ''; try { if (mode === 'sam') normalizeGuidance(guidance, request); } catch (cause) { guidanceError = String(cause); }
  const chosen = mode === 'sam' ? guidance.visualOnly ? 'Visual target' : guidance.description?.trim() || target : target;
  const submit = () => extract(mode, chosen, mode === 'sam' ? guidance : undefined);
  const available = !guidanceError && !!engine?.detailRange && (mode === 'sam' ? !!engine?.sam && !!engine?.samPrompts && !!sam?.ready : !!engine?.targets?.includes(target));
  useEffect(() => { submitShortcut.current = () => { if (available && !busy && !preparing) submit(); }; return () => { submitShortcut.current = () => {}; }; }, [available, busy, preparing, mode, target, guidance, extract, submitShortcut]);
  async function prepare() {
    try { setError(''); const secret = token; setToken(''); setSAM(await window.desktop!.prepareSAM(profile, secret, variant)); } catch (cause) { setError(String(cause)); }
  }
  return <div className="modal-backdrop"><section className="connection-modal detail-picker" role="dialog" aria-modal="true" aria-labelledby="detail-title">
    <div className="modal-top"><span className="eyebrow"><Crosshair size={14}/> CHANNEL EXTRACTION</span><button className="icon-button" onClick={close} disabled={preparing} aria-label="Close target picker"><X size={17}/></button></div>
    <h2 id="detail-title">Extract sound</h2><p className="detail-region">{request.stem.label} <span>{request.start.toFixed(2)}s → {request.end.toFixed(2)}s</span></p>
    <div className="detail-models" role="group" aria-label="Detail model"><button aria-pressed={mode === 'sam'} onClick={() => setMode('sam')}>SAM Audio <small>{variant} · experimental</small></button><button aria-pressed={mode === 'uss'} onClick={() => setMode('uss')}>USS <small>AudioSet classes</small></button><button disabled title="PromptSep-specific inference code and weights could not be verified. The project Code Base link points to GuideSep.">PromptSep <small>Not released</small></button></div>
    {mode === 'sam' && <label className="sam-size">SAM model<select value={variant} disabled={preparing || busy} onChange={event => {setVariant(event.target.value as 'small-tv'|'large-tv');setSAM(null);}}><option value="small-tv">Small TV</option><option value="large-tv" disabled={!engine?.samModels}>Large TV{!engine?.samModels ? ' · update integration' : ''}</option></select></label>}
    <div className="target-categories" role="group" aria-label="Sound categories">{[...Object.keys(presets), 'All sounds'].map(name => <button key={name} aria-pressed={category === name} onClick={() => { setCategory(name); setFilter(''); }}>{name}</button>)}</div>
    <input className="target-search" placeholder="Filter sounds (optional)" aria-label="Filter sound choices" value={filter} onChange={event => setFilter(event.target.value)}/>
    <div className="target-grid" role="group" aria-label="Target sound">{choices.map(name => <button key={name} aria-pressed={target === name} onClick={() => setTarget(name)}>{name}</button>)}{!choices.length && <p>No matching sounds.</p>}</div>
    {mode === 'sam' && <SAMGuidanceEditor range={request} sourceUrl={sourceUrl} value={guidance} change={setGuidance} supported={!!engine?.samPrompts} visualSupported={!!engine?.samVisual}/>}
    <p className="model-release-note">PromptSep: <a href="https://github.com/YutongWen/PromptSep" target="_blank" rel="noreferrer">inference / weights unavailable</a>.</p>
    {guidanceError && <p className="error-banner" role="alert">{guidanceError}</p>}
    {mode === 'sam' && !sam?.ready && <details className="sam-preparation" open><summary>Prepare SAM Audio</summary><p>Downloads a private CUDA runtime, SAM {variant} and required encoder files. Multi-GB download. Existing ComfyUI Python stays unchanged.</p><p>Approve access on Hugging Face: <a href={`https://huggingface.co/facebook/sam-audio-${variant}`} target="_blank" rel="noreferrer">SAM Audio</a> · <a href="https://huggingface.co/facebook/pe-av-large" target="_blank" rel="noreferrer">PE-AV</a>. Paste your hf_ read-access token, not a verification code. Access approval and token permissions are both required. The token is used only for preparation. <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noreferrer">Create access token</a>.</p><input type="password" autoComplete="off" spellCheck={false} aria-label="Hugging Face read token" placeholder="hf_… (Hugging Face access token)" value={token} disabled={preparing} onChange={event => setToken(event.target.value)}/><label className="sam-consent"><input type="checkbox" checked={consent} disabled={preparing} onChange={event => setConsent(event.target.checked)}/> I accept the <a href="https://github.com/facebookresearch/sam-audio/blob/main/LICENSE" target="_blank" rel="noreferrer">SAM license</a> and approve these downloads.</label><button className="secondary-button" disabled={!consent || !token || preparing || busy} onClick={() => void prepare()}>Prepare SAM Audio</button>{preparing && <button className="quiet-button" onClick={() => void window.desktop?.cancelSAM()}>Cancel preparation</button>}</details>}
    {sam?.message && mode === 'sam' && <div className="sam-progress" role="status">{preparing && <LoaderCircle className="spin" size={13}/>} {sam.message}{sam.detail && <details><summary>Details</summary><pre>{sam.detail}</pre></details>}</div>}
    {error && <p className="error-banner" role="alert">{error}</p>}
    {!engine?.detailRange && <p className="helper">Update the integration with the latest installer and restart idle ComfyUI.</p>}
    <div className="modal-actions"><span className="subtle" title={chosen}>{chosen}</span><button className="primary-button" disabled={busy || preparing || !available} onClick={submit}><Crosshair size={15}/> Extract</button></div>
  </section></div>;
}
