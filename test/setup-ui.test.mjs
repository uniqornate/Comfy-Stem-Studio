import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFile(join(root, path), 'utf8');

test('every control the unified setup looks up exists in the window definition, and every reference is looked up', async () => {
  const script = await read('build/bootstrap/UnifiedSetup.ps1'), xaml = await read('build/bootstrap/Setup.xaml');
  const looked = [...script.match(/foreach\(\$name in @\(([^)]*)\)\)/)[1].matchAll(/'(\w+)'/g)].map(match => match[1]);
  const defined = new Set([...xaml.matchAll(/ Name="(\w+)"/g)].map(match => match[1]));
  for (const name of looked) assert.ok(defined.has(name), `${name} is missing from Setup.xaml`);
  const referenced = new Set([...script.matchAll(/\$ui\.(\w+)/g)].map(match => match[1]));
  for (const name of referenced) assert.ok(looked.includes(name), `$ui.${name} is used but never looked up`);
  for (const name of ['HaveComfy', 'InstallComfy', 'ExistingPanel', 'InstallPanel', 'InstallParent', 'BrowseInstall', 'GpuHint']) assert.ok(looked.includes(name));
});
test('the worker receives exactly the arguments the setup passes, including the ComfyUI install request', async () => {
  const script = await read('build/bootstrap/UnifiedSetup.ps1'), worker = await read('setup/Unified-Worker.ps1');
  const params = worker.match(/param\(([^)]*)\)/)[1].split(',').map(item => item.trim());
  const line = script.split('\n').find(text => text.includes('AddScript($unifiedWorker.ToString())'));
  const passed = (line.match(/\.AddArgument\(/g) || []).length;
  assert.equal(passed, params.length, `${passed} arguments for ${params.length} parameters`);
  assert.deepEqual(params.slice(-2), ['$installParent', '$gpu']);
  assert.match(worker, /comfy-install\.mjs/); assert.match(worker, /\$modelRoot=Join-Path \$comfyRoot/);
});
test('the ComfyUI choice is mandatory before continuing, and install mode checks disk space and an existing install', async () => {
  const script = await read('build/bootstrap/UnifiedSetup.ps1');
  assert.match(script, /Tell setup whether you already have ComfyUI/); assert.match(script, /AvailableFreeSpace-lt 12GB/); assert.match(script, /Resolve-Comfy \(Join-Path \$full 'ComfyUI_windows_portable'\)/);
});
