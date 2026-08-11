/* ══════════════════════════════════════════════════════════════
   市場結構分頁 — 複製「期天台指盤前規劃」第一章版面
   資料來源：data/daily/{date}/market_structure.json.gz
             （由 export_market_structure.py 產生）

   全部圖形都用 inline SVG 手繪，不依賴任何圖表庫。
   依賴 app.js 的全域：fetchJsonGz / dailyPath / currentDate /
                       indexMeta / openKlineModal
   ══════════════════════════════════════════════════════════════ */
window.MarketStructure = (function () {
  'use strict';

  const state = { data: null, date: null, heatMarket: 'TSE', kwTab: 'hot' };

  // ── 小工具 ────────────────────────────────────────────────
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const isNum = v => v != null && !isNaN(v);
  const cls = v => !isNum(v) ? '' : (v > 0 ? 'up' : v < 0 ? 'down' : '');
  const sign = v => !isNum(v) ? '--' : (v > 0 ? '+' : '') + v;
  const pct = (v, nd = 2) => !isNum(v) ? '--' : (v > 0 ? '+' : '') + Number(v).toFixed(nd) + '%';
  const num = (v, nd = 2) => !isNum(v) ? '--' : Number(v).toLocaleString('en-US',
    { minimumFractionDigits: nd, maximumFractionDigits: nd });
  const int = v => !isNum(v) ? '--' : Math.round(v).toLocaleString('en-US');

  /** 熱力圖配色：台股紅漲綠跌，越深越極端（±7% 打底） */
  function heatColor(ret) {
    if (!isNum(ret)) return '#1a1a2e';
    const t = Math.min(Math.abs(ret) / 7, 1);
    if (Math.abs(ret) < 0.05) return '#20202f';
    return ret > 0
      ? `hsl(2, ${Math.round(45 + 25 * t)}%, ${Math.round(15 + 26 * t)}%)`
      : `hsl(168, ${Math.round(40 + 25 * t)}%, ${Math.round(14 + 22 * t)}%)`;
  }

  // ── SVG 元件 ──────────────────────────────────────────────

  /** 半圓儀表：-100 ~ +100 */
  function gaugeSvg(score, label) {
    const W = 190, H = 118, cx = W / 2, cy = 100, R = 74;
    const v = isNum(score) ? Math.max(-100, Math.min(100, score)) : 0;
    // -100 → 180°(左)，+100 → 0°(右)
    const ang = Math.PI * (1 - (v + 100) / 200);
    const arc = (a0, a1, color) => {
      const p = a => `${cx + R * Math.cos(a)},${cy - R * Math.sin(a)}`;
      const large = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
      return `<path d="M ${p(a0)} A ${R} ${R} 0 ${large} 1 ${p(a1)}"
        fill="none" stroke="${color}" stroke-width="13" stroke-linecap="butt"/>`;
    };
    const P = Math.PI;
    const segs = [
      arc(P, P * 0.78, '#1f8a70'), arc(P * 0.78, P * 0.56, '#3aa87a'),
      arc(P * 0.56, P * 0.44, '#8a8a55'), arc(P * 0.44, P * 0.22, '#c96a4a'),
      arc(P * 0.22, 0, '#d94a4a'),
    ].join('');
    const nx = cx + (R - 16) * Math.cos(ang), ny = cy - (R - 16) * Math.sin(ang);
    const tone = v > 20 ? 'up' : v < -20 ? 'down' : '';
    return `<div class="ms-gauge">
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="100%" aria-label="${esc(label)}">
        ${segs}
        <text x="12" y="${cy + 14}" class="g-tick">-100</text>
        <text x="${W - 12}" y="${cy + 14}" class="g-tick" text-anchor="end">100</text>
        <text x="${cx}" y="18" class="g-tick" text-anchor="middle">0</text>
        <line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" stroke="#e8e8f0" stroke-width="3"
              stroke-linecap="round"/>
        <circle cx="${cx}" cy="${cy}" r="5.5" fill="#e8e8f0"/>
      </svg>
      <div class="ms-gauge-cap">${esc(label)}
        <b class="${tone}">${isNum(score) ? sign(Math.round(score)) : '--'}</b></div>
    </div>`;
  }

  /** 迷你折線圖（近 N 日） */
  function sparkSvg(series, opts = {}) {
    const pts = (series || []).filter(p => isNum(p.c));
    if (pts.length < 2) return '<div class="ms-spark-empty">資料不足</div>';
    const W = 320, H = 96, pad = 4;
    const ys = pts.map(p => p.c);
    const lo = Math.min(...ys), hi = Math.max(...ys);
    const span = (hi - lo) || 1;
    const X = i => pad + i * (W - 2 * pad) / (pts.length - 1);
    const Y = v => pad + (1 - (v - lo) / span) * (H - 2 * pad);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.c).toFixed(1)}`).join('');
    const area = `${d}L${X(pts.length - 1).toFixed(1)},${H}L${X(0).toFixed(1)},${H}Z`;
    const color = opts.color || (ys[ys.length - 1] >= ys[0] ? 'var(--up)' : 'var(--down)');
    const id = 'msg' + Math.random().toString(36).slice(2, 8);
    return `<svg class="ms-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.30"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient></defs>
      <path d="${area}" fill="url(#${id})"/>
      <path d="${d}" fill="none" stroke="${color}" stroke-width="1.6"/>
    </svg>`;
  }

  /** 漲跌家數直方圖（-10% ~ +10%） */
  function histSvg(dist) {
    const bins = dist.bins || [], labels = dist.labels || [];
    const W = 460, H = 150, pad = 16;
    const max = Math.max(...bins, 1);
    const bw = (W - 2 * pad) / bins.length;
    const bars = bins.map((n, i) => {
      const h = n / max * (H - 34);
      const x = pad + i * bw, y = H - 18 - h;
      const lab = labels[i];
      const c = lab > 0 ? 'var(--up)' : lab < 0 ? 'var(--down)' : '#7d7d9c';
      return `<g class="ms-hb"><rect x="${(x + 1).toFixed(1)}" y="${y.toFixed(1)}"
        width="${(bw - 2).toFixed(1)}" height="${Math.max(h, 0).toFixed(1)}" fill="${c}"
        opacity="${lab === 0 ? 0.55 : 0.85}"><title>${lab > 0 ? '+' : ''}${lab}% 附近：${n} 檔</title></rect>
        ${n >= max * 0.12 ? `<text x="${(x + bw / 2).toFixed(1)}" y="${(y - 3).toFixed(1)}"
          class="ms-hb-n" text-anchor="middle">${n}</text>` : ''}
        ${(i % 2 === 0) ? `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 5}"
          class="ms-hb-x" text-anchor="middle">${lab}</text>` : ''}</g>`;
    }).join('');
    return `<svg class="ms-hist" viewBox="0 0 ${W} ${H}">${bars}</svg>`;
  }

  /** 直立 K 棒條（類股 / 權值股 / 高價股漲跌） */
  function retBarsSvg(items, key = 'ret') {
    const rows = (items || []).filter(x => isNum(x[key]));
    if (!rows.length) return '<div class="ms-spark-empty">無資料</div>';
    // 寬度跟著檔數走：類股有 78 組，固定 460 寬會把標籤壓成黑塊
    const W = Math.max(460, rows.length * 14), H = 170, top = 12, botLabel = 66;
    const plotH = H - top - botLabel;
    const cap = Math.max(10, ...rows.map(r => Math.abs(r[key]))) * 1.05;
    const bw = (W - 8) / rows.length;
    const zeroY = top + plotH / 2;
    const bars = rows.map((r, i) => {
      const v = r[key];
      const h = Math.abs(v) / cap * (plotH / 2);
      const x = 4 + i * bw;
      const y = v >= 0 ? zeroY - h : zeroY;
      const c = v >= 0 ? 'var(--up)' : 'var(--down)';
      return `<g><rect x="${(x + bw * 0.18).toFixed(1)}" y="${y.toFixed(1)}"
        width="${(bw * 0.64).toFixed(1)}" height="${Math.max(h, 1).toFixed(1)}" fill="${c}">
        <title>${esc(r.name)} ${pct(v)}</title></rect>
        <text transform="translate(${(x + bw / 2 + 3).toFixed(1)},${H - 60}) rotate(90)"
          class="ms-bar-lab">${esc(String(r.name).slice(0, 7))}</text></g>`;
    }).join('');
    return `<svg class="ms-retbars" viewBox="0 0 ${W} ${H}">
      <line x1="0" y1="${zeroY}" x2="${W}" y2="${zeroY}" stroke="#3a3a52" stroke-width="1"/>
      <text x="2" y="${top + 8}" class="ms-hb-x">${cap.toFixed(0)}%</text>
      <text x="2" y="${zeroY + plotH / 2}" class="ms-hb-x">-${cap.toFixed(0)}%</text>
      ${bars}</svg>`;
  }

  // ── Treemap（squarified） ─────────────────────────────────
  function squarify(items, x, y, w, h) {
    const out = [];
    const total = items.reduce((s, i) => s + i.value, 0);
    if (!total) return out;
    let rest = items.map(i => ({ ...i, area: i.value / total * w * h }));
    let cx = x, cy = y, cw = w, ch = h;

    const worst = (row, len) => {
      const s = row.reduce((a, b) => a + b.area, 0);
      const mx = Math.max(...row.map(r => r.area)), mn = Math.min(...row.map(r => r.area));
      return Math.max(len * len * mx / (s * s), (s * s) / (len * len * mn));
    };

    while (rest.length) {
      const vertical = cw >= ch;      // 沿短邊鋪
      const len = vertical ? ch : cw;
      const row = [rest[0]];
      let i = 1;
      while (i < rest.length && worst(row.concat(rest[i]), len) <= worst(row, len)) {
        row.push(rest[i]); i++;
      }
      const rowArea = row.reduce((a, b) => a + b.area, 0);
      const thick = rowArea / len;
      let off = 0;
      row.forEach(r => {
        const side = r.area / thick;
        out.push(vertical
          ? { ...r, x: cx, y: cy + off, w: thick, h: side }
          : { ...r, x: cx + off, y: cy, w: side, h: thick });
        off += side;
      });
      if (vertical) { cx += thick; cw -= thick; } else { cy += thick; ch -= thick; }
      rest = rest.slice(row.length);
      if (cw < 0.5 || ch < 0.5) break;
    }
    return out;
  }

  function treemapHtml(rows) {
    // 面積用 w^0.55 壓縮：台積電權重 42%，照實比例會吃掉半張圖，其他格全部
    // 縮成看不見的碎片（期天那張圖也是壓縮過的）。真實權重仍在 tooltip。
    const items = (rows || []).filter(r => isNum(r.w) && r.w > 0)
      .map(r => ({ ...r, value: Math.pow(r.w, 0.55) }));
    if (!items.length) return '<div class="ms-spark-empty">無資料</div>';
    const W = 1000, H = 560;
    const cells = squarify(items, 0, 0, W, H);
    const boxes = cells.map(c => {
      const small = c.w < 52 || c.h < 30;
      const tiny = c.w < 30 || c.h < 20;
      const lines = tiny ? '' : small
        ? `<div class="tm-n">${esc(c.name)}</div>`
        : `<div class="tm-n">${esc(c.name)}</div>
           <div class="tm-p">${pct(c.ret)}</div>
           ${isNum(c.contrib) ? `<div class="tm-c">${sign(c.contrib.toFixed(2))}</div>` : ''}`;
      return `<div class="tm-cell" style="left:${(c.x / W * 100).toFixed(3)}%;
        top:${(c.y / H * 100).toFixed(3)}%;width:${(c.w / W * 100).toFixed(3)}%;
        height:${(c.h / H * 100).toFixed(3)}%;background:${heatColor(c.ret)}"
        data-code="${esc(c.code)}" data-name="${esc(c.name)}"
        title="${esc(c.name)} ${esc(c.code)}｜${pct(c.ret)}｜權重 ${num(c.w, 2)}%｜貢獻 ${sign(c.contrib)} 點｜成交 ${num(c.amount, 1)} 億">
        ${lines}</div>`;
    }).join('');
    return `<div class="tm-wrap">${boxes}</div>`;
  }

  // ── 區塊 ──────────────────────────────────────────────────

  function kpiHtml(d) {
    const k = d.kpi, t = k.taiex || {}, o = k.otc || {};
    const tse = (k.cap && k.cap.TSE) || {};
    const amt = k.amount || {}, amp = k.amplitude || {};
    const tile = (label, value, sub, tone) => `<div class="ms-k">
      <span class="ms-k-l">${label}</span>
      <span class="ms-k-v ${tone || ''}">${value}</span>
      <span class="ms-k-s">${sub || ''}</span></div>`;
    return `<div class="ms-kpis">
      ${tile('大盤漲跌', sign(num(t.chg, 2)), `${num(t.close, 2)}　${pct(t.chg_pct)}`, cls(t.chg))}
      ${tile('台積電貢獻', sign(num(k.tsmc_contrib, 2)), '點（估算）', cls(k.tsmc_contrib))}
      ${tile('權值20貢獻', sign(num(tse.top20_contrib, 2)),
    `前50：${sign(num(tse.top50_contrib, 2))}`, cls(tse.top20_contrib))}
      ${tile('櫃買漲跌', sign(num(o.chg, 2)), `${num(o.close, 2)}　${pct(o.chg_pct)}`, cls(o.chg))}
      ${tile('權值20漲跌', `<span class="up">${tse.top20_up}</span><small>：</small><span class="down">${tse.top20_down}</span>`,
    '上漲：下跌 家數')}
      ${tile('成交值 / 20日均', `${int(amt.today_e)}<small> / ${int(amt.ma20_e)}</small>`,
    `億元　${isNum(amt.ratio) ? (amt.ratio * 100).toFixed(0) + '%' : '--'}　上市 ${int(amt.tse_e)}`,
    isNum(amt.ratio) && amt.ratio >= 1 ? 'up' : '')}
      ${tile('指數振幅 / 20日均', `${num(amp.today_pct, 2)}%<small> / ${num(amp.ma20_pct, 2)}%</small>`,
    `個股振幅中位數 ${num(amp.stock_med_pct, 2)}%`)}
      ${tile('HV20 波動率', `${num(d.series.hv_last, 2)}%`, '加權指數年化歷史波動')}
    </div>`;
  }

  /** 直方圖下面那排統計（期天在每張圖下方各放一排） */
  function breadthFootHtml(x) {
    const tot = (x.up || 0) + (x.down || 0) + (x.flat || 0);
    const upW = tot ? (x.up / tot * 100) : 0, dnW = tot ? (x.down / tot * 100) : 0;
    const cell = (lab, n, tone) => `<div class="ms-bf-c">
      <span class="ms-bf-l">${lab}</span><b class="${tone}">${n}</b></div>`;
    return `<div class="ms-bd-bar"><i class="up" style="width:${upW}%"></i>
        <i class="flat" style="width:${100 - upW - dnW}%"></i>
        <i class="down" style="width:${dnW}%"></i></div>
      <div class="ms-bf">
        ${cell('跌停', x.limit_down, 'down')}${cell('下跌', x.down, 'down')}
        ${cell('平盤', x.flat, '')}${cell('上漲', x.up, 'up')}
        ${cell('漲停', x.limit_up, 'up')}
        <div class="ms-bf-c"><span class="ms-bf-l">合計</span><b>${x.total}</b></div>
      </div>`;
  }

  function newhlHtml(d) {
    const rows = (d.newhl || []).map(r => {
      const tot = (r.high || 0) + (r.low || 0);
      const hp = tot ? r.high / tot * 100 : 0;
      const univ = (d.trend.TSE.universe || 0) + (d.trend.OTC.universe || 0);
      const share = univ ? (r.high / univ * 100) : 0;
      return `<div class="ms-nh">
        <span class="ms-nh-w">${r.win}日</span>
        <div class="ms-nh-bar" title="創高 ${r.high} 檔／創低 ${r.low} 檔">
          <i class="up" style="width:${hp.toFixed(1)}%">${share >= 6 ? share.toFixed(1) + '%' : ''}</i>
          <i class="down" style="width:${(100 - hp).toFixed(1)}%"></i></div>
        <span class="ms-nh-n"><b class="up">${r.high}</b><small>:</small><b class="down">${r.low}</b></span>
      </div>`;
    }).join('');
    return `<div class="ms-nh-list">${rows}
      <div class="ms-legend"><span class="up">■ 創高家數</span><span class="down">■ 創低家數</span>
      <span class="muted">口徑：當日最高價 &gt; 前 N 日最高價（未調整價）</span></div></div>`;
  }

  function trendHtml(d) {
    const col = m => {
      const t = d.trend[m] || {};
      const row = (lab, o, tip) => `<div class="ms-tr-row" title="${esc(tip)}">
        <span class="ms-tr-l">${lab}</span>
        <span class="ms-tr-n">${o ? o.n : '--'}<small> (${o ? o.pct : '--'}%)</small></span>
        <div class="ms-tr-bar"><i style="width:${o ? o.pct : 0}%"></i></div></div>`;
      return `<div class="ms-tr-col"><div class="ms-tr-h">${m === 'TSE' ? '上市' : '上櫃'}
        <small>${t.universe} 檔</small></div>
        ${row('站上週線', t.ma5, '收盤 > MA5')}
        ${row('站上月線', t.ma20, '收盤 > MA20')}
        ${row('站上季線', t.ma60, '收盤 > MA60')}
        ${row('多頭排列', t.bull, '贏窟定義：MA5 > MA20 > MA60（不含收盤位置條件）')}</div>`;
    };
    return `<div class="ms-tr">${col('TSE')}${col('OTC')}</div>`;
  }

  function contribHtml(d) {
    const rows = d.contrib[state.heatMarket] || { up: [], down: [] };
    const list = (arr, tone) => arr.slice(0, 15).map(r => `<tr data-code="${esc(r.code)}"
      data-name="${esc(r.name)}">
      <td class="c">${esc(r.code)}</td><td>${esc(r.name)}</td>
      <td class="n ${tone}">${sign(num(r.contrib, 2))}</td>
      <td class="n ${cls(r.ret)}">${pct(r.ret)}</td></tr>`).join('');
    return `<div class="ms-ct">
      <div class="ms-ct-col"><div class="ms-ct-h up">上漲貢獻</div>
        <table class="ms-tb"><tbody>${list(rows.up, 'up')}</tbody></table></div>
      <div class="ms-ct-col"><div class="ms-ct-h down">下跌貢獻</div>
        <table class="ms-tb"><tbody>${list(rows.down, 'down')}</tbody></table></div>
    </div>`;
  }

  function keywordsHtml(d) {
    const tabs = [['hot', '🔥 熱門'], ['strong', '📈 強勢'], ['weak', '📉 弱勢']];
    const chips = (d.keywords[state.kwTab] || []).map(k => {
      const tone = state.kwTab === 'weak' ? 'down' : cls(k.ret);
      return `<span class="ms-chip ${tone}">${esc(k.name)}
        <small>×${k.n}</small> <b>${pct(k.ret, 1)}</b></span>`;
    }).join('');
    const list = (d.lists[state.kwTab] || []).map(r => `<tr data-code="${esc(r.code)}"
      data-name="${esc(r.name)}">
      <td class="c">${esc(r.code)}</td><td>${esc(r.name)}</td>
      <td class="n">${num(r.close, 2)}</td>
      <td class="n ${cls(r.chg)}">${sign(num(r.chg, 2))}</td>
      <td class="n ${cls(r.ret)}">${pct(r.ret)}</td>
      <td class="n">${num(r.amount, 1)}</td></tr>`).join('');
    return `<div class="ms-kw-tabs">${tabs.map(([k, l]) =>
      `<button class="ms-kwt ${state.kwTab === k ? 'active' : ''}" data-kw="${k}">${l}</button>`).join('')}
      <span class="muted">關鍵字＝細產業（MoneyDJ），取該池前 100 檔統計，出現 ≥2 次才列</span></div>
      <div class="ms-chips">${chips || '<span class="muted">無</span>'}</div>
      <table class="ms-tb ms-tb-wide"><thead><tr><th>代號</th><th>名稱</th><th class="n">成交</th>
        <th class="n">漲跌</th><th class="n">幅度</th><th class="n">成交值(億)</th></tr></thead>
        <tbody>${list}</tbody></table>`;
  }

  // ── 主渲染 ────────────────────────────────────────────────
  function render() {
    const el = document.getElementById('ms-body');
    if (!el) return;
    const d = state.data;
    if (!d) { el.innerHTML = '<div class="ms-empty">此日尚無市場結構資料。</div>'; return; }

    const card = (title, body, extra = '', wide = '') =>
      `<section class="ms-card ${wide}"><div class="ms-card-h">${title}${extra}</div>
        <div class="ms-card-b">${body}</div></section>`;

    const mkBtns = ['TSE', 'OTC'].map(m =>
      `<button class="ms-mk ${state.heatMarket === m ? 'active' : ''}" data-mk="${m}">
        ${m === 'TSE' ? '上市' : '上櫃'}</button>`).join('');

    el.innerHTML = `
      <div class="ms-note">📅 ${d.trading_date}　收盤資料
        <span class="muted">${esc(d.basis.price)}</span></div>

      <div class="ms-grid ms-grid-2">
        ${card('盤面總覽', kpiHtml(d) + `<div class="ms-gauges">
            ${gaugeSvg(d.mood.market.score, '盤面氣氛')}
            ${gaugeSvg(d.mood.focus.score, '焦點股氣氛')}</div>
            <div class="ms-formula" title="${esc(d.mood.formula)}">ℹ️ 氣氛分數為贏窟自訂合成指標
            （廣度／漲跌停／指數／類股廣度／量能），非期天原式，未經預測力檢定</div>`)}
        ${card('近期焦點股', retBarsSvg(d.lists.hot, 'ret'),
    '<small class="muted">成交值前 15 名當日漲跌</small>')}
      </div>

      <div class="ms-grid ms-grid-4">
        ${card('加權指數', sparkSvg(d.series.taiex),
    `<b class="${cls(d.kpi.taiex.chg)}">${num(d.kpi.taiex.close, 2)}　${sign(num(d.kpi.taiex.chg, 2))}　${pct(d.kpi.taiex.chg_pct)}</b>`)}
        ${card('櫃買指數', sparkSvg(d.series.otc),
    `<b class="${cls(d.kpi.otc.chg)}">${num(d.kpi.otc.close, 2)}　${sign(num(d.kpi.otc.chg, 2))}　${pct(d.kpi.otc.chg_pct)}</b>`)}
        ${card('市場成交值', sparkSvg(d.series.amount, { color: '#00d4aa' }),
    `<b>${int(d.kpi.amount.today_e)} 億</b>`)}
        ${card('HV20 波動率', sparkSvg(d.series.hv, { color: '#f5b942' }),
    `<b>${num(d.series.hv_last, 2)}%</b>`)}
      </div>

      <div class="ms-grid ms-grid-4">
        ${card('上市漲跌家數', histSvg(d.dist.TSE) + breadthFootHtml(d.dist.TSE))}
        ${card('上櫃漲跌家數', histSvg(d.dist.OTC) + breadthFootHtml(d.dist.OTC))}
        ${card('創新高／新低家數', newhlHtml(d))}
        ${card('個股趨勢概況', trendHtml(d))}
      </div>

      <div class="ms-grid ms-grid-1">
        ${card('類股漲跌', retBarsSvg(d.bars.sector),
    `<small class="muted">CMoney 類股 ${d.bars.sector.length} 組，市值加權平均，≥3 檔才列</small>`,
    'ms-card-tall')}
      </div>

      <div class="ms-grid ms-grid-2">
        ${card('權值股前20', retBarsSvg(d.bars.weight20))}
        ${card('高價股前20', retBarsSvg(d.bars.price20))}
      </div>

      <div class="ms-grid ms-grid-heat">
        ${card('市場熱力圖', treemapHtml(d.heat[state.heatMarket]),
    `<span class="ms-mks">${mkBtns}</span>
     <span class="ms-scale">${[-6, -4, -2, 0, 2, 4, 6].map(v =>
      `<i style="background:${heatColor(v)}">${v > 0 ? '+' : ''}${v}%</i>`).join('')}</span>`, 'ms-card-wide')}
        ${card('貢獻點數排行', contribHtml(d),
    `<small class="muted" title="${esc(d.basis.contrib)}">估算 ⓘ</small>`)}
      </div>

      <div class="ms-grid ms-grid-1">${card('熱門股關鍵字', keywordsHtml(d))}</div>
    `;
    bind();
  }

  function bind() {
    const el = document.getElementById('ms-body');
    if (!el) return;
    el.querySelectorAll('.ms-mk').forEach(b => b.addEventListener('click', () => {
      state.heatMarket = b.dataset.mk; render();
    }));
    el.querySelectorAll('.ms-kwt').forEach(b => b.addEventListener('click', () => {
      state.kwTab = b.dataset.kw; render();
    }));
    // 點個股 → 開既有的 K 線／個股彈窗
    el.querySelectorAll('[data-code]').forEach(n => n.addEventListener('click', () => {
      const code = n.dataset.code, name = n.dataset.name || '';
      if (typeof openKlineModal === 'function' && code) {
        openKlineModal(code, name, state.heatMarket === 'OTC' ? 'OTC' : 'TSE');
      }
    }));
  }

  // ── 載入 ──────────────────────────────────────────────────
  async function load() {
    const el = document.getElementById('ms-body');
    if (!el) return;
    if (state.date === currentDate && state.data) { render(); return; }
    el.innerHTML = '<div class="ms-empty">載入中…</div>';
    try {
      state.data = await fetchJsonGz(dailyPath('market_structure'));
      state.date = currentDate;
    } catch (e) {
      state.data = null; state.date = currentDate;
      el.innerHTML = `<div class="ms-empty">此日沒有市場結構資料。<br>
        <span class="muted">跑 <code>python export_market_structure.py ${currentDate || ''}</code> 產生。</span></div>`;
      return;
    }
    render();
  }

  return { load, render, state };
})();

/** 給 app.js 的 tab 切換呼叫 */
function loadMarketStructure() { window.MarketStructure.load(); }
