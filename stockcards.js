/* ── 個股頁：FinLab 版型（深色版）────────────────────────────
   照 https://finlab.finance/stocks/3231 的呈現形式重排，內容維持贏窟自有。

   移植的七個模式：
     ① 問句式區塊大標（「XX 可以買嗎？」而不是「五維評分」）
     ② 重點結論條列 —— 判定詞 + 白話解釋 + 具體數字，把分數翻成人話
     ③ 雷達圖分數做成膠囊掛在頂點外圍
     ④ 維度分頁（重點結論 / 估值 / 品質 / 成長 / 動能 / 籌碼）
     ⑤ 訊號卡：白話定義 + 歷史事件數 + 三天期 KPI 雙進度條 + 勝率表
     ⑥ 方向分 + 漸層量表
     ⑦ 大留白、大字級
   **唯一不抄的是淺色主題**——贏窟全站深色終端風，個股頁單獨變白底會跟系統割裂。

   一份實作、兩個宿主：index.html 的個股彈窗、stock.html 獨立頁。
   資料源 data/stock/{ticker}.json.gz + _shared.json.gz（finlab_port 產出）。
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
    cache[ticker] = await fetchGz(`data/stock/${ticker}.json.gz`);
    return cache[ticker];
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
  const p0 = v => isNum(v) ? `${v.toFixed(0)}%` : '—';
  const num = (v, d = 2) => isNum(v) ? v.toFixed(d) : '—';
  const int = v => isNum(v) ? Math.round(v).toLocaleString('en-US') : '—';
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  function scoreColor(v) {
    if (!isNum(v)) return 'var(--text-mut)';
    if (v >= 80) return 'var(--up)';
    if (v >= 60) return 'var(--warn)';
    if (v >= 40) return 'var(--text-dim)';
    return 'var(--down)';
  }
  const retCls = v => !isNum(v) ? '' : (v > 0 ? 'fl-up' : (v < 0 ? 'fl-down' : ''));

  // ═══ ② 重點結論生成器 ═════════════════════════════════
  //
  //  每條 = 判定詞（粗體）+ 白話解釋 + 可驗證的數字。
  //  分數只說「贏過幾 % 的股票」，這裡補上「實際是多少」。
  //  tone: good / bad / warn / flat → 決定左側圓點顏色。
  //
  function band(p, good, mid, weak) {
    if (!isNum(p)) return null;
    if (p >= 70) return good;
    if (p >= 40) return mid;
    return weak;
  }

  /** 百分位顯示上限 99：分數是百分位，寫「勝過全市場 100% 的個股」語意上不成立 */
  const pctCap = v => isNum(v) ? Math.min(99, Math.round(v)) : null;

  function buildInsights(d) {
    const s = d.scores || {}, f = d.fundamentals || {}, v = d.valuation || {};
    const c = d.chip || {};
    const out = [];

    // 獲利能力（品質）
    if (isNum(f['ROE']) || isNum(f['營業淨利率_pct'])) {
      const p = f['營業淨利率_pct'];
      const t = band(p, ['good', '獲利能力強'], ['flat', '獲利能力中等'], ['bad', '獲利能力偏弱'])
        || ['flat', '獲利能力'];
      const bits = [];
      if (isNum(p)) bits.push(`營業利益率勝過全市場約 ${pctCap(p)}% 的個股`);
      if (isNum(f['ROE'])) bits.push(`最新一季 ROE 約 ${num(f['ROE'], 1)}%`);
      if (isNum(f['毛利率'])) bits.push(`毛利率 ${num(f['毛利率'], 1)}%`);
      out.push({ dim: 'qual', tone: t[0], title: t[1], text: bits.join('。') + '。' });
    }

    // 財務結構（品質）
    if (isNum(f['負債比率'])) {
      const p = f['負債比率_pct'];
      const t = band(p, ['good', '財務結構穩健'], ['flat', '財務結構中性'], ['bad', '負債偏高'])
        || ['flat', '財務結構'];
      out.push({
        dim: 'qual', tone: t[0], title: t[1],
        text: `負債比率 ${num(f['負債比率'], 1)}%` +
          (isNum(p) ? `，在全市場屬第 ${p.toFixed(0)} 百分位（越高越穩健）` : '') + '。',
      });
    }

    // 估值
    if (isNum(v.pe) || isNum(s.val)) {
      const t = band(s.val, ['good', '估值偏低'], ['flat', '估值中性'], ['bad', '估值偏高'])
        || ['flat', '估值'];
      const bits = [];
      if (isNum(v.pe)) bits.push(`本益比 ${num(v.pe, 1)}`);
      if (isNum(v.pe_pct_mkt)) bits.push(`居全市場第 ${v.pe_pct_mkt.toFixed(0)} 百分位`);
      if (isNum(v.pe_pct_self)) bits.push(`以自身近 5 年歷史看，目前約在第 ${v.pe_pct_self.toFixed(0)} 百分位`);
      out.push({ dim: 'val', tone: t[0], title: t[1], text: bits.join('，') + '。' });
    }

    // 成長
    if (isNum(f['月營收YoY']) || isNum(f['營收成長率'])) {
      const y = f['月營收YoY'];
      const t = isNum(y)
        ? (y >= 50 ? ['good', '營收高成長'] : y >= 20 ? ['good', '營收成長'] :
          y >= 0 ? ['flat', '營收持平'] : ['bad', '營收衰退'])
        : ['flat', '成長'];
      const bits = [];
      if (isNum(y)) bits.push(`最新月營收年增約 ${num(y, 1)}%`);
      if (isNum(f['稅後淨利成長率'])) bits.push(`稅後淨利年增 ${num(f['稅後淨利成長率'], 1)}%`);
      out.push({ dim: 'grow', tone: t[0], title: t[1], text: bits.join('，') + '。' });
    }

    // 動能
    if (isNum(s.mom)) {
      const t = band(s.mom, ['good', '價格動能強'], ['flat', '動能中性'], ['bad', '動能偏弱']);
      out.push({
        dim: 'mom', tone: t[0], title: t[1],
        text: `綜合 20／60／120 日報酬與 52 週區間位置，強過全市場約 ${pctCap(s.mom)}% 的個股。`,
      });
    }

    // 籌碼
    if (isNum(s.chip)) {
      const t = band(s.chip, ['good', '籌碼偏多'], ['flat', '籌碼中性'], ['bad', '籌碼偏空']);
      const bits = [`法人買盤強度勝過全市場約 ${pctCap(s.chip)}% 的個股`];
      const fs = c.foreign_streak;
      if (isNum(fs) && fs !== 0) {
        bits.push(`外資連${fs > 0 ? '買' : '賣'} ${Math.abs(fs)} 日`);
      }
      if (isNum(c.inst_sum5)) bits.push(`三大法人近 5 日淨${c.inst_sum5 >= 0 ? '買' : '賣'}超 ${int(Math.abs(c.inst_sum5))} 張`);
      out.push({ dim: 'chip', tone: t[0], title: t[1], text: bits.join('，') + '。' });
    }

    return out;
  }

  function insightsHtml(list) {
    if (!list.length) return '<div class="fl-none">資料不足，無法產生結論</div>';
    return `<ul class="fl-insights">${list.map(i =>
      `<li class="fl-in fl-in-${i.tone}"><b>${esc(i.title)}</b>${esc(i.text)}</li>`
    ).join('')}</ul>`;
  }

  // ═══ ③ 膠囊雷達圖 ═════════════════════════════════════
  function radarHtml(s) {
    const n = DIMS.length, R = 40;   // R 用 % 座標，膠囊靠 left/top 百分比定位
    const pt = (i, r) => {
      const a = -Math.PI / 2 + i * 2 * Math.PI / n;
      return [50 + r * Math.cos(a), 50 + r * Math.sin(a)];
    };
    const poly = (r) => DIMS.map((_, i) => pt(i, r).join(',')).join(' ');
    let grid = '';
    for (const fr of [0.25, 0.5, 0.75, 1]) {
      grid += `<polygon points="${poly(R * fr)}" fill="none"
        stroke="${fr === 1 ? 'var(--border-hi)' : 'var(--border)'}" stroke-width="0.4"/>`;
    }
    DIMS.forEach((_, i) => {
      const [x, y] = pt(i, R);
      grid += `<line x1="50" y1="50" x2="${x}" y2="${y}" stroke="var(--border)" stroke-width="0.4"/>`;
    });
    const val = DIMS.map((d, i) => pt(i, R * (isNum(s[d.k]) ? s[d.k] : 0) / 100).join(',')).join(' ');
    const dots = DIMS.map((d, i) => {
      if (!isNum(s[d.k])) return '';
      const [x, y] = pt(i, R * s[d.k] / 100);
      return `<circle cx="${x}" cy="${y}" r="1.4" fill="var(--accent)"/>`;
    }).join('');

    const pills = DIMS.map((d, i) => {
      const [x, y] = pt(i, R + 15);
      const v = s[d.k];
      return `<span class="fl-pill" style="left:${x}%;top:${y}%;border-color:${scoreColor(v)}">
        ${d.label} <b style="color:${scoreColor(v)}">${isNum(v) ? Math.round(v) : '—'}</b></span>`;
    }).join('');

    return `<div class="fl-radar-wrap">
      <svg class="fl-radar" viewBox="0 0 100 100" aria-label="五維雷達圖">
        ${grid}
        <polygon points="${val}" fill="var(--accent-bg)" stroke="var(--accent)" stroke-width="1"/>
        ${dots}
      </svg>${pills}
    </div>`;
  }

  // ═══ 迷你走勢圖（hero 用）════════════════════════════
  //   ⚠️ 這裡刻意用「大 viewBox（像素座標）+ vector-effect:non-scaling-stroke」，
  //   不要退回小 viewBox(0 0 100 58) + preserveAspectRatio="none"：那樣 X/Y 縮放比
  //   差 4~5 倍（1560px 寬 ÷ 100 = 15.6× 對 190px 高 ÷ 58 = 3.3×），線寬會被非等比
  //   拉伸——陡的地方粗成 14px、平的地方細到 3px，整條線腫成「河流」。
  //   2026-07-30 定案為「乾淨折線」：不做漸層面積填色。主表 sparkSvg() 那條 10 日迷你圖
  //   有填色是因為圖上只有一條線；這張有 MA20/MA60 穿過，填色會讓均線變濁、看不出交叉，
  //   而均線交叉正是這張圖最該看清楚的東西。要試填色版把 AREA_FILL 改成 true 即可。
  //   2026-07-30 改成 FinLab 式歷史折線圖：期間鈕 + 價格軸/格線 + 日期軸 + hover 十字線與 tooltip。
  //   期間上限是 1Y —— payload 只帶 PRICE_BARS=250 根（見 finlab_port/export_stock_page.py）。
  //   要 3Y/5Y/ALL 必須調大 PRICE_BARS 重跑，且 web/data/stock 會從 30MB 等比長大（每日推 git）。
  const RANGES = [['1M', 21], ['3M', 63], ['6M', 126], ['1Y', 250]];
  const DEF_RANGE = '6M';
  const _flCharts = {};          // uid -> 完整 bars（期間切換不必重抓資料）
  let _flChartUid = 0;

  // 座標系（像素單位，等比縮放）：右側留價格標籤、下方留量能與日期
  const CH = { W: 1200, PL: 6, PR: 54, PT: 8, H: 150, GAP: 8, VH: 30, XH: 18 };

  // ── 通用 hover 引擎：走勢圖與集保/分點多線圖共用 ───────────────
  //   圖表把「每點的 x 像素位置 + 每條線的真實值與 y」註冊進來，DOM 只留一個 id，
  //   避免把上千個數字塞進 data- 屬性。舊資料在超出保留張數後自動丟棄。
  const _flHov = {};
  let _flHovUid = 0;
  function hovRegister(spec) {
    const id = ++_flHovUid;
    _flHov[id] = spec;
    Object.keys(_flHov).forEach(k => { if (id - k > 24) delete _flHov[k]; });
    return id;
  }

  /** 價格刻度：在 1/2/2.5/5×10^n 這些「好看的」間距裡，挑條數最接近 want 的一組。
      （不能只取「第一個 ≥ span/want 的間距」——會overshoot，出現只剩 2 條格線的圖） */
  function priceTicks(lo, hi, want) {
    const span = (hi - lo) || 1;
    const base = Math.pow(10, Math.floor(Math.log10(span / want)));
    let best = null;
    for (const m of [1, 2, 2.5, 5, 10, 20]) {
      const st = m * base;
      const first = Math.ceil(lo / st) * st;
      const cnt = Math.floor((hi - first) / st) + 1;
      if (cnt < 2) continue;
      const ts = Array.from({ length: cnt }, (_, i) => first + i * st);
      const score = Math.abs(cnt - want) + (cnt < 3 ? 6 : 0) + (cnt > 7 ? 6 : 0);
      if (!best || score < best.score) best = { score, ts, st };
    }
    return best ? best : { ts: [], st: span };
  }

  function maSeries(arr, n) {
    return arr.map((_, i) => i < n - 1 ? null
      : arr.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n);
  }

  /** 畫出某個期間的 svg + 圖例（期間鈕切換時只換這段） */
  function chartBody(all, rangeKey) {
    const nBars = (RANGES.find(r => r[0] === rangeKey) || RANGES[2])[1];
    // MA 需要前置資料才不會左端斷頭：多取 60 根算完再切掉
    const start = Math.max(0, all.length - nBars);
    const warm = Math.max(0, start - 60);
    const ext = all.slice(warm);
    const extC = ext.map(b => b.c);
    const ma20e = maSeries(extC, 20), ma60e = maSeries(extC, 60);
    const off = start - warm;
    const bars = ext.slice(off);
    const cs = bars.map(b => b.c);
    const ma20 = ma20e.slice(off), ma60 = ma60e.slice(off);
    const n = bars.length;
    if (n < 2) return '';

    // Y 範圍：收盤與可見 MA 的極值，上下各留 6% 呼吸空間
    const all4 = cs.concat(ma20.filter(v => v != null), ma60.filter(v => v != null));
    let lo = Math.min(...all4), hi = Math.max(...all4);
    const pad = (hi - lo || hi || 1) * 0.06;
    lo -= pad; hi += pad;
    const span = (hi - lo) || 1;

    const { W, PL, PR, PT, H, GAP, VH, XH } = CH;
    const pw = W - PL - PR;
    const x = i => PL + (n === 1 ? pw / 2 : (i / (n - 1)) * pw);
    const y = c => PT + (1 - (c - lo) / span) * H;
    const pt = (arr) => arr.map((c, i) => c == null ? null
      : `${x(i).toFixed(1)},${y(c).toFixed(1)}`).filter(Boolean).join(' ');

    // 價格格線（右側標籤）
    const { ts: ticks, st: step } = priceTicks(lo, hi, 5);
    const dp = step < 1 ? 2 : (step < 10 ? 1 : 0);
    const grid = ticks.map(v => {
      const yy = y(v).toFixed(1);
      return `<line class="flc-grid" x1="${PL}" y1="${yy}" x2="${PL + pw}" y2="${yy}"/>`
        + `<text class="flc-ax" x="${PL + pw + 6}" y="${yy}" dominant-baseline="middle">${num(v, dp)}</text>`;
    }).join('');

    // 日期軸：約 6 個等距標籤，跨年就顯示年份
    const spanDays = n;
    const nLab = Math.min(6, n);
    const yTop = PT + H + GAP + VH;
    const xLabs = Array.from({ length: nLab }, (_, k) => {
      const i = Math.round(k * (n - 1) / (nLab - 1));
      const [Y, M, D] = String(bars[i].d).split('-');
      const txt = spanDays > 200 ? `${Y.slice(2)}/${M}` : `${M}/${D}`;
      const anchor = k === 0 ? 'start' : (k === nLab - 1 ? 'end' : 'middle');
      return `<text class="flc-ax" x="${x(i).toFixed(1)}" y="${yTop + XH - 5}" text-anchor="${anchor}">${txt}</text>`;
    }).join('');

    // 量柱（紅漲綠跌，跟著當日 K 的方向）
    const vmax = Math.max(...bars.map(b => b.v || 0)) || 1;
    const bw = Math.max(1.2, (pw / n) * 0.62);
    const vTop = PT + H + GAP;
    const volBars = bars.map((b, i) => {
      const bh = ((b.v || 0) / vmax) * VH;
      const rise = b.c >= (b.o != null ? b.o : b.c);
      return `<rect class="${rise ? 'v-up' : 'v-dn'}" x="${(x(i) - bw / 2).toFixed(1)}"`
        + ` y="${(vTop + VH - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}"/>`;
    }).join('');

    const up = cs[n - 1] >= cs[0];
    const raw = up ? '#ef5350' : '#26a69a';
    const chg = (cs[n - 1] / cs[0] - 1) * 100;
    const H_TOTAL = PT + H + GAP + VH + XH;

    // 註冊 hover 資料（通用引擎，見 hovRegister/bindChart）
    const hid = hovRegister({
      W, xs: bars.map((_, i) => x(i)), dates: bars.map(b => b.d),
      series: [
        { label: '收盤', color: raw, d: 2, vals: cs, ys: cs.map(y) },
        { label: 'MA20', color: '#f5b942', d: 2, vals: ma20, ys: ma20.map(v => v == null ? null : y(v)) },
        { label: 'MA60', color: '#8b7bd8', d: 2, vals: ma60, ys: ma60.map(v => v == null ? null : y(v)) },
      ],
      extra: [{ label: '量', unit: ' 張', d: 0, vals: bars.map(b => b.v || 0) }],
      pctOf: 0,   // 第 0 條額外顯示對前一日的漲跌%
    });

    return `<div class="flc-plot" data-hov="${hid}" data-w="${W}" data-xh="${XH}">
      <svg viewBox="0 0 ${W} ${H_TOTAL}" aria-label="近 ${rangeKey} 走勢">
        ${grid}
        <g class="flc-vol">${volBars}</g>
        ${xLabs}
        <polyline class="flc-ma60" points="${pt(ma60)}" fill="none"/>
        <polyline class="flc-ma20" points="${pt(ma20)}" fill="none"/>
        <polyline class="flc-px" points="${pt(cs)}" fill="none" stroke="${raw}"/>
      </svg>
      <div class="flc-cross" hidden></div>
      <div class="flc-tip" hidden></div>
    </div>
    <div class="fl-chart-lg">近 ${rangeKey}
      <span class="flc-k" style="color:${raw}">${chg >= 0 ? '+' : ''}${num(chg, 1)}%</span>
      　<span style="color:#f5b942">MA20</span>　<span style="color:#8b7bd8">MA60</span>
      　高 ${num(Math.max(...cs), 1)}／低 ${num(Math.min(...cs), 1)}</div>`;
  }

  function priceChartHtml(d) {
    const all = (d.price || []).filter(b => b && isNum(b.c));
    if (all.length < 20) return '';
    const uid = ++_flChartUid;
    _flCharts[uid] = all;
    // 避免長時間使用累積（彈窗每次開都重建一份），只留最近 12 張
    Object.keys(_flCharts).forEach(k => { if (uid - k > 12) delete _flCharts[k]; });

    const btns = RANGES.map(([k, nb]) => {
      const ok = all.length >= Math.min(nb, 21);
      return `<button type="button" class="flc-rb${k === DEF_RANGE ? ' on' : ''}"`
        + ` data-range="${k}"${ok ? '' : ' disabled'}>${k}</button>`;
    }).join('');

    return `<div class="fl-chart" data-uid="${uid}">
      <div class="flc-ranges">${btns}</div>
      <div class="flc-body">${chartBody(all, DEF_RANGE)}</div>
    </div>`;
  }

  // ═══ ⑤ 訊號卡 ═════════════════════════════════════════
  function signalCard(sig, meta, active) {
    const ev = sig.evidence_market || {};
    const anyH = HORIZONS.find(h => ev[h]);
    const m = meta[sig.id] || {};
    const head = `<div class="fl-sig-h">
      <span class="fl-sig-name">${esc(m.label || sig.label || sig.id)}</span>
      ${active
        ? `<span class="fl-sig-on">觸發中${isNum(sig.value) ? ` · 目前 ${num(sig.value)}` : ''}</span>`
        : '<span class="fl-sig-off">未成立</span>'}
    </div>`;
    const desc = m.desc ? `<p class="fl-sig-desc">${esc(m.desc)}</p>` : '';
    if (!anyH) return `<div class="fl-sig">${head}${desc}
      <div class="fl-none">樣本不足，無實證統計</div></div>`;

    const tags = `<div class="fl-sig-tags">
      <span class="fl-tag">歷史事件 ${int(ev[anyH].n)} 次</span>
      ${isNum(sig.streak_days) ? `<span class="fl-tag">已連續 ${sig.streak_days} 日</span>` : ''}
    </div>`;

    // 三天期 KPI：超額（本檔訊號 vs 全市場中位數）用雙進度條表達
    const maxAbs = Math.max(...HORIZONS.map(h =>
      ev[h] ? Math.abs(ev[h].alpha_xs_median || 0) : 0), 0.01);
    const kpis = HORIZONS.map(h => {
      const e = ev[h]; if (!e) return '';
      const a = e.alpha_xs_median, w = e.alpha_xs_win;
      const barA = Math.min(100, Math.abs(a || 0) / maxAbs * 100);
      return `<div class="fl-kpi">
        <div class="fl-kpi-h">${h} 日<b class="${retCls(a)}">${a > 0 ? '+' : ''}${pct(a, 2)}</b></div>
        <div class="fl-kpi-bar"><i class="${retCls(a)}" style="width:${barA}%"></i></div>
        <div class="fl-kpi-bar fl-kpi-bar2"><i style="width:${isNum(w) ? w * 100 : 0}%"></i></div>
        <div class="fl-kpi-f">勝率 ${p0(isNum(w) ? w * 100 : null)}</div>
      </div>`;
    }).join('');

    return `<div class="fl-sig${active ? ' fl-sig-active' : ''}">
      ${head}${desc}${tags}
      <div class="fl-kpis">${kpis}</div>
      <div class="fl-sig-note">上排＝對當日全市場個股報酬中位數的超額；下排＝贏過該中位數的比例</div>
    </div>`;
  }

  // ═══ 區塊 ═════════════════════════════════════════════
  function heroHtml(d) {
    const price = d.price || [];
    const last = price[price.length - 1], prev = price[price.length - 2];
    const chg = last && prev ? last.c / prev.c - 1 : null;
    const p = d.profile || {};
    const ind = p.sub_industry_tej || p.industry_tej || p.industry_tse || '';
    const chips = (d.signals || []).map(s =>
      `<span class="fl-chip-on">● ${esc(s.label)}</span>`).join('');
    return `<section class="fl-hero">
      <div class="fl-hero-l">
        <h1 class="fl-name">${esc(d.name || d.ticker)}</h1>
        <div class="fl-meta">
          <span class="fl-tag">${esc(d.ticker)}</span>
          ${ind ? `<span class="fl-tag">${esc(ind)}</span>` : ''}
          <span class="fl-tag">截至 ${esc(d.trade_date)}</span>
          <span class="fl-tag">每日盤後更新</span>
        </div>
        <div class="fl-verdict">${esc(d.verdict || '')}</div>
        ${chips ? `<div class="fl-siglist"><div class="fl-siglist-t">
          ${(d.signals || []).length} 個訊號亮起</div>${chips}</div>` : ''}
      </div>
      <div class="fl-hero-r">
        <div class="fl-price">
          <b>${last ? num(last.c, 2) : '—'}</b>
          <span class="${retCls(chg)}">${isNum(chg) ? (chg > 0 ? '+' : '') + pct(chg, 2) : ''}</span>
        </div>
        ${priceChartHtml(d)}
      </div>
    </section>`;
  }

  function qualityHtml(d) {
    const ins = buildInsights(d);
    const s = d.scores || {}, f = d.fundamentals || {}, v = d.valuation || {};
    const name = d.name || d.ticker;

    const kv = (label, val, sub) => `<div class="fl-kv">
      <div class="fl-kv-l">${label}</div><div class="fl-kv-v">${val}</div>
      ${sub ? `<div class="fl-kv-s">${sub}</div>` : ''}</div>`;

    const panes = {
      all: insightsHtml(ins),
      val: insightsHtml(ins.filter(i => i.dim === 'val')) + `<div class="fl-kvs">
        ${kv('本益比 PE', num(v.pe, 1), isNum(v.pe_pct_self) ? `自身分位 ${v.pe_pct_self.toFixed(0)}%` : '')}
        ${kv('股價淨值比 PB', num(v.pb, 2), isNum(v.pb_pct_self) ? `自身分位 ${v.pb_pct_self.toFixed(0)}%` : '')}
        ${kv('每股盈餘 TTM', num(v.eps_ttm, 2), '')}
        ${kv('每股淨值 BPS', num(v.bps, 2), '')}</div>`,
      qual: insightsHtml(ins.filter(i => i.dim === 'qual')) + `<div class="fl-kvs">
        ${kv('ROE', num(f['ROE'], 2) + '%', isNum(f['ROE_pct']) ? `第 ${f['ROE_pct'].toFixed(0)} 百分位` : '')}
        ${kv('營業利益率', num(f['營業淨利率'], 2) + '%', isNum(f['營業淨利率_pct']) ? `第 ${f['營業淨利率_pct'].toFixed(0)} 百分位` : '')}
        ${kv('毛利率', num(f['毛利率'], 2) + '%', isNum(f['毛利率_pct']) ? `第 ${f['毛利率_pct'].toFixed(0)} 百分位` : '')}
        ${kv('負債比率', num(f['負債比率'], 2) + '%', isNum(f['負債比率_pct']) ? `第 ${f['負債比率_pct'].toFixed(0)} 百分位` : '')}</div>`,
      grow: insightsHtml(ins.filter(i => i.dim === 'grow')) + `<div class="fl-kvs">
        ${kv('月營收 YoY', num(f['月營收YoY'], 1) + '%', isNum(f['月營收YoY_pct']) ? `第 ${f['月營收YoY_pct'].toFixed(0)} 百分位` : '')}
        ${kv('營收成長率', num(f['營收成長率'], 1) + '%', '')}
        ${kv('稅後淨利成長率', num(f['稅後淨利成長率'], 1) + '%', '')}</div>`,
      mom: insightsHtml(ins.filter(i => i.dim === 'mom')),
      chip: insightsHtml(ins.filter(i => i.dim === 'chip')) + chipNumsHtml(d),
    };
    const TABS = [['all', '重點結論'], ['val', '估值'], ['qual', '品質'],
    ['grow', '成長'], ['mom', '動能'], ['chip', '籌碼']];

    return `<section class="fl-sec" data-sec="體質">
      <h2 class="fl-h2">${esc(name)}可以買嗎？先看體質與估值定位</h2>
      <div class="fl-two">
        <div>
          <div class="fl-tabs" data-tabs="qual">${TABS.map(([k, l], i) =>
      `<button class="fl-tab${i === 0 ? ' on' : ''}" data-pane="${k}">${l}</button>`).join('')}</div>
          ${TABS.map(([k], i) =>
        `<div class="fl-pane${i === 0 ? ' on' : ''}" data-pane="${k}">${panes[k]}</div>`).join('')}
        </div>
        <div class="fl-radar-col">
          ${radarHtml(s)}
          <div class="fl-total">總分 <b style="color:${scoreColor(s.total)}">${isNum(s.total) ? Math.round(s.total) : '—'}</b>
            <span class="fl-mut">＝品質·成長·動能·籌碼平均，<b>不含估值</b></span></div>
        </div>
      </div>
    </section>`;
  }

  const CHIP_WHO = [['foreign', '外資'], ['trust', '投信'], ['dealer', '自營'], ['inst', '三大法人']];

  function chipNumsHtml(d) {
    const c = d.chip || {};
    if (!Object.keys(c).length) return '';
    return `<div class="fl-kvs">${CHIP_WHO.map(([k, label]) => {
      const s5 = c[`${k}_sum5`], s20 = c[`${k}_sum20`], st = c[`${k}_streak`];
      const sub = (isNum(st) && st !== 0 ? `連${st > 0 ? '買' : '賣'} ${Math.abs(st)} 日　` : '')
        + `20日 ${int(s20)}`;
      return `<div class="fl-kv"><div class="fl-kv-l">${label}近 5 日</div>
        <div class="fl-kv-v ${retCls(s5)}">${int(s5)}</div>
        <div class="fl-kv-s">${sub}</div></div>`;
    }).join('')}</div>`;
  }

  /** ⑥ 方向分 + 漸層量表：籌碼分 0-100 映到 −1…+1 */
  function chipFlowHtml(d, extraHtml) {
    const s = d.scores || {};
    const dir = isNum(s.chip) ? (s.chip - 50) / 50 : null;
    const label = !isNum(dir) ? '無資料'
      : dir >= 0.4 ? '偏多' : dir >= 0.1 ? '略偏多'
        : dir > -0.1 ? '中性' : dir > -0.4 ? '略偏空' : '偏空';
    const posPct = isNum(dir) ? (dir + 1) / 2 * 100 : 50;
    const ins = buildInsights(d).filter(i => i.dim === 'chip');
    return `<section class="fl-sec" data-sec="籌碼">
      <h2 class="fl-h2">籌碼流向</h2>
      <div class="fl-dirwrap">
        <div class="fl-dir">
          <div class="fl-dir-l ${dir > 0 ? 'fl-up' : dir < 0 ? 'fl-down' : ''}">${label}
            <span class="fl-dir-v">${isNum(dir) ? (dir > 0 ? '+' : '') + dir.toFixed(2) : ''}</span></div>
          <div class="fl-gauge"><i style="left:${posPct}%"></i></div>
          <div class="fl-gauge-t"><span>偏空</span><span>中性</span><span>偏多</span></div>
        </div>
        <div class="fl-dir-body">${insightsHtml(ins)}${chipNumsHtml(d)}</div>
      </div>
      ${extraHtml || ''}
    </section>`;
  }

  function evidenceHtml(d, shared) {
    const meta = (shared && shared.signal_meta) || {};
    const act = d.signals || [], idle = d.signals_idle || [];
    const actHtml = act.length
      ? `<div class="fl-siggrid">${act.map(s => signalCard(s, meta, true)).join('')}</div>`
      : '<div class="fl-none">今日無訊號成立</div>';
    const idleHtml = idle.length
      ? `<h3 class="fl-h3">目前未成立的訊號（歷史統計供參）</h3>
         <div class="fl-siggrid">${idle.map(s =>
        signalCard({ id: s.id, evidence_market: s.evidence_market }, meta, false)).join('')}</div>`
      : '';
    return `<section class="fl-sec" data-sec="歷史證據">
      <h2 class="fl-h2">歷史證據：接下來通常怎麼走</h2>
      <h3 class="fl-h3">目前正在發生的訊號</h3>
      <p class="fl-lead">以下訊號在最近一筆資料中成立，附全市場歷史上每次出現後的前瞻報酬統計。</p>
      ${actHtml}
      <h3 class="fl-h3">估值 × 動能的歷史對照</h3>
      ${matrixHtml(d, shared)}
      ${idleHtml}
    </section>`;
  }

  function matrixHtml(d, shared) {
    const rows = (shared && shared.val_mom_matrix) || [];
    if (!rows.length) return '<div class="fl-none">尚未產生矩陣（請跑 valuation.py）</div>';
    const H = rows[0].horizon;
    const cell = new Map(rows.filter(r => r.horizon === H)
      .map(r => [`${r.val_bucket}-${r.mom_bucket}`, r]));
    const s = d.scores || {};
    const bk = v => isNum(v) ? Math.min(5, Math.floor(v / 20) + 1) : null;
    const myV = bk(s.val), myM = bk(s.mom);
    let body = '';
    for (let v = 5; v >= 1; v--) {
      let tds = '';
      for (let m = 1; m <= 5; m++) {
        const r = cell.get(`${v}-${m}`), a = r ? r.alpha_xs_median : null;
        const me = (v === myV && m === myM) ? ' fl-mx-me' : '';
        tds += `<td class="${retCls(a)}${me}"${me ? ' title="本檔目前位置"' : ''}>${pct(a)}
          ${r ? `<small>n=${int(r.n)}</small>` : ''}</td>`;
      }
      body += `<tr><th>${v === 5 ? '最便宜5' : v === 1 ? '最貴1' : v}</th>${tds}</tr>`;
    }
    const head = [1, 2, 3, 4, 5].map(m =>
      `<th>${m === 1 ? '最弱1' : m === 5 ? '最強5' : m}</th>`).join('');
    return `<div class="fl-mx-wrap"><table class="fl-mx">
      <thead><tr><th>估值＼動能</th>${head}</tr></thead><tbody>${body}</tbody></table></div>
      <p class="fl-note">${H} 日後對全市場個股中位數的超額報酬中位數；青框＝本檔目前位置。
      樣本 ${esc(rows[0].sample_start)} ~ ${esc(rows[0].sample_end)}。
      兩個方向都單調：越便宜越好、動能越強越好；但最貴那排不管動能多強都是負的。</p>`;
  }

  // ═══ 多序列折線圖 ═════════════════════════════════════
  //
  //  集保「比率」是 %、「絕對張數」是千股，兩者量綱差 3 個數量級，
  //  硬畫在同一個 y 軸其中一條會變成貼底的直線。這裡**每條各自正規化**到 0-1，
  //  圖上看的是「形狀是否同步」——交叉驗證要看的正是背離，不是絕對高度。
  //  真實數值放在圖例上（最新值 + 區間），不會因為正規化而失去可讀性。
  //
  function fmtD(d) {
    const s = String(d);
    return s.length === 8 ? `${s.slice(2, 4)}/${s.slice(4, 6)}/${s.slice(6)}` : s;
  }

  //   ⚠️ 同 priceChartHtml：用像素座標 + non-scaling-stroke。舊版是 viewBox="0 0 100 40"
  //   + preserveAspectRatio="none" 撐到 height:200px（橫 15.6× / 縱 4.8×），線寬會在
  //   2.9~9.4px 之間亂跳，整條線腫成「河流」。
  //   正規化：預設維持「每條線各自拉滿全高」——集保那張是跨單位比形狀（比率 vs 絕對張數），
  //   共用尺規會毀掉它（實測台積電大戶比率 78% 與散戶 3% 綁同一把 % 尺後，大戶 3.24pp 的
  //   變化只剩 5px/158px，線被壓平）。要共用尺規的圖表自己傳 grp（分點庫存全是「張」且量級
  //   可比，共用才看得出誰收得多）。缺少真實數值的問題由 hover tooltip 解決，不靠共用尺規。
  function multiLineHtml(dates, series, opts) {
    const o = opts || {};
    const n = (dates || []).length;
    const live = (series || []).filter(s => (s.data || []).some(isNum));
    if (n < 2 || !live.length) return '<div class="fl-none">資料不足，無法繪圖</div>';

    const W = 1200, PL = 6, PR = 6, PT = 8, H = o.h || 158, XH = 18;
    const pw = W - PL - PR;
    const x = i => PL + (n === 1 ? pw / 2 : (i / (n - 1)) * pw);

    // 同單位（或同 grp）的線共用 lo/hi，跨單位才各自正規化
    const groups = {};
    const gkey = (s, i) => s.grp || ('#' + i);      // 預設每條線獨立；傳 grp 才共用
    live.forEach((s, i) => {
      const k = gkey(s, i);
      const ok = s.data.filter(isNum);
      const g = groups[k] || (groups[k] = { lo: Infinity, hi: -Infinity });
      g.lo = Math.min(g.lo, ...ok);
      g.hi = Math.max(g.hi, ...ok);
    });
    // o.fixed = { grpKey: [lo, hi] }：讓多張面板共用同一把尺（跨 multiLineHtml 呼叫）
    Object.entries(groups).forEach(([k, g]) => {
      const fx = o.fixed && o.fixed[k];
      if (fx) { g.lo = fx[0]; g.hi = fx[1]; g.span = (g.hi - g.lo) || 1; return; }
      const pad = ((g.hi - g.lo) || Math.abs(g.hi) || 1) * 0.08;
      g.lo -= pad; g.hi += pad; g.span = (g.hi - g.lo) || 1;
    });
    const yOf = (s, i) => {
      const g = groups[gkey(s, i)];
      return (v) => PT + (1 - (v - g.lo) / g.span) * H;
    };

    const paths = live.map((s, i) => {
      const y = yOf(s, i);
      const pts = s.data.map((v, i) => isNum(v) ? `${x(i).toFixed(1)},${y(v).toFixed(1)}` : null)
        .filter(Boolean).join(' ');
      return `<polyline points="${pts}" fill="none" stroke="${s.color}"
        stroke-width="${s.w != null ? s.w * 1.6 : 1.6}" opacity="${s.op || 1}"
        ${s.dash ? `stroke-dasharray="${s.dash * 1 ? s.dash * 3 : '5 4'}"` : ''}/>`;
    }).join('');

    // 面板模式（o.panel）不畫格線，只畫一條零基準線（照 FinLab 小倍數面板的做法）
    let grid;
    if (o.panel) {
      const zg = groups[o.zeroGrp] || Object.values(groups)[0];
      const zy = PT + (1 - (0 - zg.lo) / zg.span) * H;
      grid = (zy >= PT && zy <= PT + H)
        ? `<line class="flc-zero" x1="${PL}" y1="${zy.toFixed(1)}" x2="${PL + pw}" y2="${zy.toFixed(1)}"/>` : '';
    } else {
      grid = [0, 0.25, 0.5, 0.75, 1].map(f =>
        `<line class="flc-grid" x1="${PL}" y1="${(PT + H * f).toFixed(1)}" x2="${PL + pw}" y2="${(PT + H * f).toFixed(1)}"/>`
      ).join('');
    }

    // 日期軸：約 5 個等距標籤（面板模式只放頭尾兩個，寬度不夠）
    const nLab = o.panel ? Math.min(2, n) : Math.min(5, n);
    const xLabs = Array.from({ length: nLab }, (_, k) => {
      const i = Math.round(k * (n - 1) / (nLab - 1));
      const anchor = k === 0 ? 'start' : (k === nLab - 1 ? 'end' : 'middle');
      return `<text class="flc-ax" x="${x(i).toFixed(1)}" y="${PT + H + XH - 4}" text-anchor="${anchor}">${fmtD(dates[i])}</text>`;
    }).join('');

    const legend = live.map(s => {
      if (s.noLegend) return '';
      if (o.legend === 'dot') {     // 面板模式：只有色塊＋名稱，數字在下方明細表
        return `<span class="fl-lg fl-lg-dot"><i style="background:${s.color}"></i>${esc(s.label)}</span>`;
      }
      const ok = s.data.filter(isNum);
      const last = ok[ok.length - 1];
      const d = s.d == null ? 2 : s.d;
      return `<span class="fl-lg">
        <i style="background:${s.color}"></i>${esc(s.label)}
        <b>${num(last, d)}${s.unit ? esc(s.unit) : ''}</b>
        <span class="fl-mut">（${num(Math.min(...ok), d)}~${num(Math.max(...ok), d)}）</span>
      </span>`;
    }).join('');

    const hid = hovRegister({
      W, xs: live[0].data.map((_, i) => x(i)), dates: dates.slice(),
      series: live.map((s, i) => {
        const y = yOf(s, i);
        return {
          label: s.label, color: s.color, unit: s.unit || '', d: s.d == null ? 2 : s.d,
          vals: s.data, ys: s.data.map(v => isNum(v) ? y(v) : null),
        };
      }),
    });

    return `<div class="fl-lc${o.panel ? ' fl-lc-pane' : ''}"${o.tone ? ` data-tone="${o.tone}"` : ''}>
      <div class="flc-plot fl-lc-plot" data-hov="${hid}" data-w="${W}" data-xh="${XH}">
        <svg viewBox="0 0 ${W} ${PT + H + XH}" aria-label="${esc(o.aria || '折線圖')}">
          ${grid}${xLabs}${paths}
        </svg>
        ${o.badge ? `<span class="fl-lc-badge">${esc(o.badge)}</span>` : ''}
        <div class="flc-cross" hidden></div>
        <div class="flc-tip" hidden></div>
      </div>
      <div class="fl-lgs">${legend}</div>
      ${o.note ? `<p class="fl-note">${o.note}</p>` : ''}
    </div>`;
  }

  // ═══ 集保大戶 · 絕對持股交叉驗證 ═══════════════════════
  const JB_FLAG = {
    both_up: ['good', '真實加碼', '比率與絕對張數同步上升——確實有人在買進。'],
    denom: ['bad', '分母縮水的假象',
      '比率上升，但大戶手上的絕對張數其實是減少的。這是集保總張數變小'
      + '（減資／股票移出集保／ETF 調整）造成的，**不是大戶進場**。'],
    both_down: ['warn', '真實減碼', '比率與絕對張數同步下降——大戶確實在出。'],
    dilute: ['flat', '買了但被稀釋',
      '絕對張數增加，但比率反而下降——買盤跟不上流通張數的擴張。'],
  };

  function jibaoHtml(d) {
    const j = d.jibao || {};
    if (!j.weeks) return '';
    const f = JB_FLAG[j.flag] || ['flat', '資料不足', ''];
    const chg = (v, u, dg) => isNum(v)
      ? `<b class="${retCls(v)}">${v > 0 ? '+' : ''}${num(v, dg)}${u}</b>` : '—';

    const chart = multiLineHtml(j.date, [
      { label: '收盤價', data: j.close, color: 'var(--border-hi)', w: 0.6, op: .7, unit: '', d: 0 },
      { label: '大戶持股比率', data: j.big_pct, color: 'var(--accent)', w: 1.1, unit: '%' },
      { label: '大戶絕對張數', data: j.big_k, color: '#f5b942', w: 1.1, unit: ' 千股', d: 0 },
      { label: '散戶(≤10張)比率', data: j.small_pct, color: '#8b7bd8', w: 0.7, dash: '2 1.5', unit: '%' },
    ], {
      aria: '集保大戶比率與絕對持股交叉驗證',
      note: '四條線各自正規化到同一高度（單位不同：% 與千股不能比高低）——這張圖要看的是'
        + '<b>形狀是否同步</b>，不是絕對高度。青線（比率）與黃線（絕對張數）分岔時，'
        + '就是分母在作怪。<b>滑過圖表可看任一週四條線的真實數值。</b>',
    });

    return `<section class="fl-sec" data-sec="集保">
      <h2 class="fl-h2">集保大戶 · 絕對持股交叉驗證</h2>
      <p class="fl-lead">大戶持股「比率」的分母是集保總張數，會因減資或股票移出集保而縮水——
        <b>大戶一張都沒買，比率照樣上升</b>。所以比率一定要跟絕對張數一起看。</p>
      <div class="fl-jb-head">
        <div class="fl-in fl-in-${f[0]} fl-jb-verdict"><b>${esc(f[1])}</b>${esc(f[2])}</div>
        <div class="fl-kvs">
          <div class="fl-kv"><div class="fl-kv-l">大戶持股比率</div>
            <div class="fl-kv-v">${num(j.big_pct[j.big_pct.length - 1], 2)}%</div>
            <div class="fl-kv-s">近 ${j.lookback_w} 週 ${chg(j.big_pct_chg, ' pp', 2)}</div></div>
          <div class="fl-kv"><div class="fl-kv-l">大戶絕對張數</div>
            <div class="fl-kv-v">${int(j.big_k[j.big_k.length - 1])}</div>
            <div class="fl-kv-s">千股，近 ${j.lookback_w} 週 ${chg(j.big_k_chg, '', 0)}</div></div>
          <div class="fl-kv"><div class="fl-kv-l">集保總張數</div>
            <div class="fl-kv-v">${int(j.total_k[j.total_k.length - 1])}</div>
            <div class="fl-kv-s">千股（＝比率的分母）</div></div>
          <div class="fl-kv"><div class="fl-kv-l">股東人數</div>
            <div class="fl-kv-v">${int(j.holders[j.holders.length - 1])}</div>
            <div class="fl-kv-s">人</div></div>
        </div>
      </div>
      ${chart}
      <p class="fl-note">大戶＝持股 ≥400 張；散戶＝≤10 張。集保每週五結算、次週一公布，
        故最新一點是 <b>${fmtD(j.asof)}</b>，會落後盤面數天，<b>不能拿來做當日判斷</b>。
        共 ${j.weeks} 週。</p>
    </section>`;
  }

  // ═══ 分點明細 + 分點庫存重建 ═══════════════════════════
  //   版型照 finlab.finance/stocks/6488（2026-07-30 截圖）重排：
  //   把分點依「重建庫存曲線」分成 承接／派發／交易台 三組，各給一張小倍數面板
  //   （組內用同色系深→淺區分，股價當灰色底線），下面接三欄明細（橫條＋狀態）。
  //   ⚠️ 數字對不上 FinLab 是預期的，不是 bug：我們的窗口只有 61 個交易日、6 家分點，
  //   他們約 103 日、16 家。分點資料只能每天存檔往前長（TEJ 回補是死路），會隨時間收斂。
  const BK_COLORS = ['var(--accent)', '#f5b942', '#8b7bd8', '#4ec9b0', '#e8734a', '#6a9fd8'];

  // 組內深→淺色階（照 FinLab：同色系區分同組分點，不用彩虹色）
  const BK_RAMP = {
    hold: ['#0e8f6f', '#17a97f', '#2ec49a', '#4dd6ae', '#7ee3c6', '#a9eeda'],
    dist: ['#a3231f', '#c0392b', '#d9534f', '#e8736f', '#f0968f', '#f5b8b3'],
    desk: ['#5a6a8a', '#6e7f9f', '#8492b0', '#9aa6c0', '#b0bad0', '#c6cee0'],
  };
  const BK_DIST_MIN = 0.30;   // 自峰值回吐 ≥30% 才算「派發倒貨」
  const BK_PACE_WIN = 20;     // 估算倒貨速度的回看天數

  /** 依重建庫存曲線把分點分成 承接／派發／交易台，並算出已賣%、倒完天數 */
  function bkClassify(x) {
    const cum = (x.cum || []).filter(isNum);
    if (!cum.length) return null;
    const now = cum[cum.length - 1];
    const peak = Math.max(...cum);
    const soldPct = peak > 0 ? Math.max(0, (peak - now) / peak) : 0;
    const daily = (x.daily || []).slice(-BK_PACE_WIN).filter(isNum);
    const sells = daily.filter(v => v < 0);
    // 倒貨速度＝回看窗內「賣出日」的平均賣量（不用全部日平均，否則買賣互相抵銷會低估）
    const pace = sells.length ? Math.abs(sells.reduce((a, b) => a + b, 0)) / BK_PACE_WIN : 0;
    const daysLeft = (pace > 0 && now > 0) ? Math.round(now / pace) : null;

    let grp;
    if (now <= 0) grp = 'desk';                     // 負庫存 → 交易台淨空
    else if (soldPct >= BK_DIST_MIN) grp = 'dist';  // 曾大量累積、已明顯回吐 → 派發
    else grp = 'hold';                              // 仍留正庫存 → 承接
    return { ...x, now, peak, soldPct, pace, daysLeft, grp, recentSells: sells.length };
  }

  const BK_GRP_META = {
    hold: {
      key: 'hold', title: '承接持有者', short: '承接', tone: 'hold',
      desc: '窗口內累積買進後仍留有正庫存的分點，可視為正在吸收籌碼的一方。',
    },
    dist: {
      key: 'dist', title: '派發倒貨者', short: '派發', tone: 'dist',
      desc: '曾累積大量庫存、近期持續賣出的分點；「剩」是估計尚未出完的張數。',
    },
    desk: {
      key: 'desk', title: '交易台淨空', short: '交易台', tone: 'desk',
      desc: '分點呈現負庫存或淨賣出，多見於避險、對沖或短線部位，不直接等同看空。',
    },
  };

  /** 明細列的狀態文字（只用資料算得出來的，不猜分點性質） */
  function bkStatus(r) {
    const sold = `${(r.soldPct * 100).toFixed(0)}%`;
    if (r.grp === 'hold') {
      return `已賣 ${sold}·${r.recentSells >= BK_PACE_WIN * 0.5 ? '邊買邊出' : '仍在加碼'}`;
    }
    if (r.grp === 'dist') {
      if (r.daysLeft == null) return `已倒 ${sold}·近期停手`;
      return `已倒 ${sold}·約 ${int(r.daysLeft)} 日倒完`;
    }
    // 交易台：只講庫存方向與是否回補中
    const last5 = (r.daily || []).slice(-5).filter(isNum).reduce((a, b) => a + b, 0);
    return last5 > 0 ? '負庫存·近 5 日回補中' : '負庫存·仍在淨賣';
  }

  function brokerHtml(d) {
    const b = d.broker || {};
    if (!b.days || !(b.brokers || []).length) return '';
    const dt = b.detail || {};

    const board = (title, rows, sub) => `<div class="fl-bd">
      <div class="fl-bd-h">${title}<span class="fl-mut">${sub}</span></div>
      ${(rows || []).map(r => `<div class="fl-bd-r">
        <span>${esc(r.bk)}</span><b>${int(r.qty)}</b></div>`).join('')}
    </div>`;

    // ── 分組 ──────────────────────────────────────────
    const rows = b.brokers.map(bkClassify).filter(Boolean);
    const byGrp = { hold: [], dist: [], desk: [] };
    rows.forEach(r => byGrp[r.grp].push(r));
    // 組內依規模排序，並指派同色系深→淺
    Object.keys(byGrp).forEach(k => {
      byGrp[k].sort((a, c) => (k === 'dist' ? c.now - a.now
        : k === 'desk' ? a.now - c.now : c.now - a.now));
      byGrp[k].forEach((r, i) => { r.color = BK_RAMP[k][i % BK_RAMP[k].length]; });
    });

    // 股價當面板底線：broker 日期是 YYYYMMDD，price 是 YYYY-MM-DD
    const pmap = {};
    (d.price || []).forEach(p => { pmap[String(p.d).replace(/-/g, '')] = p.c; });
    const pxLine = b.dates.map(dd => pmap[String(dd)] ?? null);
    const hasPx = pxLine.some(isNum);

    // 承接與派發共用同一把尺（可互比）；交易台獨立（負值域，混在一起會把正庫存壓平）
    const shareVals = byGrp.hold.concat(byGrp.dist)
      .flatMap(r => r.cum.filter(isNum));
    const shareRange = shareVals.length
      ? (() => {
        let lo = Math.min(0, ...shareVals), hi = Math.max(0, ...shareVals);
        const pad = ((hi - lo) || 1) * 0.08;
        return [lo - pad, hi + pad];
      })() : null;

    const panel = (key) => {
      const list = byGrp[key];
      if (!list.length) return '';           // 空組不出現（全站慣例）
      const m = BK_GRP_META[key];
      const shared = key !== 'desk' && shareRange;
      const series = list.map(r => ({
        label: r.bk, data: r.cum, color: r.color, w: 1, unit: ' 張', d: 0, grp: '張',
      }));
      if (hasPx) {
        series.push({
          label: '股價', data: pxLine, color: 'var(--text-mut)', w: 0.7, op: .55,
          unit: '', d: 2, grp: '價', noLegend: true,
        });
      }
      return `<div class="fl-pane fl-pane-${key}">
        <div class="fl-pane-h">${m.short}</div>
        ${multiLineHtml(b.dates, series, {
          h: 150, panel: true, legend: 'dot', tone: m.tone, zeroGrp: '張',
          badge: shared ? '' : '獨立尺度',
          aria: `分點庫存重建 · ${m.short}`,
          fixed: shared ? { '張': shareRange } : null,
        })}
      </div>`;
    };

    const explainer = ['hold', 'dist', 'desk'].map(k => byGrp[k].length
      ? `<div class="fl-pcard fl-pcard-${k}">
          <div class="fl-pcard-t">${BK_GRP_META[k].title}</div>
          <p>${BK_GRP_META[k].desc}</p>
        </div>` : '').join('');

    // ── 明細三欄（名稱＋值＋橫條＋狀態）─────────────────
    //   橫條三欄共用同一個分母（全組最大絕對值），所以跨欄長度可直接比
    const barMax = Math.max(1, ...rows.map(r => Math.abs(r.now)));
    const detailCol = (key) => {
      const list = byGrp[key];
      if (!list.length) return '';
      const m = BK_GRP_META[key];
      return `<div class="fl-dcol fl-dcol-${key}">
        <div class="fl-dcol-h">${m.short}</div>
        ${list.map(r => `<div class="fl-drow">
          <div class="fl-drow-t"><span>${esc(r.bk)}</span>
            <b>${key === 'dist' ? `剩 ${int(r.now)}`
        : `${r.now > 0 ? '+' : ''}${int(r.now)}`}</b></div>
          <div class="fl-dbar"><i style="width:${(Math.abs(r.now) / barMax * 100).toFixed(1)}%;background:${r.color}"></i></div>
          <div class="fl-drow-s">${esc(bkStatus(r))}
            <span class="fl-cov fl-cov-${!isNum(r.coverage) ? 'flat'
        : (r.coverage >= 0.85 && r.coverage <= 1.15 ? 'good' : 'warn')}"
              title="自行累加的近60日淨額 ÷ TEJ 給的近60日買賣超；越接近 1 越可信">覆蓋 ${isNum(r.coverage) ? r.coverage.toFixed(2) : '—'}</span>
            <span class="fl-mut">進榜 ${r.days_on_board}/${b.days}</span></div>
        </div>`).join('')}
      </div>`;
    };

    // ── 底部合計 ──────────────────────────────────────
    const distLeft = byGrp.dist.reduce((a, r) => a + Math.max(0, r.now), 0);
    const maxDays = byGrp.dist.reduce((a, r) => r.daysLeft != null ? Math.max(a, r.daysLeft) : a, 0);
    const pull = rows.reduce((a, r) => {
      const s = (r.daily || []).slice(-BK_PACE_WIN).filter(isNum);
      return a + s.filter(v => v > 0).reduce((x, y) => x + y, 0);
    }, 0);
    const push = rows.reduce((a, r) => {
      const s = (r.daily || []).slice(-BK_PACE_WIN).filter(isNum);
      return a + s.filter(v => v < 0).reduce((x, y) => x + y, 0);
    }, 0);
    const net = pull + push;

    return `<section class="fl-sec" data-sec="分點">
      <h2 class="fl-h2">誰在收、誰在倒？分點庫存重建</h2>
      <p class="fl-lead">追蹤「近 60 日買賣超」排行前段的分點，把牠們每日淨額累加成庫存曲線，
        再依曲線形狀分成三組。每日淨額＝<b>當日買進榜的量 減 賣出榜的量</b>——只用買賣超榜會
        漏掉牠們賣出的日子，累積會系統性高估（實測覆蓋率會跑到 1.2~3.1）。</p>

      <h3 class="fl-h3">分點庫存重建（近 ${b.days} 個交易日）</h3>
      <div class="fl-pcards">${explainer}</div>
      <div class="fl-panes">${panel('hold')}${panel('dist')}${panel('desk')}</div>
      <p class="fl-note">${hasPx ? '灰線＝股價（各面板獨立縮放，只看形狀對照）。' : ''}
        ${byGrp.hold.length && byGrp.dist.length ? '承接與派發<b>共用尺度可互比</b>；' : ''}
        ${byGrp.desk.length ? '交易台為獨立尺度（負值域）。' : ''}橫線為零基準。
        滑過任一面板可看該日各分點的真實累積張數。</p>

      <h3 class="fl-h3">分點明細<span class="fl-h3-r">單位：張</span></h3>
      <div class="fl-dcols">${detailCol('hold')}${detailCol('dist')}${detailCol('desk')}</div>
      <div class="fl-dsum">
        <div><div class="fl-dsum-l">還在倒</div>
          <div class="fl-dsum-v">${int(distLeft)} 張</div>
          <div class="fl-dsum-s">${maxDays ? `最長約 ${int(maxDays)} 個交易日見底` : '無倒貨速度可估'}</div></div>
        <div><div class="fl-dsum-l">近 ${BK_PACE_WIN} 日買賣力道</div>
          <div class="fl-dsum-v"><span class="fl-up">+${int(pull)} 吸</span>
            <span class="fl-mut"> / </span><span class="fl-down">${int(push)} 倒</span></div>
          <div class="fl-dsum-s">${net > 0 ? '買盤略勝' : (net < 0 ? '賣壓略勝' : '買賣相抵')}</div></div>
      </div>

      <h3 class="fl-h3">${fmtD(dt.date)} 當日分點進出</h3>
      <p class="fl-lead">當日成交 ${int(dt.turnover_k)} 張，${int(dt.n_brokers)} 家分點進出
        （買方 ${int(dt.n_buy)} 家／賣方 ${int(dt.n_sell)} 家）。</p>
      <div class="fl-bds">
        ${board('買超榜', dt.net, '淨額 · 張')}
        ${board('買進榜', dt.buy, '毛額 · 張')}
        ${board('賣出榜', dt.sell, '毛額 · 張')}
      </div>

      <p class="fl-note"><b>分組規則</b>：目前庫存 ≤0 → 交易台；自峰值回吐 ≥${(BK_DIST_MIN * 100).toFixed(0)}%
        → 派發；其餘 → 承接。<b>倒完天數</b>＝目前庫存 ÷ 近 ${BK_PACE_WIN} 日的平均賣出速度
        （只算賣出日的量，避免買賣互相抵銷而低估），窗口只有 ${b.days} 日、屬粗估。
        <b>覆蓋率</b>＝自行累加的近 60 日淨額 ÷ TEJ 直接給的「近60日買賣超」，越接近 1 代表
        這家幾乎天天在榜、重建線越可信。<br>${esc(b.caveat)}</p>
    </section>`;
  }

  const PROFILE_FIELDS = [
    ['name_full', '公司全稱'], ['industry_tej', 'TEJ 產業'], ['sub_industry_tej', 'TEJ 子產業'],
    ['industry_tse', 'TSE 產業'], ['market', '市場別'], ['listing_type', '上市別'],
    ['founded_date', '設立日期'], ['ipo_date', '首次掛牌'], ['chairman', '董事長'],
    ['ceo', '總經理'], ['spokesman', '發言人'], ['employees', '員工人數'],
    ['paid_in_capital', '實收資本額'], ['website', '網址'],
  ];

  function aboutHtml(d, extraHtml) {
    const p = d.profile || {};
    const rows = PROFILE_FIELDS.map(([k, label]) => {
      let v = p[k];
      if (v == null || v === '') return '';
      if (k === 'paid_in_capital' && isNum(v)) v = `${(v / 1e8).toFixed(2)} 億`;
      if (k === 'employees' && isNum(v)) v = `${int(v)} 人`;
      const val = (k === 'website')
        ? `<a href="${/^https?:/.test(String(v)) ? esc(v) : 'https://' + esc(v)}"
             target="_blank" rel="noopener noreferrer">${esc(v)}</a>` : esc(v);
      return `<div class="fl-pf"><span class="fl-mut">${label}</span><span>${val}</span></div>`;
    }).join('');
    const del = p.is_delisted
      ? `<p class="fl-warn">⚠️ 本檔已於 ${esc(p.delist_date || '—')} 下市</p>` : '';
    return `<section class="fl-sec" data-sec="基本資料">
      <h2 class="fl-h2">${esc(d.name || d.ticker)}是做什麼的？公司基本資料</h2>
      ${rows ? `<div class="fl-pfgrid">${rows}</div>` : '<div class="fl-none">無基本資料</div>'}
      ${del}${extraHtml || ''}
    </section>`;
  }

  function methodHtml(d, shared) {
    return `<section class="fl-sec fl-sec-method" data-sec="方法與限制">
      <h2 class="fl-h2">方法與限制</h2>
      <ul class="fl-method">
        <li><b>分數＝當日全市場橫斷面百分位。</b>85 分代表贏過 85% 的股票，跨日跨股可比。
          品質維度另做 50% 同業校正——不校正的話 ODM／EMS 整個族群會一起趴在地板，
          分數只是在重新編碼「你屬於哪個產業」。</li>
        <li><b>總分不含估值。</b>贏窟是動能導向系統，估值高分（便宜）常常正是動能弱的，
          放進同一個總分會互相抵銷。估值是「買貴買便宜」的獨立問題，不是好壞的加項。</li>
        <li><b>超額報酬對的是「當日全市場個股報酬中位數」，不是加權指數。</b>
          加權指數被權值股拉動，中位數個股本來就跑輸它——用指數當基準會讓幾乎所有
          選股訊號的超額都是負的，毫無鑑別力。</li>
        <li><b>PE／PB 以還原價計算。</b>還原基準是資料匯出當日，故「當前」值準確，
          但歷史價被往下還原使歷史 PE 偏低，「自身歷史分位」因此系統性偏高。
          橫斷面分位不受影響。</li>
        <li><b>${esc((shared && shared.caveat) || '')}</b></li>
        <li>資料來源全部為 TEJ。訊號為策略輔助、非投資建議。</li>
      </ul>
    </section>`;
  }

  /** 分頁切換（宿主呼叫一次即可，事件委派） */
  function bindTabs(root) {
    if (!root || root.__flTabs) return;
    root.__flTabs = true;
    root.addEventListener('click', (e) => {
      const b = e.target.closest('.fl-tab');
      if (!b) return;
      const box = b.closest('.fl-two') || root;
      box.querySelectorAll('.fl-tab').forEach(x => x.classList.toggle('on', x === b));
      box.querySelectorAll('.fl-pane').forEach(p =>
        p.classList.toggle('on', p.dataset.pane === b.dataset.pane));
    });
    bindChart(root);
  }

  /** 走勢圖互動：期間鈕切換 + hover 十字線/tooltip（同樣事件委派，宿主無需額外呼叫） */
  function bindChart(root) {
    // 期間鈕
    root.addEventListener('click', (e) => {
      const b = e.target.closest('.flc-rb');
      if (!b || b.disabled) return;
      const box = b.closest('.fl-chart');
      const all = _flCharts[box && box.dataset.uid];
      if (!all) return;
      box.querySelectorAll('.flc-rb').forEach(x => x.classList.toggle('on', x === b));
      box.querySelector('.flc-body').innerHTML = chartBody(all, b.dataset.range);
    });

    const hideAll = () => root.querySelectorAll('.flc-plot').forEach(p => {
      const c = p.querySelector('.flc-cross'), t = p.querySelector('.flc-tip');
      if (c) c.hidden = true;
      if (t) t.hidden = true;
    });

    // hover：把滑鼠 px 位置換算回圖表座標，找最近的一點，列出每條線的真實值
    const move = (e) => {
      const plot = e.target.closest ? e.target.closest('.flc-plot') : null;
      if (!plot) { hideAll(); return; }   // 移出圖表就收起（不用 mouseleave capture，避免掠過子元素時閃動）
      const spec = _flHov[plot.dataset.hov];
      if (!spec || !spec.xs.length) return;
      const r = plot.getBoundingClientRect();
      if (!r.width) return;
      const sc = r.width / spec.W;
      const ux = (e.clientX - r.left) / sc;
      let k = 0, best = Infinity;
      for (let i = 0; i < spec.xs.length; i++) {
        const dd = Math.abs(spec.xs[i] - ux);
        if (dd < best) { best = dd; k = i; }
      }

      const cross = plot.querySelector('.flc-cross');
      const tip = plot.querySelector('.flc-tip');
      const lx = spec.xs[k] * sc;
      cross.hidden = false;
      cross.style.left = lx + 'px';
      // 每條線在該點的位置各放一顆點
      cross.innerHTML = spec.series.map(s => s.ys[k] == null ? '' :
        `<i class="flc-dotm" style="top:${(s.ys[k] * sc).toFixed(1)}px;background:${s.color}"></i>`).join('');

      const rows = spec.series.map((s, si) => {
        const v = s.vals[k];
        if (!isNum(v)) return '';
        let extra = '';
        if (spec.pctOf === si && k > 0 && isNum(s.vals[k - 1]) && s.vals[k - 1]) {
          const dp = (v / s.vals[k - 1] - 1) * 100;
          extra = `<i class="${dp > 0 ? 'flc-t-up' : (dp < 0 ? 'flc-t-dn' : '')}">${dp >= 0 ? '+' : ''}${num(dp, 2)}%</i>`;
        }
        return `<span><em style="background:${s.color}"></em>${esc(s.label)}`
          + `<i>${num(v, s.d)}${esc(s.unit || '')}</i>${extra}</span>`;
      }).join('');
      const extras = (spec.extra || []).map(x => isNum(x.vals[k])
        ? `<span><em class="flc-noc"></em>${esc(x.label)}<i>${num(x.vals[k], x.d)}${esc(x.unit || '')}</i></span>` : '').join('');

      tip.hidden = false;
      tip.innerHTML = `<b>${esc(String(spec.dates[k] || ''))}</b>${rows}${extras}`;
      // tooltip 靠邊時翻到左側，避免被容器裁掉
      const tw = tip.offsetWidth || 160;
      tip.style.left = (lx + tw + 16 > r.width ? Math.max(0, lx - tw - 12) : lx + 12) + 'px';
    };
    root.addEventListener('mousemove', move);
    root.addEventListener('mouseleave', hideAll);
  }

  return {
    load, loadShared, bindTabs,
    heroHtml, qualityHtml, chipFlowHtml, evidenceHtml, aboutHtml, methodHtml,
    jibaoHtml, brokerHtml, multiLineHtml,
    matrixHtml, chipNumsHtml, buildInsights, insightsHtml, radarHtml,
    esc, isNum, pct, num, int, scoreColor, retCls,
  };
})();
