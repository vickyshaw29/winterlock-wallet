import { readFileSync } from 'node:fs';
import { initSync } from '../pkg/signer_wasm.js';

initSync({ module: readFileSync(new URL('../pkg/signer_wasm_bg.wasm', import.meta.url)) });

export * from '../pkg/signer_wasm.js';
