// The demo's document: a fictional monthly report whose script shows one tab at a time and draws a
// small chart (a page that rewrites itself), and the same report after someone rewrote a sentence.

const page = (newCustomers: string) => `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>営業部 11月の月次報告</title>
<style>
  body { font-family: -apple-system, "Hiragino Sans", sans-serif; margin: 0; padding: 28px 36px; color: #1f2937; line-height: 1.8; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #6b7280; font-size: 13px; margin-bottom: 18px; }
  .tabs button { border: 1px solid #d1d5db; background: #f9fafb; padding: 6px 14px; border-radius: 8px 8px 0 0; font-size: 14px; cursor: pointer; }
  .tabs button.on { background: #fff; border-bottom-color: #fff; font-weight: 600; }
  .panel { border: 1px solid #d1d5db; border-radius: 0 8px 8px 8px; padding: 16px 20px; margin-top: -1px; }
  table { border-collapse: collapse; margin: 8px 0 12px; }
  td, th { border: 1px solid #e5e7eb; padding: 4px 12px; font-size: 14px; }
  .bar { height: 14px; background: #60a5fa; border-radius: 3px; display: inline-block; vertical-align: middle; margin-left: 8px; }
</style>
</head>
<body>
<h1>営業部 11月の月次報告</h1>
<div class="sub">株式会社サンプル（架空のデータ）・作成 2026-11-30</div>
<div class="tabs"><button data-tab="now" class="on">今月の売上</button><button data-tab="next">来月の目標</button></div>
<div class="panel" id="now">
  <p>11月の売上は 2,340 万円で、前年同月比 112% でした。</p>
  <p>${newCustomers}大口の更新が 3 件あり、解約は 1 件でした。</p>
  <table><tr><th>商品</th><th>売上</th></tr><tr><td>年間プラン</td><td>1,520 万円</td></tr><tr><td>月額プラン</td><td>820 万円</td></tr></table>
  <div id="chart"></div>
</div>
<div class="panel" id="next" style="display:none">
  <p>12月の目標は 2,600 万円です。</p>
  <p>年末のキャンペーンで新規 20 社を目指します。</p>
</div>
<script>
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b))
    document.getElementById('now').style.display = b.dataset.tab === 'now' ? '' : 'none'
    document.getElementById('next').style.display = b.dataset.tab === 'next' ? '' : 'none'
  }))
  const months = [['9月', 1980], ['10月', 2150], ['11月', 2340]]
  document.getElementById('chart').innerHTML = months.map(([m, v]) => '<div>' + m + ' ' + v.toLocaleString() + ' 万円<span class="bar" style="width:' + v / 10 + 'px"></span></div>').join('')
</script>
</body>
</html>
`

export const SAMPLE_HTML = page('新規のお客さまは 18 社で、')
export const SAMPLE_HTML_CHANGED = page('新しく契約したお客さまは 18 社（初回の契約日で数えています）で、')
