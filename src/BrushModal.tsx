import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Paintbrush, X } from 'lucide-react';
import type { BrushState, Engine, Profile } from './types';

const MIN = 0.5, MAX = 60;
const running = (state: BrushState | null) => state?.phase === 'downloading';
export function BrushModal({ region, engine, profile, busy, close, refreshEngine, run }: { region: { start: number; end: number }; engine: Engine | null; profile: Profile; busy: boolean; close: () => void; refreshEngine: () => Promise<void>; run: (prompt: string) => void }) {
  const [prompt, setPrompt] = useState(''), [state, setState] = useState<BrushState | null>(null), [consent, setConsent] = useState(false), [error, setError] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  const seconds = region.end - region.start, active = running(state);
  const modelReady = !!engine?.brush && !!engine?.brushModel, problem = seconds < MIN ? `Paint at least ${MIN} seconds.` : seconds > MAX ? `Paint at most ${MAX} seconds at a time.` : !engine?.brush ? 'Update the Stem Studio integration and ComfyUI first.' : !modelReady ? 'Download the sound model first.' : !prompt.trim() ? 'Describe the sound.' : '';
  useEffect(() => { field.current?.focus(); void window.desktop?.brushStatus(profile).then(setState).catch(() => {}); }, []);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { void window.desktop?.brushStatus(profile).then(next => { setState(next); if (next.phase === 'complete') void refreshEngine(); }).catch(() => {}); }, 1000);
    return () => clearInterval(timer);
  }, [active]);
  const submit = () => { if (!problem && !busy) run(prompt.trim()); };
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !active) close(); }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [close, active]);
  async function download() { try { setError(''); setState(await window.desktop!.prepareBrush(profile)); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }
  return <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget && !active) close(); }}>
    <section className="connection-modal mini-modal brush-modal" role="dialog" aria-modal="true" aria-label="Brush">
      <header><span className="mini-title"><Paintbrush size={15}/><strong>Brush</strong></span><button className="icon-button" disabled={active} onClick={close} aria-label="Close"><X size={15}/></button></header>
      <div className="mini-body">
        <p className="brush-region">{region.start.toFixed(2)} s to {region.end.toFixed(2)} s <span>{seconds.toFixed(1)} s</span></p>
        <textarea ref={field} className="brush-prompt" rows={3} maxLength={300} value={prompt} placeholder="e.g. slow footsteps on wet gravel, close up" onChange={event => setPrompt(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopPropagation(); submit(); } }}/>
        <p className="helper">Paints a new channel from Stable Audio 3 Small-SFX, placed at this time and silent elsewhere. Short, specific effects work best.</p>
        {engine?.brush && !modelReady && <details className="sam-preparation" open><summary>Download the sound model</summary>
          <p>Stable Audio 3 Small-SFX (2.3 GB) and its T5Gemma text encoder (1.2 GB), under the Stability AI Community License. Saved in ComfyUI/models/audio_separation/stable-audio-3 and checked against pinned hashes. No account needed.</p>
          <label className="sam-consent"><input type="checkbox" checked={consent} disabled={active} onChange={event => setConsent(event.target.checked)}/> I approve the download and accept the <a href="https://huggingface.co/stabilityai/stable-audio-open-1.0/blob/main/LICENSE.md" target="_blank" rel="noreferrer">license</a>.</label>
          <button className="secondary-button" disabled={!consent || active} onClick={() => void download()}>Download</button>
          {active && <button className="quiet-button" onClick={() => void window.desktop?.cancelBrush()}>Cancel</button>}
          {state?.phase === 'complete' && <button className="secondary-button" onClick={() => void refreshEngine()}>Check again</button>}
        </details>}
        {state?.message && state.phase !== 'idle' && <div className="sam-progress" role="status">{active && <LoaderCircle className="spin" size={13}/>} {state.message}{active && state.percent >= 0 && <progress max="100" value={state.percent}/>}{state.detail && <small>{state.detail}</small>}</div>}
        {error && <p className="error-banner" role="alert">{error}</p>}
      </div>
      <footer><span className="subtle" data-tip={problem}>{problem}</span><button className="primary-button" disabled={!!problem || busy} onClick={submit}>Paint</button></footer>
    </section>
  </div>;
}
