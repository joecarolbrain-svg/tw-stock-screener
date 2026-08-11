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

  const state = {
    data: null, chips: null, date: null,
    heatMarket: 'TSE', kwTab: 'hot', biasMa: 'ma60',
    chapter: 'structure',      // structure(一) / options(二) / trend(三) / players(四) / board(五)
  };

  const CHAPTERS = [
    ['structure', '① 市場整體結構'],
    ['options', '② 選擇權結構'],
    ['trend', '③ 市場趨勢結構'],
    ['players', '④ 市場參與者'],
    ['board', '⑤ 籌碼綜合儀表板'],
  ];

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
  /** 帶正負號的整數。⚠ 不可寫成 sign(int(v))：int() 會加千分位逗號，
   *  再進 isNum() 就變成 NaN，四位數以上全部顯示 '--'。 */
  const signInt = v => !isNum(v) ? '--' : (v > 0 ? '+' : '') + int(v);

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

  // ══ 共用卡片外殼 ══════════════════════════════════════════
  const card = (title, body, extra = '', wide = '') =>
    `<section class="ms-card ${wide}"><div class="ms-card-h">${title}${extra}</div>
      <div class="ms-card-b">${body}</div></section>`;

  /** 水位條：把數值在近 N 日的百分位畫成一條（期天「籌碼強弱分析」那排） */
  function levelBar(label, pct, value, sub) {
    const p = isNum(pct) ? Math.max(0, Math.min(100, pct)) : null;
    const tone = p == null ? '' : (p >= 70 ? 'hi' : p <= 30 ? 'lo' : 'mid');
    return `<div class="ms-lv">
      <span class="ms-lv-l">${esc(label)}</span>
      <span class="ms-lv-v">${value}</span>
      <div class="ms-lv-bar"><i class="${tone}" style="width:${p == null ? 0 : p}%"></i>
        ${p == null ? '' : `<b style="left:${p}%"></b>`}</div>
      <span class="ms-lv-p">${p == null ? '--' : p.toFixed(0) + '%'}</span>
      ${sub ? `<span class="ms-lv-s">${sub}</span>` : ''}</div>`;
  }

  /** 淨額磚：數值 + 今日增減（期天那種一格一格的） */
  function netTile(label, net, chg, unit = '口') {
    return `<div class="ms-nt">
      <span class="ms-nt-l">${esc(label)}</span>
      <span class="ms-nt-v ${cls(net)}">${int(net)}<small>${unit}</small></span>
      ${isNum(chg) ? `<span class="ms-nt-c ${cls(chg)}">今日 ${signInt(chg)}</span>` : ''}
    </div>`;
  }

  // ══ 第一章 ════════════════════════════════════════════════
  function renderStructure(d) {
    const mkBtns = ['TSE', 'OTC'].map(m =>
      `<button class="ms-mk ${state.heatMarket === m ? 'active' : ''}" data-mk="${m}">
        ${m === 'TSE' ? '上市' : '上櫃'}</button>`).join('');

    return `
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
  }

  // ══ 第三章：市場趨勢結構 ══════════════════════════════════
  function renderTrend(d) {
    const a = d.amplitude_rank || {};
    const ampHist = (a.hist || []);
    const maxA = Math.max(1, ...ampHist.map(h => h.n));
    const ampBars = ampHist.map(h => `<div class="ms-hbar">
      <span class="ms-hbar-l">${h.label}</span>
      <div class="ms-hbar-t"><i style="width:${h.n / maxA * 100}%"></i></div>
      <span class="ms-hbar-n">${h.n}</span></div>`).join('');
    const ampTop = (a.top || []).map(r => `<tr data-code="${esc(r.code)}" data-name="${esc(r.name)}">
      <td class="c">${esc(r.code)}</td><td>${esc(r.name)}</td>
      <td class="n">${num(r.close, 2)}</td><td class="n ${cls(r.ret)}">${pct(r.ret)}</td>
      <td class="n warn">${num(r.amp, 2)}%</td><td class="n">${num(r.amount, 1)}</td></tr>`).join('');

    const bias = d.bias || {};
    const maBtns = ['ma20', 'ma60'].map(k =>
      `<button class="ms-mk ${state.biasMa === k ? 'active' : ''}" data-bias="${k}">
        ${k === 'ma20' ? '月線 MA20' : '季線 MA60'}</button>`).join('');
    const b = bias[state.biasMa] || {};
    const biasCols = ['TSE', 'OTC'].map(mk => {
      const x = b[mk];
      if (!x) return '';
      const mx = Math.max(1, ...x.hist.map(h => h.n));
      return `<div class="ms-tr-col">
        <div class="ms-tr-h">${mk === 'TSE' ? '上市' : '上櫃'}
          <small>中位數 <b class="${cls(x.median)}">${pct(x.median)}</b>
          站上 <b class="up">${x.above}</b>／跌破 <b class="down">${x.below}</b></small></div>
        ${x.hist.map(h => {
    const neg = String(h.label).startsWith('<') || String(h.label).startsWith('-');
    return `<div class="ms-hbar"><span class="ms-hbar-l">${h.label}</span>
          <div class="ms-hbar-t"><i class="${neg ? 'neg' : 'pos'}"
            style="width:${h.n / mx * 100}%"></i></div>
          <span class="ms-hbar-n">${h.n}</span></div>`;
  }).join('')}</div>`;
    }).join('');

    return `
      <div class="ms-grid ms-grid-1">${card('市場個股趨勢（同第一章）', trendHtml(d),
    '<small class="muted">站上週／月／季線家數與多頭排列</small>')}</div>
      <div class="ms-grid ms-grid-2">
        ${card('振幅分布', ampBars,
    `<b>中位數 ${num(a.median, 2)}%　平均 ${num(a.mean, 2)}%</b>`)}
        ${card('振幅排行前 20', `<table class="ms-tb ms-tb-wide"><thead><tr>
          <th>代號</th><th>名稱</th><th class="n">收盤</th><th class="n">漲跌</th>
          <th class="n">振幅</th><th class="n">成交值(億)</th></tr></thead>
          <tbody>${ampTop}</tbody></table>`)}
      </div>
      <div class="ms-grid ms-grid-1">
        ${card('高低檔及 MA 乖離程度', `<div class="ms-tr">${biasCols}</div>`,
    `<span class="ms-mks">${maBtns}</span>
     <small class="muted">期天用小時線；收盤系統改用日線乖離率 (收盤−MA)/MA</small>`)}
      </div>`;
  }

  // ══ 第二章：選擇權結構 ════════════════════════════════════
  function oiChartSvg(rows, spot) {
    const r = (rows || []).filter(x => isNum(x.k));
    if (!r.length) return '<div class="ms-spark-empty">無資料</div>';
    const W = 900, H = 420, padL = 58, padR = 8, padT = 10, padB = 22;
    const max = Math.max(1, ...r.map(x => Math.max(x.c_oi || 0, x.p_oi || 0)));
    const bh = (H - padT - padB) / r.length;
    const half = (W - padL - padR) / 2;
    const mid = padL + half;
    // 標籤最多 ~14 個，否則履約價會疊成一團黑塊
    const lblEvery = Math.max(1, Math.ceil(r.length / 14));
    const bars = r.map((x, i) => {
      const y = padT + i * bh;
      const cw = (x.c_oi || 0) / max * half, pw = (x.p_oi || 0) / max * half;
      const atSpot = spot && Math.abs(x.k - spot) < (r[1] ? Math.abs(r[1].k - r[0].k) : 100) / 2;
      return `<g>
        ${atSpot ? `<rect x="${padL}" y="${y}" width="${half * 2}" height="${bh}"
           fill="#ffffff" opacity="0.05"/>` : ''}
        <rect x="${mid - cw}" y="${y + 0.6}" width="${cw}" height="${Math.max(bh - 1.2, 0.6)}"
          fill="var(--up)" opacity="0.85"><title>Call ${x.k}：${int(x.c_oi)} 口</title></rect>
        <rect x="${mid}" y="${y + 0.6}" width="${pw}" height="${Math.max(bh - 1.2, 0.6)}"
          fill="var(--down)" opacity="0.85"><title>Put ${x.k}：${int(x.p_oi)} 口</title></rect>
        ${i % lblEvery === 0 ? `<text x="${padL - 5}" y="${y + bh / 2 + 3}" class="ms-hb-x"
          text-anchor="end">${int(x.k)}</text>` : ''}</g>`;
    }).join('');
    return `<svg class="ms-oi" viewBox="0 0 ${W} ${H}">
      <line x1="${mid}" y1="${padT}" x2="${mid}" y2="${H - padB}" stroke="#3a3a52"/>
      ${bars}
      <text x="${mid - half / 2}" y="${H - 6}" class="ms-hb-x" text-anchor="middle">◀ 買權 CALL</text>
      <text x="${mid + half / 2}" y="${H - 6}" class="ms-hb-x" text-anchor="middle">賣權 PUT ▶</text>
    </svg>`;
  }

  function pnlCurveSvg(pts, spot, peak) {
    const p = (pts || []).filter(x => isNum(x.x) && isNum(x.y));
    if (p.length < 2) return '<div class="ms-spark-empty">無資料</div>';
    const W = 460, H = 220, pad = 30;
    const xs = p.map(o => o.x), ys = p.map(o => o.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const y0 = Math.min(0, ...ys), y1 = Math.max(0, ...ys);
    const X = v => pad + (v - x0) / (x1 - x0 || 1) * (W - pad - 8);
    const Y = v => H - pad - (v - y0) / (y1 - y0 || 1) * (H - pad - 12);
    const d = p.map((o, i) => `${i ? 'L' : 'M'}${X(o.x).toFixed(1)},${Y(o.y).toFixed(1)}`).join('');
    const zero = Y(0);
    return `<svg class="ms-pnl" viewBox="0 0 ${W} ${H}">
      <line x1="${pad}" y1="${zero}" x2="${W - 8}" y2="${zero}" stroke="#4a4a63" stroke-dasharray="3 3"/>
      <path d="${d}L${X(x1)},${zero}L${X(x0)},${zero}Z" fill="var(--accent)" opacity="0.13"/>
      <path d="${d}" fill="none" stroke="var(--accent)" stroke-width="1.8"/>
      ${spot ? `<line x1="${X(spot)}" y1="10" x2="${X(spot)}" y2="${H - pad}"
        stroke="#f5b942" stroke-dasharray="4 3"/>
        <text x="${X(spot)}" y="8" class="ms-hb-x" text-anchor="middle">現價</text>` : ''}
      ${peak && isNum(peak.x) ? `<circle cx="${X(peak.x)}" cy="${Y(peak.y)}" r="3.5" fill="#f5b942"/>
        <text x="${X(peak.x)}" y="${Y(peak.y) + 15}" class="ms-hb-x" text-anchor="middle">
        最大獲利 ${int(peak.x)}</text>` : ''}
      <text x="4" y="${Y(y1) + 12}" class="ms-hb-x">${int(y1)}萬</text>
      <text x="4" y="${zero - 4}" class="ms-hb-x">0</text>
    </svg>`;
  }

  function renderOptions(c) {
    const o = c && c.options;
    if (!o || !o.available) {
      return `<div class="ms-empty">選擇權資料未產生。<br><span class="muted">
        ${esc((o && o.error) || '跑 Finmind\\_ingest_option.py 匯入 TEJ 選擇權，再跑 export_market_chips.py')}
        </span></div>`;
    }
    const a = o.atm || {};
    const p = c.pcr || {};
    const heat = o.heat || {};
    const heatRows = Object.values(heat).map(h => levelBar(
      h.label, h.pctile, `${int(h.value)}`,
      `近20日均 ${int(h.avg20)}　${isNum(h.ratio) ? (h.ratio * 100).toFixed(0) + '%' : ''}`)).join('');

    return `
      <div class="ms-grid ms-grid-4">
        ${card('價平和', `<div class="ms-big ${''}">${num(a.sum, 1)}</div>
          <div class="ms-sub">履約價 ${int(a.strike)}　Call ${num(a.call, 1)}／Put ${num(a.put, 1)}</div>`)}
        ${card('隱含波動率', `<div class="ms-big">${num(a.iv, 2)}%</div>
          <div class="ms-sub">Call ${num(a.iv_call, 2)}%／Put ${num(a.iv_put, 2)}%</div>`,
    '<small class="muted" title="' + esc(a.note || '') + '">自算 ⓘ</small>')}
        ${card('合成遠期價', `<div class="ms-big">${int(a.forward)}</div>
          <div class="ms-sub ${cls(a.forward - a.spot_index)}">對加權指數
            ${sign(num(a.forward - a.spot_index, 0))} 點（${a.forward < a.spot_index ? '逆價差' : '正價差'}）</div>`,
    '<small class="muted" title="由買賣權平價 F = K + (C−P)·e^(rT) 反推">ⓘ</small>')}
        ${card('Put/Call Ratio', `<div class="ms-big ${p.pcr > 1.3 || p.pcr < 0.7 ? 'warn' : ''}">${num(p.pcr, 3)}</div>
          <div class="ms-sub">60日均 ${num(p.avg60, 3)}　百分位 ${num(p.pctile, 0)}%</div>`)}
      </div>

      <div class="ms-grid ms-grid-heat">
        ${card('OI 口數分布（近月 ' + esc(o.front_month || '') + '）',
    oiChartSvg(o.oi_by_strike, o.spot),
    '<small class="muted">左紅＝買權未平倉、右綠＝賣權未平倉；白底列為現價所在履約價</small>',
    'ms-card-wide')}
        <div>
          ${card('主力損益曲線', pnlCurveSvg(o.pnl_curve, o.spot, o.pnl_peak),
    '<small class="muted">全市場未平倉當賣方組合的到期損益</small>')}
          ${card('買賣方熱度（贏窟自訂）', heatRows || '<span class="muted">歷史不足</span>',
    '<small class="muted" title="' + esc(o.heat_note || '') + '">ⓘ</small>')}
        </div>
      </div>`;
  }

  // ══ 第四章：市場參與者 ════════════════════════════════════
  function renderPlayers(c) {
    if (!c) return '<div class="ms-empty">籌碼資料未產生。</div>';
    const eq = c.equity_inst || {};
    const eqRows = ['TSE', 'OTC'].map(mk => {
      const x = (eq.markets || {})[mk];
      if (!x) return '';
      return `<tr><td>${mk === 'TSE' ? '上市' : '上櫃'}</td>
        <td class="n ${cls(x.foreign)}">${sign(num(x.foreign, 2))}</td>
        <td class="n ${cls(x.trust)}">${sign(num(x.trust, 2))}</td>
        <td class="n ${cls(x.dealer)}">${sign(num(x.dealer, 2))}</td>
        <td class="n ${cls(x.sum3)}"><b>${sign(num(x.sum3, 2))}</b></td></tr>`;
    }).join('');

    const dv = c.inst_deriv || {};
    const futRows = (dv.futures || []).map(f => `<tr><td>${esc(f.label)}</td>
      ${['外資', '投信', '自營商'].map(w => {
    const v = f.by[w];
    return `<td class="n ${v ? cls(v.net) : ''}">${v ? int(v.net) : '--'}
      ${v && isNum(v.chg) ? `<small class="${cls(v.chg)}">${signInt(v.chg)}</small>` : ''}</td>`;
  }).join('')}
      <td class="n ${cls(f.net)}"><b>${int(f.net)}</b></td></tr>`).join('');
    const optRows = (dv.options || []).map(f => `<tr><td>${esc(f.label)}</td>
      ${['外資', '投信', '自營商'].map(w => {
    const v = f.by[w];
    return `<td class="n ${v ? cls(v.net) : ''}">${v ? int(v.net) : '--'}
      ${v && isNum(v.chg) ? `<small class="${cls(v.chg)}">${signInt(v.chg)}</small>` : ''}</td>`;
  }).join('')}<td></td></tr>`).join('');

    const lt = c.large_traders || {};
    const ltCards = (lt.groups || []).map(g => card(`大額交易人 — ${esc(g.label)}`,
      `<div class="ms-nts">${g.rows.map(r => netTile(r.name, r.net, r.chg)).join('')}</div>
       <div class="ms-lvs">${g.rows.map(r => levelBar(
        r.name + ' 留倉水位', r.pctile, int(r.net),
        `近 ${r.n_hist} 日`)).join('')}</div>
       <div class="muted" style="margin-top:6px">全市場未沖銷 ${int(g.market_oi)} 口</div>`)).join('');

    const rt = c.retail || {};
    const rtCards = (rt.rows || []).map(r => card(`散戶多空 — ${esc(r.label)}`,
      `<div class="ms-big ${cls(r.ratio)}">${pct(r.ratio)}</div>
       <div class="ms-sub">散戶淨 <b class="${cls(r.retail_net)}">${signInt(r.retail_net)}</b> 口
         ${isNum(r.retail_chg) ? `（今日 ${signInt(r.retail_chg)}）` : ''}</div>
       ${levelBar('多空比水位', r.pctile, pct(r.ratio), `60日均 ${pct(r.avg60)}`)}
       <div class="muted">全市場未沖銷 ${int(r.market_oi)} 口</div>`)).join('');

    return `
      <div class="ms-grid ms-grid-2">
        ${card('三大法人買賣超（現貨）', `<table class="ms-tb ms-tb-wide">
          <thead><tr><th>市場</th><th class="n">外資</th><th class="n">投信</th>
          <th class="n">自營</th><th class="n">合計</th></tr></thead>
          <tbody>${eqRows}</tbody></table>
          <div class="muted" style="margin-top:6px">${esc(eq.note || '')}</div>`,
    '<small class="muted">單位：億元</small>')}
        ${card('三大法人期貨未平倉', `<table class="ms-tb ms-tb-wide">
          <thead><tr><th>契約</th><th class="n">外資</th><th class="n">投信</th>
          <th class="n">自營</th><th class="n">合計</th></tr></thead>
          <tbody>${futRows}${optRows}</tbody></table>
          <div class="muted" style="margin-top:6px">
            選擇權淨額＝(買權淨 − 賣權淨)，即多方曝險，與大額交易人同口徑</div>`,
    '<small class="muted">單位：口（淨未平倉）</small>')}
      </div>
      <div class="ms-grid ms-grid-2">${ltCards}</div>
      <div class="ms-grid ms-grid-2">${rtCards}</div>`;
  }

  // ══ 第五章：籌碼綜合儀表板 ════════════════════════════════
  function renderBoard(d, c) {
    if (!c) return '<div class="ms-empty">籌碼資料未產生。</div>';
    const eq = (c.equity_inst || {}).markets || {};
    const dv = c.inst_deriv || {};
    const lt = (c.large_traders || {}).groups || [];
    const rt = (c.retail || {}).rows || [];
    const p = c.pcr || {};
    const txf = (dv.futures || []).find(f => f.code === 'TX');
    const fo = txf && txf.by['外資'];

    const kpis = [
      ['三大法人上市買賣超', eq.TSE ? sign(num(eq.TSE.sum3, 2)) + ' 億' : '--',
        eq.TSE ? cls(eq.TSE.sum3) : ''],
      ['三大法人上櫃買賣超', eq.OTC ? sign(num(eq.OTC.sum3, 2)) + ' 億' : '--',
        eq.OTC ? cls(eq.OTC.sum3) : ''],
      ['外資期貨淨未平倉', fo ? int(fo.net) + ' 口' : '--', fo ? cls(fo.net) : ''],
      ['散戶小台多空比', rt[0] ? pct(rt[0].ratio) : '--', rt[0] ? cls(rt[0].ratio) : ''],
      ['散戶微台多空比', rt[1] ? pct(rt[1].ratio) : '--', rt[1] ? cls(rt[1].ratio) : ''],
      ['Put/Call Ratio', num(p.pcr, 3), p.pcr > 1.3 || p.pcr < 0.7 ? 'warn' : ''],
    ].map(([l, v, t]) => `<div class="ms-k"><span class="ms-k-l">${l}</span>
      <span class="ms-k-v ${t}">${v}</span></div>`).join('');

    // 籌碼強弱：把能算百分位的全部排成一排水位條
    const levels = [];
    lt.forEach(g => g.rows.forEach(r =>
      levels.push([`${g.label}・${r.name}`, r.pctile, int(r.net) + ' 口'])));
    rt.forEach(r => levels.push([`散戶・${r.label}`, r.pctile, pct(r.ratio)]));
    if (isNum(p.pctile)) levels.push(['選擇權・PCR', p.pctile, num(p.pcr, 3)]);
    const levelHtml = levels.map(([l, pc, v]) => levelBar(l, pc, v)).join('');

    return `
      <div class="ms-grid ms-grid-1">
        ${card('籌碼快照', `<div class="ms-kpis">${kpis}</div>`,
    `<small class="muted">${esc(c.trading_date)}</small>`)}
      </div>
      <div class="ms-grid ms-grid-1">
        ${card(`籌碼強弱分析（近 ${c.window} 日留倉水位百分位）`, levelHtml,
    '<small class="muted">0%＝窗格內最低、100%＝最高。純描述性，未經預測力檢定</small>')}
      </div>`;
  }

  // ══ 主渲染 ════════════════════════════════════════════════
  function render() {
    const el = document.getElementById('ms-body');
    if (!el) return;
    const d = state.data;
    if (!d) { el.innerHTML = '<div class="ms-empty">此日尚無市場結構資料。</div>'; return; }
    const c = state.chips;

    const nav = CHAPTERS.map(([k, lbl]) =>
      `<button class="ms-ch ${state.chapter === k ? 'active' : ''}" data-ch="${k}">${lbl}</button>`
    ).join('');

    let body;
    if (state.chapter === 'structure') body = renderStructure(d);
    else if (state.chapter === 'trend') body = renderTrend(d);
    else if (state.chapter === 'options') body = renderOptions(c);
    else if (state.chapter === 'players') body = renderPlayers(c);
    else body = renderBoard(d, c);

    el.innerHTML = `
      <div class="ms-note">📅 ${d.trading_date}　收盤資料
        <span class="muted">${esc(d.basis.price)}</span></div>
      <nav class="ms-chs">${nav}</nav>
      ${body}`;
    bind();
  }

  function bind() {
    const el = document.getElementById('ms-body');
    if (!el) return;
    el.querySelectorAll('.ms-ch').forEach(b => b.addEventListener('click', () => {
      state.chapter = b.dataset.ch; render();
      document.getElementById('ms-body').scrollIntoView({ block: 'start' });
    }));
    el.querySelectorAll('[data-bias]').forEach(b => b.addEventListener('click', () => {
      state.biasMa = b.dataset.bias; render();
    }));
    // 只綁有 data-mk 的：第三章的 MA20/MA60 切換也用 .ms-mk 外觀，但走 data-bias
    el.querySelectorAll('.ms-mk[data-mk]').forEach(b => b.addEventListener('click', () => {
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
    // 籌碼那包（第二/四/五章）缺了不該擋住第一/三章 → 各自 catch
    state.chips = await fetchJsonGz(dailyPath('market_chips')).catch(() => null);
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
