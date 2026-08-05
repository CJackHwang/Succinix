// posix-node shim for the python runtime bundle (TASK23).
// The real posix-node ships native .node addons (x86_64-macos.node, ...) that cannot load
// inside WebContainer and are only used for optional signal/blocking-stdin behavior.
// python-wasm's @cowasm/kernel guards every call with `?.` / `!= null`, so an empty module
// is a safe no-op. Bundled via esbuild `alias` so no native addon is ever resolved.
module.exports = {
  sleep: undefined,
  usleep: undefined,
  watchForSignal: undefined,
  getSignalState: undefined,
  makeStdinBlocking: undefined,
};
