#!/usr/bin/env python3
"""web/licenses.html from build/vfs/modules-manifest.json: every bundled module
with its licence and a link to the exact source commit (the corresponding
source the GPL/AGPL ones require for a public deployment)."""
import html, json, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
m = json.load(open(os.path.join(ROOT, 'build/vfs/modules-manifest.json')))['modules']
rows = ''.join(
    f"<tr><td>{html.escape(x['name'])}</td><td>{x['type'].replace('_', ' ')}</td><td>{html.escape(x.get('license') or '?')}</td>"
    f"<td><a href=\"https://github.com/{x['repo']}/tree/{x['commit']}\">{x['repo']}@{x['commit'][:7]}</a></td></tr>"
    for x in sorted(m, key=lambda x: x['name'].lower()))
TPL = open(os.path.join(ROOT, 'web/licenses.html')).read() if False else None
page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Credits and licences</title><style>
:root{{--bg:#0d0e10;--fg:#e6e7e9;--mute:#8b8f96;--line:#24262b;--link:#7fb0ff}}
body{{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}}
main{{max-width:900px;margin:0 auto;padding:32px 16px}} a{{color:var(--link)}} p{{color:var(--mute)}}
table{{width:100%;border-collapse:collapse;font-size:14px}} td,th{{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}}
.wrap{{overflow-x:auto}}</style></head><body><main>
<h1>Credits and licences</h1>
<p>This page runs <a href="https://github.com/charlesvestal/schwung">Schwung</a> (MIT, © Charles Vestal) compiled to WebAssembly by
<a href="https://github.com/Vochsel/schwung-wasm">schwung-wasm</a> (MIT). The {len(m)} modules below are their authors' work, built from
their own repositories at the commits linked, under their own licences; the linked source is the corresponding source for the code served here.
Not affiliated with or endorsed by Ableton. "Ableton" and "Move" are trademarks of Ableton AG.</p>
<div class="wrap"><table><thead><tr><th>Module</th><th>Type</th><th>Licence</th><th>Source</th></tr></thead><tbody>{rows}</tbody></table></div>
<p><a href="./">← back to the virtual Move</a></p></main></body></html>"""
open(os.path.join(ROOT, 'web/licenses.html'), 'w').write(page)
print(f'web/licenses.html: {len(m)} modules')
