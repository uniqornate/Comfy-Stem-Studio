import test from 'node:test';
import assert from 'node:assert/strict';
import { PYTHON_STUBS } from '../electron/sam-manager.mjs';

test('SAM runtime stubs cover the optional xformers and torchcodec imports', () => {
  assert.match(PYTHON_STUBS['xformers/ops/__init__.py'], /class AttentionBias/);
  assert.match(PYTHON_STUBS['xformers/ops/__init__.py'], /fmha =/);
  assert.match(PYTHON_STUBS['torchcodec/decoders.py'], /AudioDecoder = VideoDecoder/);
  assert.match(PYTHON_STUBS['torchcodec/encoders.py'], /AudioEncoder/);
});
