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
  function priceChartHtml(d) {
    const bars = (d.price || []).slice(-120);
    if (bars.length < 20) return '';
    const cs = bars.map(b => b.c), vs = bars.map(b => b.v || 0);
    const lo = Math.min(...cs), hi = Math.max(...cs), rng = (hi - lo) || 1;
    const W = 100, H = 46, VH = 12;
    const x = i => (i / (bars.length - 1)) * W;
    const y = c => H - ((c - lo) / rng) * H;
    const ma = (arr, n) => arr.map((_, i) =>
      i < n - 1 ? null : arr.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n);
    const line = (arr) => arr.map((c, i) => c == null ? null : `${x(i)},${y(c)}`)
      .filter(Boolean).join(' ');
    const vmax = Math.max(...vs) || 1;
    const volBars = bars.map((b, i) =>
      `<rect x="${x(i) - 0.32}" y="${H + VH - (b.v / vmax) * VH}" width="0.64"
        height="${(b.v / vmax) * VH}" fill="var(--border-hi)" opacity=".5"/>`).join('');

    const up = cs[cs.length - 1] >= cs[0];
    return `<div class="fl-chart">
      <svg viewBox="0 0 ${W} ${H + VH}" preserveAspectRatio="none" aria-label="近 120 日走勢">
        ${volBars}
        <polyline points="${line(ma(cs, 60))}" fill="none" stroke="#8b7bd8" stroke-width="0.5" opacity=".8"/>
        <polyline points="${line(ma(cs, 20))}" fill="none" stroke="#f5b942" stroke-width="0.5" opacity=".8"/>
        <polyline points="${line(cs)}" fill="none"
          stroke="${up ? 'var(--up)' : 'var(--down)'}" stroke-width="0.9"/>
      </svg>
      <div class="fl-chart-lg">近 120 日收盤　<span style="color:#f5b942">MA20</span>
        　<span style="color:#8b7bd8">MA60</span>　最高 ${num(hi, 1)}／最低 ${num(lo, 1)}</div>
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
  }

  return {
    load, loadShared, bindTabs,
    heroHtml, qualityHtml, chipFlowHtml, evidenceHtml, aboutHtml, methodHtml,
    matrixHtml, chipNumsHtml, buildInsights, insightsHtml, radarHtml,
    esc, isNum, pct, num, int, scoreColor, retCls,
  };
})();
