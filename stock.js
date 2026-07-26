/* ── 贏窟 個股詳情頁（獨立頁宿主）─────────────────────────
   卡片內容一律由 stockcards.js 提供——跟 index.html 彈窗卡片堆是同一份實作，
   改一邊兩邊都會動，不會出現「彈窗改了頁面沒改」的漂移。

   這一頁的定位是 **深連結 / 分享 / 兩檔並排比較**；日常操作主入口是彈窗。
   ------------------------------------------------------------------ */
'use strict';

let idx = null;

const SC = () => window.StockCards;

// 跟主看板同步皮膚（memory: v2 已預設開啟，🧪 鈕可切回舊版）
if (localStorage.getItem('ui_v2') !== '0') document.body.classList.add('ui-v2');

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const isNum = v => typeof v === 'number' && isFinite(v);
const pct = (v, d = 1) => isNum(v) ? `${(v * 100).toFixed(d)}%` : '—';

/** 獨立頁的卡：預設全部展開（來這頁就是要細看，不需要再點開） */
function cardHtml(icon, title, bodyHtml, sum) {
  return `<details class="card sv-card" data-card="${SC().esc(title)}" open>
    <summary class="sv-card-h"><span class="sv-ic">${icon}</span>
      <span class="sv-t">${SC().esc(title)}</span>
      <span class="sv-card-sum">${sum || ''}</span></summary>
    <div class="sv-c">${bodyHtml}</div></details>`;
}

function render(d, shared) {
  const root = document.getElementById('sp-root');
  const price = d.price || [];
  const last = price[price.length - 1];
  const prev = price[price.length - 2];
  const chg = last && prev ? last.c / prev.c - 1 : null;
  const chgCls = isNum(chg) ? (chg > 0 ? 'sc-up' : (chg < 0 ? 'sc-down' : '')) : '';
  const ind = (d.profile && (d.profile.sub_industry_tej || d.profile.industry_tej)) || '—';
  const E = SC().esc;

  root.innerHTML = `
    <section class="sp-head">
      <div class="sp-head-main">
        <h1 class="sp-name">${E(d.name || d.ticker)}
          <span class="sp-ticker">${E(d.ticker)}</span></h1>
        <div class="sp-sub">${E(ind)}<span class="sp-dot">·</span>資料日 <b>${E(d.trade_date)}</b></div>
        <div class="sp-verdict">${E(d.verdict || '')}</div>
      </div>
      <div class="sp-head-price">
        <div class="sp-close">${last ? last.c.toFixed(2) : '—'}</div>
        <div class="sp-chg ${chgCls}">${isNum(chg) ? (chg > 0 ? '+' : '') + pct(chg, 2) : ''}</div>
      </div>
    </section>
    ${SC().CARDS.map(c =>
      cardHtml(c.icon, c.title, c.body(d, shared), c.sum(d, shared))).join('')}
    ${cardHtml('🏦', '籌碼流向', SC().chipNumsHtml(d) || '<div class="sc-none">無籌碼資料</div>', '')}
    <p class="sp-caveat">${E((shared && shared.caveat) || '')}</p>
    <p class="sp-back"><a href="index.html">← 回主看板</a>
      <span class="sc-mut">日常操作建議走主看板點代號開彈窗，這頁供深連結／分享／並排比較</span></p>
  `;
  document.title = `${d.name || ''} ${d.ticker} · 贏窟個股`;
}

async function show(ticker) {
  const root = document.getElementById('sp-root');
  root.innerHTML = '<div class="sp-status">載入中…</div>';
  try {
    const [d, shared] = await Promise.all([SC().load(ticker), SC().loadShared()]);
    render(d, shared);
    history.replaceState(null, '', `?t=${ticker}`);
  } catch (err) {
    root.innerHTML = `<div class="sp-status">載入 ${ticker} 失敗：${err.message}</div>`;
  }
}

function initSearch() {
  const box = document.getElementById('sp-search');
  const sug = document.getElementById('sp-suggest');
  const close = () => { sug.hidden = true; sug.textContent = ''; };

  box.addEventListener('input', () => {
    const q = box.value.trim().toLowerCase();
    if (!q || !idx) return close();
    const hits = idx.rows.filter(r =>
      r.ticker.includes(q) || (r.name || '').toLowerCase().includes(q)).slice(0, 20);
    sug.textContent = '';
    if (!hits.length) return close();
    for (const r of hits) {
      const b = el('button');
      b.append(el('span', 'sp-sg-t', r.ticker));
      b.append(document.createTextNode(r.name || ''));
      b.addEventListener('click', () => { close(); box.value = ''; show(r.ticker); });
      sug.append(b);
    }
    sug.hidden = false;
  });
  box.addEventListener('keydown', e => {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter') { const f = sug.querySelector('button'); if (f) f.click(); }
  });
  document.addEventListener('click', e => {
    if (!sug.contains(e.target) && e.target !== box) close();
  });
}

/** j/k 在索引裡上下切檔，沿用主看板的快速鍵慣例 */
function initKeys() {
  document.addEventListener('keydown', e => {
    if (!idx || e.ctrlKey || e.altKey || e.metaKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
    if (e.key !== 'j' && e.key !== 'k') return;
    const cur = new URLSearchParams(location.search).get('t');
    const i = idx.rows.findIndex(r => r.ticker === cur);
    if (i < 0) return;
    const n = e.key === 'j' ? i + 1 : i - 1;
    if (n >= 0 && n < idx.rows.length) { e.preventDefault(); show(idx.rows[n].ticker); }
  });
}

(async function main() {
  initSearch();
  initKeys();
  try {
    // _index.json.gz 跟個股檔同目錄，load() 的路徑規則直接適用
    idx = await SC().load('_index');
    document.getElementById('sp-meta').textContent =
      `${idx.count} 檔 · 資料日 ${idx.trade_date} · 產出 ${idx.generated_at}　(j/k 切換)`;
  } catch (err) {
    document.getElementById('sp-root').innerHTML =
      `<div class="sp-status">無法載入個股索引：${err.message}<br>
       <span class="muted">請先執行 finlab_port/export_stock_page.py</span></div>`;
    return;
  }
  const want = new URLSearchParams(location.search).get('t');
  show(want && idx.rows.some(r => r.ticker === want) ? want : idx.rows[0].ticker);
})();
