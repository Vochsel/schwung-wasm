// Mount the module VFS (build/vfs/data -> /data) and the output dir (-> /out)
// before main() runs. Host paths come from the environment (set by
// scripts/test-module.mjs).
Module.preRun = Module.preRun || [];
Module.preRun.push(function () {
  var data = process.env.TESTHOST_DATA, out = process.env.TESTHOST_OUT;
  if (data) { FS.mkdir('/data'); FS.mount(NODEFS, { root: data }, '/data'); }
  if (out) { FS.mkdir('/out'); FS.mount(NODEFS, { root: out }, '/out'); }
});
