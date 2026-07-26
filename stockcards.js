/* ── 個股研究卡（finlab_port）共用渲染模組 ────────────────────
   一份實作、兩個宿主：
     ① index.html 的個股彈窗卡片堆（主要入口，app.js 呼叫）
     ② stock.html 獨立頁（深連結／分享／並排比較）
   之後若要做右抽屜掃檔模式，第三個宿主也直接接這裡，不必再寫一遍。

   資料源：data/stock/{ticker}.json.gz、_shared.json.gz
          （由 finlab_port/export_stock_page.py 產生）

   所有函式回傳 HTML 字串，宿主自行 innerHTML 注入。
   ------------------------------------------------------------------ */
'use strict';

window.StockCards = (function () {

  const DIMS = [
    { k: 'val', label: '估值' },
    { k: 'qual', label: '品質' },
    { k: 'grow', label: '成長' },
    { k: 'mom', label: '動能' },
    { k: 'chip', label: '籌碼' },
  ];
  const HORIZONS = ['20', '60', '120'];

  const cache = {};
  let sharedCache = null;

  // ── 取數 ────────────────────────────────────────────────
  async function fetchGz(path) {
    const res = await fetch(`${path}?t=${Date.now()}`);
    if (!res.ok) throw new Error(`fetch ${path} 失敗 (${res.status})`);
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('瀏覽器不支援 DecompressionStream');
    }
    const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }

  async function load(ticker) {
    if (cache[ticker]) return cache[ticker];
    const d = await fetchGz(`data/stock/${ticker}.json.gz`);
    cache[ticker] = d;
    return d;
  }

  async function loadShared() {
    if (sharedCache) return sharedCache;
    try { sharedCache = await fetchGz('data/stock/_shared.json.gz'); }
    catch (e) { sharedCache = null; }
    return sharedCache;
  }

  // ── 格式化 ──────────────────────────────────────────────
  const isNum = v => typeof v === 'number' && isFinite(v);
  const pct = (v, d = 1) => isNum(v) ? `${(v * 100).toFixed(d)}%` : '—';
  const num = (v, d = 2) => isNum(v) ? v.toFixed(d) : '—';
  const int = v => isNum(v) ? Math.round(v).toLocaleString('en-US') : '—';
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  /** 分數色階：高=紅（強）低=綠（弱），對齊台股紅漲綠跌直覺 */
  function scoreColor(v) {
    if (!isNum(v)) return 'var(--text-mut)';
    if (v >= 80) return 'var(--up)';
    if (v >= 60) return 'var(--warn)';
    if (v >= 40) return 'var(--text-dim)';
    return 'var(--down)';
  }
  const retCls = v => !isNum(v) ? '' : (v > 0 ? 'sc-up' : (v < 0 ? 'sc-down' : ''));

  // ── ① 五維評分 ──────────────────────────────────────────
  function scoresSummary(d) {
    const s = (d && d.scores) || {};
    return DIMS.filter(x => x.k !== 'val')
      .map(x => `${x.label}${isNum(s[x.k]) ? Math.round(s[x.k]) : '—'}`).join(' ');
  }

  function radarSvg(s) {
    const n = DIMS.length, cx = 96, cy = 96, R = 66;
    const pt = (i, r) => {
      const a = -Math.PI / 2 + i * 2 * Math.PI / n;
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    };
    let g = '';
    for (const f of [0.25, 0.5, 0.75, 1]) {
      g += `<polygon points="${DIMS.map((_, i) => pt(i, R * f).join(',')).join(' ')}"
             fill="none" stroke="${f === 1 ? 'var(--border-hi)' : 'var(--border)'}" stroke-width="1"/>`;
    }
    DIMS.forEach((d, i) => {
      const [x, y] = pt(i, R);
      g += `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="var(--border)"/>`;
      const [lx, ly] = pt(i, R + 14);
      g += `<text x="${lx}" y="${ly}" fill="var(--text-dim)" font-size="10"
             text-anchor="middle" dominant-baseline="middle">${d.label}</text>`;
    });
    const poly = DIMS.map((d, i) => pt(i, R * (isNum(s[d.k]) ? s[d.k] : 0) / 100).join(',')).join(' ');
    g += `<polygon points="${poly}" fill="var(--accent-bg)" stroke="var(--accent)" stroke-width="2"/>`;
    DIMS.forEach((d, i) => {
      if (!isNum(s[d.k])) return;
      const [x, y] = pt(i, R * s[d.k] / 100);
      g += `<circle cx="${x}" cy="${y}" r="2.5" fill="var(--accent)"/>`;
    });
    return `<svg class="sc-radar" viewBox="0 0 192 192" aria-label="五維雷達圖">${g}</svg>`;
  }

  function scoresHtml(d) {
    const s = (d && d.scores) || {};
    if (!Object.keys(s).length) return '<div class="sc-none">無評分資料</div>';
    const bars = DIMS.map(x => {
      const v = s[x.k];
      const isVal = x.k === 'val';
      return `<div class="sc-dim${isVal ? ' sc-dim-off' : ''}">
        <span class="sc-dim-l">${x.label}</span>
        <span class="sc-dim-bar"><i style="width:${isNum(v) ? v : 0}%;background:${scoreColor(v)}"></i></span>
        <span class="sc-dim-v" style="color:${scoreColor(v)}">${isNum(v) ? Math.round(v) : '—'}</span>
      </div>`;
    }).join('');
    return `<div class="sc-scores">
      <div class="sc-dims">${bars}
        <div class="sc-total">總分 <b style="color:${scoreColor(s.total)}">${isNum(s.total) ? Math.round(s.total) : '—'}</b>
          <span class="sc-mut">＝品質·成長·動能·籌碼平均，<b>不含估值</b></span></div>
      </div>
      ${radarSvg(s)}
    </div>
    <div class="sc-mut sc-foot">分數＝當日全市場橫斷面百分位（85 分＝贏過 85% 的股票）；
      品質已做同業校正。財報基準 ${esc(s.asof || '—')}。
      估值另計不進總分——便宜/貴是獨立問題，不是好壞的加項。</div>`;
  }

  // ── ② 訊號實證 ──────────────────────────────────────────
  function signalsSummary(d) {
    const sigs = (d && d.signals) || [];
    if (!sigs.length) return '今日無訊號';
    const best = sigs.map(s => {
      const e = s.evidence_market && s.evidence_market['60'];
      return e ? e.alpha_xs_median : null;
    }).filter(isNum);
    const b = best.length ? Math.max(...best) : null;
    return `${sigs.length} 個成立` + (isNum(b) ? `　60日超額最高 ${pct(b)}` : '');
  }

  function signalsHtml(d) {
    const sigs = (d && d.signals) || [];
    if (!sigs.length) return '<div class="sc-none">今日無訊號成立</div>';
    const blocks = sigs.map(sig => {
      const ev = sig.evidence_market || {};
      const anyH = HORIZONS.find(h => ev[h]);
      if (!anyH) {
        return `<div class="sc-sig"><div class="sc-sig-h">
          <b>${esc(sig.label)}</b>${isNum(sig.streak_days) ? `<span class="sc-mut">　已連續 ${sig.streak_days} 日</span>` : ''}
          ${isNum(sig.value) ? `<span class="sc-sig-v">現值 ${num(sig.value)}</span>` : ''}
        </div><div class="sc-none">樣本不足，無實證統計</div></div>`;
      }
      const cells = HORIZONS.map(h => {
        const e = ev[h] || {};
        return `<td class="${retCls(e.alpha_xs_median)}">${pct(e.alpha_xs_median)}
          <small>${pct(e.alpha_xs_win, 0)}</small></td>`;
      }).join('');
      return `<div class="sc-sig">
        <div class="sc-sig-h">
          <b>${esc(sig.label)}</b>${isNum(sig.streak_days) ? `<span class="sc-mut">　已連續 ${sig.streak_days} 日</span>` : ''}
          ${isNum(sig.value) ? `<span class="sc-sig-v">現值 ${num(sig.value)}</span>` : ''}
        </div>
        <table class="sc-ev"><thead><tr>
          <th>全市場 n=${int(ev[anyH].n)}</th>${HORIZONS.map(h => `<th>${h}日</th>`).join('')}
        </tr></thead><tbody><tr><td class="sc-ev-l">超額<small>勝率</small></td>${cells}</tr></tbody></table>
      </div>`;
    }).join('');
    return blocks + `<div class="sc-mut sc-foot">超額＝對「當日全市場個股報酬中位數」的差（不是對加權指數——
      指數被權值股拉動，中位數個股本來就跑輸它）。只顯示全市場統計，個股自身樣本太小易誤導。</div>`;
  }

  // ── ③ 估值定位 ──────────────────────────────────────────
  function valuationSummary(d) {
    const v = (d && d.valuation) || {};
    if (!isNum(v.pe) && !isNum(v.pb)) return '無估值資料';
    return `PE ${num(v.pe, 1)}${isNum(v.pe_pct_self) ? `（分位${Math.round(v.pe_pct_self)}%）` : ''}` +
      `　PB ${num(v.pb, 2)}`;
  }

  function kvItem(label, value, p) {
    return `<div class="sc-kv-i">
      <div class="sc-kv-l">${label}</div>
      <div class="sc-kv-v">${value}</div>
      ${isNum(p) ? `<div class="sc-pctbar"><i style="left:${Math.min(99, Math.max(0, p))}%"></i></div>
        <div class="sc-kv-l">分位 ${Math.round(p)}%</div>` : ''}
    </div>`;
  }

  function valuationHtml(d) {
    const v = (d && d.valuation) || {};
    if (!Object.keys(v).length) return '<div class="sc-none">無估值資料</div>';
    const neg = isNum(v.eps_ttm) && v.eps_ttm <= 0;
    return `<div class="sc-kv">
      ${kvItem('本益比 PE', num(v.pe, 1), v.pe_pct_self)}
      ${kvItem('股價淨值比 PB', num(v.pb, 2), v.pb_pct_self)}
      ${kvItem('每股盈餘 EPS(TTM)', num(v.eps_ttm, 2))}
      ${kvItem('每股淨值 BPS', num(v.bps, 2))}
    </div>
    <div class="sc-mut sc-foot">分位＝個股自身近 5 年分布位置（越低越便宜）；
      橫斷面分位 PE ${isNum(v.pe_pct_mkt) ? Math.round(v.pe_pct_mkt) + '%' : '—'}、
      PB ${isNum(v.pb_pct_mkt) ? Math.round(v.pb_pct_mkt) + '%' : '—'}。
      ${neg ? '<br>⚠️ EPS(TTM) 非正值，PE 不具意義故留空。' : ''}</div>
    <div class="sc-warn">⚠️ PE/PB 以還原價計算。還原基準是資料匯出當日，故「當前」值準確，
      但歷史價被往下還原使歷史 PE 偏低，「自身歷史分位」因此系統性偏高（看起來比實際更貴）。
      橫斷面分位不受影響。</div>`;
  }

  // ── ④ 法人買賣超數字（併進彈窗既有的💰籌碼卡）───────────
  const CHIP_WHO = [['foreign', '外資'], ['trust', '投信'], ['dealer', '自營'], ['inst', '三大法人']];

  function chipNumsHtml(d) {
    const c = (d && d.chip) || {};
    if (!Object.keys(c).length) return '';
    const cells = CHIP_WHO.map(([k, label]) => {
      const s5 = c[`${k}_sum5`], s20 = c[`${k}_sum20`], st = c[`${k}_streak`];
      const streak = isNum(st) && st !== 0
        ? `　連${st > 0 ? '買' : '賣'}${Math.abs(st)}日` : '';
      return `<span class="sc-chipn">${label}
        <b class="${retCls(s5)}">${int(s5)}</b>
        <span class="sc-mut">20日 ${int(s20)}${streak}</span></span>`;
    }).join('');
    return `<div class="sc-chipnums"><div class="sc-mut">法人淨買超（張）　近5日 / 近20日</div>
      <div class="sc-chipn-row">${cells}</div></div>`;
  }

  // ── ⑤ 估值×動能矩陣 ─────────────────────────────────────
  function matrixHtml(d, shared) {
    const rows = (shared && shared.val_mom_matrix) || [];
    if (!rows.length) return '<div class="sc-none">尚未產生矩陣（請跑 valuation.py）</div>';
    const H = rows[0].horizon;
    const cell = new Map(rows.filter(r => r.horizon === H)
      .map(r => [`${r.val_bucket}-${r.mom_bucket}`, r]));
    const s = (d && d.scores) || {};
    const bucket = v => isNum(v) ? Math.min(5, Math.floor(v / 20) + 1) : null;
    const myV = bucket(s.val), myM = bucket(s.mom);

    let body = '';
    for (let v = 5; v >= 1; v--) {
      let tds = '';
      for (let m = 1; m <= 5; m++) {
        const r = cell.get(`${v}-${m}`);
        const a = r ? r.alpha_xs_median : null;
        const me = (v === myV && m === myM) ? ' sc-mx-me' : '';
        tds += `<td class="${retCls(a)}${me}"${me ? ' title="本檔目前位置"' : ''}>${pct(a)}
          ${r ? `<small>n=${int(r.n)}</small>` : ''}</td>`;
      }
      const lbl = v === 5 ? '最便宜5' : (v === 1 ? '最貴1' : String(v));
      body += `<tr><th>${lbl}</th>${tds}</tr>`;
    }
    const head = [1, 2, 3, 4, 5].map(m =>
      `<th>${m === 1 ? '最弱1' : (m === 5 ? '最強5' : m)}</th>`).join('');
    return `<div class="sc-mx-wrap"><table class="sc-mx">
      <thead><tr><th>估值＼動能</th>${head}</tr></thead><tbody>${body}</tbody></table></div>
      <div class="sc-mut sc-foot">${H} 日後對全市場個股中位數的超額報酬中位數；青框＝本檔目前位置。
      樣本 ${esc(rows[0].sample_start)} ~ ${esc(rows[0].sample_end)}。
      兩個方向都單調：越便宜越好、動能越強越好，但最貴那排不管動能多強都是負的。</div>`;
  }

  // ── ⑥ 公司基本資料 ──────────────────────────────────────
  const PROFILE_FIELDS = [
    ['name_full', '公司全稱'], ['industry_tej', 'TEJ 產業'], ['sub_industry_tej', 'TEJ 子產業'],
    ['industry_tse', 'TSE 產業'], ['market', '市場別'], ['listing_type', '上市別'],
    ['founded_date', '設立日期'], ['ipo_date', '首次掛牌'], ['chairman', '董事長'],
    ['ceo', '總經理'], ['spokesman', '發言人'], ['employees', '員工人數'],
    ['paid_in_capital', '實收資本額'], ['website', '網址'],
  ];

  function profileSummary(d) {
    const p = (d && d.profile) || {};
    const bits = [];
    if (p.sub_industry_tej || p.industry_tej) bits.push(esc(p.sub_industry_tej || p.industry_tej));
    if (p.ipo_date) bits.push(`${esc(p.ipo_date)} 掛牌`);
    return bits.join('　·　') || '—';
  }

  function profileHtml(d) {
    const p = (d && d.profile) || {};
    const rows = PROFILE_FIELDS.map(([k, label]) => {
      let v = p[k];
      if (v == null || v === '') return '';
      if (k === 'paid_in_capital' && isNum(v)) v = `${(v / 1e8).toFixed(2)} 億`;
      if (k === 'employees' && isNum(v)) v = `${int(v)} 人`;
      const val = (k === 'website')
        ? `<a href="${/^https?:/.test(String(v)) ? esc(v) : 'https://' + esc(v)}"
             target="_blank" rel="noopener noreferrer">${esc(v)}</a>`
        : esc(v);
      return `<div class="sc-pf-r"><span class="sc-mut">${label}</span><span>${val}</span></div>`;
    }).join('');
    if (!rows) return '<div class="sc-none">無基本資料</div>';
    const del = p.is_delisted
      ? `<div class="sc-warn">⚠️ 本檔已於 ${esc(p.delist_date || '—')} 下市</div>` : '';
    return `<div class="sc-profile">${rows}</div>${del}`;
  }

  // ── 卡片定義（宿主照這張表產生卡）─────────────────────
  //  open: 預設是否展開。研究卡一律預設收合——每天開幾十次的是決策卡，
  //        研究卡收合時只佔一行標題，但標題已帶重點數字，滑過去就掃得到。
  const CARDS = [
    { id: 'scores',    icon: '🎯', title: '五維評分',      open: false, sum: scoresSummary,    body: (d) => scoresHtml(d) },
    { id: 'signals',   icon: '📊', title: '訊號實證',      open: false, sum: signalsSummary,   body: (d) => signalsHtml(d) },
    { id: 'valuation', icon: '💵', title: '估值定位',      open: false, sum: valuationSummary, body: (d) => valuationHtml(d) },
    { id: 'matrix',    icon: '🔲', title: '估值×動能矩陣', open: false, sum: () => '5×5 前瞻報酬', body: (d, sh) => matrixHtml(d, sh) },
    { id: 'profile',   icon: '🏢', title: '基本資料',      open: false, sum: profileSummary,   body: (d) => profileHtml(d) },
  ];

  return {
    load, loadShared, CARDS,
    scoresHtml, signalsHtml, valuationHtml, matrixHtml, profileHtml, chipNumsHtml,
    scoresSummary, signalsSummary, valuationSummary, profileSummary,
    esc, isNum, pct, num, int, scoreColor,
  };
})();
