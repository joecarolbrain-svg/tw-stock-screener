/* ============================================================
   期貨建倉計算機 — ATR 驅動「間距加碼 + 回落減倉」
   - 純 vanilla，掛兩個入口：① 頂部新分頁 ② K 線彈窗 subtab
   - 市場數據自動（現價/近期高/週支撐/ATR，讀 klineState.cache）
   - 你的部位手動（口數/均價/現金）
   - 依 [[futures_qef_position_tool]] 策略；工具給線、人決定
   ============================================================ */
(function () {
  'use strict';

  // ── 預設參數（全域記憶） ─────────────────────────────
  const DEFAULTS = {
    mult: 100,        // 小型股票期貨 1 口 = 100 股 = 100 元/點（一般股期 2000）
    maxLots: 3,       // 高波動建議封頂 3 口
    gapMult: 1.5,     // 加碼間距 = gapMult × ATR
    bufferMult: 0.3,  // 加碼線 = 近期高 ×(1 + bufferMult×ATR)；過高 + 緩衝才算站穩
    trimMults: [1, 2, 3], // 回落減倉階梯 = 近期高 −{1,2,3}×ATR
    highN: 20,        // 近期高回看天數
    riskInit: 0.2025, // 原始保證金率（契約市值×）；國巨實際約 0.2675，可改
    riskMaint: 0.155, // 維持保證金率
  };

  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  const G = () => Object.assign({}, DEFAULTS, LS.get('qef.global', {}));
  const saveG = (patch) => LS.set('qef.global', Object.assign(G(), patch));
  const posKey = (t) => `qef.pos.${t || '_'}`;
  const getPos = (t) => LS.get(posKey(t), { lots: 0, avg: 0, cash: 0 });
  const savePos = (t, patch) => LS.set(posKey(t), Object.assign(getPos(t), patch));

  const fmt = (n, d = 1) => isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
  const fmt0 = (n) => isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—';
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ── 從 K 線資料推市場數據 ───────────────────────────
  function lastVal(arr) { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i]; return NaN; }

  function computeATR(d, n = 14) {
    const { h, l, c } = d;
    const trs = [];
    for (let i = 1; i < c.length; i++) {
      if (h[i] == null || l[i] == null || c[i - 1] == null) continue;
      trs.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
    }
    if (!trs.length) return NaN;
    const slice = trs.slice(-n);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  }

  function marketFromKline(d, highN) {
    if (!d || !d.c) return null;
    const price = lastVal(d.c);
    const hi = d.h.filter(x => x != null).slice(-highN);
    const lo = d.l.filter(x => x != null).slice(-5);
    const atrPts = computeATR(d, 14);
    return {
      price,
      recentHigh: hi.length ? Math.max(...hi) : price,
      weekSupport: lo.length ? Math.min(...lo) : NaN,
      atrPts,
      atrPct: isFinite(atrPts) && price ? atrPts / price : NaN,
    };
  }

  // ── 核心計算 ────────────────────────────────────────
  function computePlan(mkt, pos, p) {
    const { mult } = p;
    const { price, recentHigh, weekSupport, atrPct } = mkt;
    const { lots, avg, cash } = pos;

    // 部位狀態
    const notional = lots * price * mult;
    const initPerLot = p.riskInit * price * mult;
    const maintPerLot = p.riskMaint * price * mult;
    const reqInit = lots * initPerLot, reqMaint = lots * maintPerLot;
    const pnl = (price - avg) * mult * lots;
    const lev = cash > 0 ? notional / cash : 0;
    const marginCall = lots > 0 ? avg + (reqMaint - cash) / (mult * lots) : NaN;
    const callDist = price > 0 ? (price - marginCall) / price : NaN;

    // 加碼線：過近期高 + 緩衝，收盤站穩才加
    const addLine = recentHigh * (1 + p.bufferMult * atrPct);
    const gapPct = p.gapMult * atrPct;             // 等效加碼間距
    const capped = lots >= p.maxLots;

    // 減倉觸發線：合併「回落 ATR 階梯」+「保本(均價)」+「週支撐」，由高到低排序
    const cand = [];
    if (isFinite(weekSupport)) cand.push({ p: weekSupport, why: '週支撐', kind: 'support' });
    if (lots > 0 && isFinite(avg)) cand.push({ p: avg, why: '保本/均價', kind: 'breakeven' });
    p.trimMults.forEach(m => cand.push({ p: recentHigh * (1 - m * atrPct), why: `近高 −${m}ATR`, kind: 'atr' }));
    cand.sort((a, b) => b.p - a.p);
    // 去重（相差 <0.5% 視為同一條，合併理由）
    const lines = [];
    cand.forEach(x => {
      const prev = lines[lines.length - 1];
      if (prev && Math.abs(prev.p - x.p) / x.p < 0.005) { prev.why += ' / ' + x.why; }
      else lines.push(Object.assign({}, x));
    });
    // 由上而下逐條減 1 口，減到底倉(1)為止
    const core = 1;
    let held = lots;
    lines.forEach(ln => {
      ln.hit = price <= ln.p;
      ln.dist = price > 0 ? (ln.p - price) / price : 0;
      if (held > core) { ln.action = `減 1 口 (${held}→${held - 1})`; held -= 1; }
      else { ln.action = '已底倉 · 跌破=出場觀望'; ln.last = true; }
    });

    // 不動區 = 最高減倉線 ~ 加碼線
    const topTrim = lines.length ? lines[0].p : weekSupport;

    return { price, recentHigh, weekSupport, atrPct, pnl, lev, marginCall, callDist,
      reqInit, initPerLot, addLine, gapPct, capped, lines, topTrim, notional };
  }

  // ── 渲染 ────────────────────────────────────────────
  // ctx: { prefix, container, ticker, name, data }
  function renderPanel(ctx) {
    const { container, ticker } = ctx;
    if (!container) return;
    const g = G();
    const pos = getPos(ticker);
    const px = ctx.prefix;
    const noData = !ctx.data;

    container.innerHTML = `
      <div class="qef">
        <div class="qef-head">
          <div>
            <div class="qef-kicker">期貨建倉計算機 · ATR 驅動</div>
            <div class="qef-title">${ticker ? esc(ticker) + '　' + esc(ctx.name || '') : '輸入代號'}</div>
          </div>
          <div class="qef-atr" id="${px}-atrbox">—</div>
        </div>

        <div class="qef-hero" id="${px}-hero"></div>
        <div class="qef-warn">⚠ 一天最多動一次 · 跌破/站穩要帶緩衝（再走一點或 hold 幾分鐘）· 別追針</div>

        <div class="qef-status" id="${px}-status"></div>

        <div class="qef-card">
          <div class="qef-card-t">目前部位 <span class="muted">（手動，工具不假設你有幾口）</span></div>
          <div class="qef-grid">
            <label>口數<input type="number" step="1" id="${px}-lots" value="${pos.lots}"></label>
            <label>平均成本<input type="number" step="0.5" id="${px}-avg" value="${pos.avg}"></label>
            <label>總口數上限<input type="number" step="1" id="${px}-max" value="${g.maxLots}"></label>
            <label>帳戶現金<input type="number" step="1000" id="${px}-cash" value="${pos.cash}"></label>
          </div>
        </div>

        <div class="qef-card">
          <div class="qef-card-t">市場數據 <span class="muted">（自動帶，可覆寫）</span></div>
          <div class="qef-grid">
            <label>現價<input type="number" step="0.5" id="${px}-price"></label>
            <label>近期高 (N=<span id="${px}-nlbl">${g.highN}</span>)<input type="number" step="0.5" id="${px}-high"></label>
            <label>週支撐<input type="number" step="0.5" id="${px}-ws"></label>
            <label>ATR %<input type="number" step="0.1" id="${px}-atr"></label>
          </div>
          ${noData ? `<div class="qef-note-warn">此代號無快取 K 線（可能無個股期貨或尚未抓資料）→ 純手動試算，請自行填市場數據。</div>` : ''}
        </div>

        <details class="qef-adv">
          <summary>進階參數（加碼間距 / 減倉階梯 / 保證金）</summary>
          <div class="qef-grid">
            <label>加碼間距 ×ATR<input type="number" step="0.1" id="${px}-gapm" value="${g.gapMult}"></label>
            <label>加碼緩衝 ×ATR<input type="number" step="0.1" id="${px}-bufm" value="${g.bufferMult}"></label>
            <label>近期高天數 N<input type="number" step="1" id="${px}-highn" value="${g.highN}"></label>
            <label>每口股數<input type="number" step="100" id="${px}-mult" value="${g.mult}"></label>
            <label>原始保證金率%<input type="number" step="0.01" id="${px}-ri" value="${(g.riskInit * 100).toFixed(2)}"></label>
            <label>維持保證金率%<input type="number" step="0.01" id="${px}-rm" value="${(g.riskMaint * 100).toFixed(2)}"></label>
          </div>
          <div class="muted" style="margin-top:6px">減倉階梯固定 1/2/3×ATR；保證金以期商公告為準。</div>
        </details>

        <details class="qef-adv" id="${px}-simwrap">
          <summary>加碼網格模擬（往上等距加到上限）</summary>
          <div id="${px}-sim"></div>
        </details>

        <div class="qef-foot muted">本工具為部位管理試算、非投資建議；輸入存在你瀏覽器本機。</div>
      </div>`;

    // 帶入市場數據預設值（input value 用 JS set 以保留可空）
    const mkt0 = ctx.data ? marketFromKline(ctx.data, g.highN) : null;
    const setIf = (id, v, dec) => { const el = container.querySelector('#' + id); if (el && el.value === '') el.value = isFinite(v) ? (+v).toFixed(dec) : ''; };
    if (mkt0) {
      setIf(`${px}-price`, mkt0.price, 1);
      setIf(`${px}-high`, mkt0.recentHigh, 1);
      setIf(`${px}-ws`, mkt0.weekSupport, 1);
      setIf(`${px}-atr`, mkt0.atrPct * 100, 2);
    }

    // 綁定：任何 input 變動 → 存檔 + 重算輸出（不重建 DOM，保住游標）
    const ids = ['lots', 'avg', 'max', 'cash', 'price', 'high', 'ws', 'atr', 'gapm', 'bufm', 'highn', 'mult', 'ri', 'rm'];
    ids.forEach(s => {
      const el = container.querySelector(`#${px}-${s}`);
      if (el) el.addEventListener('input', () => recompute(ctx));
    });
    // 防呆：滾輪不要改到口數/均價等數字（財務工具誤滾很危險）
    container.querySelectorAll('input[type=number]').forEach(el =>
      el.addEventListener('wheel', (e) => { if (document.activeElement === el) e.preventDefault(); }, { passive: false }));
    recompute(ctx);
  }

  function num(container, id) { const el = container.querySelector('#' + id); return el ? parseFloat(el.value) : NaN; }

  function recompute(ctx) {
    const { container, ticker } = ctx, px = ctx.prefix;
    const p = {
      mult: num(container, `${px}-mult`) || 100,
      maxLots: num(container, `${px}-max`) || 1,
      gapMult: num(container, `${px}-gapm`) || 1.5,
      bufferMult: isFinite(num(container, `${px}-bufm`)) ? num(container, `${px}-bufm`) : 0.3,
      trimMults: [1, 2, 3],
      highN: num(container, `${px}-highn`) || 20,
      riskInit: (num(container, `${px}-ri`) || 0) / 100,
      riskMaint: (num(container, `${px}-rm`) || 0) / 100,
    };
    const mkt = {
      price: num(container, `${px}-price`),
      recentHigh: num(container, `${px}-high`),
      weekSupport: num(container, `${px}-ws`),
      atrPct: (num(container, `${px}-atr`) || 0) / 100,
    };
    const pos = {
      lots: num(container, `${px}-lots`) || 0,
      avg: num(container, `${px}-avg`) || 0,
      cash: num(container, `${px}-cash`) || 0,
    };
    // 持久化
    saveG({ maxLots: p.maxLots, mult: p.mult, gapMult: p.gapMult,
      bufferMult: p.bufferMult, highN: p.highN, riskInit: p.riskInit, riskMaint: p.riskMaint });
    savePos(ticker, { lots: pos.lots, avg: pos.avg, cash: pos.cash });
    const nlbl = container.querySelector(`#${px}-nlbl`); if (nlbl) nlbl.textContent = p.highN;

    if (!isFinite(mkt.price) || !isFinite(mkt.atrPct) || mkt.atrPct <= 0) {
      container.querySelector(`#${px}-hero`).innerHTML = `<div class="qef-empty">填入現價與 ATR% 後即顯示三條線。</div>`;
      container.querySelector(`#${px}-status`).innerHTML = '';
      container.querySelector(`#${px}-atrbox`).textContent = '—';
      return;
    }

    const r = computePlan(mkt, pos, p);
    const atrBox = container.querySelector(`#${px}-atrbox`);
    atrBox.innerHTML = `ATR <b>${fmt(mkt.atrPct * 100, 1)}%</b><span class="muted">≈${fmt0(mkt.price * mkt.atrPct)}點</span>`;

    // HERO 三條線
    const hero = container.querySelector(`#${px}-hero`);
    const addHit = mkt.price >= r.addLine;
    const trimRows = r.lines.slice(0, 5).map(ln => `
      <div class="qef-line ${ln.kind} ${ln.hit ? 'hit' : ''}">
        <span class="ql-dot"></span>
        <span class="ql-px">${fmt(ln.p, 1)}</span>
        <span class="ql-act">${esc(ln.action)}<span class="ql-why">${esc(ln.why)}</span></span>
        <span class="ql-dist">${ln.hit ? '✓ 已觸及' : '↓ ' + fmt(Math.abs(ln.dist) * 100, 1) + '%'}</span>
      </div>`).join('');
    hero.innerHTML = `
      <div class="qef-line add ${addHit ? 'hit' : ''}">
        <span class="ql-dot"></span>
        <span class="ql-px">${fmt(r.addLine, 1)}</span>
        <span class="ql-act">${r.capped ? '已達上限 ' + p.maxLots + ' 口 · 不建議再加' : '加碼線：收盤站穩才加'}<span class="ql-why">過近高 +${fmt(p.bufferMult, 1)}ATR · 間距≈${fmt(r.gapPct * 100, 1)}%</span></span>
        <span class="ql-dist">${addHit ? '✓ 已站上' : '↑ ' + fmt((r.addLine - mkt.price) / mkt.price * 100, 1) + '%'}</span>
      </div>
      <div class="qef-zone">⚪ 不動區　${fmt(r.topTrim, 1)} ── ${fmt(r.addLine, 1)}　<span class="muted">盤中在此區間怎麼晃都不理</span></div>
      ${trimRows}`;

    // 部位狀態
    const levCls = r.lev <= 2.5 ? 'good' : r.lev <= 3.5 ? 'warn' : 'bad';
    const pnlCls = r.pnl >= 0 ? 'pos' : 'neg';
    const status = container.querySelector(`#${px}-status`);
    status.innerHTML = pos.lots > 0 ? `
      <div class="qef-stat"><span>浮動損益</span><b class="${pnlCls}">${r.pnl >= 0 ? '+' : ''}${fmt0(r.pnl)}</b></div>
      <div class="qef-stat"><span>有效槓桿</span><b class="${levCls}">${fmt(r.lev, 2)}x</b></div>
      <div class="qef-stat"><span>追繳價</span><b>${fmt(r.marginCall, 1)}</b></div>
      <div class="qef-stat"><span>距追繳</span><b class="${r.callDist > 0.2 ? 'good' : 'bad'}">${fmt(r.callDist * 100, 1)}%</b></div>
      ${pos.cash > 0 && pos.cash < r.reqInit ? `<div class="qef-stat full bad">⚠ 現金不足以支撐目前口數（需原始保證金 ${fmt0(r.reqInit)}）</div>` : ''}` :
      `<div class="qef-stat full muted">填口數/均價後顯示浮盈、槓桿、追繳價</div>`;

    // 加碼網格模擬
    renderSim(container.querySelector(`#${px}-sim`), mkt, pos, p, r);
  }

  function renderSim(el, mkt, pos, p, r) {
    if (!el) return;
    if (r.capped) { el.innerHTML = `<div class="muted" style="padding:6px">已達上限,不再模擬加碼。</div>`; return; }
    let curLots = Math.max(pos.lots, 0), curCost = curLots * pos.avg;
    const base = Math.max(mkt.price, pos.avg || mkt.price);
    const rows = [`<tr><td>現部位</td><td>${fmt(pos.avg || mkt.price, 1)}</td><td>—</td><td>${curLots}</td><td>${curLots ? fmt(curCost / curLots, 1) : '—'}</td></tr>`];
    let bp = base;
    const remain = Math.max(0, p.maxLots - curLots);
    for (let i = 0; i < remain; i++) {
      bp = bp * (1 + r.gapPct);
      curCost += bp; curLots += 1;
      rows.push(`<tr><td>${i === 0 ? '下一口' : '加碼 ' + (i + 1)}</td><td>${fmt(bp, 1)}</td><td class="pos">+1</td><td>${curLots}</td><td><b>${fmt(curCost / curLots, 1)}</b></td></tr>`);
    }
    const finalAvg = curLots ? curCost / curLots : NaN;
    const buf = mkt.price > 0 && isFinite(finalAvg) ? (mkt.price - finalAvg) / finalAvg : NaN;
    el.innerHTML = `
      <table class="qef-sim">
        <thead><tr><th>動作</th><th>價位</th><th>加</th><th>累積</th><th>均價</th></tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>
      <div class="qef-note ${buf > 0.05 ? 'ok' : 'warn'}">滿倉均價 <b>${fmt(finalAvg, 1)}</b> · 以現價 ${fmt0(mkt.price)} 計緩衝剩 <b>${fmt(buf * 100, 1)}%</b>${buf <= 0.05 ? ' ← 緩衝偏薄,考慮砍口數或拉大間距' : ''}</div>`;
  }

  // ── 入口 ① 頂部分頁 ─────────────────────────────────
  const tabCtx = { prefix: 'qt', container: null, ticker: '', name: '', data: null };

  async function loadTabTicker(ticker) {
    ticker = (ticker || '').trim();
    if (!ticker) return;
    const root = document.getElementById('calc-tab-body');
    try {
      let d = klineState.cache[ticker];
      if (!d) { d = await fetchJsonGz(`data/kline/${ticker}.json.gz`); klineState.cache[ticker] = d; }
      tabCtx.ticker = ticker; tabCtx.name = d.name || ''; tabCtx.data = d; tabCtx.container = root;
    } catch (e) {
      tabCtx.ticker = ticker; tabCtx.name = ''; tabCtx.data = null; tabCtx.container = root;
    }
    LS.set('qef.lastTicker', ticker);
    renderPanel(tabCtx);
  }

  function initTab() {
    const root = document.getElementById('calc-tab-body');
    if (!root) return;
    const inp = document.getElementById('calc-ticker-input');
    const btn = document.getElementById('calc-ticker-go');
    if (btn) btn.addEventListener('click', () => loadTabTicker(inp.value));
    if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') loadTabTicker(inp.value); });
    tabCtx.container = root;
    const last = LS.get('qef.lastTicker', '');
    if (last) { if (inp) inp.value = last; loadTabTicker(last); }
    else root.innerHTML = `<div class="qef-empty" style="padding:30px">輸入股票代號（例如 2327）→ 自動帶現價/近期高/週支撐/ATR,算出今日加碼/減倉三條線。</div>`;
  }

  // 從 K 線彈窗「送到計算機分頁」
  function sendToTab(ticker, name, data) {
    const btn = document.querySelector(`.tab-btn[data-tab="calc"]`);
    if (btn) btn.click();
    const inp = document.getElementById('calc-ticker-input');
    if (inp) inp.value = ticker;
    if (data) klineState.cache[ticker] = data;
    loadTabTicker(ticker);
  }

  // ── 入口 ② K 線彈窗 subtab ──────────────────────────
  const mdlCtx = { prefix: 'qm', container: null, ticker: '', name: '', data: null };

  function onKline(ticker, name, data) {
    mdlCtx.ticker = ticker; mdlCtx.name = name; mdlCtx.data = data;
    mdlCtx.container = document.getElementById('kc-build');
    // 只有「建倉」subtab 正在顯示時才渲染（省效能）；切過去時也會補渲染
    const buildTab = document.querySelector('.kl-subtab-btn[data-kltab="build"]');
    if (buildTab && buildTab.classList.contains('active')) renderPanel(mdlCtx);
  }

  function initModalSubtabs() {
    document.querySelectorAll('.kl-subtab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.kltab;
        document.querySelectorAll('.kl-subtab-btn').forEach(b => b.classList.toggle('active', b === btn));
        document.getElementById('kc-klinewrap').style.display = tab === 'kline' ? '' : 'none';
        document.getElementById('kc-build').style.display = tab === 'build' ? '' : 'none';
        if (tab === 'build') { mdlCtx.container = document.getElementById('kc-build'); renderPanel(mdlCtx); }
      });
    });
  }

  // ── 全域曝露 ────────────────────────────────────────
  window.QEFCalc = { onKline, sendToTab, initTab, initModalSubtabs };

  document.addEventListener('DOMContentLoaded', () => { initTab(); initModalSubtabs(); });
})();
