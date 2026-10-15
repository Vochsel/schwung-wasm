// Mount the module VFS (build/vfs/data -> /data) and the output dir (-> /out)
// before main() runs, and pass TESTHOST_* settings through to getenv()
// (Emscripten does not copy Node's process.env into the C environment).
// Host paths come from the environment (set by scripts/test-module.mjs).
Module.preRun = Module.preRun || [];
Module.preRun.push(function () {
  for (var k in process.env) if (k.indexOf('TESTHOST_') === 0) ENV[k] = process.env[k];
  var data = process.env.TESTHOST_DATA, out = process.env.TESTHOST_OUT;
  if (data) { FS.mkdir('/data'); FS.mount(NODEFS, { root: data }, '/data'); }
  if (out) { FS.mkdir('/out'); FS.mount(NODEFS, { root: out }, '/out'); }
});
