import type { ServiceDef } from './types.js';

export interface ServiceTemplate extends ServiceDef {
  runtime: 'node' | 'python' | 'lifo';
  description: string;
}

/** Stable v0.7 declarative service templates.  They are recipes, not a fake
 * PID 1: lifecycle always delegates to the shared process/service registries. */
export const SERVICE_TEMPLATES: readonly ServiceTemplate[] = [
  { name: 'node-http', runtime: 'node', command: 'node server.js', port: 3000, description: 'Node HTTP server from server.js' },
  { name: 'vite', runtime: 'node', command: 'npx vite --host 0.0.0.0 --port ${PORT}', port: 5173, description: 'Vite development server' },
  { name: 'static-http', runtime: 'node', command: 'npx serve . --listen ${PORT}', port: 3000, description: 'Static file preview server' },
  { name: 'python-http', runtime: 'python', command: 'python -m http.server ${PORT}', port: 8000, description: 'Python standard-library HTTP server' },
  { name: 'tinbase', runtime: 'node', command: 'npx tinbase start --port ${PORT} --engine wasm --data-dir .tinbase', port: 3001, description: 'Tinbase WASM database service' },
  { name: 'websocket', runtime: 'node', command: 'node websocket-server.js', port: 8080, description: 'WebSocket server from websocket-server.js' },
  { name: 'worker', runtime: 'node', command: 'node worker.js', port: null, description: 'Long-running Node worker' },
] as const;

export function serviceTemplate(name: string): ServiceTemplate | undefined {
  const template = SERVICE_TEMPLATES.find((entry) => entry.name === name);
  return template ? { ...template } : undefined;
}
