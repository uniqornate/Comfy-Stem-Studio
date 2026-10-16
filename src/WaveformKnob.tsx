import { useEffect, useRef, useState } from 'react';
export function WaveformKnob({ value, onChange, onPreview }: { value: number; onChange: (value: number) => void; onPreview?: (value: number) => void }) {
  const drag = useRef<{ y: number; value: number } | null>(null);
  const current = useRef(value), frame = useRef<number | null>(null), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [display, setDisplay] = useState(value);
  const callbacks = useRef({ onChange, onPreview }); callbacks.current = { onChange, onPreview };
  useEffect(() => { if (!drag.current) { current.current = value; setDisplay(value); } }, [value]);
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); if (timer.current) clearTimeout(timer.current); }, []);
  const update = (next: number) => { current.current = Math.max(.1,Math.min(1,next)); if (frame.current === null) frame.current = requestAnimationFrame(() => { frame.current = null; setDisplay(current.current); callbacks.current.onPreview?.(current.current); }); };
  const commit = () => { if (timer.current) clearTimeout(timer.current); callbacks.current.onChange(current.current); };
  const finish = (event: React.PointerEvent<HTMLDivElement>) => { if (!drag.current) return; drag.current = null; commit(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); };
  return <div className="waveform-knob" role="slider" tabIndex={0} aria-label="Waveform visual height" aria-valuemin={10} aria-valuemax={100} aria-valuenow={Math.round(display*100)} aria-valuetext={`${Math.round(display*90)} percent of clip height. Visual only.`} title="Waveform height. Drag, scroll or use arrow keys. Double-click to reset."
    onPointerDown={event => { if (event.button !== 0) return; drag.current={y:event.clientY,value:current.current}; event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={event => { if(drag.current) update(drag.current.value+(drag.current.y-event.clientY)/100); }} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
    onWheel={event => { update(current.current+(event.deltaY<0?.05:-.05)); if(timer.current)clearTimeout(timer.current);timer.current=setTimeout(commit,140); }}
    onDoubleClick={() => { update(.7);commit(); }}
    onKeyDown={event => { const next=event.key==='Home'?.1:event.key==='End'?1:['ArrowUp','ArrowRight'].includes(event.key)?current.current+.05:['ArrowDown','ArrowLeft'].includes(event.key)?current.current-.05:null;if(next!==null){event.preventDefault();update(next);commit();} }}>
    <span className="knob-dial" style={{transform:`rotate(${-135+(display-.1)/.9*270}deg)`}}><i/></span>
  </div>;
}
