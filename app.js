// ─────────────────────────────────────────────────────────
//  右側突破篩選器 — 雲端 MVP 前端
//  讀 web/data/latest.json → 渲染表格 + 多條件篩選
// ─────────────────────────────────────────────────────────

const PRESET_STORAGE_KEY = 'screener_presets_v1';

// ── 日期 & gzip JSON 載入 ────────────────────────────
// currentDate: 'YYYYMMDD'。null 時等同 index.json.latest_date
let currentDate = null;
let availableDates = [];     // 由 index.json 帶入
let indexMeta = null;

async function fetchJsonGz(path) {
  const res = await fetch(`${path}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`fetch ${path} 失敗 (${res.status})`);
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('瀏覽器不支援 DecompressionStream，請升級到 Chrome/Edge/Safari 最新版');
  }
  const ds = new DecompressionStream('gzip');
  const stream = res.body.pipeThrough(ds);
  const text = await new Response(stream).text();
  return JSON.parse(text);
}

async function loadIndex() {
  const res = await fetch(`data/index.json?t=${Date.now()}`);
  if (!res.ok) throw new Error(`無法載入 index.json (${res.status})`);
  indexMeta = await res.json();
  // 日期下拉只列「有 latest 資料」的日期（只有 market 的日期不算可切）
  availableDates = (indexMeta.dates || [])
    .filter(e => (e.has || []).includes('latest'))
    .map(e => e.date);
  if (!currentDate) currentDate = indexMeta.latest_date;
  return indexMeta;
}

function dailyPath(name) {
  if (!currentDate) throw new Error('currentDate 尚未設定');
  return `data/daily/${currentDate}/${name}.json.gz`;
}

function fmtDate8(s) {
  // 20260521 → 2026-05-21
  return s.length === 8 ? `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6)}` : s;
}

function renderDatePicker() {
  const sel = document.getElementById('date-picker');
  if (!sel) return;
  sel.innerHTML = '';
  availableDates.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d;
    opt.textContent = `📅 ${fmtDate8(d)}${d === indexMeta.latest_date ? ' (最新)' : ''}`;
    if (d === currentDate) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.addEventListener('change', onDateChange);
}

async function onDateChange(ev) {
  const newDate = ev.target.value;
  if (newDate === currentDate) return;
  currentDate = newDate;

  // 重設所有分頁的 loaded，下次切到時會重新 fetch
  rankState.loaded = flowState.loaded = themeState.loaded = false;
  rankState.data = flowState.data = themeState.data = null;
  rankState.selectedIndustry = null;
  flowState.selectedIndustry = flowState.selectedSub = null;
  themeState.selectedItem = null;

  // 重新載入主表（dashboard）
  try {
    const data = await loadData();
    state.data = data;
    data._catColor = {};
    data.categories.forEach(c => { data._catColor[c.code] = c.color; });
    renderMeta(data);
    renderCategoryChips(data.categories);
    renderDimensionOptions();
    buildTable(data);
    applyFilters();
  } catch (err) {
    console.error(err);
    alert(`載入 ${newDate} 失敗：${err.message}`);
  }

  // 當前分頁若是其他 tab，馬上重 fetch
  const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab;
  if (activeTab === 'industry-ranking') loadIndustryRanking();
  else if (activeTab === 'flow') loadIndustryFlow();
  else if (activeTab === 'concept') loadThemeFlow();
}

// 市場別 -> TradingView 交易所代碼
const TV_EXCHANGE = {
  TSE: 'TWSE',     // 上市
  OTC: 'TPEX',     // 上櫃
  REG: 'TPEX',     // 興櫃（TradingView 大多無，先導 TPEX）
  TIB: 'TPEX',
  PSB: 'TWSE',
};

function tvUrl(ticker, market) {
  const ex = TV_EXCHANGE[market] || 'TWSE';
  return `https://tw.tradingview.com/chart/?symbol=${ex}%3A${ticker}`;
}

const state = {
  data: null,           // 完整 JSON payload
  selectedCats: new Set(),
  mode: 'OR',
  dim: 'industry',                  // 'industry' | 'sector' | 'concept'
  dimSelected: new Set(),           // 該維度下勾選的項目名
  dimSearch: '',                    // 搜尋選項用
  search: '',
  scoreMin: 0,
  rsMin: 0,
  distRiskMax: null,
  groupZMin: null,
  table: null,
};

// 維度名 -> row 上對應的欄位
const DIM_FIELD = {
  industry: 'd_industry',
  sector:   'd_sector',
  concept:  'd_concept',
};

// 大盤狀態分頁
const marketState = { loaded: false };

// 題材資金流向分頁狀態
const themeState = {
  data: null,
  subtab: 'concept',          // 'concept' | 'sector'
  selectedItem: null,
  listTable: null,
  stocksTable: null,
  historyTable: null,
  loaded: false,
};

// 資金流向分頁狀態
const flowState = {
  data: null,
  selectedIndustry: null,     // 選中的大產業
  selectedSub: null,          // 選中的細產業（優先用這個顯示 stocks/history）
  indTable: null,
  subTable: null,
  stocksTable: null,
  historyTable: null,
  loaded: false,
};

// 產業排行分頁狀態
const rankState = {
  data: null,
  days: '20',
  selectedIndustry: null,
  selectedSub: null,         // 細產業選擇 → 個股/歷史以此為優先
  indTable: null,
  subTable: null,
  stocksTable: null,
  historyTable: null,
  loaded: false,
};

// ── 1. 載入 JSON ────────────────────────────────────
async function loadData() {
  return await fetchJsonGz(dailyPath('latest'));
}

// ── 2. 初始化 Header / Meta ─────────────────────────
function renderMeta(d) {
  document.getElementById('trading-date').textContent = `📅 ${d.trading_date}`;
  document.getElementById('generated-at').textContent = `更新於 ${d.generated_at.slice(11, 16)}`;
  document.getElementById('schema-version').textContent = d.schema_version;

  const r = d.regime || {};
  const badge = document.getElementById('regime-badge');
  badge.textContent = `市況: ${r.label || '--'}`;
  badge.className = `badge regime-${r.color || 'unknown'}`;
}

// ── 3. 渲染分類 chips ───────────────────────────────
function renderCategoryChips(cats) {
  const container = document.getElementById('cat-checkboxes');
  container.innerHTML = '';
  cats.forEach(c => {
    if (c.count === 0) return; // 無命中就不顯示
    const chip = document.createElement('label');
    chip.className = 'cat-chip';
    chip.style.color = c.color;
    chip.dataset.code = c.code;
    chip.innerHTML = `
      <input type="checkbox" value="${c.code}" />
      <span class="dot" style="background:${c.color}"></span>
      <span class="label">${c.label}</span>
      <span class="count">${c.count}</span>
    `;
    const cb = chip.querySelector('input');
    cb.addEventListener('change', () => {
      chip.classList.toggle('checked', cb.checked);
      if (cb.checked) state.selectedCats.add(c.code);
      else state.selectedCats.delete(c.code);
      applyFilters();
    });
    container.appendChild(chip);
  });
}

// ── 4. 渲染維度選項（三維度切換 + 搜尋） ─────────────
function renderDimensionOptions() {
  const dims = state.data.dimensions || {};
  const d = dims[state.dim];
  const sel = document.getElementById('dim-select');
  const src = document.getElementById('dim-source');
  sel.innerHTML = '';

  if (!d || !d.options) {
    src.textContent = '(無此維度資料)';
    return;
  }

  const q = state.dimSearch.toLowerCase();
  const opts = d.options.filter(o => !q || o.name.toLowerCase().includes(q));
  opts.forEach(o => {
    const el = document.createElement('option');
    el.value = o.name;
    el.textContent = `${o.name} (${o.count})`;
    el.selected = state.dimSelected.has(o.name);
    sel.appendChild(el);
  });
  const total = d.options.length;
  const shown = opts.length;
  src.textContent = `來源: ${d.source || '—'}｜${shown}/${total} 項`;
}

// ── 5. 建表（Tabulator） ────────────────────────────
function buildTable(data) {
  const cols = data.column_meta.map(c => {
    const def = {
      title: c.label,
      field: c.id,
      headerFilter: false,
      headerTooltip: c.label,
    };
    if (c.frozen) def.frozen = true;
    if (c.width) def.width = c.width;
    if (c.type === 'number') {
      def.hozAlign = 'right';
      def.sorter = 'number';
      def.formatter = (cell) => {
        const v = cell.getValue();
        if (v == null) return '';
        const p = c.precision != null ? c.precision : 2;
        const txt = Number(v).toFixed(p);
        // 漲跌幅/距高百分比類欄位上色
        if (['dist_high', 'dist_year_high', 'risk_pct', 'stop_loss_pct'].includes(c.id)) {
          const cls = v > 0 ? 'num-pos' : (v < 0 ? 'num-neg' : '');
          return `<span class="${cls}">${txt}</span>`;
        }
        return txt;
      };
    }
    // ticker 欄位轉成 TradingView 連結（依市場別決定 exchange）
    if (c.id === 'ticker') {
      def.formatter = (cell) => {
        const row = cell.getRow().getData();
        const t = cell.getValue();
        return `<a class="ticker-link" href="${tvUrl(t, row.market)}" target="_blank">${t}</a>`;
      };
    }
    // 命中策略欄：渲染分類色塊
    if (c.id === 'hit_strategy') {
      def.formatter = (cell) => {
        const row = cell.getRow().getData();
        const cats = row.categories || [];
        const cmap = state.data._catColor || {};
        return cats.map(code =>
          `<span class="cat-tag" style="background:${cmap[code] || '#888'}">${code}</span>`
        ).join('');
      };
    }
    return def;
  });

  state.table = new Tabulator('#main-table', {
    data: data.rows,
    columns: cols,
    layout: 'fitDataStretch',
    height: 'calc(100vh - 280px)',
    pagination: true,
    paginationSize: 50,
    paginationSizeSelector: [25, 50, 100, 200],
    initialSort: [{ column: 'score', dir: 'desc' }],
    placeholder: '🔍 沒有符合條件的個股',
  });
}

// ── 6. 篩選邏輯 ─────────────────────────────────────
function applyFilters() {
  if (!state.table) return;

  state.table.setFilter((row) => {
    // 分類（AND/OR）
    if (state.selectedCats.size > 0) {
      const rowCats = new Set(row.categories || []);
      if (state.mode === 'AND') {
        for (const c of state.selectedCats) if (!rowCats.has(c)) return false;
      } else {
        let any = false;
        for (const c of state.selectedCats) if (rowCats.has(c)) { any = true; break; }
        if (!any) return false;
      }
    }

    // 代號/名稱搜尋（搜尋啟用時，其他閾值仍套用，但分數=0/RS=0 預設不卡）
    if (state.search) {
      const q = state.search.toLowerCase();
      const t = (row.ticker || '').toLowerCase();
      const n = (row.name || '').toLowerCase();
      if (!t.includes(q) && !n.includes(q)) return false;
    }

    // 三維度（依當前 dim 切換來源欄位；維度內走 OR）
    if (state.dimSelected.size > 0) {
      const field = DIM_FIELD[state.dim];
      const vals = row[field] || [];
      let any = false;
      for (const v of vals) {
        if (state.dimSelected.has(v)) { any = true; break; }
      }
      if (!any) return false;
    }

    // 數值閾值
    if (state.scoreMin > 0 && (row.score ?? -Infinity) < state.scoreMin) return false;
    if (state.rsMin > 0 && (row.rs ?? -Infinity) < state.rsMin) return false;
    if (state.distRiskMax != null && (row.dist_risk ?? Infinity) > state.distRiskMax) return false;
    if (state.groupZMin != null && (row.max_group_z ?? -Infinity) < state.groupZMin) return false;

    return true;
  });

  // 更新計數摘要
  setTimeout(() => {
    const visible = state.table.getDataCount('active');
    const total = state.table.getDataCount();
    document.getElementById('row-count').textContent = `${visible}/${total} 檔`;
    document.getElementById('filter-summary').textContent =
      `${state.mode}｜分類 ${state.selectedCats.size}｜產業 ${state.industries.size}`;
  }, 0);
}

// ── 7. 綁定篩選控制項 ───────────────────────────────
function bindControls() {
  document.querySelectorAll('input[name="mode"]').forEach(r => {
    r.addEventListener('change', e => { state.mode = e.target.value; applyFilters(); });
  });

  document.getElementById('search-input').addEventListener('input', e => {
    state.search = e.target.value.trim(); applyFilters();
  });

  document.querySelectorAll('input[name="dim"]').forEach(r => {
    r.addEventListener('change', e => {
      state.dim = e.target.value;
      state.dimSelected.clear();           // 切換維度後清空已選
      state.dimSearch = '';
      document.getElementById('dim-search').value = '';
      renderDimensionOptions();
      applyFilters();
    });
  });

  document.getElementById('dim-search').addEventListener('input', e => {
    state.dimSearch = e.target.value.trim();
    renderDimensionOptions();
  });

  document.getElementById('dim-select').addEventListener('change', e => {
    state.dimSelected = new Set(Array.from(e.target.selectedOptions).map(o => o.value));
    applyFilters();
  });

  const numBindings = [
    ['score-min',     v => state.scoreMin = parseFloat(v) || 0],
    ['rs-min',        v => state.rsMin = parseFloat(v) || 0],
    ['dist-risk-max', v => state.distRiskMax = (v === '' ? null : parseFloat(v))],
    ['group-z-min',   v => state.groupZMin = (v === '' ? null : parseFloat(v))],
  ];
  numBindings.forEach(([id, setter]) => {
    document.getElementById(id).addEventListener('input', e => {
      setter(e.target.value); applyFilters();
    });
  });

  document.getElementById('btn-clear').addEventListener('click', clearAllFilters);
  document.getElementById('btn-save-preset').addEventListener('click', saveCurrentPreset);
  document.getElementById('preset-select').addEventListener('change', loadPreset);
  document.getElementById('btn-delete-preset').addEventListener('click', deleteCurrentPreset);
}

function clearAllFilters() {
  state.selectedCats.clear();
  state.mode = 'OR';
  state.dim = 'industry';
  state.dimSelected.clear();
  state.dimSearch = '';
  state.search = '';
  state.scoreMin = 0;
  state.rsMin = 0;
  state.distRiskMax = null;
  state.groupZMin = null;

  document.querySelectorAll('.cat-chip input').forEach(cb => { cb.checked = false; cb.parentElement.classList.remove('checked'); });
  document.querySelector('input[name="mode"][value="OR"]').checked = true;
  document.querySelector('input[name="dim"][value="industry"]').checked = true;
  document.getElementById('dim-search').value = '';
  renderDimensionOptions();
  document.getElementById('search-input').value = '';
  document.getElementById('score-min').value = 0;
  document.getElementById('rs-min').value = 0;
  document.getElementById('dist-risk-max').value = '';
  document.getElementById('group-z-min').value = '';
  document.getElementById('preset-select').value = '';
  applyFilters();
}

// ── 8. 篩選組合（localStorage） ─────────────────────
function getPresets() {
  try { return JSON.parse(localStorage.getItem(PRESET_STORAGE_KEY)) || {}; }
  catch { return {}; }
}
function setPresets(p) {
  localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(p));
  refreshPresetSelect();
}
function refreshPresetSelect() {
  const sel = document.getElementById('preset-select');
  const current = sel.value;
  sel.innerHTML = '<option value="">-- 載入組合 --</option>';
  Object.keys(getPresets()).forEach(name => {
    const o = document.createElement('option');
    o.value = name; o.textContent = name;
    sel.appendChild(o);
  });
  sel.value = current;
}
function saveCurrentPreset() {
  const name = prompt('組合名稱（例如「半導體+突破」）：');
  if (!name) return;
  const presets = getPresets();
  presets[name] = {
    cats: [...state.selectedCats],
    mode: state.mode,
    dim: state.dim,
    dimSelected: [...state.dimSelected],
    search: state.search,
    scoreMin: state.scoreMin,
    rsMin: state.rsMin,
    distRiskMax: state.distRiskMax,
    groupZMin: state.groupZMin,
  };
  setPresets(presets);
  document.getElementById('preset-select').value = name;
}
function loadPreset(e) {
  const name = e.target.value;
  if (!name) return;
  const p = getPresets()[name];
  if (!p) return;
  state.selectedCats = new Set(p.cats || []);
  state.mode = p.mode || 'OR';
  state.dim = p.dim || 'industry';
  state.dimSelected = new Set(p.dimSelected || []);
  state.search = p.search || '';
  state.scoreMin = p.scoreMin || 0;
  state.rsMin = p.rsMin || 0;
  state.distRiskMax = p.distRiskMax ?? null;
  state.groupZMin = p.groupZMin ?? null;

  // 回填 UI
  document.querySelectorAll('.cat-chip').forEach(chip => {
    const cb = chip.querySelector('input');
    cb.checked = state.selectedCats.has(chip.dataset.code);
    chip.classList.toggle('checked', cb.checked);
  });
  document.querySelector(`input[name="mode"][value="${state.mode}"]`).checked = true;
  document.querySelector(`input[name="dim"][value="${state.dim}"]`).checked = true;
  renderDimensionOptions();
  document.getElementById('search-input').value = state.search;
  document.getElementById('score-min').value = state.scoreMin;
  document.getElementById('rs-min').value = state.rsMin;
  document.getElementById('dist-risk-max').value = state.distRiskMax ?? '';
  document.getElementById('group-z-min').value = state.groupZMin ?? '';
  applyFilters();
}
function deleteCurrentPreset() {
  const sel = document.getElementById('preset-select');
  const name = sel.value;
  if (!name) { alert('請先選擇要刪除的組合'); return; }
  if (!confirm(`刪除組合「${name}」？`)) return;
  const presets = getPresets();
  delete presets[name];
  setPresets(presets);
  sel.value = '';
}

// ── X. Tab 切換 ─────────────────────────────────────
function bindTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.tab-panel').forEach(p =>
        p.classList.toggle('active', p.dataset.panel === tab));
      // Lazy load
      if (tab === 'industry-ranking' && !rankState.loaded) {
        loadIndustryRanking();
      }
      if (tab === 'flow' && !flowState.loaded) {
        loadFlow();
      }
      if (tab === 'concept' && !themeState.loaded) {
        loadTheme();
      }
      if (tab === 'market' && !marketState.loaded) {
        loadMarket();
      }
      // Resize tables after switch
      setTimeout(() => {
        if (state.table) state.table.redraw();
        ['indTable','subTable','stocksTable','historyTable'].forEach(k => {
          if (rankState[k]) rankState[k].redraw();
        });
        ['indTable','subTable','stocksTable','historyTable'].forEach(k => {
          if (flowState[k]) flowState[k].redraw();
        });
        ['listTable','stocksTable','historyTable'].forEach(k => {
          if (themeState[k]) themeState[k].redraw();
        });
      }, 50);
    });
  });
}

// ── Y. 產業排行 ─────────────────────────────────────
async function loadIndustryRanking() {
  if (rankState.loaded) return;
  try {
    rankState.data = await fetchJsonGz(dailyPath('industry_ranking'));
    rankState.loaded = true;
    document.getElementById('ind-meta').textContent =
      `${rankState.data.data_source}｜更新於 ${rankState.data.generated_at.slice(11, 16)}`;
    renderIndustryRanking();
    bindRankingControls();
  } catch (err) {
    document.getElementById('industry-table').innerHTML =
      `<div style="padding:30px;color:#ff6b6b">❌ 載入失敗：${err.message}</div>`;
  }
}

function _top1Cell(row) {
  const warn = row.top1_warn || '';
  const name = row.top1_name || '';
  const code = row.top1_ticker || '';
  const ret = row.top1_return;
  if (!code) return '';
  const sign = ret > 0 ? '+' : '';
  const cls = ret > 0 ? 'num-pos' : 'num-neg';
  const retStr = ret != null ? `${sign}${ret.toFixed(1)}%` : '';
  return `<span title="${code} ${name} ${retStr}">${warn} <span class="${cls}">${retStr}</span></span>`;
}

function renderIndustryRanking() {
  const block = rankState.data?.by_days?.[rankState.days];
  if (!block) return;

  const indRows = block.industries.map(r => ({ ...r }));
  const maxAbs = Math.max(1, ...indRows.map(r => Math.abs(r.avg_return)));

  if (rankState.indTable) rankState.indTable.destroy();
  rankState.indTable = new Tabulator('#industry-table', {
    data: indRows,
    layout: 'fitColumns',
    height: '100%',
    initialSort: [{ column: 'avg_return', dir: 'desc' }],
    rowClick: (e, row) => {
      const ind = row.getData().industry;
      if (!ind) return;
      rankState.selectedIndustry = ind;
      rankState.selectedSub = null;
      rankState.indTable.getRows().forEach(r => r.reformat());
      renderSubIndustry();
      renderIndustryStocks('industry', ind);
      renderIndustryHistory('industry', ind);
    },
    rowFormatter: (row) => {
      const isSel = row.getData().industry === rankState.selectedIndustry;
      row.getElement().style.background = isSel ? 'rgba(0, 212, 170, 0.18)' : '';
      row.getElement().style.cursor = 'pointer';
    },
    columns: [
      { title: '大產業', field: 'industry', widthGrow: 1.8 },
      {
        title: '平均漲幅%', field: 'avg_return', hozAlign: 'right', widthGrow: 1.2,
        sorter: 'number',
        formatter: (cell) => {
          const v = cell.getValue();
          const cls = v > 0 ? 'num-pos' : (v < 0 ? 'num-neg' : '');
          const pct = Math.min(100, Math.abs(v) / maxAbs * 100);
          const color = v < 0 ? 'rgba(74, 222, 128, 0.25)' : 'rgba(255, 107, 107, 0.25)';
          const dir = v < 0 ? 'to left' : 'to right';
          cell.getElement().style.backgroundImage =
            `linear-gradient(${dir}, ${color} ${pct}%, transparent ${pct}%)`;
          cell.getElement().style.backgroundRepeat = 'no-repeat';
          return `<span class="${cls}" style="position:relative;z-index:1">${v > 0 ? '+' : ''}${v.toFixed(2)}%</span>`;
        },
      },
      { title: '家數', field: 'stock_count', hozAlign: 'right', widthGrow: 0.5, sorter: 'number' },
      {
        title: 'Top1', field: 'top1_warn', widthGrow: 1, hozAlign: 'center',
        headerSort: false,
        formatter: (cell) => _top1Cell(cell.getRow().getData()),
      },
    ],
  });

  if (!rankState.selectedIndustry && indRows.length) {
    rankState.selectedIndustry = indRows[0].industry;
  }
  renderSubIndustry();
  if (rankState.selectedIndustry) {
    renderIndustryStocks('industry', rankState.selectedIndustry);
    renderIndustryHistory('industry', rankState.selectedIndustry);
  }
}

function renderSubIndustry() {
  const block = rankState.data?.by_days?.[rankState.days];
  if (!block || !rankState.selectedIndustry) return;

  document.getElementById('sub-industry-title').textContent =
    `🏭 ${rankState.selectedIndustry} — 細產業明細`;

  const subRows = block.sub_industries
    .filter(s => s.industry === rankState.selectedIndustry)
    .map(s => ({ ...s }));

  if (rankState.subTable) rankState.subTable.destroy();
  rankState.subTable = new Tabulator('#sub-industry-table', {
    data: subRows,
    layout: 'fitColumns',
    height: '100%',
    initialSort: [{ column: 'avg_return', dir: 'desc' }],
    rowClick: (e, row) => {
      const sub = row.getData().sub_industry;
      if (!sub) return;
      rankState.selectedSub = sub;
      rankState.subTable.getRows().forEach(r => r.reformat());
      renderIndustryStocks('sub_industry', sub);
      renderIndustryHistory('sub_industry', sub);
    },
    rowFormatter: (row) => {
      const isSel = row.getData().sub_industry === rankState.selectedSub;
      row.getElement().style.background = isSel ? 'rgba(0, 212, 170, 0.18)' : '';
      row.getElement().style.cursor = 'pointer';
    },
    columns: [
      { title: '細產業', field: 'sub_industry', widthGrow: 1.5 },
      {
        title: '平均漲幅%', field: 'avg_return', hozAlign: 'right', widthGrow: 1,
        sorter: 'number',
        formatter: (cell) => {
          const v = cell.getValue();
          const cls = v > 0 ? 'num-pos' : (v < 0 ? 'num-neg' : '');
          return `<span class="${cls}">${v > 0 ? '+' : ''}${v.toFixed(2)}%</span>`;
        },
      },
      { title: '家數', field: 'stock_count', hozAlign: 'right', widthGrow: 0.5, sorter: 'number' },
      {
        title: 'Top1', field: 'top1_warn', widthGrow: 1, hozAlign: 'center',
        headerSort: false,
        formatter: (cell) => _top1Cell(cell.getRow().getData()),
      },
    ],
  });
}

function renderIndustryStocks(level, name) {
  const block = rankState.data?.by_days?.[rankState.days];
  if (!block) return;

  let stocks = [];
  if (level === 'sub_industry') {
    const sub = block.sub_industries.find(s => s.sub_industry === name);
    if (sub) stocks = sub.top_stocks;
    document.getElementById('ind-stocks-title').textContent =
      `📈 ${name} — 個股清單（${stocks.length} 檔）`;
  } else {
    // 大產業：合併底下所有 sub 的 top_stocks（去重）
    const seen = new Set();
    block.sub_industries
      .filter(s => s.industry === name)
      .forEach(s => s.top_stocks.forEach(t => {
        if (!seen.has(t.ticker)) { seen.add(t.ticker); stocks.push(t); }
      }));
    stocks.sort((a, b) => b.return - a.return);
    document.getElementById('ind-stocks-title').textContent =
      `📈 ${name} — 個股清單（${stocks.length} 檔）`;
  }

  if (rankState.stocksTable) rankState.stocksTable.destroy();
  rankState.stocksTable = new Tabulator('#ind-stocks-table', {
    data: stocks,
    layout: 'fitColumns',
    height: '100%',
    initialSort: [{ column: 'return', dir: 'desc' }],
    columns: [
      {
        title: '代號', field: 'ticker', widthGrow: 0.8,
        formatter: (cell) => {
          const r = cell.getRow().getData();
          return `<a class="ticker-link" href="${tvUrl(r.ticker, r.market)}" target="_blank">${r.ticker}</a>`;
        },
      },
      { title: '名稱', field: 'name', widthGrow: 1.2 },
      {
        title: `${rankState.days}日漲幅%`, field: 'return', hozAlign: 'right', widthGrow: 1,
        sorter: 'number',
        formatter: (cell) => {
          const v = cell.getValue();
          const cls = v > 0 ? 'num-pos' : (v < 0 ? 'num-neg' : '');
          return `<span class="${cls}">${v > 0 ? '+' : ''}${v.toFixed(2)}%</span>`;
        },
      },
    ],
  });
}

function renderIndustryHistory(level, name) {
  const block = rankState.data?.by_days?.[rankState.days];
  if (!block) return;

  let history = [];
  if (level === 'sub_industry') {
    const sub = block.sub_industries.find(s => s.sub_industry === name);
    history = sub?.history || [];
  } else {
    const ind = block.industries.find(s => s.industry === name);
    history = ind?.history || [];
  }
  document.getElementById('ind-history-title').textContent =
    `📊 ${name} — 20 日每日平均漲跌（${history.length} 日）`;

  const maxAbs = Math.max(0.1, ...history.map(h => Math.abs(h.avg_return)));
  const rows = history.slice().reverse();  // 最新在上

  if (rankState.historyTable) rankState.historyTable.destroy();
  rankState.historyTable = new Tabulator('#ind-history-table', {
    data: rows,
    layout: 'fitColumns',
    height: '100%',
    columns: [
      {
        title: '日期', field: 'date', widthGrow: 1,
        formatter: (cell) => {
          const d = cell.getValue();
          return d ? `${d.slice(4, 6)}/${d.slice(6, 8)}` : '';
        },
      },
      {
        title: '平均漲跌%', field: 'avg_return', hozAlign: 'right', widthGrow: 1.5,
        sorter: 'number',
        formatter: (cell) => {
          const v = cell.getValue();
          const cls = v > 0 ? 'num-pos' : (v < 0 ? 'num-neg' : '');
          const pct = Math.min(100, Math.abs(v) / maxAbs * 100);
          const color = v < 0 ? 'rgba(74, 222, 128, 0.28)' : 'rgba(255, 107, 107, 0.28)';
          const dir = v < 0 ? 'to left' : 'to right';
          cell.getElement().style.backgroundImage =
            `linear-gradient(${dir}, ${color} ${pct}%, transparent ${pct}%)`;
          cell.getElement().style.backgroundRepeat = 'no-repeat';
          return `<span class="${cls}" style="position:relative;z-index:1">${v > 0 ? '+' : ''}${v.toFixed(2)}%</span>`;
        },
      },
      { title: '家數', field: 'stock_count', hozAlign: 'right', widthGrow: 0.5, sorter: 'number' },
    ],
  });
}

function bindRankingControls() {
  document.querySelectorAll('input[name="ind-days"]').forEach(r => {
    r.addEventListener('change', e => {
      rankState.days = e.target.value;
      // 切換 window 時保留 selectedIndustry/sub，重 render
      renderIndustryRanking();
      if (rankState.selectedSub) {
        renderIndustryStocks('sub_industry', rankState.selectedSub);
        renderIndustryHistory('sub_industry', rankState.selectedSub);
      } else if (rankState.selectedIndustry) {
        renderIndustryStocks('industry', rankState.selectedIndustry);
        renderIndustryHistory('industry', rankState.selectedIndustry);
      }
    });
  });
}

// ── Z. 資金流向 ─────────────────────────────────────
async function loadFlow() {
  if (flowState.loaded) return;
  try {
    flowState.data = await fetchJsonGz(dailyPath('industry_flow'));
    flowState.loaded = true;

    document.getElementById('flow-meta').textContent =
      `${flowState.data.data_source}｜window=${flowState.data.window} 日`;
    document.getElementById('flow-updated').textContent =
      `更新於 ${flowState.data.generated_at.slice(11, 16)}｜交易日 ${flowState.data.trading_date}`;

    bindFlowTableClicks();
    renderFlowIndTable();
    renderFlowSubTable();
  } catch (err) {
    document.getElementById('flow-ind-table').innerHTML =
      `<div style="padding:30px;color:#ff6b6b">❌ 載入失敗：${err.message}</div>`;
  }
}

function flowZColor(z) {
  if (z == null) return '';
  if (z >= 1.5) return 'num-pos';
  if (z >= 0.5) return 'num-pos-soft';
  if (z <= -1.5) return 'num-neg';
  if (z <= -0.5) return 'num-neg-soft';
  return '';
}

function flowCommonColumns(includeIndustry) {
  const cols = [];
  if (includeIndustry) {
    cols.push({ title: '大產業', field: 'industry', widthGrow: 1, headerSort: true });
  }
  cols.push(
    { title: '細產業', field: 'sub_industry', widthGrow: 1, headerSort: true },
    {
      title: '方向', field: 'direction', widthGrow: 0.4, hozAlign: 'center', headerSort: false,
    },
    {
      title: 'z', field: 'z_score', widthGrow: 0.5, hozAlign: 'right', sorter: 'number',
      formatter: (cell) => {
        const v = cell.getValue();
        if (v == null) return '';
        return `<span class="${flowZColor(v)}">${(v > 0 ? '+' : '') + v.toFixed(2)}</span>`;
      },
    },
    { title: '超量比', field: 'excess_ratio', widthGrow: 0.5, hozAlign: 'right', sorter: 'number',
      formatter: (c) => c.getValue() != null ? c.getValue().toFixed(2) + 'x' : '' },
    { title: 'Δ占比pp', field: 'share_diff_pp', widthGrow: 0.5, hozAlign: 'right', sorter: 'number',
      formatter: (c) => c.getValue() != null ? (c.getValue() > 0 ? '+' : '') + c.getValue().toFixed(2) : '' },
    { title: '5日z均', field: 'z_5d_avg', widthGrow: 0.5, hozAlign: 'right', sorter: 'number',
      formatter: (c) => c.getValue() != null ? (c.getValue() > 0 ? '+' : '') + c.getValue().toFixed(2) : '' },
    { title: '連續日', field: 'consec_inflow', widthGrow: 0.4, hozAlign: 'right', sorter: 'number' },
    { title: '今額(億)', field: 'today_amount', widthGrow: 0.6, hozAlign: 'right', sorter: 'number' },
    { title: 'Top1', field: 'top1_warn', widthGrow: 0.3, hozAlign: 'center', headerSort: false,
      formatter: (c) => {
        const row = c.getRow().getData();
        const warn = row.top1_warn || '';
        const share = row.top1_share != null ? `${row.top1_share}%` : '';
        const name = row.top1_name || '';
        return `<span title="${name} ${share}">${warn}</span>`;
      } },
    { title: '備註', field: 'note', widthGrow: 1, headerSort: false },
  );
  return cols.filter(c => c.field !== 'sub_industry' || !includeIndustry || c.field === 'sub_industry');
}

function renderFlowIndTable() {
  const rows = (flowState.data.industries || []).map(r => ({ ...r }));
  if (flowState.indTable) flowState.indTable.destroy();
  flowState.indTable = new Tabulator('#flow-ind-table', {
    data: rows,
    layout: 'fitColumns',
    height: '100%',
    initialSort: [{ column: 'z_score', dir: 'desc' }],
    rowFormatter: (row) => {
      const isSel = row.getData().industry === flowState.selectedIndustry;
      row.getElement().style.background = isSel ? 'rgba(0, 212, 170, 0.18)' : '';
      row.getElement().style.cursor = 'pointer';
    },
    columns: [
      { title: '大產業', field: 'industry', widthGrow: 1.2 },
      { title: '方向', field: 'direction', widthGrow: 0.4, hozAlign: 'center', headerSort: false },
      {
        title: 'z', field: 'z_score', widthGrow: 0.5, hozAlign: 'right', sorter: 'number',
        formatter: (c) => {
          const v = c.getValue();
          if (v == null) return '';
          return `<span class="${flowZColor(v)}">${(v > 0 ? '+' : '') + v.toFixed(2)}</span>`;
        },
      },
      { title: '超量', field: 'excess_ratio', widthGrow: 0.5, hozAlign: 'right', sorter: 'number',
        formatter: (c) => c.getValue() != null ? c.getValue().toFixed(2) + 'x' : '' },
      { title: 'Δ占比pp', field: 'share_diff_pp', widthGrow: 0.5, hozAlign: 'right', sorter: 'number',
        formatter: (c) => c.getValue() != null ? (c.getValue() > 0 ? '+' : '') + c.getValue().toFixed(2) : '' },
      { title: '5日z均', field: 'z_5d_avg', widthGrow: 0.5, hozAlign: 'right', sorter: 'number',
        formatter: (c) => c.getValue() != null ? (c.getValue() > 0 ? '+' : '') + c.getValue().toFixed(2) : '' },
      { title: '連續', field: 'consec_inflow', widthGrow: 0.35, hozAlign: 'right', sorter: 'number' },
      { title: '今額(億)', field: 'today_amount', widthGrow: 0.6, hozAlign: 'right', sorter: 'number' },
      { title: 'Top1', field: 'top1_warn', widthGrow: 0.3, hozAlign: 'center', headerSort: false,
        formatter: (c) => {
          const row = c.getRow().getData();
          return `<span title="${row.top1_name || ''} ${row.top1_share != null ? row.top1_share + '%' : ''}">${row.top1_warn || ''}</span>`;
        } },
      { title: '備註', field: 'note', widthGrow: 1, headerSort: false },
    ],
  });
}

function renderFlowSubTable() {
  let rows = flowState.data.sub_industries || [];
  if (flowState.selectedIndustry) {
    rows = rows.filter(r => r.industry === flowState.selectedIndustry);
    document.getElementById('flow-sub-title').textContent =
      `🏭 ${flowState.selectedIndustry} — 細產業資金流向`;
  } else {
    document.getElementById('flow-sub-title').textContent =
      `細產業資金流向（點上方大產業可篩選 / 共 ${rows.length} 個）`;
  }

  rows = rows.map(r => ({ ...r }));

  if (flowState.subTable) flowState.subTable.destroy();
  flowState.subTable = new Tabulator('#flow-sub-table', {
    data: rows,
    layout: 'fitColumns',
    height: '100%',
    initialSort: [{ column: 'z_score', dir: 'desc' }],
    rowFormatter: (row) => {
      const isSel = row.getData().sub_industry === flowState.selectedSub;
      row.getElement().style.background = isSel ? 'rgba(0, 212, 170, 0.18)' : '';
      row.getElement().style.cursor = 'pointer';
    },
    columns: [
      { title: '細產業', field: 'sub_industry', widthGrow: 1.2 },
      { title: '大產業', field: 'industry', widthGrow: 0.8 },
      { title: '方向', field: 'direction', widthGrow: 0.4, hozAlign: 'center', headerSort: false },
      {
        title: 'z', field: 'z_score', widthGrow: 0.5, hozAlign: 'right', sorter: 'number',
        formatter: (c) => {
          const v = c.getValue();
          if (v == null) return '';
          return `<span class="${flowZColor(v)}">${(v > 0 ? '+' : '') + v.toFixed(2)}</span>`;
        },
      },
      { title: '超量', field: 'excess_ratio', widthGrow: 0.5, hozAlign: 'right', sorter: 'number',
        formatter: (c) => c.getValue() != null ? c.getValue().toFixed(2) + 'x' : '' },
      { title: '5日z均', field: 'z_5d_avg', widthGrow: 0.5, hozAlign: 'right', sorter: 'number',
        formatter: (c) => c.getValue() != null ? (c.getValue() > 0 ? '+' : '') + c.getValue().toFixed(2) : '' },
      { title: '連續', field: 'consec_inflow', widthGrow: 0.35, hozAlign: 'right', sorter: 'number' },
      { title: '今額(億)', field: 'today_amount', widthGrow: 0.6, hozAlign: 'right', sorter: 'number' },
      { title: 'Top1', field: 'top1_warn', widthGrow: 0.3, hozAlign: 'center', headerSort: false,
        formatter: (c) => {
          const row = c.getRow().getData();
          return `<span title="${row.top1_name || ''} ${row.top1_share != null ? row.top1_share + '%' : ''}">${row.top1_warn || ''}</span>`;
        } },
      { title: '備註', field: 'note', widthGrow: 0.8, headerSort: false },
    ],
  });
}

function renderFlowStocksTable(level, name) {
  const key = level === 'industry' ? 'stocks_by_industry' : 'stocks_by_sub';
  const rows = (flowState.data[key] || {})[name] || [];
  const labelLevel = level === 'industry' ? '大產業' : '細產業';
  document.getElementById('flow-stocks-title').textContent =
    `📊 ${name}（${labelLevel}）內個股貢獻 — 依今日成交額排序（${rows.length}）`;

  if (flowState.stocksTable) flowState.stocksTable.destroy();
  flowState.stocksTable = new Tabulator('#flow-stocks-table', {
    data: rows,
    layout: 'fitColumns',
    height: '100%',
    columns: [
      { title: '代號', field: 'code', widthGrow: 0.5,
        formatter: (c) => {
          const r = c.getRow().getData();
          return `<a class="ticker-link" href="${tvUrl(r.code, r.market)}" target="_blank">${r.code}</a>`;
        } },
      { title: '名稱', field: 'name', widthGrow: 0.8 },
      { title: '收盤', field: 'close', widthGrow: 0.5, hozAlign: 'right', sorter: 'number',
        formatter: (c) => c.getValue() != null ? c.getValue().toFixed(2) : '' },
      { title: '漲跌%', field: 'pct_change', widthGrow: 0.5, hozAlign: 'right', sorter: 'number',
        formatter: (c) => {
          const v = c.getValue();
          if (v == null) return '';
          const cls = v > 0 ? 'num-pos' : (v < 0 ? 'num-neg' : '');
          return `<span class="${cls}">${(v > 0 ? '+' : '') + v.toFixed(2)}%</span>`;
        } },
      { title: '成交額(億)', field: 'amount_yi', widthGrow: 0.7, hozAlign: 'right', sorter: 'number',
        formatter: (c) => c.getValue() != null ? c.getValue().toFixed(1) : '' },
      { title: '族群占比%', field: 'share_in_grp', widthGrow: 0.6, hozAlign: 'right', sorter: 'number',
        formatter: (c) => c.getValue() != null ? c.getValue().toFixed(2) : '' },
      { title: '量比', field: 'volume_ratio', widthGrow: 0.5, hozAlign: 'right', sorter: 'number',
        formatter: (c) => c.getValue() != null ? c.getValue().toFixed(2) : '' },
    ],
  });
}

function renderFlowHistoryTable(level, name) {
  const key = level === 'industry' ? 'history_by_industry' : 'history_by_sub';
  const rows = (flowState.data[key] || {})[name] || [];
  const labelLevel = level === 'industry' ? '大產業' : '細產業';
  const status = rows.length ? '' : '（無歷史快取，僅 |z| ≥ 0.5 的族群預載）';
  document.getElementById('flow-history-title').textContent =
    `📈 ${name}（${labelLevel}）— 最近 20 日 z-score${status}`;

  if (flowState.historyTable) flowState.historyTable.destroy();
  flowState.historyTable = new Tabulator('#flow-history-table', {
    data: rows,
    layout: 'fitColumns',
    height: '100%',
    columns: [
      { title: '日期', field: 'date', widthGrow: 0.7 },
      { title: '今額(億)', field: 'today_amount', widthGrow: 0.7, hozAlign: 'right', sorter: 'number' },
      { title: '今日占比%', field: 'today_share', widthGrow: 0.7, hozAlign: 'right', sorter: 'number',
        formatter: (c) => c.getValue() != null ? c.getValue().toFixed(3) : '' },
      { title: '基期占比%', field: 'avg_share', widthGrow: 0.7, hozAlign: 'right', sorter: 'number',
        formatter: (c) => c.getValue() != null ? c.getValue().toFixed(3) : '' },
      { title: 'z', field: 'z_score', widthGrow: 0.5, hozAlign: 'right', sorter: 'number',
        formatter: (c) => {
          const v = c.getValue();
          if (v == null) return '';
          return `<span class="${flowZColor(v)}">${(v > 0 ? '+' : '') + v.toFixed(2)}</span>`;
        } },
      { title: '超量比', field: 'excess_ratio', widthGrow: 0.5, hozAlign: 'right', sorter: 'number',
        formatter: (c) => c.getValue() != null ? c.getValue().toFixed(2) + 'x' : '' },
      { title: '備註', field: 'note', widthGrow: 1, headerSort: false },
    ],
  });
}

function bindFlowTableClicks() {
  document.getElementById('flow-ind-table').addEventListener('click', (e) => {
    const rowEl = e.target.closest('.tabulator-row');
    if (!rowEl || !flowState.indTable) return;
    const tr = flowState.indTable.getRows().find(r => r.getElement() === rowEl);
    if (!tr) return;
    const ind = tr.getData().industry;
    if (!ind) return;
    flowState.selectedIndustry = (flowState.selectedIndustry === ind) ? null : ind;
    flowState.selectedSub = null;
    flowState.indTable.getRows().forEach(r => r.reformat());
    renderFlowSubTable();
    // 同時更新個股 / 歷史（大產業 level）
    if (flowState.selectedIndustry) {
      renderFlowStocksTable('industry', flowState.selectedIndustry);
      renderFlowHistoryTable('industry', flowState.selectedIndustry);
    }
  });

  document.getElementById('flow-sub-table').addEventListener('click', (e) => {
    const rowEl = e.target.closest('.tabulator-row');
    if (!rowEl || !flowState.subTable) return;
    const tr = flowState.subTable.getRows().find(r => r.getElement() === rowEl);
    if (!tr) return;
    const sub = tr.getData().sub_industry;
    if (!sub) return;
    flowState.selectedSub = sub;
    flowState.subTable.getRows().forEach(r => r.reformat());
    renderFlowStocksTable('sub_industry', sub);
    renderFlowHistoryTable('sub_industry', sub);
  });
}

// ── W. 題材資金流向 ─────────────────────────────────
async function loadTheme() {
  if (themeState.loaded) return;
  try {
    themeState.data = await fetchJsonGz(dailyPath('theme_flow'));
    themeState.loaded = true;
    document.getElementById('theme-updated').textContent =
      `${themeState.data.data_source}｜window=${themeState.data.window}｜更新 ${themeState.data.generated_at.slice(11, 16)}`;

    // sub-tab 切換
    document.querySelectorAll('.subtab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.subtab-btn').forEach(b => b.classList.toggle('active', b === btn));
        themeState.subtab = btn.dataset.subtab;
        themeState.selectedItem = null;
        renderThemeList();
        // 清空右側
        document.getElementById('theme-stocks-title').textContent = '個股貢獻（點題材查看）';
        document.getElementById('theme-history-title').textContent = '20 日 z-score 歷史（點題材查看）';
        if (themeState.stocksTable) { themeState.stocksTable.destroy(); themeState.stocksTable = null; }
        if (themeState.historyTable) { themeState.historyTable.destroy(); themeState.historyTable = null; }
      });
    });

    // 一次性綁原生 click delegation
    document.getElementById('theme-list-table').addEventListener('click', (e) => {
      const rowEl = e.target.closest('.tabulator-row');
      if (!rowEl || !themeState.listTable) return;
      const tr = themeState.listTable.getRows().find(r => r.getElement() === rowEl);
      if (!tr) return;
      const label = themeState.subtab === 'concept' ? 'concept_name' : 'sector_name';
      const name = tr.getData()[label];
      if (!name) return;
      themeState.selectedItem = name;
      themeState.listTable.getRows().forEach(r => r.reformat());
      renderThemeStocks();
      renderThemeHistory();
    });

    renderThemeList();
  } catch (err) {
    document.getElementById('theme-list-table').innerHTML =
      `<div style="padding:30px;color:#ff6b6b">❌ 載入失敗：${err.message}</div>`;
  }
}

function _currentThemeBlock() {
  return themeState.data?.[themeState.subtab] || null;
}

function renderThemeList() {
  const block = _currentThemeBlock();
  if (!block) return;

  const label = themeState.subtab === 'concept' ? 'concept_name' : 'sector_name';
  const titleName = themeState.subtab === 'concept' ? '題材' : '類股';
  document.getElementById('theme-list-title').textContent =
    `${titleName}列表 — ${block.items.length} 項（依 z-score 排序）`;

  const rows = block.items.map(r => ({ ...r }));

  if (themeState.listTable) themeState.listTable.destroy();
  themeState.listTable = new Tabulator('#theme-list-table', {
    data: rows,
    layout: 'fitColumns',
    height: '100%',
    initialSort: [{ column: 'z_score', dir: 'desc' }],
    rowFormatter: (row) => {
      const isSel = row.getData()[label] === themeState.selectedItem;
      row.getElement().style.background = isSel ? 'rgba(0, 212, 170, 0.18)' : '';
      row.getElement().style.cursor = 'pointer';
    },
    columns: [
      { title: titleName, field: label, widthGrow: 1.4 },
      { title: '方向', field: 'direction', widthGrow: 0.4, hozAlign: 'center', headerSort: false },
      {
        title: 'z', field: 'z_score', widthGrow: 0.5, hozAlign: 'right', sorter: 'number',
        formatter: (c) => {
          const v = c.getValue();
          if (v == null) return '';
          return `<span class="${flowZColor(v)}">${(v > 0 ? '+' : '') + v.toFixed(2)}</span>`;
        },
      },
      { title: '超量', field: 'excess_ratio', widthGrow: 0.5, hozAlign: 'right', sorter: 'number',
        formatter: (c) => c.getValue() != null ? c.getValue().toFixed(2) + 'x' : '' },
      { title: 'Δ占比pp', field: 'share_diff_pp', widthGrow: 0.6, hozAlign: 'right', sorter: 'number',
        formatter: (c) => c.getValue() != null ? (c.getValue() > 0 ? '+' : '') + c.getValue().toFixed(2) : '' },
      { title: '5日z均', field: 'z_5d_avg', widthGrow: 0.5, hozAlign: 'right', sorter: 'number',
        formatter: (c) => c.getValue() != null ? (c.getValue() > 0 ? '+' : '') + c.getValue().toFixed(2) : '' },
      { title: '連續', field: 'consec_inflow', widthGrow: 0.4, hozAlign: 'right', sorter: 'number' },
      { title: '今額(億)', field: 'today_amount', widthGrow: 0.6, hozAlign: 'right', sorter: 'number' },
      { title: 'Top1', field: 'top1_warn', widthGrow: 0.3, hozAlign: 'center', headerSort: false,
        formatter: (c) => {
          const row = c.getRow().getData();
          return `<span title="${row.top1_name || ''} ${row.top1_share != null ? row.top1_share + '%' : ''}">${row.top1_warn || ''}</span>`;
        } },
      { title: '備註', field: 'note', widthGrow: 0.8, headerSort: false },
    ],
  });
}

function renderThemeStocks() {
  const block = _currentThemeBlock();
  if (!block || !themeState.selectedItem) return;
  const rows = block.stocks_by_item?.[themeState.selectedItem] || [];
  const titleName = themeState.subtab === 'concept' ? '題材' : '類股';
  document.getElementById('theme-stocks-title').textContent =
    `📊 ${themeState.selectedItem}（${titleName}）內個股貢獻 — 依今日成交額排序（${rows.length}）`;

  if (themeState.stocksTable) themeState.stocksTable.destroy();
  themeState.stocksTable = new Tabulator('#theme-stocks-table', {
    data: rows,
    layout: 'fitColumns',
    height: '100%',
    columns: [
      { title: '代號', field: 'code', widthGrow: 0.5,
        formatter: (c) => {
          const r = c.getRow().getData();
          return `<a class="ticker-link" href="${tvUrl(r.code, r.market)}" target="_blank">${r.code}</a>`;
        } },
      { title: '名稱', field: 'name', widthGrow: 0.8 },
      { title: '收盤', field: 'close', widthGrow: 0.5, hozAlign: 'right', sorter: 'number',
        formatter: (c) => c.getValue() != null ? c.getValue().toFixed(2) : '' },
      { title: '漲跌%', field: 'pct_change', widthGrow: 0.5, hozAlign: 'right', sorter: 'number',
        formatter: (c) => {
          const v = c.getValue();
          if (v == null) return '';
          const cls = v > 0 ? 'num-pos' : (v < 0 ? 'num-neg' : '');
          return `<span class="${cls}">${(v > 0 ? '+' : '') + v.toFixed(2)}%</span>`;
        } },
      { title: '成交額(億)', field: 'amount_yi', widthGrow: 0.7, hozAlign: 'right', sorter: 'number',
        formatter: (c) => c.getValue() != null ? c.getValue().toFixed(1) : '' },
      { title: '族群占比%', field: 'share_in_grp', widthGrow: 0.6, hozAlign: 'right', sorter: 'number',
        formatter: (c) => c.getValue() != null ? c.getValue().toFixed(2) : '' },
      { title: '量比', field: 'volume_ratio', widthGrow: 0.5, hozAlign: 'right', sorter: 'number',
        formatter: (c) => c.getValue() != null ? c.getValue().toFixed(2) : '' },
    ],
  });
}

function renderThemeHistory() {
  const block = _currentThemeBlock();
  if (!block || !themeState.selectedItem) return;
  const rows = block.history_by_item?.[themeState.selectedItem] || [];
  const titleName = themeState.subtab === 'concept' ? '題材' : '類股';
  const status = rows.length ? '' : '（無歷史快取，僅 |z| ≥ 0.5 的族群預載）';
  document.getElementById('theme-history-title').textContent =
    `📈 ${themeState.selectedItem}（${titleName}）— 最近 20 日 z-score${status}`;

  if (themeState.historyTable) themeState.historyTable.destroy();
  themeState.historyTable = new Tabulator('#theme-history-table', {
    data: rows,
    layout: 'fitColumns',
    height: '100%',
    columns: [
      { title: '日期', field: 'date', widthGrow: 0.7 },
      { title: '今額(億)', field: 'today_amount', widthGrow: 0.6, hozAlign: 'right', sorter: 'number' },
      { title: '今日占比%', field: 'today_share', widthGrow: 0.7, hozAlign: 'right', sorter: 'number',
        formatter: (c) => c.getValue() != null ? c.getValue().toFixed(3) : '' },
      { title: '基期占比%', field: 'avg_share', widthGrow: 0.7, hozAlign: 'right', sorter: 'number',
        formatter: (c) => c.getValue() != null ? c.getValue().toFixed(3) : '' },
      { title: 'z', field: 'z_score', widthGrow: 0.5, hozAlign: 'right', sorter: 'number',
        formatter: (c) => {
          const v = c.getValue();
          if (v == null) return '';
          return `<span class="${flowZColor(v)}">${(v > 0 ? '+' : '') + v.toFixed(2)}</span>`;
        } },
      { title: '超量比', field: 'excess_ratio', widthGrow: 0.5, hozAlign: 'right', sorter: 'number',
        formatter: (c) => c.getValue() != null ? c.getValue().toFixed(2) + 'x' : '' },
    ],
  });
}

// ── V. 大盤狀態 ─────────────────────────────────────
async function loadMarket() {
  if (marketState.loaded) return;
  try {
    // market 永遠用「最新有 market 的日期」（chip 資料是當下狀態，可能比 screener 新一天）
    const mDate = (indexMeta?.dates || []).find(e => (e.has || []).includes('market'))?.date
                  || indexMeta?.latest_date || currentDate;
    const d = await fetchJsonGz(`data/daily/${mDate}/market.json.gz`);
    marketState.loaded = true;
    renderMarket(d);
  } catch (err) {
    document.getElementById('market-content').innerHTML =
      `<div style="padding:30px;color:#ff6b6b">❌ 載入失敗：${err.message}</div>`;
  }
}

function _chipColorByZ(z) {
  if (z == null) return '#aaa';
  if (z >= 1.0)  return '#00ff9d';
  if (z >= 0.3)  return '#00d4aa';
  if (z <= -1.0) return '#ef5350';
  if (z <= -0.3) return '#ff8a80';
  return '#e0e0e0';
}

function _fmtMillion(v) {
  if (v == null) return '—';
  if (Math.abs(v) >= 10000) return (v > 0 ? '+' : '') + (v / 10000).toFixed(1) + '億';
  return (v > 0 ? '+' : '') + Math.round(v).toLocaleString() + 'M';
}

function renderMarket(d) {
  const s = d.chip_score || {};
  if (!s.available) {
    document.getElementById('market-content').innerHTML =
      `<div class="market-card" style="color:#ff9d00">⚠ ${s.error || '無籌碼資料'}</div>`;
    return;
  }

  const state = s.state || '—';
  const stateColor = state.includes('多') ? '#00ff9d' : state.includes('空') ? '#ef5350' : '#aaa';
  const comp = s.composite_score;

  const commentaryHTML = (d.commentary || []).map(c =>
    `<div class="lvl-${c.level || 'info'}">${c.text}</div>`
  ).join('') || '<div class="muted">（今日無觸發特殊訊號）</div>';

  const signalsHTML = (d.signals && d.signals.length) ? `
    <div style="font-weight:700;font-size:14px;margin-bottom:6px">🚨 衍生訊號</div>
    <ul>${d.signals.map(s => `<li class="lvl-${s.level || 'info'}">${s.text}</li>`).join('')}</ul>
  ` : '<div class="muted">（無特殊衍生訊號）</div>';

  // 五維度卡片
  const dims = [
    { title: '外資現貨', val: _fmtMillion(s.fo_value), sub: `z=${s.fo_z != null ? s.fo_z.toFixed(2) : '—'}`, color: _chipColorByZ(s.fo_z) },
    { title: '投信現貨', val: _fmtMillion(s.ic_value), sub: `z=${s.ic_z != null ? s.ic_z.toFixed(2) : '—'}`, color: _chipColorByZ(s.ic_z) },
    { title: '自營現貨', val: _fmtMillion(s.pc_value), sub: '（顯示用，不入加權）', color: '#e0e0e0' },
    { title: '外資台指期 OI',
      val: s.fu_value != null ? (s.fu_value > 0 ? '+' : '') + s.fu_value.toLocaleString() + '口' : '—',
      sub: `z=${s.fu_z != null ? s.fu_z.toFixed(2) : '—'}`,
      color: _chipColorByZ(s.fu_z) },
    { title: '選擇權 PCR',
      val: s.pcr != null ? s.pcr.toFixed(2) : '—',
      sub: `score=${s.pcr_score != null ? s.pcr_score : '—'}`,
      color: (s.pcr != null && s.pcr > 1.3) ? '#ff9d00' :
             (s.pcr != null && s.pcr < 0.7) ? '#7ec0ff' : '#e0e0e0' },
  ];

  const dimHTML = dims.map(x => `
    <div class="market-card dim-card">
      <div class="dim-title">${x.title}</div>
      <div class="dim-val" style="color:${x.color}">${x.val}</div>
      <div class="dim-sub">${x.sub}</div>
    </div>
  `).join('');

  // OI 表
  let oiHTML = '';
  const oi = d.oi_table || {};
  if (oi.available) {
    oiHTML = `
      <div class="market-card">
        <div style="font-weight:700;font-size:14px;margin-bottom:6px">
          🏦 外資各期貨契約未平倉
          <span class="muted" style="margin-left:8px">
            日期：${oi.date}　前一交易日：${oi.prev_date || '—'}
          </span>
        </div>
        <table class="market-table">
          <thead><tr>
            <th>契約</th><th>名稱</th>
            <th class="r">多方 OI</th><th class="r">空方 OI</th>
            <th class="r">淨 OI</th><th class="r">日變化</th>
          </tr></thead>
          <tbody>
            ${oi.rows.map(r => {
              const netColor = r.net_oi > 0 ? '#00ff9d' : r.net_oi < 0 ? '#ef5350' : '#aaa';
              const chColor = r.day_change > 0 ? '#00ff9d' : r.day_change < 0 ? '#ef5350' : '#888';
              const chStr = r.day_change != null ? (r.day_change > 0 ? '+' : '') + r.day_change.toLocaleString() : '—';
              return `<tr>
                <td style="color:#7ec0ff">${r.code}</td>
                <td>${r.name}</td>
                <td class="r">${r.long_oi.toLocaleString()}</td>
                <td class="r">${r.short_oi.toLocaleString()}</td>
                <td class="r" style="color:${netColor};font-weight:700">${(r.net_oi > 0 ? '+' : '') + r.net_oi.toLocaleString()}</td>
                <td class="r" style="color:${chColor}">${chStr}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  } else {
    oiHTML = `<div class="market-card muted">⚠ 無期交所資料：${oi.error || ''}</div>`;
  }

  document.getElementById('market-content').innerHTML = `
    <div class="market-row market-row-2">
      <div class="market-card market-summary">
        <div class="muted">綜合判斷</div>
        <div class="state-big" style="color:${stateColor}">${state}</div>
        <div class="state-score">分數 ${comp != null ? (comp > 0 ? '+' : '') + comp.toFixed(2) : '—'}</div>
        <div class="market-commentary">${commentaryHTML}</div>
        <div class="state-meta">
          現貨日期 ${s.equity_date || '—'} ｜ 期貨日期 ${s.futures_date || '—'} ｜
          歷史 現${s.days_eq || 0}/期${s.days_fu || 0} 天
        </div>
      </div>
      <div class="market-card market-signals">${signalsHTML}</div>
    </div>
    <div class="market-row market-row-5">${dimHTML}</div>
    ${oiHTML}
  `;
}

// ── 9. 啟動 ─────────────────────────────────────────
(async function init() {
  try {
    await loadIndex();
    renderDatePicker();
    const data = await loadData();
    state.data = data;

    // 建分類顏色 lookup（供命中策略欄渲染色塊用）
    data._catColor = {};
    data.categories.forEach(c => { data._catColor[c.code] = c.color; });

    renderMeta(data);
    renderCategoryChips(data.categories);
    renderDimensionOptions();
    buildTable(data);
    bindControls();
    bindTabs();
    refreshPresetSelect();
    applyFilters();
  } catch (err) {
    document.getElementById('main-table').innerHTML =
      `<div style="padding:30px;color:#ff6b6b">❌ 載入失敗：${err.message}</div>`;
    console.error(err);
  }
})();
