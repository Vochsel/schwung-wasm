// Appended to schwung.js (--post-js). On the main thread, fetch the second
// asset bundle (extra.js/extra.data: large module directories and the sample
// library) in the background and mount it into the FS once the runtime is up,
// so the page starts from the small core bundle. The shadow UI scans module
// directories when its pickers open, so these appear a few seconds after boot.
if (typeof ENVIRONMENT_IS_PTHREAD === 'undefined' || !ENVIRONMENT_IS_PTHREAD) {
  (function () {
    var src = (Module.locateFile ? Module.locateFile('extra.js', '') : 'extra.js');
    var code = fetch(src).then(function (r) { return r.ok ? r.text() : null; }).catch(function () { return null; });
    addOnPostRun(function () {
      code.then(function (t) {
        if (!t) return;
        try { new Function('Module', t)(Module); } catch (e) { err('extra bundle: ' + e); }
      });
    });
  })();
}
