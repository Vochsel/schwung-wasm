#!/usr/bin/env bash
# Build Schwung catalog modules as Emscripten side modules and stage them into
# the virtual filesystem tree the engine mounts at /data:
#
#   build/vfs/data/UserData/schwung/modules/<category_dir>/<id>/<so_name>
#   build/vfs/data/UserData/schwung/modules/<category_dir>/<id>/{module.json,ui.js,…}
#   build/vfs/modules-manifest.json
#
# Usage: scripts/build-modules.sh [id ...]        (no ids = every recipe)
#
# Each module is described by modules/recipes/<id>.json. Its source is cloned
# from GitHub at the pinned commit into build/module-src/ (never committed),
# patched (generic wasm32 fixups + modules/patches/<id>/*.patch), compiled with
# the pinned emsdk image via scripts/em, then staged.
#
# Env:
#   MODULE_MIRROR=<dir>   look for <dir>/<owner>_<repo> clones before GitHub
#   JOBS=<n>              parallel compiles inside the container (default 8)
#   KEEP_GOING=1          (default) continue after a failed module; 0 = stop
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
RECIPES="$ROOT/modules/recipes"
SRCROOT="$ROOT/build/module-src"
OBJROOT="$ROOT/build/module-obj"
VFS="$ROOT/build/vfs"
MODROOT="$VFS/data/UserData/schwung/modules"
JOBS="${JOBS:-8}"
KEEP_GOING="${KEEP_GOING:-1}"
mkdir -p "$SRCROOT" "$OBJROOT" "$MODROOT"

# The fake/real host headers come from the patched Schwung copy.
[ -f "$ROOT/build/schwung/src/host/plugin_api_v1.h" ] || bash "$ROOT/scripts/prepare.sh" >/dev/null

if [ $# -eq 0 ]; then
  set -- $(cd "$RECIPES" && ls *.json | sed 's/\.json$//')
fi

# Small Node helper: recipe -> shell vars, compile script, staging.
HELPER="$OBJROOT/.recipe-helper.mjs"
cat > "$HELPER" <<'EOF'
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const [,, cmd, recipePath, srcDir, objDir, stageDir] = process.argv;
const r = cmd === 'manifest' ? null : JSON.parse(fs.readFileSync(recipePath, 'utf8'));
const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
const toW = p => '/w/' + path.relative(process.env.ROOT, p);

function expand(pattern) {
  const hits = fs.globSync(pattern, { cwd: srcDir }).sort();
  return hits;
}

// Minimal wasm reader: returns the symbols a side module needs from the main
// module (env.* imports and GOT.* entries for symbols it does not export
// itself), skipping the memory/table/stack plumbing every side module has.
// Symbols the host dlsym()s from a module (grep dlsym( in build/schwung/src:
// chain_synth_load.c, chain_fx_load.c, shadow_chain_mgmt.c, schwung_shim.c's
// overtake loader), plus clap_entry for the airwindows .clap side module.
// Modules are linked SIDE_MODULE=2 exporting ONLY the ones they define:
// Emscripten's dynamic linker has one global namespace, so any other export
// would be bound by later-loaded modules (freak's plaits:: vs plaits).
const ENTRY_POINTS = ['move_plugin_init_v2', 'move_plugin_init_v1', 'move_audio_fx_init_v2',
  'move_audio_fx_init_v1', 'move_midi_fx_init', 'move_audio_fx_on_midi', 'move_plugin_render_split',
  'clap_entry'];
// Exports Emscripten itself adds to every side module.
const EM_INTERNAL = /^(__wasm_call_ctors|__wasm_apply_data_relocs|__wasm_apply_global_relocs|_emscripten_tls_init|__wasm_init_tls|__tls_base|__tls_size|__tls_align|__start_em_asm|__stop_em_asm|__start_em_js|__stop_em_js|__start_em_lib_deps|__stop_em_lib_deps|__em_js__.*|__em_lib_deps_.*)$/;

function wasmExports(buf) {
  let p = 8;
  const u = () => { let r = 0, sh = 0, b; do { b = buf[p++]; r |= (b & 0x7f) << sh; sh += 7; } while (b & 0x80); return r >>> 0; };
  const str = () => { const n = u(); const s = buf.toString('utf8', p, p + n); p += n; return s; };
  const out = [];
  while (p < buf.length) {
    const id = buf[p++], size = u(), end = p + size;
    if (id === 7) for (let n = u(); n > 0; n--) { out.push(str()); p++; u(); }
    p = end;
  }
  return out;
}

function wasmImports(buf) {
  let p = 8;
  const u = () => { let r = 0, sh = 0, b; do { b = buf[p++]; r |= (b & 0x7f) << sh; sh += 7; } while (b & 0x80); return r >>> 0; };
  const str = () => { const n = u(); const s = buf.toString('utf8', p, p + n); p += n; return s; };
  const limits = () => { const f = u(); u(); if (f & 1) u(); };
  const imps = [], exps = new Set();
  while (p < buf.length) {
    const id = buf[p++], size = u(), end = p + size;
    if (id === 2) {
      for (let n = u(); n > 0; n--) {
        const mod = str(), field = str(), kind = buf[p++];
        if (kind === 0) u(); else if (kind === 1) { p++; limits(); } else if (kind === 2) limits();
        else if (kind === 3) { p += 2; } else if (kind === 4) { p++; u(); }
        if (mod === 'env' && ['memory', '__indirect_function_table', '__stack_pointer', '__memory_base',
          '__table_base'].includes(field)) continue;
        imps.push([mod, field]);
      }
    } else if (id === 7) {
      for (let n = u(); n > 0; n--) { exps.add(str()); p++; u(); }
    }
    p = end;
  }
  return imps.filter(([m, f]) => !exps.has(f))
    .map(([m, f]) => m === 'env' ? f : `${m}.${f}`);
}

if (cmd === 'extras') {
  // one line per pinned dependency: repo<TAB>commit<TAB>dir<TAB>submodules
  for (const e of r.extra_repos || []) console.log([e.repo, e.commit, e.dir, e.submodules ? 1 : 0].join('\t'));
  process.exit(0);
}
if (cmd === 'downloads') {
  // url<TAB>sha256<TAB>src-dest (only for "src" downloads, staged before compile)
  for (const d of r.downloads || []) console.log([d.url, d.sha256, d.src ? d.to : ''].join('\t'));
  process.exit(0);
}
if (cmd === 'prescript') {
  // pre_build: shell commands run in the container from the source root
  // before sources are globbed (configure, codegen, building a dep into a .a).
  if (!(r.pre_build || []).length) process.exit(0);
  console.log(['set -e', `cd ${q(toW(srcDir))}`, ...r.pre_build.map(c => `( ${c} )`)].join('\n'));
  process.exit(0);
}
if (cmd === 'vars') {
  const [owner, repo] = r.repo.split('/');
  const out = {
    R_ID: r.id, R_REPO: r.repo, R_OWNER: owner, R_NAME: repo, R_COMMIT: r.commit,
    R_CATEGORY: r.category_dir, R_SO: r.so_name, R_SUBMODULES: r.submodules ? 1 : 0,
    R_SKIP: r.skip ? 1 : 0,
  };
  for (const [k, v] of Object.entries(out)) console.log(`${k}=${q(v)}`);
} else if (cmd === 'script') {
  // Generate the in-container compile script.
  const sources = [];
  for (const g of r.sources) {
    if (g.startsWith('!')) continue;
    const optional = g.startsWith('?');           // "?glob" may match nothing
    const hits = expand(optional ? g.slice(1) : g);
    if (!hits.length && optional) continue;
    if (!hits.length) { console.error(`recipe ${r.id}: source glob matched nothing: ${g}`); process.exit(3); }
    sources.push(...hits);
  }
  const excludes = r.sources.filter(g => g.startsWith('!')).flatMap(g => expand(g.slice(1)));
  const srcs = [...new Set(sources)].filter(s => !excludes.includes(s));
  const base = ['-O2', '-fPIC', '-pthread', '-fvisibility=hidden', '-include', '/w/compat/include/schwung_module_prelude.h', '-include', '/w/compat/wasm_compat.h',
    ...(r.include || []).map(i => '-I' + toW(path.join(srcDir, i))),
    ...(r.include_abs || []).map(i => '-I' + i),
    ...(r.defines || []).map(d => '-D' + d)];
  const lines = ['set -e', `cd ${q(toW(srcDir))}`, `OBJ=${q(toW(objDir))}`, 'rm -rf "$OBJ/o"; mkdir -p "$OBJ/o"', ': > "$OBJ/cmds"'];

  const objs = [];
  srcs.forEach((s, i) => {
    const isCxx = /\.(cc|cpp|cxx|C)$/.test(s);
    const o = `$OBJ/o/${i}_${path.basename(s).replace(/\.[^.]+$/, '')}.o`;
    objs.push(o);
    const flags = [...base, ...(isCxx ? ['-fvisibility-inlines-hidden'] : []), ...(r.cflags_all || []), ...(isCxx ? (r.cxxflags || []) : (r.cflags || [])),
      ...((r.per_file_flags || {})[s] || [])];
    const c = `${isCxx ? 'em++' : 'emcc'} -c ${flags.map(q).join(' ')} ${q(s)} -o "${o}"`;
    lines.push(`printf '%s\\n' ${q(c.replace(/\$OBJ/g, toW(objDir)))} >> "$OBJ/cmds"`);
  });
  lines.push(`xargs -P ${process.env.JOBS || 8} -d '\\n' -I{} sh -c '{} || exit 255' < "$OBJ/cmds"`);
  const link = r.cxx ? 'em++' : 'emcc';
  // Export only the host entry points this module defines (SIDE_MODULE=2
  // errors on exporting an undefined symbol). Scan our objects plus any .o/.a
  // or @response file named in ldflags (static deps, Rust staticlibs).
  const ld = r.ldflags || [];
  const extra = ld.flatMap(t => t.split(',')).filter(t => /\.(a|o)$/.test(t)).map(q);
  // response files may hold linker flags; hand only .o/.a paths to llvm-nm
  const rsp = ld.filter(t => t.startsWith('@')).map(t => `$(tr -s ' \\t' '\\n\\n' < ${q(t.slice(1))} | tr -d '"' | grep -E '\\.(a|o)$')`);
  lines.push(`EXPORTS=$(/emsdk/upstream/bin/llvm-nm --defined-only -j ${objs.map(o => `"${o}"`).join(' ')} ${extra.join(' ')} ${rsp.join(' ')} 2>/dev/null | grep -xE '${ENTRY_POINTS.join('|')}' | sort -u | sed 's/^/_/' | paste -sd, -)`);
  lines.push(`[ -n "$EXPORTS" ] || { echo "error: no host entry point (${ENTRY_POINTS.join(', ')}) defined" >&2; exit 1; }`);
  lines.push('echo "exports: $EXPORTS"');
  lines.push(`${link} -O2 -pthread -sSIDE_MODULE=2 -sEXPORTED_FUNCTIONS="$EXPORTS" ${ld.map(q).join(' ')} ${objs.map(o => `"${o}"`).join(' ')} -o "$OBJ/${r.so_name}"`);
  console.log(lines.join('\n'));
} else if (cmd === 'stage') {
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  fs.copyFileSync(path.join(objDir, r.so_name), path.join(stageDir, r.so_name));
  for (const a of r.assets || []) {
    const spec = typeof a === 'string' ? { from: a } : a;
    if (spec.mkdir) { fs.mkdirSync(path.join(stageDir, spec.mkdir), { recursive: true }); continue; }
    if (spec.from.startsWith('$generated/')) {
      fs.mkdirSync(path.dirname(path.join(stageDir, spec.to)), { recursive: true });
      fs.writeFileSync(path.join(stageDir, spec.to), JSON.stringify(spec.content, null, 2));
      continue;
    }
    const hits = expand(spec.from);
    if (!hits.length) {
      if (spec.optional) continue;
      console.error(`recipe ${r.id}: asset matched nothing: ${spec.from}`); process.exit(4);
    }
    for (const h of hits) {
      const src = path.join(srcDir, h);
      let dst;
      // "to" starting with /data/ = absolute VFS path (e.g. UserLibrary/Samples)
      const base = spec.to && spec.to.startsWith('/data/') ? path.join(process.env.ROOT, 'build/vfs') : stageDir;
      if (!spec.to) dst = path.join(stageDir, path.basename(h));
      else if (spec.to.endsWith('/') || hits.length > 1) dst = path.join(base, spec.to, path.basename(h));
      else dst = path.join(base, spec.to);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(src, dst, { recursive: true });
    }
  }
  // pinned downloads that belong in the module dir or elsewhere in /data
  for (const d of r.downloads || []) {
    if (d.src) continue;
    const cached = path.join(process.env.ROOT, 'build/module-downloads', d.sha256);
    const dest = d.to.startsWith('/data/') ? path.join(process.env.ROOT, 'build/vfs', d.to) : path.join(stageDir, d.to);
    if (d.extract) {
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(dest, { recursive: true });
      const isZip = /\.zip($|\?)/i.test(d.url) || d.extract === 'zip';
      const args = isZip ? ['unzip', ['-q', '-o', cached, '-d', dest]] : ['tar', ['-xf', cached, '-C', dest, ...(d.strip ? [`--strip-components=${d.strip}`] : [])]];
      const x = spawnSync(args[0], args[1], { stdio: 'inherit' });
      if (x.status !== 0) { console.error(`recipe ${r.id}: extract failed: ${d.url}`); process.exit(5); }
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(cached, dest);
    }
  }
  // manifest entry
  let mj = {};
  try { mj = JSON.parse(fs.readFileSync(path.join(stageDir, 'module.json'), 'utf8')); } catch {}
  const entry = {
    id: r.id, name: r.name || mj.name || r.id, type: r.component_type, category_dir: r.category_dir,
    version: mj.version || null, license: r.license || null, repo: r.repo, commit: r.commit,
    path: `/data/UserData/schwung/modules/${r.category_dir}/${r.id}`, dsp: r.so_name,
    built_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(objDir, 'manifest-entry.json'), JSON.stringify(entry, null, 2));
} else if (cmd === 'manifest') {
  // recipePath = objroot, srcDir = vfs root
  const objroot = recipePath, vfs = srcDir;
  const mods = [];
  for (const d of fs.readdirSync(objroot)) {
    const f = path.join(objroot, d, 'manifest-entry.json');
    if (!fs.existsSync(f)) continue;
    const e = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!fs.existsSync(path.join(vfs, e.path, e.dsp))) continue;
    mods.push(e);
  }
  mods.sort((a, b) => a.id.localeCompare(b.id));
  // Union of what the side modules import from the main module. A MAIN_MODULE=2
  // engine must export all of these (MAIN_MODULE=1 exports everything).
  const imports = {};
  for (const e of mods) {
    for (const sym of wasmImports(fs.readFileSync(path.join(vfs, e.path, e.dsp)))) {
      (imports[sym] ||= []).push(e.id);
    }
  }
  const sorted = Object.fromEntries(Object.keys(imports).sort().map(k => [k, imports[k]]));
  // One global namespace: no two modules may export the same non-entry symbol,
  // and no module should export anything beyond entry points + Emscripten's own.
  const owners = {};
  let bad = 0;
  for (const e of mods) {
    for (const x of wasmExports(fs.readFileSync(path.join(vfs, e.path, e.dsp)))) {
      if (ENTRY_POINTS.includes(x) || EM_INTERNAL.test(x)) continue;
      (owners[x] ||= []).push(e.id);
    }
  }
  for (const [sym, ids] of Object.entries(owners)) {
    if (ids.length > 1) { console.error(`!! symbol clash: ${sym} exported by ${ids.join(', ')}`); bad++; }
  }
  const extraExp = Object.entries(owners).filter(([, ids]) => ids.length === 1);
  if (extraExp.length) console.error(`warning: ${extraExp.length} non-entry exports (e.g. ${extraExp.slice(0, 5).map(([s, i]) => `${i[0]}:${s}`).join(', ')})`);
  if (bad) { console.error(`!! ${bad} exported-symbol clashes between modules`); process.exitCode = 6; }
  fs.writeFileSync(path.join(vfs, 'modules-imports.json'), JSON.stringify(sorted, null, 1) + '\n');
  fs.writeFileSync(path.join(vfs, 'modules-manifest.json'),
    JSON.stringify({ generated_at: new Date().toISOString(), modules: mods }, null, 2) + '\n');
  console.log(`manifest: ${mods.length} modules`);
}
EOF
export ROOT JOBS

fetch_src() { # dir url commit submodules owner name
  local dir="$1" url="$2" commit="$3" subs="$4" mirror=""
  [ -n "${MODULE_MIRROR:-}" ] && [ -d "$MODULE_MIRROR/$5_$6/.git" ] && mirror="$MODULE_MIRROR/$5_$6"
  if [ ! -d "$dir/.git" ]; then
    git init -q "$dir" && git -C "$dir" remote add origin "$url"
  fi
  if [ "$(git -C "$dir" rev-parse -q --verify HEAD 2>/dev/null)" != "$commit" ]; then
    if ! git -C "$dir" cat-file -e "$commit^{commit}" 2>/dev/null; then
      { [ -n "$mirror" ] && git -C "$dir" fetch -q --depth 1 "$mirror" "$commit" 2>/dev/null; } ||
        git -C "$dir" fetch -q --depth 1 origin "$commit" || return 1
    fi
  fi
  git -C "$dir" checkout -q -f "$commit" || return 1
  git -C "$dir" clean -q -fdx
  if [ "$subs" = 1 ]; then
    git -C "$dir" submodule -q sync && git -C "$dir" submodule -q update --init --recursive --depth 1 --force || return 1
  fi
}

# wasm32 fixups that every module needs, applied to the pristine checkout:
#  - module copies of plugin_api_v1.h static-assert the LP64 offsets of
#    host_api_v1_t (reserved at +120); on wasm32 the struct is smaller. Guard
#    them like patches/apply.py does for the host's own copy.
generic_fixups() {
  local dir="$1"
  grep -rlE --include='*.h' --include='*.hpp' --include='*.c' --include='*.cc' --include='*.cpp' \
      '(_Static_assert|static_assert)[[:space:]]*\([[:space:]]*offsetof[[:space:]]*\([[:space:]]*host_api_v1_t' "$dir" 2>/dev/null |
    while read -r f; do
      perl -0pi -e 's/^([ \t]*(?:_Static_assert|static_assert)\s*\(\s*offsetof\s*\(\s*host_api_v1_t\b.*?\);)/#if UINTPTR_MAX > 0xFFFFFFFFu \/* schwung-wasm: LP64-only layout guard *\/\n$1\n#endif/gms' "$f"
    done
}

build_one() {
  local id="$1" recipe="$RECIPES/$1.json"
  [ -f "$recipe" ] || { echo "!! $id: no recipe $recipe"; return 1; }
  eval "$(node "$HELPER" vars "$recipe")" || return 1
  if [ "$R_SKIP" = 1 ]; then echo "-- $id: recipe marked skip"; return 0; fi
  local src="$SRCROOT/${R_OWNER}__${R_NAME}" obj="$OBJROOT/$id" stage="$MODROOT/$R_CATEGORY/$id"
  mkdir -p "$obj"
  rm -f "$obj/manifest-entry.json"
  echo "== $id ($R_REPO@${R_COMMIT:0:10})"
  fetch_src "$src" "https://github.com/$R_REPO.git" "$R_COMMIT" "$R_SUBMODULES" "$R_OWNER" "$R_NAME" ||
    { echo "!! $id: fetch failed"; return 1; }
  # pinned dependency repos, cloned inside the module tree (git clean -fdx
  # leaves nested repos alone, so they stay cached)
  while IFS=$'\t' read -r erepo ecommit edir esubs; do
    [ -n "$erepo" ] || continue
    fetch_src "$src/$edir" "https://github.com/$erepo.git" "$ecommit" "$esubs" "${erepo%%/*}" "${erepo##*/}" ||
      { echo "!! $id: fetch of $erepo failed"; return 1; }
  done < <(node "$HELPER" extras "$recipe")
  # pinned downloads (sha256-verified, cached in build/module-downloads/)
  while IFS=$'\t' read -r durl dsha dsrc; do
    [ -n "$durl" ] || continue
    local cache="$ROOT/build/module-downloads/$dsha"
    if [ ! -f "$cache" ]; then
      mkdir -p "$ROOT/build/module-downloads"
      curl -fsSL --retry 3 -o "$cache.part" "$durl" || { echo "!! $id: download failed: $durl"; return 1; }
      local got; got=$(shasum -a 256 "$cache.part" | cut -d' ' -f1)
      [ "$got" = "$dsha" ] || { echo "!! $id: sha256 mismatch for $durl (got $got)"; rm -f "$cache.part"; return 1; }
      mv "$cache.part" "$cache"
    fi
    if [ -n "$dsrc" ]; then
      case "$durl" in
        *.zip) mkdir -p "$src/$dsrc" && unzip -q -o "$cache" -d "$src/$dsrc" ;;
        *.tar*|*.tgz) mkdir -p "$src/$dsrc" && tar -xf "$cache" -C "$src/$dsrc" ;;
        *) mkdir -p "$(dirname "$src/$dsrc")" && cp "$cache" "$src/$dsrc" ;;
      esac
    fi
  done < <(node "$HELPER" downloads "$recipe")
  generic_fixups "$src"
  for p in "$ROOT/modules/patches/$id"/*.patch; do
    [ -e "$p" ] || continue
    patch -s -p1 -d "$src" < "$p" || { echo "!! $id: patch $(basename "$p") failed"; return 1; }
  done
  node "$HELPER" prescript "$recipe" "$src" > "$obj/pre.sh" || { echo "!! $id: bad recipe"; return 1; }
  if [ -s "$obj/pre.sh" ] && ! "$ROOT/scripts/em" bash "/w/${obj#$ROOT/}/pre.sh" > "$obj/pre.log" 2>&1; then
    echo "!! $id: pre_build failed (build/module-obj/$id/pre.log):"; tail -15 "$obj/pre.log"; return 1
  fi
  node "$HELPER" script "$recipe" "$src" "$obj" > "$obj/build.sh" || { echo "!! $id: bad recipe"; return 1; }
  if ! "$ROOT/scripts/em" bash "/w/${obj#$ROOT/}/build.sh" > "$obj/build.log" 2>&1; then
    echo "!! $id: compile failed (build/module-obj/$id/build.log):"
    grep -E 'error|undefined' "$obj/build.log" | grep -v experimental | head -15
    return 1
  fi
  node "$HELPER" stage "$recipe" "$src" "$obj" "$stage" || { echo "!! $id: staging failed"; return 1; }
  echo "   ok -> ${stage#$ROOT/}/ ($(du -k "$stage/$R_SO" | cut -f1) KB)"
}

fails=()
for id in "$@"; do
  if ! build_one "$id"; then
    fails+=("$id")
    [ "$KEEP_GOING" = 1 ] || break
  fi
done
clash=0
node "$HELPER" manifest "$OBJROOT" "$VFS" || clash=1
[ "$clash" = 1 ] && echo "FAILED: exported-symbol clash check (see !! lines above)"
if [ ${#fails[@]} -gt 0 ] || [ "$clash" = 1 ]; then
  echo "FAILED: ${fails[*]-}"
  exit 1
fi
