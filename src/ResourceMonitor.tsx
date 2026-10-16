import { useEffect, useState } from 'react';
import type { Profile, Resources } from './types';

const gb = (bytes: number) => (bytes / 1073741824).toFixed(1);
export function ResourceMonitor({ profile }: { profile: Profile }) {
  const [value, setValue] = useState<Resources | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    setValue(null);
    const poll = async () => {
      try {
        const result = await window.desktop?.resources(profile);
        if (alive) setValue(result || null);
      } catch { if (alive) setValue(null); }
      if (alive) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [profile.comfyUrl]);
  const memory = (name: 'vram' | 'ram') => {
    const item = value?.[name];
    return <div className="resource-cell" title={item ? `${name.toUpperCase()}: ${gb(item.used)} / ${gb(item.total)} GiB used on selected ComfyUI` : 'Selected ComfyUI memory unavailable'}><small>{name.toUpperCase()}</small><span>{item ? <>{gb(item.used)}<i> / {gb(item.total)} G</i></> : 'n/a'}</span><b style={{ width: `${item ? Math.min(100, item.used / item.total * 100) : 0}%` }}/></div>;
  };
  return <div className={`resource-monitor ${value?.online ? 'available' : ''}`} aria-label="Selected ComfyUI resources">
    {memory('vram')}{memory('ram')}
    {(['gpu', 'cpu'] as const).map(kind => {
      const temp = value?.[kind === 'gpu' ? 'gpuTemperature' : 'cpuTemperature'];
      return <div key={kind} className={`resource-cell thermal ${temp != null && temp >= 85 ? 'hot' : ''}`} title={temp == null ? `${kind.toUpperCase()} sensor unavailable on selected ComfyUI. GPU requires NVML; CPU sensors depend on OS support.` : `${kind.toUpperCase()} temperature on selected ComfyUI`}><small>{kind.toUpperCase()} °C</small><span>{temp == null ? 'n/a' : Math.round(temp) + '°'}</span></div>;
    })}
  </div>;
}
