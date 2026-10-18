import { useEffect, useState } from 'react';
import { Check, FolderOpen, Layers, LoaderCircle, Minus, Plus, X } from 'lucide-react';
import type { BatchFile, BatchOptions, BatchState, Profile } from './types';

const icon = (status: string) => status === 'done' ? <Check size={12}/> : status === 'running' ? <LoaderCircle size={12} className="spin"/> : status === 'failed' ? <X size={12}/> : status === 'skipped' ? <Minus size={12}/> : <span className="batch-dot"/>;
const running = (state: BatchState | null) => state?.phase === 'running';
export function BatchModal({ profile, options, label, blocked, close }: { profile: Profile; options: BatchOptions | null; label: string; blocked: string; close: () => void }) {
  const [files, setFiles] = useState<BatchFile[]>([]), [folder, setFolder] = useState(''), [state, setState] = useState<BatchState | null>(null), [error, setError] = useState('');
  const active = running(state), shown = state && state.items.length ? state.items : files.map(file => ({ name: file.name, status: 'queued', message: '', folder: '' }));
  useEffect(() => { void window.desktop?.batchStatus().then(value => { if (value.phase !== 'idle') { setState(value); setFolder(value.folder); } }).catch(() => {}); }, []);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { void window.desktop?.batchStatus().then(setState).catch(() => {}); }, 1000);
    return () => clearInterval(timer);
  }, [active]);
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !active) close(); }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [close, active]);
  async function choose(kind: 'files' | 'folder') {
    try { setError(''); if (kind === 'files') { const picked = await window.desktop!.chooseBatchFiles(); if (picked.length) { setFiles(picked); setState(null); } } else { const picked = await window.desktop!.chooseBatchFolder(); if (picked) setFolder(picked); } }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function start() { try { setError(''); setState(await window.desktop!.startBatch(profile, files, options!)); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }
  const done = state ? state.items.filter(item => ['done', 'failed', 'skipped'].includes(item.status)).length : 0;
  const finished = state && !active && state.phase !== 'idle';
  const hint = blocked || (!files.length ? 'Add the files to process' : !folder ? 'Choose where to save the results' : '');
  return <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget && !active) close(); }}>
    <section className="connection-modal mini-modal batch-modal" role="dialog" aria-modal="true" aria-label="Batch">
      <header><span className="mini-title"><Layers size={15}/><strong>Batch</strong></span><button className="icon-button" disabled={active} onClick={close} aria-label="Close"><X size={15}/></button></header>
      <div className="mini-body">
        <p className="batch-model" data-tip="Change the model in the left panel before opening the batch.">{label}</p>
        <div className="batch-actions">
          <button className="secondary-button" disabled={active} onClick={() => void choose('files')}><Plus size={13}/> {files.length ? `${files.length} files` : 'Add files'}</button>
          <button className="secondary-button" disabled={active} onClick={() => void choose('folder')} data-tip={folder || 'Output folder'}><FolderOpen size={13}/><span>{folder ? folder.split(/[\\/]/).pop() : 'Output folder'}</span></button>
        </div>
        <ul className="batch-list" aria-label="Files">{shown.slice(0, 7).map((item, index) => <li key={index} className={`is-${item.status}`} data-tip={item.message || item.folder || item.name}>{icon(item.status)}<span>{item.name}</span></li>)}{shown.length > 7 && <li className="batch-more">+{shown.length - 7} more</li>}{!shown.length && <li className="batch-more">Results go to one folder per file, named after the file and model.</li>}</ul>
        {state && <p className="helper" role="status">{active ? `Processing ${Math.min(done + 1, state.items.length)} of ${state.items.length}` : finished ? `${state.items.filter(item => item.status === 'done').length} of ${state.items.length} done${state.items.some(item => item.status === 'failed') ? '. Hover a failed file for the reason.' : ''}` : ''}</p>}
        {error && <p className="error-banner" role="alert">{error}</p>}
      </div>
      <footer><span className="subtle" data-tip={hint}>{hint}</span>{active ? <button className="secondary-button" onClick={() => void window.desktop?.cancelBatch().then(setState)}>Cancel</button> : <button className="primary-button" disabled={!!hint || !options} onClick={() => void start()}>Start</button>}</footer>
    </section>
  </div>;
}
