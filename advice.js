/* ============================================================
   進出場建議面板 — 點個股彈窗的「📍 進出場」子分頁 + K 線上方摘要條
   - 純前端：資料全部來自「主篩選表那一列」(state.data.rows 已帶的訊號欄)
     + K 線 payload 的 hanku.state / markers / dist_markers。
     不需要任何 Python / 重跑匯出。
   - 收錄四種現成方法：
       ① 朱家泓主升：回後買上漲 / 盤整突破（mainup_strategy.compute_mainup）
       ② Anchor 反應K買點 + 停損 + R:R（anchor_bar.pick_anchor_bar）
       ③ HANKU 波段：金叉進場 / 死叉出場 / 守9週停損（hanku_overlay）
       ④ 出場線 + 出貨警訊 + 飆股停利（B3 出場引擎 / §5 出貨）
   - 由 app.js 在開窗載完 K 線後呼叫 onKline(ticker,name,klineData,row)。
   ============================================================ */
(function () {
  'use strict';

  const ctx = { ticker: '', name: '', data: null, row: null };

  // ── 小工具 ──────────────────────────────────────────
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const truthy = (v) => v === 1 || v === true || v === '1' || v === 'True' || v === 'true';
  function num(v) { const n = parseFloat(v); return isFinite(n) ? n : null; }
  function fnum(v, d = 2) { const n = num(v); return n == null ? null : n.toFixed(d); }
  const has = (s) => s != null && String(s).trim() !== '' && String(s).trim() !== '—';
  const G = (k) => (ctx.row ? ctx.row[k] : undefined);

  // ── 進場價位推算：回後買上漲 / 盤整突破（純前端，從 K 線 OHLC 算）──
  // 回傳 { kind, entry, trigger, triggerLabel, stop, stopLabel, stopPct, target, targetLabel, rr, ma5 } 或 null
  // 規則對齊 zhuEntry 的 desc：回後買上漲＝多頭回檔觸5日線後中長紅K收盤突破昨高；盤整突破＝窄幅盤整後突破上緣。
  function mainupLevels(dArg, rowArg) {
    const d = dArg || ctx.data;
    const row = rowArg || ctx.row;
    const e = row ? row.mainup_entry : (ctx.row ? G('mainup_entry') : null);
    if (e !== '回後買上漲' && e !== '盤整突破') return null;
    if (!d || !d.c || !d.h || !d.l) return null;
    const c = d.c, h = d.h, l = d.l, L = c.length;
    if (L < 25) return null;
    const last = L - 1;
    const entry = num(c[last]);
    if (entry == null) return null;
    const sma = (arr, n, end) => {            // 含 end 往回 n 根的簡單均線
      let s = 0, k = 0;
      for (let i = end; i > end - n && i >= 0; i--) { const v = num(arr[i]); if (v != null) { s += v; k++; } }
      return k ? s / k : null;
    };
    const ma5 = sma(c, 5, last);
    let trigger = null, triggerLabel = '', stop = null, stopLabel = '', target = null, targetLabel = '';
    if (e === '回後買上漲') {
      trigger = num(h[last - 1]); triggerLabel = '突破昨高';
      // 回檔低：近 4 根最低（觸5日線的短回檔，避免回看太遠抓到起漲前基期）；不應低於5日線太多
      let lo = Infinity, loIdx = last;
      for (let i = last; i > last - 4 && i >= 0; i--) { const v = num(l[i]); if (v != null && v < lo) { lo = v; loIdx = i; } }
      stop = isFinite(lo) ? lo : null; stopLabel = '回檔低';
      // 若回檔低距進場 >12%（多為大紅K當日，回檔低其實偏遠），改守5日線 = 更貼朱家泓「守5日線」
      if (stop != null && ma5 != null && (entry - stop) / entry > 0.12 && ma5 < entry) { stop = ma5; stopLabel = '守5日線'; }
      let hi = -Infinity;                                     // 前波高：回檔低之前 30 根最高
      for (let i = loIdx - 1; i > loIdx - 30 && i >= 0; i--) { const v = num(h[i]); if (v != null && v > hi) hi = v; }
      if (isFinite(hi) && hi > entry) { target = hi; targetLabel = '前波高'; }
      else if (stop != null) { target = entry + (entry - stop) * 2; targetLabel = '測幅2R'; }
    } else {                                                  // 盤整突破
      let up = -Infinity, dn = Infinity;                      // 盤整上/下緣：近 20 根(不含今日)
      for (let i = last - 1; i > last - 21 && i >= 0; i--) {
        const hv = num(h[i]), lv = num(l[i]);
        if (hv != null && hv > up) up = hv;
        if (lv != null && lv < dn) dn = lv;
      }
      trigger = isFinite(up) ? up : null; triggerLabel = '盤整上緣';
      stop = isFinite(dn) ? dn : null; stopLabel = '盤整下緣';
      if (trigger != null && stop != null) { target = trigger + (trigger - stop); targetLabel = '箱型測幅'; }
    }
    const stopPct = (stop != null && entry) ? (entry - stop) / entry * 100 : null;
    const rr = (target != null && stop != null && (entry - stop) > 0) ? (target - entry) / (entry - stop) : null;
    return { kind: e, entry, trigger, triggerLabel, stop, stopLabel, stopPct, target, targetLabel, rr, ma5 };
  }

  // 把推算價位排成一行 HTML（綠卡/摘要共用）
  function mainupPriceBits(lv) {
    if (!lv) return '';
    const b = [];
    if (lv.entry != null) b.push(`進場(收盤) <b style="color:#26a69a">${fnum(lv.entry)}</b>`);
    if (lv.trigger != null) b.push(`${lv.triggerLabel} <b>${fnum(lv.trigger)}</b>`);
    if (lv.ma5 != null && lv.kind === '回後買上漲') b.push(`回測5日線 <b>${fnum(lv.ma5)}</b>`);
    if (lv.stop != null) b.push(`停損(${lv.stopLabel}) <b style="color:#ff5252">${fnum(lv.stop)}</b>${lv.stopPct != null ? `（−${lv.stopPct.toFixed(1)}%）` : ''}`);
    if (lv.target != null) b.push(`目標(${lv.targetLabel}) <b style="color:#ffd54f">${fnum(lv.target)}</b>`);
    if (lv.rr != null) { const r = lv.rr; b.push(`R:R <b style="color:${r >= 2 ? '#22c55e' : r >= 1 ? '#f5b942' : '#888'}">${r.toFixed(2)}</b>`); }
    return b.length ? `<div class="adv-px" style="margin-top:5px;line-height:1.7">${b.join('　｜　')}</div>` : '';
  }

  // ── 進場：朱家泓主升型態 ─────────────────────────────
  // 回傳 { icon, cls, head, desc, sub } 或 null
  function zhuEntry() {
    const e = G('mainup_entry');
    const tag = G('mainup_tag');
    // 訊號明細：飆股5訊號 + 高勝率3條件
    const S = [['s1', 'S1長底'], ['s2', 'S2爆量'], ['s3', 'S3多排'], ['s4', 'S4突破'], ['s5', 'S5題材']];
    const C = [['c1', 'C1多頭'], ['c2', 'C2黃金交叉'], ['c3', 'C3進場點']];
    const sLit = S.filter(([k]) => truthy(G(k))).map(([, n]) => n);
    const cLit = C.filter(([k]) => truthy(G(k))).map(([, n]) => n);
    const n5 = num(G('mainup_n')), n3 = num(G('win_n'));
    const subBits = [];
    if (has(tag)) subBits.push(`<b style="color:#ffd54f">${esc(tag)}</b>`);
    if (n5 != null) subBits.push(`飆股5訊號 ${n5}/5${sLit.length ? '（' + sLit.join('、') + '）' : ''}`);
    if (n3 != null) subBits.push(`高勝率 ${n3}/3${cLit.length ? '（' + cLit.join('、') + '）' : ''}`);
    if (truthy(G('weekly_lit'))) subBits.push('週線亮燈');
    const sub = subBits.join('　·　');

    if (e === '回後買上漲')
      return { icon: '🟢', cls: 'go', head: '回後買上漲（朱家泓第二波起漲）',
        desc: '多頭中回檔觸及/跌破5日線後，中長紅K收盤突破昨日高 = 第二波起漲點。' + mainupPriceBits(mainupLevels()), sub };
    if (e === '盤整突破')
      return { icon: '🟢', cls: 'go', head: '盤整突破',
        desc: '近20日窄幅盤整後，中長紅K收盤突破盤整上緣。' + mainupPriceBits(mainupLevels()), sub };
    if (e === '⚠過高勿追')
      return { icon: '🟠', cls: 'warn', head: '⚠ 過高勿追',
        desc: '距底部已漲多又創120日新高，非好進場點 — 等回檔出現「回後買上漲」再進。', sub };
    return { icon: '⚪', cls: 'off', head: '今日無「回後買上漲 / 盤整突破」訊號',
      desc: '朱家泓只在兩個起漲位置進場：回後買上漲、盤整突破；其餘觀望。', sub };
  }

  // ── 進場：Anchor 反應K買點 ──────────────────────────
  function anchorEntry() {
    let type = G('reaction_bar_type'), date = G('reaction_bar_date');
    let buy = G('buy_point'), stop = G('stop_loss'), stopPct = G('stop_loss_pct'), rr = G('rr_ratio');
    // row 缺值時退用 K 線 payload 的 anchor marker
    if (!has(type) && ctx.data && ctx.data.markers && ctx.data.markers.length) {
      const m = ctx.data.markers[0];
      type = m.type; date = m.date;
      if (!has(buy) && m.entry_low != null)
        buy = m.entry_high != null && m.entry_high !== m.entry_low
          ? `${fnum(m.entry_low)}~${fnum(m.entry_high)}` : fnum(m.entry_low);
      if (stop == null) stop = m.stop;
    }
    if (!has(type)) return { icon: '⚪', cls: 'off', head: '近10日無反應K買點', desc: '量增止穩K / Pocket Pivot / Inside Bar 突破皆未出現。', sub: '' };
    const bits = [];
    if (has(buy)) bits.push(`買點 <b>${esc(buy)}</b>`);
    if (fnum(stop) != null) bits.push(`停損 <b style="color:#ff5252">${fnum(stop)}</b>${fnum(stopPct, 1) != null ? `（−${fnum(stopPct, 1)}%）` : ''}`);
    if (fnum(rr) != null) { const r = num(rr); bits.push(`R:R <b style="color:${r >= 2 ? '#22c55e' : r >= 1 ? '#f5b942' : '#888'}">${fnum(rr)}</b>`); }
    const tgt = fnum(G('target')), pos = fnum(G('position_pct'), 1);
    const sub2 = [];
    if (tgt != null) sub2.push(`目標價 ${tgt}`);
    if (pos != null) sub2.push(`部位建議 ${pos}%`);
    return { icon: '🔵', cls: 'go', head: `${esc(type)}${has(date) ? `（${esc(date)}）` : ''}`,
      desc: bits.join('　｜　'), sub: sub2.join('　·　') };
  }

  // ── 進/出場：HANKU 波段狀態 ─────────────────────────
  function hankuState() {
    const st = ctx.data && ctx.data.hanku ? ctx.data.hanku.state : null;
    if (!st || !st.狀態) return null;
    return st;
  }

  // ── 出場：守均線（朱家泓主升 B3 出場引擎）──────────
  function maExit() {
    const w = G('exit_warn');
    if (has(w)) {
      const cls = /跌破MA60/.test(w) ? 'stop' : /跌破MA20/.test(w) ? 'warn' : 'go';
      return { icon: cls === 'stop' ? '🔴' : cls === 'warn' ? '🟠' : '🟢', cls, head: esc(w),
        desc: '主升段守均線：跌破MA20＝早期警示、跌破MA60＝現股出場（回測：守MA20/MA60 期望值最高）。' };
    }
    return { icon: '⚪', cls: 'off', head: '尚無均線出場訊號', desc: '守MA20（早期警示）/ MA60（現股出場）。', sub: '' };
  }

  // ── 出場：出貨警訊（§5 高檔爆量收弱）────────────────
  function distWarn() {
    const on = truthy(G('mainup_dist'));
    const sig = G('dist_signal'), risk = num(G('dist_risk'));
    const dm = ctx.data && ctx.data.dist_markers ? ctx.data.dist_markers.length : 0;
    if (on || dm > 0 || (risk != null && risk > 0)) {
      const bits = [];
      if (has(sig)) bits.push(esc(sig));
      if (risk != null && risk > 0) bits.push(`出貨風險 ${risk}`);
      if (dm > 0) bits.push(`圖上 ${dm} 根出貨K`);
      return { icon: '🔴', cls: 'stop', head: '高檔爆量收弱 — 出貨警訊',
        desc: bits.join('　·　') || '距底>40% + 近5日爆量(≥5×)且收盤在K棒下半。' };
    }
    return { icon: '🟢', cls: 'go', head: '無出貨警訊', desc: '近期無高檔爆量收弱的出貨型態。', sub: '' };
  }

  // ── 渲染：一行摘要（K 線分頁上方）────────────────────
  function entrySummaryText() {
    const e = G('mainup_entry');
    if (e === '回後買上漲' || e === '盤整突破') {
      const lv = mainupLevels();
      let t = e;
      if (lv && lv.entry != null) t += ` 進${fnum(lv.entry)}` + (lv.stop != null ? `/損${fnum(lv.stop)}` : '');
      return { t, cls: 'go' };
    }
    if (e === '⚠過高勿追') return { t: '⚠過高勿追', cls: 'warn' };
    if (has(G('reaction_bar_type'))) {
      const buy = G('buy_point');
      return { t: `${G('reaction_bar_type')}${has(buy) ? ' ' + buy : ''}`, cls: 'go' };
    }
    const st = hankuState();
    if (st && /持有|抱/.test(st.狀態 || '')) return { t: `波段${st.狀態}`, cls: 'go' };
    if (st && st.狀態) return { t: `波段${st.狀態}`, cls: 'off' };
    return { t: '無明確進場訊號', cls: 'off' };
  }
  function exitSummaryText() {
    const bits = [];
    let cls = 'off';
    const w = G('exit_warn');
    if (has(w)) { bits.push(w); cls = /跌破MA60/.test(w) ? 'stop' : /跌破MA20/.test(w) ? 'warn' : 'go'; }
    if (truthy(G('mainup_dist'))) { bits.unshift('⚠出貨警訊'); cls = 'stop'; }
    const st = hankuState();
    if (!bits.length && st && st.週9停損 != null) bits.push(`守9週停損≈${st.週9停損}`);
    return { t: bits.length ? bits.join('｜') : '—', cls };
  }

  function renderBar() {
    const el = document.getElementById('kline-advice-bar');
    if (!el) return;
    if (!ctx.row && !(ctx.data && ctx.data.hanku)) { el.innerHTML = ''; el.style.display = 'none'; return; }
    el.style.display = '';
    const en = entrySummaryText(), ex = exitSummaryText();
    el.innerHTML =
      `<span class="adv-bar-seg"><span class="adv-bar-lbl">📍 進場</span>` +
      `<b class="adv-${en.cls}">${esc(en.t)}</b></span>` +
      `<span class="adv-bar-div">｜</span>` +
      `<span class="adv-bar-seg"><span class="adv-bar-lbl">🚪 出場</span>` +
      `<b class="adv-${ex.cls}">${esc(ex.t)}</b></span>` +
      `<span class="adv-bar-hint">詳見「📍 進出場」分頁</span>`;
  }

  // ── 渲染：完整兩張卡（📍 進出場 子分頁）──────────────
  function row1(o) {
    if (!o) return '';
    return `<div class="adv-row adv-${o.cls}">
      <span class="adv-ic">${o.icon || ''}</span>
      <div class="adv-main">
        <div class="adv-head">${o.head || ''}</div>
        ${o.desc ? `<div class="adv-desc">${o.desc}</div>` : ''}
        ${o.sub ? `<div class="adv-sub">${o.sub}</div>` : ''}
      </div>
    </div>`;
  }

  function hankuEntryRow() {
    const st = hankuState();
    if (!st) return row1({ icon: '⚪', cls: 'off', head: '無 HANKU 波段資料', desc: '週4/9 金叉發散進場、死叉出場。', sub: '' });
    const bits = [`狀態 <b>${esc(st.狀態)}</b>`];
    if (st.進場日) {
      const rc = (st.報酬 != null && st.報酬 >= 0) ? '#ff5252' : '#26a69a';
      bits.push(`進 ${esc(st.進場日)} @${esc(st.進場價)}` +
        (st.報酬 != null ? `（報酬 <b style="color:${rc}">${st.報酬 > 0 ? '+' : ''}${st.報酬}%</b>）` : ''));
    }
    return row1({ icon: /持有|抱|進/.test(st.狀態 || '') ? '🟢' : '⚪',
      cls: /持有|抱|進/.test(st.狀態 || '') ? 'go' : 'off',
      head: 'HANKU 波段（週4/9 金叉發散）', desc: bits.join('　｜　'), sub: '' });
  }

  function hankuExitRow() {
    const st = hankuState();
    const exits = ctx.data && ctx.data.hanku ? (ctx.data.hanku.exits || []) : [];
    const bits = [];
    if (st && st.週9停損 != null) bits.push(`守9週停損 <b style="color:#f5b942">≈${st.週9停損}</b>`);
    if (exits.length) bits.push(`最近死叉出場 ${esc(exits[exits.length - 1].date)}`);
    if (!bits.length) return row1({ icon: '⚪', cls: 'off', head: 'HANKU：無波段出場訊號', desc: '週4 死叉週9＝出場；持有中守9週低。', sub: '' });
    return row1({ icon: '🟠', cls: 'warn', head: 'HANKU 波段出場 / 停損', desc: bits.join('　｜　'), sub: '' });
  }

  function piaoguExitRow() {
    return row1({ icon: '📘', cls: 'note', head: '飆股停利守則（朱家泓 EP07）',
      desc: '獲利 >20% 後出現「爆量黑K」→ 停利；否則續抱、守MA20/MA60。',
      sub: '回測：飆股停利勝守5均，但長線「守MA20/MA60」期望值最高 — 別太早下車。' });
  }

  function renderFull() {
    const el = document.getElementById('kc-advice');
    if (!el) return;
    const noRow = !ctx.row;
    const head = `<div class="adv-title">${esc(ctx.ticker)}　${esc(ctx.name || '')}　<span class="adv-mut">進出場建議</span></div>` +
      (noRow ? `<div class="adv-note-warn">此標的不在今日篩選結果中 — 僅顯示圖上 HANKU / 反應K 疊加，朱家泓主升訊號從缺。</div>` : '');

    const entryCard = `<div class="adv-card">
      <div class="adv-card-t">📍 進場建議</div>
      ${row1(zhuEntry())}
      ${row1(anchorEntry())}
      ${hankuEntryRow()}
    </div>`;

    const exitCard = `<div class="adv-card">
      <div class="adv-card-t">🚪 出場 / 停利停損</div>
      ${row1(maExit())}
      ${row1(distWarn())}
      ${hankuExitRow()}
      ${piaoguExitRow()}
    </div>`;

    el.innerHTML = `<div class="adv-wrap">${head}${entryCard}${exitCard}
      <div class="adv-foot">訊號為策略輔助、非投資建議；數值與主篩選表同源（朱家泓飆股5訊號 / Anchor反應K / HANKU波段 / B3出場引擎）。</div>
    </div>`;
  }

  // ── 入口：app.js 開窗載完 K 線後呼叫 ─────────────────
  function onKline(ticker, name, klineData, row) {
    ctx.ticker = ticker; ctx.name = name; ctx.data = klineData; ctx.row = row || null;
    // 若「📍進出場」分頁正開著，順手重渲染
    const advBtn = document.querySelector('.kl-subtab-btn[data-kltab="advice"]');
    if (advBtn && advBtn.classList.contains('active')) renderFull();
  }

  window.AdvicePanel = { onKline, renderBar, renderFull, mainupLevels };
})();
