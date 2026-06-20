// ─────────────────────────────────────────────────────────
//  右側突破篩選器 — 雲端 MVP 前端
//  讀 web/data/latest.json → 渲染表格 + 多條件篩選
// ─────────────────────────────────────────────────────────

const PRESET_STORAGE_KEY = 'screener_presets_v1';

// 介面版本 — 顯示在頁尾，方便確認是否載到最新版(避開瀏覽器快取舊檔)
const APP_VERSION = '20260620i';
document.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('app-version');
  if (el) el.textContent = APP_VERSION;
});

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
    buildTickerIndustry(data);
    renderMeta(data);
    renderCategoryChips(data.categories);
    renderDimensionOptions();
    buildTable(data);
    renderFocusStrip(data);
    loadResonanceData();
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
  else if (activeTab === 'hanku') loadHanku();
  else if (activeTab === 'wave3') loadWave3();
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
  mainView: null,        // 每日看板檢視：table | card
  // 自選股
  pinned: new Set(JSON.parse(localStorage.getItem('pinnedTickers') || '[]')),
  onlyPinned: false,
  // 只顯示族群 z≥1
  onlyHotGroup: false,
  // 只看跨策略共振（≥2 策略）
  onlyResonance: false,
  // 主升策略：off|sig|A|B；sig 模式用 mainupSignals 勾選的旗標(5訊號+3條件+季線突破)
  mainupMode: 'off',
  mainupSignals: new Set(['s1', 's2', 's3', 's4', 's5', 'c1', 'c2', 'c3', 'mainup_ma60']),
  mainupEntry: '',        // 進場型態篩選（空=不限）；任何模式皆生效
  mainupExclDist: false,  // 排除出貨警訊；任何模式皆生效
};

// 代號→產業 對照表（供 hanku/wave3 等資料無產業欄的分頁，借主表 row 的 industry）
let tickerIndustry = {};
function buildTickerIndustry(data) {
  tickerIndustry = {};
  (data.rows || []).forEach(r => { if (r.ticker) tickerIndustry[r.ticker] = r.industry || ''; });
}

// 依目前 rows 內出現的產業，重建產業下拉選項（保留原選取）
function populateIndustrySelect(selectEl, rows) {
  if (!selectEl) return;
  const prev = selectEl.value;
  const inds = Array.from(new Set(rows.map(r => r._ind).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  selectEl.innerHTML = '<option value="all">全部產業</option>' +
    inds.map(i => `<option value="${i}">${i}</option>`).join('');
  if (prev && (prev === 'all' || inds.includes(prev))) selectEl.value = prev;
}

// ── 跨策略共振：把 Hanku / 第三浪 的 actionable 清單併進每日看板 ──
//   resonance.hanku/​wave3 = { 代號: 狀態 }；共振數 = 突破(命中≥1)+Hanku+三浪 命中幾個
const resonance = { hanku: {}, wave3: {} };

function _resoDate(kind) {
  const ds = indexMeta?.dates || [];
  return (ds.find(e => e.date === currentDate && (e.has || []).includes(kind))
       || ds.find(e => (e.has || []).includes(kind)) || {}).date;
}

async function loadResonanceData() {
  resonance.hanku = {}; resonance.wave3 = {};
  const grab = async (kind, store) => {
    try {
      const d = _resoDate(kind);
      if (!d) return;
      const j = await fetchJsonGz(`data/daily/${d}/${kind}.json.gz`);
      (j.rows || []).forEach(r => { if (r.ticker) store[r.ticker] = r.state || ''; });
    } catch (e) { /* 缺資料不影響主表 */ }
  };
  await Promise.all([grab('hanku', resonance.hanku), grab('wave3', resonance.wave3)]);
  // 資料到位後重跑篩選（共振篩選/排序/徽章才正確）
  if (state.table) applyFilters();
}

function _resoCount(r) {
  let n = 0;
  if ((r.hits || 0) >= 1) n++;
  if (resonance.hanku[r.ticker]) n++;
  if (resonance.wave3[r.ticker]) n++;
  return n;
}
function _stripLeadEmoji(s) { return String(s || '').replace(/^[^一-龥A-Za-z0-9]+/, ''); }

// 🔥 今日突破焦點 Top3（借鏡 aistockmap「今日焦點」榜）
//   排序：命中數(跨策略共振) → 分數；點卡片開站內 K 線。
function renderFocusStrip(data) {
  const el = document.getElementById('focus-strip');
  if (!el) return;
  const rows = (data.rows || []).filter(r => (r.hits || 0) >= 1);
  rows.sort((a, b) => (b.hits || 0) - (a.hits || 0) || (b.score || 0) - (a.score || 0));
  const top = rows.slice(0, 3);
  if (!top.length) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML =
    `<div class="fs-head">🔥 今日突破焦點 <span class="fs-sub">命中數 → 分數 排序，點卡片看 K 線</span></div>` +
    `<div class="fs-cards">` +
    top.map((r, i) => {
      const chg = Number(r.chg_pct);
      const pos = !(chg < 0);
      const chgTxt = isNaN(chg) ? '--' : `${chg > 0 ? '+' : ''}${chg.toFixed(2)}%`;
      return `<button type="button" class="fs-card ${pos ? 'pos' : 'neg'}">
        <div class="fs-row"><span class="fs-rank">#${i + 1}</span><span class="fs-hits">命中 ${r.hits}</span></div>
        <div class="fs-chg">${chgTxt}</div>
        <div class="fs-id"><span class="fs-code">${r.ticker}</span> <span class="fs-name">${r.name || ''}</span></div>
        <div class="fs-meta">分數 ${r.score != null ? Math.round(r.score) : '--'}　${r.industry || ''}</div>
      </button>`;
    }).join('') +
    `</div>`;
  el.querySelectorAll('.fs-card').forEach((card, i) => {
    const r = top[i];
    card.addEventListener('click', () => openKlineModal(r.ticker, r.name, r.market));
  });
}

// 自選股分頁狀態
const watchState = {
  table: null,
  loaded: false,
};

function savePinned() {
  localStorage.setItem('pinnedTickers', JSON.stringify([...state.pinned]));
}
function togglePin(ticker) {
  if (state.pinned.has(ticker)) state.pinned.delete(ticker);
  else state.pinned.add(ticker);
  savePinned();
  updatePinSummary();
  if (state.table) {
    // 重新套用排序（pinned 自動置頂）
    state.table.setSort(state.table.getSorters());
    if (state.onlyPinned) state.table.refreshFilter();
  }
}
function updatePinSummary() {
  const el = document.getElementById('pin-summary');
  if (!el) return;
  const n = state.pinned.size;
  el.textContent = n > 0 ? `已勾 ${n} 檔` : '';
  const btn = document.getElementById('btn-only-pinned');
  if (btn) btn.disabled = n === 0;
  const clr = document.getElementById('btn-clear-pinned');
  if (clr) clr.disabled = n === 0;
}

// 維度名 -> row 上對應的欄位
const DIM_FIELD = {
  industry: 'd_industry',
  sector:   'd_sector',
  concept:  'd_concept',
};

// 大盤狀態分頁
const marketState = { loaded: false };

// 權證精選分頁
const warrantState = {
  loaded: false,
  data: null,     // 整檔 warrants.json
  table: null,    // Tabulator 物件
  loadedDate: null,
  issuerSel: null,     // Set<string>，null = 全選
  allIssuers: [],      // 所有可選券商（依出現次數排序）
};

const WARRANT_MAJOR_ISSUERS = ['元大', '群益', '凱基', '永豐'];

// CB 監控分頁
const cbState = {
  loaded: false,
  data: null,
  table: null,
  loadedDate: null,
};

// 題材資金流向分頁狀態
const themeState = {
  data: null,
  window: 20,
  cache: {},
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
  window: 20,
  cache: {},                  // {window: data}
  selectedIndustry: null,
  selectedSub: null,
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
  historyN: 20,              // 歷史 pane 顯示最近 N 日
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

// ── 3. 渲染分類 chips（依「突破生命週期」分 5 區塊） ──
//   參考 aistockmap 結構頁：分層+分區標題，而非平鋪一整排。
const CAT_GROUPS = [
  { title: '🌀 醞釀蓄勢', hint: '還沒突破、潛伏蓄力', codes: ['A_VCP', 'A_Coil', 'N_NearHigh', 'R_Neckline'] },
  { title: '🚀 突破發動', hint: '剛突破、發動點',   codes: ['B_Day0', 'B_Recent', 'R_Breakout'] },
  { title: '⚡ 續攻動能', hint: '突破後沿均線走',   codes: ['S_MA3Rider', 'S_MA5Rider'] },
  { title: '💰 籌碼/族群', hint: '主力/族群撐腰',   codes: ['M_Accumulate', 'GroupResonance'] },
  { title: '👁 觀察/風險', hint: '謹慎、別追',       codes: ['P_Watch', 'P_PunishExit', 'P_PostExit'] },
];

function _makeCatChip(c) {
  const chip = document.createElement('label');
  chip.className = 'cat-chip';
  chip.style.color = c.color;
  chip.style.setProperty('--cat', c.color);
  chip.dataset.code = c.code;
  if (state.selectedCats.has(c.code)) chip.classList.add('checked');
  chip.innerHTML = `
    <input type="checkbox" value="${c.code}"${state.selectedCats.has(c.code) ? ' checked' : ''} />
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
  return chip;
}

function renderCategoryChips(cats) {
  const container = document.getElementById('cat-checkboxes');
  container.innerHTML = '';
  const byCode = {};
  cats.forEach(c => { byCode[c.code] = c; });
  const placed = new Set();

  const renderGroup = (title, hint, items) => {
    const shown = items.filter(c => c && c.count > 0);   // 無命中不顯示
    if (!shown.length) return;
    const g = document.createElement('div');
    g.className = 'cat-group';
    const head = document.createElement('div');
    head.className = 'cat-group-head';
    head.innerHTML = `${title}<span class="cat-group-hint">${hint}</span>`;
    const chips = document.createElement('div');
    chips.className = 'cat-group-chips';
    shown.forEach(c => chips.appendChild(_makeCatChip(c)));
    g.appendChild(head); g.appendChild(chips);
    container.appendChild(g);
  };

  CAT_GROUPS.forEach(grp => {
    grp.codes.forEach(code => placed.add(code));
    renderGroup(grp.title, grp.hint, grp.codes.map(code => byCode[code]));
  });
  // 未歸類的新代碼 → 其他
  const others = cats.filter(c => !placed.has(c.code));
  if (others.length) renderGroup('🏷 其他', '', others);
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

  // 隱藏 select 仍同步(相容既有清除/組合邏輯)
  opts.forEach(o => {
    const el = document.createElement('option');
    el.value = o.name;
    el.textContent = `${o.name} (${o.count})`;
    el.selected = state.dimSelected.has(o.name);
    sel.appendChild(el);
  });

  // 聚合今日均漲(從個股 chg_pct)→ 卡片顯示熱度
  const field = DIM_FIELD[state.dim];
  const agg = {};
  (state.data.rows || []).forEach(r => {
    const chg = Number(r.chg_pct);
    if (isNaN(chg)) return;
    (r[field] || []).forEach(v => {
      const a = agg[v] || (agg[v] = { sum: 0, n: 0 });
      a.sum += chg; a.n++;
    });
  });

  // 卡片：依命中家數排序，顯示 名稱/家數/今日均漲/🔥
  const cardsEl = document.getElementById('dim-cards');
  if (cardsEl) {
    const sorted = opts.slice().sort((a, b) => (b.count || 0) - (a.count || 0));
    cardsEl.innerHTML = sorted.map(o => {
      const a = agg[o.name];
      const avg = a && a.n ? a.sum / a.n : null;
      const chgCls = avg == null ? '' : (avg > 0 ? 'pos' : (avg < 0 ? 'neg' : ''));
      const chgTxt = avg == null ? '' : `${avg > 0 ? '+' : ''}${avg.toFixed(1)}%`;
      const hot = (avg != null && avg >= 1.5) ? ' 🔥' : '';
      const on = state.dimSelected.has(o.name) ? ' checked' : '';
      return `<button type="button" class="dim-chip${on}" data-name="${o.name}">
        <span class="dim-name">${o.name}${hot}</span>
        <span class="dim-cnt">${o.count}</span>
        <span class="dim-chg ${chgCls}">${chgTxt}</span>
      </button>`;
    }).join('') || '<span class="muted" style="padding:6px">無符合項目</span>';
    cardsEl.querySelectorAll('.dim-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.name;
        if (state.dimSelected.has(name)) state.dimSelected.delete(name);
        else state.dimSelected.add(name);
        btn.classList.toggle('checked');
        const opt = [...sel.options].find(o => o.value === name);
        if (opt) opt.selected = state.dimSelected.has(name);
        applyFilters();
      });
    });
  }

  const total = d.options.length;
  const shown = opts.length;
  src.textContent = `來源: ${d.source || '—'}｜${shown}/${total} 項｜點卡片=篩選(可複選)`;
}

// ── 5. 建表（Tabulator） ────────────────────────────
function buildTable(data) {
  // pin 欄位（最前）
  const pinCol = {
    title: '📌', field: '_pin', width: 44, hozAlign: 'center',
    frozen: true, headerSort: false,
    formatter: (cell) => {
      const t = cell.getRow().getData().ticker;
      return state.pinned.has(t)
        ? '<span style="color:#ffd166;font-size:16px">★</span>'
        : '<span style="color:#555;font-size:16px">☆</span>';
    },
    cellClick: (e, cell) => {
      e.stopPropagation();
      const t = cell.getRow().getData().ticker;
      togglePin(t);
      // freeze/unfreeze 對應 row
      const row = cell.getRow();
      if (state.pinned.has(t)) row.freeze();
      else row.unfreeze();
      cell.getRow().reformat();
    },
  };

  const cols = [pinCol, ...data.column_meta.map(c => {
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
        if (['dist_high', 'dist_year_high', 'risk_pct', 'stop_loss_pct', 'chg_pct'].includes(c.id)) {
          const cls = v > 0 ? 'num-pos' : (v < 0 ? 'num-neg' : '');
          const sign = c.id === 'chg_pct' && v > 0 ? '+' : '';
          return `<span class="${cls}">${sign}${txt}</span>`;
        }
        return txt;
      };
    }
    // ticker 欄位：點代號 → 站內 K 線彈窗
    if (c.id === 'ticker') {
      def.formatter = (cell) => {
        const t = cell.getValue();
        return `<a class="ticker-link" href="#" data-kline-ticker="${t}">${t}</a>`;
      };
      def.cellClick = (e, cell) => {
        e.preventDefault();
        const row = cell.getRow().getData();
        openKlineModal(cell.getValue(), row.name, row.market);
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
    // 命中數欄：≥2 用螢光綠（DannyQuant Top 10 共振訊號）
    if (c.id === 'hits') {
      def.formatter = (cell) => {
        const v = cell.getValue();
        if (v == null || v === 0) return '<span class="muted">0</span>';
        if (v >= 3) return `<span class="hits-strong">×${v}</span>`;
        if (v >= 2) return `<span class="hits-mid">×${v}</span>`;
        return `<span>${v}</span>`;
      };
    }
    // 族群集中度欄：≥70 標紅、≥50 黃
    if (c.id === 'ind_top3_share') {
      def.formatter = (cell) => {
        const v = cell.getValue();
        if (v == null) return '';
        const cls = v >= 70 ? 'conc-high' : (v >= 50 ? 'conc-mid' : '');
        const icon = v >= 70 ? '🚨 ' : (v >= 50 ? '⚠️ ' : '');
        return `<span class="${cls}" title="該產業前 3 大個股佔成交額${v.toFixed(1)}%">${icon}${v.toFixed(1)}</span>`;
      };
    }
    return def;
  })];

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

  // 初始 freeze 已勾選的股票
  state.table.on('tableBuilt', () => {
    state.table.getRows().forEach(row => {
      if (state.pinned.has(row.getData().ticker)) row.freeze();
    });
  });
  updatePinSummary();
}

// ── 6. 篩選邏輯 ─────────────────────────────────────
function applyFilters() {
  if (!state.table) return;

  state.table.setFilter((row) => {
    // 只看勾選
    if (state.onlyPinned && !state.pinned.has(row.ticker)) return false;
    // 只看共振（同時被 ≥2 策略 actionable：突破/Hanku/三浪）
    if (state.onlyResonance && _resoCount(row) < 2) return false;
    // 只顯示族群 z≥1
    if (state.onlyHotGroup && (row.max_group_z == null || row.max_group_z < 1)) return false;
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

    // 主升策略：sig=勾選旗標全中｜A=高勝率3且非出貨｜B=Z_主升飆股🔥
    if (state.mainupMode === 'sig') {
      for (const s of state.mainupSignals) if (row[s] !== 1) return false;
    } else if (state.mainupMode === 'A') {
      if ((row.win_n ?? 0) < 3) return false;
      if (row.mainup_dist === 1) return false;
    } else if (state.mainupMode === 'B') {
      if (!(row.mainup_tag && String(row.mainup_tag).includes('飆股'))) return false;
    }
    // 進場型態 / 排除出貨：任何模式皆生效（獨立精修）
    if (state.mainupEntry && row.mainup_entry !== state.mainupEntry) return false;
    if (state.mainupExclDist && row.mainup_dist === 1) return false;

    return true;
  });

  // 主升 sig/B 模式：依量比由大到小排序
  if (state.mainupMode === 'sig' || state.mainupMode === 'B') {
    state.table.setSort('vol_ratio', 'desc');
  }

  // 更新計數摘要 + 已選條件列 + 分組徽章
  setTimeout(() => {
    const visible = state.table.getDataCount('active');
    const total = state.table.getDataCount();
    document.getElementById('row-count').textContent = `${visible}/${total} 檔`;
    renderActiveFilters();
    updateGroupCounts();
    refreshMainView();
  }, 0);
}

// ── 6b. 已選條件 chip 列 / 分組徽章 / 收合 ───────────────
const DIM_LABEL = { industry: '產業', sector: '類股', concept: '題材' };
const MAINUP_MODE_LABEL = { sig: '自訂', A: '穩健A', B: '獵飆B' };

function renderActiveFilters() {
  const bar = document.getElementById('active-filters');
  if (!bar) return;
  const chips = [];
  const add = (key, label) => chips.push({ key, label });
  if (state.selectedCats.size) add('cat', `分類:${state.selectedCats.size}(${state.mode})`);
  if (state.mainupMode !== 'off') {
    let l = `主升:${MAINUP_MODE_LABEL[state.mainupMode]}`;
    if (state.mainupMode === 'sig') l += `(${[...state.mainupSignals].length}旗標)`;
    add('mainup', l);
  }
  if (state.mainupEntry) add('mainupEntry', `進場:${state.mainupEntry}`);
  if (state.mainupExclDist) add('mainupExcl', '排除出貨');
  if (state.dimSelected.size) add('dim', `${DIM_LABEL[state.dim]}:${state.dimSelected.size}`);
  if (state.search) add('search', `搜尋:${state.search}`);
  if (state.scoreMin > 0) add('scoreMin', `分數≥${state.scoreMin}`);
  if (state.rsMin > 0) add('rsMin', `RS≥${state.rsMin}`);
  if (state.distRiskMax != null) add('distRiskMax', `出貨風險≤${state.distRiskMax}`);
  if (state.groupZMin != null) add('groupZMin', `族群z≥${state.groupZMin}`);
  if (state.onlyResonance) add('onlyResonance', '⚡只看共振');
  if (state.onlyHotGroup) add('onlyHotGroup', '族群z≥1');
  if (state.onlyPinned) add('onlyPinned', '只看勾選');

  if (!chips.length) {
    bar.innerHTML = '<span class="af-empty">未套用任何篩選</span>';
    return;
  }
  bar.innerHTML = chips.map(c =>
    `<span class="afchip">${c.label}<button class="afx" data-key="${c.key}" title="移除">✕</button></span>`
  ).join('');
  bar.querySelectorAll('.afx').forEach(b =>
    b.addEventListener('click', () => removeFilter(b.dataset.key)));
}

function updateGroupCounts() {
  const set = (id, n) => { const e = document.getElementById(id); if (e) e.textContent = n ? ` ${n}` : ''; };
  set('fgc-cat', state.selectedCats.size);
  set('fgc-mainup', (state.mainupMode !== 'off' ? 1 : 0) +
                    (state.mainupEntry ? 1 : 0) + (state.mainupExclDist ? 1 : 0));
  set('fgc-dim', state.dimSelected.size);
  set('fgc-thresh', (state.scoreMin > 0 ? 1 : 0) + (state.rsMin > 0 ? 1 : 0) +
                    (state.distRiskMax != null ? 1 : 0) + (state.groupZMin != null ? 1 : 0));
}

function removeFilter(key) {
  switch (key) {
    case 'cat':
      state.selectedCats.clear();
      document.querySelectorAll('.cat-chip input').forEach(cb => { cb.checked = false; cb.parentElement.classList.remove('checked'); });
      break;
    case 'mainup':
      state.mainupMode = 'off';
      document.querySelector('input[name="mainup-mode"][value="off"]').checked = true;
      { const s = document.getElementById('mainup-signals'); if (s) s.hidden = true; }
      break;
    case 'mainupEntry':
      state.mainupEntry = ''; { const e = document.getElementById('mainup-entry'); if (e) e.value = ''; }
      break;
    case 'mainupExcl':
      state.mainupExclDist = false; { const e = document.getElementById('mainup-excl-dist'); if (e) e.checked = false; }
      break;
    case 'dim':
      state.dimSelected.clear();
      [...document.getElementById('dim-select').options].forEach(o => o.selected = false);
      if (state.data) renderDimensionOptions();
      break;
    case 'search':
      state.search = ''; document.getElementById('search-input').value = '';
      break;
    case 'scoreMin': state.scoreMin = 0; document.getElementById('score-min').value = 0; break;
    case 'rsMin': state.rsMin = 0; document.getElementById('rs-min').value = 0; break;
    case 'distRiskMax': state.distRiskMax = null; document.getElementById('dist-risk-max').value = ''; break;
    case 'groupZMin': state.groupZMin = null; document.getElementById('group-z-min').value = ''; break;
    case 'onlyResonance': state.onlyResonance = false; document.getElementById('only-resonance').checked = false; break;
    case 'onlyHotGroup': state.onlyHotGroup = false; document.getElementById('only-hot-group').checked = false; break;
    case 'onlyPinned': {
      state.onlyPinned = false;
      const b = document.getElementById('btn-only-pinned');
      if (b) { b.classList.remove('btn-active'); b.textContent = '★ 只看勾選'; }
      break;
    }
  }
  applyFilters();
}

function bindGroupToggles() {
  document.querySelectorAll('.fg-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const g = btn.dataset.group;
      const body = document.querySelector(`.fg-body[data-group="${g}"]`);
      if (!body) return;
      const willOpen = body.hidden;
      body.hidden = !willOpen;
      btn.classList.toggle('open', willOpen);
    });
  });
}

// ── 7. 綁定篩選控制項 ───────────────────────────────
function bindControls() {
  document.querySelectorAll('input[name="mode"]').forEach(r => {
    r.addEventListener('change', e => { state.mode = e.target.value; applyFilters(); });
  });

  document.getElementById('search-input').addEventListener('input', e => {
    state.search = e.target.value.trim(); applyFilters();
  });

  // 每日看板 表格 ⇄ 卡片 切換
  const mvt = document.getElementById('main-viewtoggle');
  if (mvt) mvt.querySelectorAll('.vt-btn').forEach(b => b.addEventListener('click', () => {
    state.mainView = b.dataset.view;
    setTabView('main', b.dataset.view);
    refreshMainView();
  }));
  const mcs = document.getElementById('main-card-sort');
  if (mcs) mcs.addEventListener('change', refreshMainView);

  // 主升模式 radio + 5 訊號 checkbox
  document.querySelectorAll('input[name="mainup-mode"]').forEach(r => {
    r.addEventListener('change', e => {
      state.mainupMode = e.target.value;
      const sigBox = document.getElementById('mainup-signals');  // 漸進揭露：只在「自訂」顯示
      if (sigBox) sigBox.hidden = (e.target.value !== 'sig');
      applyFilters();
    });
  });
  document.querySelectorAll('input[name="mainup-sig"]').forEach(cb => {
    cb.addEventListener('change', e => {
      if (e.target.checked) state.mainupSignals.add(e.target.value);
      else state.mainupSignals.delete(e.target.value);
      applyFilters();
    });
  });
  const muEntry = document.getElementById('mainup-entry');
  if (muEntry) muEntry.addEventListener('change', e => { state.mainupEntry = e.target.value; applyFilters(); });
  const muExcl = document.getElementById('mainup-excl-dist');
  if (muExcl) muExcl.addEventListener('change', e => { state.mainupExclDist = e.target.checked; applyFilters(); });

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

  const hotChk = document.getElementById('only-hot-group');
  if (hotChk) {
    hotChk.addEventListener('change', e => {
      state.onlyHotGroup = e.target.checked;
      applyFilters();
    });
  }

  const resoChk = document.getElementById('only-resonance');
  if (resoChk) {
    resoChk.addEventListener('change', e => {
      state.onlyResonance = e.target.checked;
      applyFilters();
    });
  }

  document.getElementById('btn-only-pinned').addEventListener('click', (e) => {
    state.onlyPinned = !state.onlyPinned;
    e.target.classList.toggle('btn-active', state.onlyPinned);
    e.target.textContent = state.onlyPinned ? '★ 只看勾選（開）' : '★ 只看勾選';
    applyFilters();
  });
  document.getElementById('btn-clear-pinned').addEventListener('click', () => {
    if (!confirm(`清空全部勾選（${state.pinned.size} 檔）？`)) return;
    state.pinned.clear();
    savePinned();
    updatePinSummary();
    if (state.table) {
      state.table.getRows().forEach(row => { try { row.unfreeze(); } catch(_){} });
      state.table.redraw(true);
      if (state.onlyPinned) {
        state.onlyPinned = false;
        document.getElementById('btn-only-pinned').classList.remove('btn-active');
        document.getElementById('btn-only-pinned').textContent = '★ 只看勾選';
        applyFilters();
      }
    }
  });
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
  state.mainupMode = 'off';
  state.mainupSignals = new Set(['s1', 's2', 's3', 's4', 's5', 'c1', 'c2', 'c3', 'mainup_ma60']);
  state.mainupEntry = '';
  state.mainupExclDist = false;

  document.querySelectorAll('.cat-chip input').forEach(cb => { cb.checked = false; cb.parentElement.classList.remove('checked'); });
  document.querySelector('input[name="mode"][value="OR"]').checked = true;
  const muOff = document.querySelector('input[name="mainup-mode"][value="off"]');
  if (muOff) muOff.checked = true;
  document.querySelectorAll('input[name="mainup-sig"]').forEach(cb => { cb.checked = true; });
  const muSig = document.getElementById('mainup-signals'); if (muSig) muSig.hidden = true;
  const muE = document.getElementById('mainup-entry'); if (muE) muE.value = '';
  const muD = document.getElementById('mainup-excl-dist'); if (muD) muD.checked = false;
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

// ── 自選股 watch list 分頁 ───────────────────────────
function renderWatchlist() {
  if (!state.data) return;
  const pinned = state.pinned;
  const rows = (state.data.rows || []).filter(r => pinned.has(r.ticker));

  document.getElementById('watchlist-count').textContent = `${rows.length} 檔`;
  const clr = document.getElementById('btn-watch-clear');
  if (clr) clr.disabled = rows.length === 0;

  const cmap = state.data._catColor || {};

  if (watchState.table) watchState.table.destroy();

  if (rows.length === 0) {
    document.getElementById('watchlist-table').innerHTML =
      `<div style="padding:30px;color:#888;text-align:center">
        尚未勾選任何個股 — 到「📊 每日看板」點 ☆ 加入
      </div>`;
    watchState.table = null;
    return;
  }

  watchState.table = new Tabulator('#watchlist-table', {
    data: rows,
    layout: 'fitColumns',
    height: 'calc(100vh - 280px)',
    initialSort: [{ column: 'hits', dir: 'desc' }, { column: 'score', dir: 'desc' }],
    placeholder: '尚未勾選個股',
    columns: [
      {
        title: '📌', field: '_pin', width: 44, hozAlign: 'center', headerSort: false,
        formatter: () => '<span style="color:#ffd166;font-size:16px">★</span>',
        cellClick: (e, cell) => {
          const t = cell.getRow().getData().ticker;
          togglePin(t);
          renderWatchlist();
        },
      },
      {
        title: '代號', field: 'ticker', widthGrow: 0.6,
        formatter: (cell) => {
          const r = cell.getRow().getData();
          return `<a class="ticker-link" href="${tvUrl(r.ticker, r.market)}" target="_blank">${r.ticker}</a>`;
        },
      },
      { title: '名稱', field: 'name', widthGrow: 1 },
      {
        title: '當日%', field: 'chg_pct', hozAlign: 'right', widthGrow: 0.6, sorter: 'number',
        formatter: (c) => {
          const v = c.getValue();
          if (v == null) return '';
          const cls = v > 0 ? 'num-pos' : (v < 0 ? 'num-neg' : '');
          return `<span class="${cls}">${v > 0 ? '+' : ''}${v.toFixed(2)}</span>`;
        },
      },
      {
        title: '命中數', field: 'hits', hozAlign: 'right', widthGrow: 0.5, sorter: 'number',
        formatter: (c) => {
          const v = c.getValue();
          if (v == null || v === 0) return '<span class="muted">0</span>';
          if (v >= 3) return `<span class="hits-strong">×${v}</span>`;
          if (v >= 2) return `<span class="hits-mid">×${v}</span>`;
          return `<span>${v}</span>`;
        },
      },
      {
        title: '命中策略', field: 'hit_strategy', widthGrow: 1.6, headerSort: false,
        formatter: (cell) => {
          const row = cell.getRow().getData();
          const cats = row.categories || [];
          return cats.map(code =>
            `<span class="cat-tag" style="background:${cmap[code] || '#888'}">${code}</span>`
          ).join('') || '<span class="muted">—</span>';
        },
      },
      {
        title: '分數', field: 'score', hozAlign: 'right', widthGrow: 0.5, sorter: 'number',
        formatter: (c) => c.getValue() != null ? c.getValue().toFixed(1) : '',
      },
      { title: '產業', field: 'industry', widthGrow: 1 },
      {
        title: '族群集中%', field: 'ind_top3_share', hozAlign: 'right', widthGrow: 0.7, sorter: 'number',
        formatter: (c) => {
          const v = c.getValue();
          if (v == null) return '';
          const cls = v >= 70 ? 'conc-high' : (v >= 50 ? 'conc-mid' : '');
          const icon = v >= 70 ? '🚨 ' : (v >= 50 ? '⚠️ ' : '');
          return `<span class="${cls}">${icon}${v.toFixed(1)}</span>`;
        },
      },
      {
        title: '族群最高z', field: 'max_group_z', hozAlign: 'right', widthGrow: 0.6, sorter: 'number',
        formatter: (c) => {
          const v = c.getValue();
          if (v == null) return '';
          const cls = v >= 1.5 ? 'num-pos' : (v >= 0.5 ? 'num-pos-soft' : '');
          return `<span class="${cls}">${v > 0 ? '+' : ''}${v.toFixed(2)}</span>`;
        },
      },
      { title: '熱類股', field: 'hot_sector', widthGrow: 1.2, headerSort: false },
      { title: '熱題材', field: 'hot_concept', widthGrow: 1.5, headerSort: false },
      {
        title: '收盤', field: 'close', hozAlign: 'right', widthGrow: 0.5, sorter: 'number',
        formatter: (c) => c.getValue() != null ? c.getValue().toFixed(2) : '',
      },
    ],
  });
}

function bindWatchlistControls() {
  const clr = document.getElementById('btn-watch-clear');
  if (clr) {
    clr.addEventListener('click', () => {
      if (!confirm(`清空全部勾選（${state.pinned.size} 檔）？`)) return;
      state.pinned.clear();
      savePinned();
      updatePinSummary();
      renderWatchlist();
      // 主表也要刷新
      if (state.table) {
        state.table.getRows().forEach(row => { try { row.unfreeze(); } catch(_){} });
        state.table.redraw(true);
      }
    });
  }
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
      if (tab === 'watchlist') {
        renderWatchlist();   // 每次切到都重渲染，反應 pin 變更
      }
      if (tab === 'hanku') {
        loadHanku();
      }
      if (tab === 'wave3') {
        loadWave3();
      }
      if (tab === 'sector-flow') {
        // 泡泡圖＝獨立頁 sector.html，首次切入才設 src（lazy，避免未看就抓資料）
        const f = document.getElementById('sf-bubble-frame');
        if (f && !f.src) f.src = f.dataset.src;
      }
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
      if (tab === 'warrant') {
        loadWarrants();
      }
      if (tab === 'cb') {
        loadCB();
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

  rankState.indTable.on('rowClick', (e, row) => {
    const ind = row.getData().industry;
    if (!ind) return;
    rankState.selectedIndustry = ind;
    rankState.selectedSub = null;
    rankState.indTable.getRows().forEach(r => r.reformat());
    renderSubIndustry();
    renderIndustryStocks('industry', ind);
    renderIndustryHistory('industry', ind);
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

  rankState.subTable.on('rowClick', (e, row) => {
    const sub = row.getData().sub_industry;
    if (!sub) return;
    rankState.selectedSub = sub;
    rankState.subTable.getRows().forEach(r => r.reformat());
    renderIndustryStocks('sub_industry', sub);
    renderIndustryHistory('sub_industry', sub);
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
  // 切最近 N 日
  const n = rankState.historyN || 20;
  history = history.slice(-n);
  document.getElementById('ind-history-label').textContent =
    `📊 ${name} — 平均漲跌（${history.length} 日）`;

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
  const daysSel = document.getElementById('ind-days');
  if (daysSel) {
    daysSel.addEventListener('change', e => {
      rankState.days = e.target.value;
      renderIndustryRanking();
      if (rankState.selectedSub) {
        renderIndustryStocks('sub_industry', rankState.selectedSub);
        renderIndustryHistory('sub_industry', rankState.selectedSub);
      } else if (rankState.selectedIndustry) {
        renderIndustryStocks('industry', rankState.selectedIndustry);
        renderIndustryHistory('industry', rankState.selectedIndustry);
      }
    });
  }
  // 歷史 pane N 日切換
  const histN = document.getElementById('ind-history-n');
  if (histN) {
    histN.addEventListener('change', e => {
      rankState.historyN = parseInt(e.target.value, 10);
      const lvl = rankState.selectedSub ? 'sub_industry' : 'industry';
      const name = rankState.selectedSub || rankState.selectedIndustry;
      if (name) renderIndustryHistory(lvl, name);
    });
  }
}

// ── Z. 資金流向 ─────────────────────────────────────
async function loadFlow() {
  if (flowState.loaded && flowState.window === 20) {
    bindFlowWindowSelector();
    return;
  }
  await _loadFlowWindow(flowState.window);
  bindFlowWindowSelector();
}

async function _loadFlowWindow(win) {
  try {
    if (flowState.cache[win]) {
      flowState.data = flowState.cache[win];
    } else {
      const fname = win === 20 ? 'industry_flow' : `industry_flow_${win}`;
      flowState.data = await fetchJsonGz(dailyPath(fname));
      flowState.cache[win] = flowState.data;
    }
    flowState.window = win;
    flowState.loaded = true;
    flowState.selectedIndustry = null;
    flowState.selectedSub = null;

    document.getElementById('flow-meta').textContent =
      `${flowState.data.data_source}｜window=${flowState.data.window} 日`;
    document.getElementById('flow-updated').textContent =
      `更新於 ${flowState.data.generated_at.slice(11, 16)}｜交易日 ${flowState.data.trading_date}`;

    bindFlowTableClicks();
    renderFlowIndTable();
    renderFlowSubTable();
    // 清空右下兩格
    ['flow-stocks-table', 'flow-history-table'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '';
    });
    ['stocksTable', 'historyTable'].forEach(k => {
      if (flowState[k]) { flowState[k].destroy(); flowState[k] = null; }
    });
  } catch (err) {
    document.getElementById('flow-ind-table').innerHTML =
      `<div style="padding:30px;color:#ff6b6b">❌ 載入失敗：${err.message}（window=${win}）</div>`;
  }
}

let _flowSelectorBound = false;
function bindFlowWindowSelector() {
  if (_flowSelectorBound) return;
  _flowSelectorBound = true;
  const sel = document.getElementById('flow-window');
  if (!sel) return;
  sel.addEventListener('change', e => {
    _loadFlowWindow(parseInt(e.target.value, 10));
  });
}

// ── 跨 window 排名 mini bar 渲染 ─────────────
const FLOW_WINDOWS_ORDER = [1, 3, 5, 10, 20, 40, 60];
function _rankClass(r) {
  if (r == null) return 'rk-none';
  if (r <= 5)  return 'rk-top5';
  if (r <= 10) return 'rk-top10';
  if (r <= 20) return 'rk-top20';
  if (r <= 50) return 'rk-top50';
  return 'rk-low';
}
function renderRankTrend(ranks, currentWin) {
  if (!ranks) return '';
  return '<div class="rk-row">' + FLOW_WINDOWS_ORDER.map(w => {
    const r = ranks[String(w)];
    const cls = _rankClass(r);
    const cur = currentWin && String(w) === String(currentWin) ? ' rk-cur' : '';
    const label = r != null ? `#${r}` : '–';
    return `<span class="rk-cell ${cls}${cur}" title="${w}日: ${label}"><b>${w}</b>${label}</span>`;
  }).join('') + '</div>';
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
      title: '方向', field: 'direction', widthGrow: 0.8, hozAlign: 'center', headerSort: false,
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
    { title: '排名延續', field: 'ranks', widthGrow: 2.2, headerSort: false,
      formatter: (c) => renderRankTrend(c.getValue(), flowState.window) },
    { title: '持續', field: 'persistence', widthGrow: 1, headerSort: false },
    { title: '備註', field: 'note', widthGrow: 0.8, headerSort: false },
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
      { title: '方向', field: 'direction', widthGrow: 0.8, hozAlign: 'center', headerSort: false },
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
      { title: '排名延續', field: 'ranks', widthGrow: 2.2, headerSort: false,
        formatter: (c) => renderRankTrend(c.getValue(), flowState.window) },
      { title: '持續', field: 'persistence', widthGrow: 1, headerSort: false },
      { title: '備註', field: 'note', widthGrow: 0.8, headerSort: false },
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
      { title: '方向', field: 'direction', widthGrow: 0.8, hozAlign: 'center', headerSort: false },
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
      { title: '排名延續', field: 'ranks', widthGrow: 2.2, headerSort: false,
        formatter: (c) => renderRankTrend(c.getValue(), flowState.window) },
      { title: '持續', field: 'persistence', widthGrow: 1, headerSort: false },
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

let _flowClicksBound = false;
function bindFlowTableClicks() {
  if (_flowClicksBound) return;
  _flowClicksBound = true;
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
  if (themeState.loaded && themeState.window === 20) {
    _bindThemeOnce();
    return;
  }
  await _loadThemeWindow(themeState.window);
  _bindThemeOnce();
}

async function _loadThemeWindow(win) {
  try {
    if (themeState.cache[win]) {
      themeState.data = themeState.cache[win];
    } else {
      const fname = win === 20 ? 'theme_flow' : `theme_flow_${win}`;
      themeState.data = await fetchJsonGz(dailyPath(fname));
      themeState.cache[win] = themeState.data;
    }
    themeState.window = win;
    themeState.loaded = true;
    themeState.selectedItem = null;
    document.getElementById('theme-updated').textContent =
      `${themeState.data.data_source}｜window=${themeState.data.window}｜更新 ${themeState.data.generated_at.slice(11, 16)}`;
    document.getElementById('theme-stocks-title').textContent = '個股貢獻（點題材查看）';
    document.getElementById('theme-history-title').textContent = `${win} 日 z-score 歷史（點題材查看）`;
    if (themeState.stocksTable) { themeState.stocksTable.destroy(); themeState.stocksTable = null; }
    if (themeState.historyTable) { themeState.historyTable.destroy(); themeState.historyTable = null; }
    renderThemeList();
  } catch (err) {
    document.getElementById('theme-list-table').innerHTML =
      `<div style="padding:30px;color:#ff6b6b">❌ 載入失敗：${err.message}（window=${win}）</div>`;
  }
}

let _themeBound = false;
function _bindThemeOnce() {
  if (_themeBound) return;
  _themeBound = true;
  document.querySelectorAll('.subtab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.subtab-btn').forEach(b => b.classList.toggle('active', b === btn));
      themeState.subtab = btn.dataset.subtab;
      themeState.selectedItem = null;
      renderThemeList();
      document.getElementById('theme-stocks-title').textContent = '個股貢獻（點題材查看）';
      document.getElementById('theme-history-title').textContent = `${themeState.window} 日 z-score 歷史（點題材查看）`;
      if (themeState.stocksTable) { themeState.stocksTable.destroy(); themeState.stocksTable = null; }
      if (themeState.historyTable) { themeState.historyTable.destroy(); themeState.historyTable = null; }
    });
  });

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

  const sel = document.getElementById('theme-window');
  if (sel) sel.addEventListener('change', e => {
    _loadThemeWindow(parseInt(e.target.value, 10));
  });
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
      { title: '方向', field: 'direction', widthGrow: 0.8, hozAlign: 'center', headerSort: false },
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
      { title: '排名延續', field: 'ranks', widthGrow: 2.2, headerSort: false,
        formatter: (c) => renderRankTrend(c.getValue(), themeState.window) },
      { title: '持續', field: 'persistence', widthGrow: 1, headerSort: false },
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

// 兩個 ISO 日期(d1<d2)間的交易日數(扣週末) — 用來算期貨落後幾天
function _tradingDaysBehind(d1, d2) {
  let n = 0;
  const a = new Date(d1 + 'T00:00:00'), b = new Date(d2 + 'T00:00:00');
  for (let t = new Date(a); t < b; t.setDate(t.getDate() + 1)) {
    const wd = t.getDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
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

  // 現貨 vs 期貨 日期不同步警示（期貨/OI 來源落後時提醒，避免綜合分數混算誤判）
  let staleHTML = '';
  if (s.equity_date && s.futures_date && s.futures_date < s.equity_date) {
    const lag = _tradingDaysBehind(s.futures_date, s.equity_date);
    staleHTML = `<div class="market-stale">⚠ 期貨/OI 資料落後 ${lag} 個交易日
      （現貨 ${s.equity_date}，期貨僅到 ${s.futures_date}）—
      綜合判斷仍含舊期貨資料，僅供參考；補齊期貨來源後重跑匯出即同步</div>`;
  }

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
    ${staleHTML}
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

    buildTickerIndustry(data);
    renderMeta(data);
    renderCategoryChips(data.categories);
    renderDimensionOptions();
    buildTable(data);
    renderFocusStrip(data);
    loadResonanceData();
    bindControls();
    bindGroupToggles();
    bindTabs();
    bindWatchlistControls();
    refreshPresetSelect();
    applyFilters();
  } catch (err) {
    document.getElementById('main-table').innerHTML =
      `<div style="padding:30px;color:#ff6b6b">❌ 載入失敗：${err.message}</div>`;
    console.error(err);
  }
})();


// ─── 權證自選清單 ────────────────────────────────────
const WW_STORE = 'warrant_watch_v1';
const warrantWatchState = { list: [], subtab: 'query' };

function wwLoad() {
  try { warrantWatchState.list = JSON.parse(localStorage.getItem(WW_STORE) || '[]'); }
  catch { warrantWatchState.list = []; }
}
function wwSave() {
  localStorage.setItem(WW_STORE, JSON.stringify(warrantWatchState.list));
}
function wwAdd(code) {
  code = String(code).trim();
  if (!code || warrantWatchState.list.includes(code)) return;
  warrantWatchState.list.push(code);
  wwSave();
  renderWarrantWatch();
}
function wwRemove(code) {
  warrantWatchState.list = warrantWatchState.list.filter(c => c !== code);
  wwSave();
  renderWarrantWatch();
}

function renderWarrantWatch() {
  const container = document.getElementById('warrant-watch-cards');
  if (!container) return;
  const strat = document.getElementById('ww-strategy')?.value || '短打';
  const us = warrantState.data?.underlyings || {};

  if (!warrantState.data) {
    container.innerHTML = '<div style="padding:40px;color:#ff9d00;text-align:center">⚠️ 尚未載入權證資料，請稍後再試</div>';
    return;
  }
  if (warrantWatchState.list.length === 0) {
    container.innerHTML = '<div style="padding:40px;color:#888;text-align:center">清單是空的，在上方輸入股號後按「＋ 加入」</div>';
    return;
  }

  container.innerHTML = warrantWatchState.list.map(code => {
    const u = us[code];
    if (!u) {
      return `<div class="ww-card ww-card-missing">
        <div class="ww-card-head">
          <span class="ww-code">${code}</span>
          <span class="muted" style="margin-left:8px">資料中無此標的（無認購權證或未達門檻）</span>
          <button class="ww-rm btn btn-ghost btn-danger" data-code="${code}" style="margin-left:auto">✕</button>
        </div>
      </div>`;
    }
    const top = (u.strategies?.[strat] || [])[0];
    const topHtml = top
      ? `<div class="ww-best">
           <span class="ww-strat-lbl">${strat} #1</span>
           <b>${top['權證代號'] || ''}</b>
           <span style="color:#aaa;margin:0 4px">${top['權證名稱'] || ''}</span>
           <span class="ww-check">${top['小哥檢核'] || ''}</span>
           <span class="ww-attrs">
             ${top['剩餘天數'] != null ? `剩<b>${top['剩餘天數']}</b>天` : ''}
             ${top['有效槓桿'] != null ? `槓<b>${Number(top['有效槓桿']).toFixed(1)}x</b>` : ''}
             ${top['隱含波動率'] != null ? `IV<b>${Number(top['隱含波動率']).toFixed(0)}%</b>` : ''}
             ${top['分數'] != null ? `分<b>${Number(top['分數']).toFixed(1)}</b>` : ''}
           </span>
         </div>`
      : `<div class="ww-best muted" style="padding:4px 0">該策略下無排名</div>`;

    return `<div class="ww-card">
      <div class="ww-card-head">
        <span class="ww-code">${code}</span>
        <span class="ww-name">${u.name || ''}</span>
        <span class="ww-price">${u.price != null ? u.price.toFixed(1) : '—'}</span>
        <span class="muted" style="margin-left:8px">認購${u.warrant_count || 0}檔　IV均${u.avg_iv ?? '—'}%</span>
        <button class="ww-detail btn btn-ghost" data-code="${code}" style="margin-left:auto">🔍 詳查</button>
        <button class="ww-rm btn btn-ghost btn-danger" data-code="${code}" style="margin-left:4px">✕</button>
      </div>
      ${topHtml}
    </div>`;
  }).join('');

  container.querySelectorAll('.ww-rm').forEach(btn => {
    btn.addEventListener('click', () => wwRemove(btn.dataset.code));
  });
  container.querySelectorAll('.ww-detail').forEach(btn => {
    btn.addEventListener('click', () => {
      setWarrantSubtab('query');
      document.getElementById('warrant-stock').value = btn.dataset.code;
      renderWarrant();
    });
  });
}

function setWarrantSubtab(sub) {
  warrantWatchState.subtab = sub;
  document.querySelectorAll('.warrant-subtab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.wsub === sub));
  document.getElementById('warrant-query-panel').style.display = sub === 'query' ? '' : 'none';
  document.getElementById('warrant-watch-panel').style.display  = sub === 'watch'  ? '' : 'none';
  if (sub === 'watch') renderWarrantWatch();
}

function bindWarrantWatchControls() {
  if (bindWarrantWatchControls._done) return;
  bindWarrantWatchControls._done = true;
  wwLoad();

  document.querySelectorAll('.warrant-subtab-btn').forEach(btn => {
    btn.addEventListener('click', () => setWarrantSubtab(btn.dataset.wsub));
  });

  const input = document.getElementById('ww-input');
  document.getElementById('ww-add-btn')?.addEventListener('click', () => {
    wwAdd(input.value); input.value = '';
  });
  input?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { wwAdd(input.value); input.value = ''; }
  });
  document.getElementById('ww-clear-btn')?.addEventListener('click', () => {
    if (!confirm('確定清空自選清單？')) return;
    warrantWatchState.list = []; wwSave(); renderWarrantWatch();
  });
  document.getElementById('ww-strategy')?.addEventListener('change', renderWarrantWatch);
}

// ─── 權證精選分頁 ────────────────────────────────────
async function loadWarrants() {
  // 切日期會 invalidate
  if (warrantState.loaded && warrantState.loadedDate === currentDate) {
    renderWarrant();
    return;
  }
  const metaEl = document.getElementById('warrant-meta');
  const sumEl  = document.getElementById('warrant-summary');
  const dateOk = (indexMeta?.dates || []).some(
    e => e.date === currentDate && (e.has || []).includes('warrants'));
  if (!dateOk) {
    metaEl.textContent = `⚠️ 日期 ${currentDate} 沒有權證資料`;
    sumEl.innerHTML = `<div style="padding:20px;color:#ff9d00">
      該日期未提供權證排名。請選有 warrants 的日期，或在本地跑 export_warrants_to_json.py 推上來。
    </div>`;
    document.getElementById('warrant-table').innerHTML = '';
    return;
  }
  try {
    metaEl.textContent = '載入中...';
    warrantState.data = await fetchJsonGz(`data/daily/${currentDate}/warrants.json.gz`);
    warrantState.loaded = true;
    warrantState.loadedDate = currentDate;
    metaEl.textContent =
      `資料日 ${warrantState.data.date}　|　${warrantState.data.underlying_count} 標的　|　` +
      `每策略 top ${warrantState.data.top_per_strategy || '不限'}　|　更新 ${warrantState.data.generated_at.slice(11,16)}`;
    collectIssuers();
    renderIssuerChecks();
    bindWarrantControls();
    bindWarrantWatchControls();
    renderWarrant();
    if (warrantWatchState.subtab === 'watch') renderWarrantWatch();
  } catch (err) {
    metaEl.textContent = `❌ ${err.message}`;
    console.error(err);
  }
}

function bindWarrantControls() {
  if (bindWarrantControls._done) return;
  bindWarrantControls._done = true;
  document.getElementById('warrant-query-btn').addEventListener('click', renderWarrant);
  document.getElementById('warrant-stock').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') renderWarrant();
  });
  document.getElementById('warrant-strategy').addEventListener('change', renderWarrant);
  document.getElementById('warrant-limit').addEventListener('change', renderWarrant);
  document.getElementById('warrant-issuer-all').addEventListener('click', () => {
    warrantState.issuerSel = new Set(WARRANT_MAJOR_ISSUERS.filter(i => warrantState.allIssuers.includes(i)));
    renderIssuerChecks(); renderWarrant();
  });
  document.getElementById('warrant-issuer-clear').addEventListener('click', () => {
    warrantState.issuerSel = null;   // null = 全選
    renderIssuerChecks(); renderWarrant();
  });
  document.getElementById('warrant-issuer-none').addEventListener('click', () => {
    warrantState.issuerSel = new Set();
    renderIssuerChecks(); renderWarrant();
  });
}

function collectIssuers() {
  const counts = {};
  const us = warrantState.data?.underlyings || {};
  for (const code in us) {
    for (const strat in us[code].strategies) {
      for (const row of us[code].strategies[strat]) {
        const iss = row['發行券商'];
        if (iss) counts[iss] = (counts[iss] || 0) + 1;
      }
    }
  }
  warrantState.allIssuers = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(e => e[0]);
}

function renderIssuerChecks() {
  const box = document.getElementById('warrant-issuer-checks');
  if (!box) return;
  const sel = warrantState.issuerSel;   // null = 全選
  box.innerHTML = warrantState.allIssuers.map(iss => {
    const checked = (sel == null || sel.has(iss)) ? 'checked' : '';
    const major = WARRANT_MAJOR_ISSUERS.includes(iss) ? 'style="color:#ffd166;font-weight:600"' : '';
    return `<label ${major}><input type="checkbox" data-issuer="${iss}" ${checked} /> ${iss}</label>`;
  }).join('');
  box.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', () => {
      // 第一次勾選/取消 → 把 null 物質化成 Set
      if (warrantState.issuerSel == null) {
        warrantState.issuerSel = new Set(warrantState.allIssuers);
      }
      const iss = cb.dataset.issuer;
      if (cb.checked) warrantState.issuerSel.add(iss);
      else            warrantState.issuerSel.delete(iss);
      renderWarrant();
    });
  });
}

const _fmtNum  = (d) => (c) => { const v = c.getValue(); return v == null ? '' : v.toFixed(d); };
const _fmtPct  = (d) => (c) => { const v = c.getValue(); return v == null ? '' : (v > 0 ? '+' : '') + v.toFixed(d); };
const _fmtInt  = () => (c) => { const v = c.getValue(); return v == null ? '' : v.toLocaleString(); };

const WARRANT_COLS = [
  // ─── 身分 ───
  { title: '排名', field: '排名', width: 60, hozAlign: 'center', sorter: 'number', frozen: true },
  { title: '權證代號', field: '權證代號', width: 90, frozen: true,
    formatter: (c) => `<a class="ticker-link" href="https://tw.tradingview.com/symbols/TPE-${c.getValue()}/" target="_blank">${c.getValue()}</a>` },
  { title: '權證名稱', field: '權證名稱', minWidth: 180, frozen: true },
  { title: '券商', field: '發行券商', width: 70, hozAlign: 'center' },
  // ─── 條款 ───
  { title: '剩餘天', field: '剩餘天數', width: 80, hozAlign: 'right', sorter: 'number' },
  { title: '履約價', field: '履約價', width: 90, hozAlign: 'right', sorter: 'number', formatter: _fmtNum(2) },
  { title: '標的現價', field: '標的現價', width: 90, hozAlign: 'right', sorter: 'number', formatter: _fmtNum(2) },
  { title: '價內外%', field: '價內外', width: 80, hozAlign: 'right', sorter: 'number', formatter: _fmtPct(2) },
  // ─── 績效 ───
  { title: '收盤', field: '權證收盤價', width: 80, hozAlign: 'right', sorter: 'number', formatter: _fmtNum(2) },
  { title: '當日%', field: '權證ROI(%)', width: 80, hozAlign: 'right', sorter: 'number',
    formatter: (c) => {
      const v = c.getValue();
      if (v == null) return '';
      const cls = v > 0 ? 'num-pos' : (v < 0 ? 'num-neg' : '');
      return `<span class="${cls}">${v > 0 ? '+' : ''}${v.toFixed(2)}</span>`;
    } },
  { title: '溢價%', field: '溢價比率', width: 80, hozAlign: 'right', sorter: 'number', formatter: _fmtNum(2) },
  // ─── 槓桿 + 波動 ───
  { title: '有效槓桿', field: '有效槓桿', width: 90, hozAlign: 'right', sorter: 'number', formatter: _fmtNum(2) },
  { title: '成本槓桿', field: '成本槓桿', width: 90, hozAlign: 'right', sorter: 'number', formatter: _fmtNum(2) },
  { title: 'IV%', field: '隱含波動率', width: 70, hozAlign: 'right', sorter: 'number', formatter: _fmtNum(1) },
  { title: 'HV%', field: '歷史波動率', width: 70, hozAlign: 'right', sorter: 'number', formatter: _fmtNum(1) },
  // ─── 希臘字母 ───
  { title: 'DELTA', field: 'DELTA', width: 80, hozAlign: 'right', sorter: 'number', formatter: _fmtNum(4) },
  { title: 'GAMMA', field: 'GAMMA', width: 80, hozAlign: 'right', sorter: 'number', formatter: _fmtNum(4) },
  { title: 'VEGA',  field: 'VEGA',  width: 80, hozAlign: 'right', sorter: 'number', formatter: _fmtNum(4) },
  { title: 'THETA', field: 'THETA', width: 80, hozAlign: 'right', sorter: 'number', formatter: _fmtNum(4) },
  // ─── 理論值 ───
  { title: '理論價', field: '權證理論價格', width: 90, hozAlign: 'right', sorter: 'number', formatter: _fmtNum(2) },
  { title: '高估元', field: '權證高估(元)', width: 80, hozAlign: 'right', sorter: 'number', formatter: _fmtNum(2) },
  { title: '高估%',  field: '權證高估率',   width: 80, hozAlign: 'right', sorter: 'number', formatter: _fmtNum(2) },
  { title: '內含值', field: '內含價值',     width: 80, hozAlign: 'right', sorter: 'number', formatter: _fmtNum(2) },
  { title: '時間值', field: '時間價值',     width: 80, hozAlign: 'right', sorter: 'number', formatter: _fmtNum(2) },
  // ─── 量能 ───
  { title: '成交量(張)', field: '成交量',  width: 100, hozAlign: 'right', sorter: 'number', formatter: _fmtInt() },
  { title: '成交額(元)', field: '成交金額', width: 130, hozAlign: 'right', sorter: 'number', formatter: _fmtInt() },
  { title: '流通%', field: '流通比例', width: 80, hozAlign: 'right', sorter: 'number', formatter: _fmtNum(1) },
  // ─── 排名分數 ───
  { title: '分數', field: '分數', width: 80, hozAlign: 'right', sorter: 'number',
    formatter: (c) => {
      const v = c.getValue();
      if (v == null) return '';
      const cls = v >= 75 ? 'num-pos' : (v < 55 ? 'num-neg' : '');
      return `<span class="${cls}">${v.toFixed(2)}</span>`;
    } },
];

function renderWarrant() {
  if (!warrantState.data) return;
  const stock = String(document.getElementById('warrant-stock').value || '').trim();
  const strat = document.getElementById('warrant-strategy').value;
  const limit = parseInt(document.getElementById('warrant-limit').value, 10);
  const sumEl = document.getElementById('warrant-summary');
  const tblEl = document.getElementById('warrant-table');

  if (!stock) {
    sumEl.innerHTML = '<div class="muted">請輸入股號</div>';
    tblEl.innerHTML = '';
    return;
  }
  const u = warrantState.data.underlyings[stock];
  if (!u) {
    sumEl.innerHTML =
      `<div style="color:#ff9d00">⚠️ 找不到 ${stock}（可能是該標的無認購權證或檔數 &lt; 3）</div>`;
    if (warrantState.table) { warrantState.table.destroy(); warrantState.table = null; }
    tblEl.innerHTML = '';
    return;
  }
  let rows = (u.strategies[strat] || []).slice();
  const totalBeforeFilter = rows.length;

  // 券商過濾（null = 全選 / 空 Set = 都不選）
  const sel = warrantState.issuerSel;
  if (sel != null) {
    rows = rows.filter(r => sel.has(r['發行券商']));
  }

  if (limit > 0) rows = rows.slice(0, limit);

  const issuerSummary = sel == null
    ? '全部券商'
    : (sel.size === 0 ? '未選券商' : `${sel.size} 個券商`);

  sumEl.innerHTML =
    `<span style="font-size:18px;font-weight:700;color:#00d4aa">${stock} ${u.name || ''}</span>` +
    `<span style="margin-left:14px">現價 <b>${u.price != null ? u.price.toFixed(2) : '—'}</b></span>` +
    `<span style="margin-left:14px;color:#aaa">認購權證 ${u.warrant_count} 檔</span>` +
    `<span style="margin-left:14px;color:#aaa">平均 IV ${u.avg_iv ?? '—'}%</span>` +
    `<span style="margin-left:14px;color:#aaa">平均剩餘 ${u.avg_days_left ?? '—'} 天</span>` +
    `<span style="margin-left:14px;color:#888">策略：<b>${strat}</b>　|　${issuerSummary}　|　顯示 ${rows.length} / ${totalBeforeFilter}</span>`;

  if (warrantState.table) warrantState.table.destroy();
  if (rows.length === 0) {
    tblEl.innerHTML = `<div style="padding:30px;color:#888;text-align:center">該策略下無排名</div>`;
    warrantState.table = null;
    return;
  }
  warrantState.table = new Tabulator('#warrant-table', {
    data: rows,
    layout: 'fitDataTable',   // 欄位多，讓水平捲動
    height: 'calc(100vh - 320px)',
    columns: WARRANT_COLS,
    placeholder: '無資料',
  });
}

// ── CB 可轉債監控 ─────────────────────────────────────
const CB_TAG_ICON = {
  '套利窗': '🟢', '賣回套利': '🎯', '觀察': '🟡',
  '高溢價': '🔴', '殭屍': '⚠️', '—': '—',
};

function _cbNum(c, digits) {
  const v = c.getValue();
  if (v == null) return '';
  return Number(v).toFixed(digits);
}

const CB_COLS = [
  { title: '標籤', field: 'tag', width: 96, headerSort: true,
    formatter: c => `${CB_TAG_ICON[c.getValue()] || ''} ${c.getValue() || ''}` },
  { title: 'CB代號', field: 'cb_code', width: 90 },
  { title: 'CB名稱', field: 'cb_name', width: 110 },
  { title: '母股', field: 'stock_code', width: 80,
    formatter: c => {
      const code = c.getValue(); if (!code) return '';
      return `<a href="https://www.tradingview.com/chart/?symbol=TWSE%3A${code}" target="_blank" style="color:#00d4aa">${code}</a>`;
    } },
  { title: '現股價', field: 'stock_price', width: 90, hozAlign: 'right', sorter: 'number',
    formatter: c => _cbNum(c, 2) },
  { title: '轉換價', field: 'conv_price', width: 90, hozAlign: 'right', sorter: 'number',
    formatter: c => _cbNum(c, 2) },
  { title: 'CB市價', field: 'cb_price', width: 90, hozAlign: 'right', sorter: 'number',
    formatter: c => _cbNum(c, 2) },
  { title: 'Parity (理論股價)', field: 'parity', width: 130, hozAlign: 'right', sorter: 'number',
    formatter: c => _cbNum(c, 2) },
  { title: '溢價率 %', field: 'premium_pct', width: 100, hozAlign: 'right', sorter: 'number',
    formatter: c => {
      const v = c.getValue(); if (v == null) return '';
      const cls = v < 5 ? 'num-pos' : (v > 30 ? 'num-neg' : '');
      return `<span class="${cls}">${v.toFixed(2)}</span>`;
    } },
  { title: '賣回殖利率', field: 'yield_pct', width: 100, hozAlign: 'right', sorter: 'number',
    formatter: c => {
      const v = c.getValue(); if (v == null) return '';
      const cls = v > 5 ? 'num-pos' : '';
      return `<span class="${cls}">${v.toFixed(2)}</span>`;
    } },
  { title: '存續(年)', field: 'duration_yr', width: 90, hozAlign: 'right', sorter: 'number',
    formatter: c => _cbNum(c, 2) },
  { title: 'TCRI', field: 'tcri', width: 70, hozAlign: 'center', sorter: 'number' },
  { title: '5日均量', field: 'vol_5d', width: 90, hozAlign: 'right', sorter: 'number',
    formatter: c => _cbNum(c, 1) },
  { title: '20日均量', field: 'vol_20d', width: 90, hozAlign: 'right', sorter: 'number',
    formatter: c => _cbNum(c, 1) },
  { title: '賣回價', field: 'redeem_price', width: 90, hozAlign: 'right', sorter: 'number',
    formatter: c => _cbNum(c, 2) },
  { title: '賣回日', field: 'redeem_date', width: 105 },
  { title: '到期日', field: 'maturity_date', width: 105 },
];

async function loadCB() {
  if (cbState.loaded && cbState.loadedDate === currentDate) {
    renderCB(); return;
  }
  const metaEl = document.getElementById('cb-meta');
  const sumEl  = document.getElementById('cb-summary');
  const entry = (indexMeta?.dates || []).find(
    e => e.date === currentDate && (e.has || []).includes('cb'));
  let cbDate = currentDate;
  if (!entry) {
    // 找最近一個有 cb 的日期
    const fallback = (indexMeta?.dates || []).find(e => (e.has || []).includes('cb'));
    if (!fallback) {
      metaEl.textContent = '無 CB 資料';
      sumEl.innerHTML = '<div style="padding:20px;color:#aaa">該日期未提供 CB 監控資料。請跑 export_cb_to_json.py。</div>';
      document.getElementById('cb-table').innerHTML = '';
      return;
    }
    cbDate = fallback.date;
  }
  metaEl.textContent = `載入中... (${cbDate})`;
  try {
    cbState.data = await fetchJsonGz(`data/daily/${cbDate}/cb.json.gz`);
    cbState.loaded = true;
    cbState.loadedDate = currentDate;
    metaEl.textContent = `資料日 ${cbState.data.date}　|　${cbState.data.count} 檔　|　更新 ${cbState.data.generated_at.slice(11,16)}`;
    renderCB();
  } catch (err) {
    metaEl.textContent = `載入失敗：${err.message}`;
  }
}

function renderCB() {
  if (!cbState.data) return;
  const tag = document.getElementById('cb-tag').value;
  const q = String(document.getElementById('cb-search').value || '').trim().toLowerCase();
  const tcriMax = parseFloat(document.getElementById('cb-tcri-max').value);
  const volMin = parseFloat(document.getElementById('cb-vol-min').value);
  const premMax = parseFloat(document.getElementById('cb-prem-max').value);

  let rows = cbState.data.rows.slice();
  if (tag !== 'all') rows = rows.filter(r => r.tag === tag);
  if (q) rows = rows.filter(r =>
    (r.cb_code || '').toLowerCase().includes(q) ||
    (r.cb_name || '').toLowerCase().includes(q) ||
    (r.stock_code || '').toLowerCase().includes(q));
  if (!isNaN(tcriMax)) rows = rows.filter(r => r.tcri != null && r.tcri <= tcriMax);
  if (!isNaN(volMin)) rows = rows.filter(r => r.vol_5d != null && r.vol_5d >= volMin);
  if (!isNaN(premMax)) rows = rows.filter(r => r.premium_pct != null && r.premium_pct <= premMax);

  // 預設排序：套利窗按 5日量 desc；其他按溢價率 asc
  if (tag === '套利窗') rows.sort((a,b)=>(b.vol_5d||0)-(a.vol_5d||0));
  else if (tag === '賣回套利') rows.sort((a,b)=>(b.yield_pct||0)-(a.yield_pct||0));
  else rows.sort((a,b)=>(a.premium_pct||0)-(b.premium_pct||0));

  const tc = cbState.data.tag_counts || {};
  document.getElementById('cb-summary').innerHTML =
    `<span style="font-size:15px;font-weight:600">標籤分布：</span>` +
    Object.entries(tc).map(([k,v]) =>
      `<span style="margin-left:10px">${CB_TAG_ICON[k]||''} ${k} <b>${v}</b></span>`).join('') +
    `<span style="margin-left:14px;color:#888">顯示 ${rows.length} 檔</span>`;

  if (cbState.table) cbState.table.destroy();
  cbState.table = new Tabulator('#cb-table', {
    data: rows,
    layout: 'fitDataTable',
    height: 'calc(100vh - 320px)',
    columns: CB_COLS,
    placeholder: '無符合條件的 CB',
  });
}

function initCBControls() {
  ['cb-tag','cb-search','cb-tcri-max','cb-vol-min','cb-prem-max'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const ev = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(ev, () => { if (cbState.loaded) renderCB(); });
  });
}
document.addEventListener('DOMContentLoaded', initCBControls);

// ═════════════════════════════════════════════════════════
//  🌀 Hanku 波段（週4/9 金叉狀態機）分頁
//  讀 data/daily/{date}/hanku.json.gz → 狀態清單 + 點代號開 K 線(含疊加)
// ═════════════════════════════════════════════════════════
const hankuState = { loaded: false, loadedDate: null, data: null, table: null, view: null };

function _hkNum(prec) {
  return (cell) => { const v = cell.getValue(); return (v == null) ? '' : Number(v).toFixed(prec); };
}
function _hkPct(prec) {
  return (cell) => {
    const v = cell.getValue();
    if (v == null) return '';
    const c = v > 0 ? '#ef5350' : (v < 0 ? '#26a69a' : '#9aa');
    return `<span style="color:${c}">${v > 0 ? '+' : ''}${Number(v).toFixed(prec)}</span>`;
  };
}

// ── 卡片檢視（Hanku / 第三浪 共用） ──────────────────
function getTabView(key, fallback = 'card') {
  const s = localStorage.getItem('tabView_' + key);
  return (s === 'card' || s === 'table') ? s : fallback;
}
function setTabView(key, v) { localStorage.setItem('tabView_' + key, v); }
function syncViewToggle(id, view) {
  const vt = document.getElementById(id);
  if (!vt) return;
  vt.querySelectorAll('.vt-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
}
const _cardNum = (v, p = 2) => (v == null || isNaN(v)) ? '--' : Number(v).toFixed(p);
function _cardPct(v, p = 1) {
  if (v == null || isNaN(v)) return '<span class="v">--</span>';
  const cls = v > 0 ? 'pos' : (v < 0 ? 'neg' : '');
  return `<span class="v ${cls}">${v > 0 ? '+' : ''}${Number(v).toFixed(p)}%</span>`;
}
function _chgSpan(v) {
  const cls = v > 0 ? 'pos' : (v < 0 ? 'neg' : '');
  return `<span class="sc-chg ${cls}">${isNaN(v) ? '--' : (v > 0 ? '+' : '') + v.toFixed(2) + '%'}</span>`;
}

// Hanku 排序器
const HANKU_SORT = {
  fresh:     (a, b) => String(b.entry_date || '').localeCompare(String(a.entry_date || '')) || (b.ret_pct ?? -1e9) - (a.ret_pct ?? -1e9),
  gap_asc:   (a, b) => (a.gap ?? 1e9) - (b.gap ?? 1e9),
  ret:       (a, b) => (b.ret_pct ?? -1e9) - (a.ret_pct ?? -1e9),
  chg:       (a, b) => (b.chg_pct ?? -1e9) - (a.chg_pct ?? -1e9),
  dist9_asc: (a, b) => (a.dist_w9 ?? 1e9) - (b.dist_w9 ?? 1e9),
};

function hankuCardHtml(r) {
  const warns = [];
  if (r.warn47) warns.push('⚠️破47');
  if (r.w4_down) warns.push('⚠️4T下彎');
  const fresh = r.entry_date && hankuState.data && r.entry_date === hankuState.data.trading_date;
  return `<button type="button" class="stk-card" data-ticker="${r.ticker}">
    <div class="sc-head">
      <span class="sc-id"><b>${r.ticker}</b> ${r.name || ''}${fresh ? ' <span class="sc-new">🆕剛進場</span>' : ''}</span>
      <span class="sc-state">${r.state || ''}</span>
    </div>
    <div class="sc-price">${_chgSpan(Number(r.chg_pct))}<span class="sc-close">現價 ${_cardNum(r.close)}</span></div>
    <div class="sc-grid">
      <div class="sc-cell"><span class="k">進場</span><span class="v">${_cardNum(r.entry_px)} <small>${r.entry_date ? r.entry_date.slice(5) : ''}</small></span></div>
      <div class="sc-cell"><span class="k">報酬</span>${_cardPct(r.ret_pct)}</div>
      <div class="sc-cell"><span class="k">週9停損</span><span class="v">${_cardNum(r.w9_stop)}</span></div>
      <div class="sc-cell"><span class="k">距9週</span>${_cardPct(r.dist_w9)}</div>
    </div>
    <div class="sc-tags">
      ${r._ind ? `<span class="tag">${r._ind}</span>` : ''}
      <span class="tag">發散 ${_cardNum(r.gap)}</span>
      ${warns.map(w => `<span class="tag tag-warn">${w}</span>`).join('')}
    </div>
  </button>`;
}

function wave3CardHtml(r) {
  const rr = r.rr;
  const rrCls = rr >= 2 ? 'tag-good' : (rr >= 1 ? 'tag-warn' : '');
  return `<button type="button" class="stk-card" data-ticker="${r.ticker}">
    <div class="sc-head">
      <span class="sc-id"><b>${r.ticker}</b> ${r.name || ''}</span>
      <span class="sc-state">${r.state || ''}</span>
    </div>
    <div class="sc-price">${_chgSpan(Number(r.chg_pct))}<span class="sc-close">現價 ${_cardNum(r.close)}</span></div>
    <div class="sc-grid">
      <div class="sc-cell"><span class="k">觸發(過1浪高)</span><span class="v">${_cardNum(r.trigger)}</span></div>
      <div class="sc-cell"><span class="k">距觸發</span>${_cardPct(r.dist_trig)}</div>
      <div class="sc-cell"><span class="k">停損(2浪低)</span><span class="v">${_cardNum(r.stop)}</span></div>
      <div class="sc-cell"><span class="k">目標(Fib)</span><span class="v">${_cardNum(r.target)}</span></div>
    </div>
    <div class="sc-tags">
      ${r._ind ? `<span class="tag">${r._ind}</span>` : ''}
      <span class="tag ${rrCls}">R:R ${rr == null ? '--' : Number(rr).toFixed(2)}</span>
      <span class="tag">報酬 ${r.ret_pct == null ? '--' : (r.ret_pct > 0 ? '+' : '') + Number(r.ret_pct).toFixed(1) + '%'}</span>
      ${r.bull == null ? '' : `<span class="tag">${r.bull ? '大盤多✓' : '大盤空'}</span>`}
    </div>
  </button>`;
}

function renderStockCards(containerId, rows, htmlFn) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!rows.length) { el.innerHTML = '<div class="muted" style="padding:20px">無符合條件的個股</div>'; return; }
  el.innerHTML = rows.map(htmlFn).join('');
  el.querySelectorAll('.stk-card').forEach((card, i) => {
    const r = rows[i];
    card.addEventListener('click', () => openKlineModal(r.ticker, r.name, r.market));
  });
}

// ── 每日看板 卡片檢視 ────────────────────────────────
// 卡片排序器（預設 命中數→分數）
const MAIN_CARD_SORT = {
  hits:        (a, b) => (b.hits || 0) - (a.hits || 0) || (b.score || 0) - (a.score || 0),
  score:       (a, b) => (b.score || 0) - (a.score || 0),
  rs:          (a, b) => (b.rs ?? -1e9) - (a.rs ?? -1e9),
  chg_pct:     (a, b) => (b.chg_pct ?? -1e9) - (a.chg_pct ?? -1e9),
  rr:          (a, b) => (b.rr ?? -1e9) - (a.rr ?? -1e9),
  max_group_z: (a, b) => (b.max_group_z ?? -1e9) - (a.max_group_z ?? -1e9) || (b.score || 0) - (a.score || 0),
  reso:        (a, b) => _resoCount(b) - _resoCount(a) || (b.hits || 0) - (a.hits || 0) || (b.score || 0) - (a.score || 0),
};

function _hitTier(h) {
  h = h || 0;
  if (h >= 4) return 'q-gold';
  if (h === 3) return 'q-silver';
  if (h === 2) return 'q-bronze';
  return 'q-grey';
}

function mainCardHtml(r) {
  const cmap = (state.data && state.data._catColor) || {};
  const catTags = (r.categories || []).map(code =>
    `<span class="cat-tag" style="background:${cmap[code] || '#888'}">${code}</span>`).join('');
  const pinned = state.pinned.has(r.ticker);

  // 可交易性：進場(無價→觀察) / 目標 / RR
  const entry = r.entry_price != null ? _cardNum(r.entry_price)
    : (r.buy_point != null ? _cardNum(r.buy_point) : '觀察');
  const rr = r.rr;
  const rrCls = rr == null ? '' : (rr >= 2 ? 'rr-good' : (rr >= 1 ? 'rr-mid' : 'rr-low'));

  // 旗標：地雷(紅) + 進場型態(綠)
  const flags = [];
  if (r.mainup_entry === '⚠過高勿追') flags.push(['⚠過高勿追', 'f-red']);
  else if (r.mainup_entry) flags.push([r.mainup_entry, 'f-good']);
  if (r.dist_signal && /盤頭|出貨/.test(r.dist_signal)) flags.push(['⚠' + r.dist_signal, 'f-red']);
  if (r.overhead && /壓力|套牢|重/.test(r.overhead)) flags.push(['⚠上方套牢', 'f-warn']);
  const flagHtml = flags.map(([t, c]) => `<span class="tag ${c}">${t}</span>`).join('');

  const hot = (r.max_group_z != null && r.max_group_z >= 1)
    ? '<span class="sc-hot">🔥族群</span>' : '';

  // 跨策略共振徽章
  const hk = resonance.hanku[r.ticker];
  const wv = resonance.wave3[r.ticker];
  const resoN = _resoCount(r);
  const resoBadges =
    (hk ? `<span class="reso-badge reso-hk">🌀${_stripLeadEmoji(hk)}</span>` : '') +
    (wv ? `<span class="reso-badge reso-wv">🌊${_stripLeadEmoji(wv)}</span>` : '');
  const resoRow = resoBadges ? `<div class="sc-reso">${resoBadges}</div>` : '';
  const zap = resoN >= 2 ? '<span class="sc-zap" title="多策略共振">⚡共振</span>' : '';

  return `<div class="stk-card main-card ${_hitTier(r.hits)}${resoN >= 2 ? ' is-reso' : ''}" data-ticker="${r.ticker}">
    <div class="sc-head">
      <span class="sc-id"><b>${r.ticker}</b> ${r.name || ''}</span>
      <span class="sc-head-r">${zap}${hot}<span class="sc-pin ${pinned ? 'on' : ''}" data-pin="${r.ticker}">${pinned ? '★' : '☆'}</span></span>
    </div>
    <div class="sc-quality">
      <span class="q-hit">命中×${r.hits || 0}</span>
      <span class="q-score">分 ${r.score != null ? Math.round(r.score) : '--'}</span>
      <span class="q-rs">RS ${_cardNum(r.rs, 0)}</span>
    </div>
    <div class="sc-price">${_chgSpan(Number(r.chg_pct))}<span class="sc-close">現價 ${_cardNum(r.close)}</span><span class="sc-vol">量 ${_cardNum(r.vol_ratio, 1)}x</span></div>
    <div class="sc-trade">
      <span><i>進場</i>${entry}</span>
      <span><i>目標</i>${_cardNum(r.target)}</span>
      <span><i>RR</i><b class="${rrCls}">${rr == null ? '--' : Number(rr).toFixed(2)}</b></span>
    </div>
    ${resoRow}
    <div class="sc-tags">
      ${r.industry ? `<span class="tag">${r.industry}</span>` : ''}
      ${flagHtml}
      ${catTags}
    </div>
  </div>`;
}

function refreshMainView() {
  if (!state.table) return;
  const view = state.mainView || (state.mainView = getTabView('main', 'card'));
  syncViewToggle('main-viewtoggle', view);
  const cardsEl = document.getElementById('main-cards');
  const tableEl = document.getElementById('main-table');
  const sortEl = document.getElementById('main-card-sort');
  if (view !== 'card') {
    if (cardsEl) { cardsEl.style.display = 'none'; cardsEl.innerHTML = ''; }
    if (sortEl) sortEl.style.display = 'none';
    if (tableEl) tableEl.style.display = '';
    return;
  }
  if (tableEl) tableEl.style.display = 'none';
  if (cardsEl) cardsEl.style.display = '';
  if (sortEl) sortEl.style.display = '';
  const CAP = 200;
  const active = state.table.getData('active');
  const sortKey = (sortEl && sortEl.value) || 'hits';
  active.sort(MAIN_CARD_SORT[sortKey] || MAIN_CARD_SORT.hits);
  const shown = active.slice(0, CAP);
  let html = shown.map(mainCardHtml).join('');
  if (active.length > CAP)
    html += `<div class="muted" style="padding:8px;grid-column:1/-1">顯示前 ${CAP} / 共 ${active.length} 檔（縮小篩選或切表格看全部）</div>`;
  cardsEl.innerHTML = html || '<div class="muted" style="padding:20px">🔍 沒有符合條件的個股</div>';
  cardsEl.querySelectorAll('.main-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.sc-pin')) return;
      const t = card.dataset.ticker;
      const r = active.find(x => String(x.ticker) === String(t));
      openKlineModal(t, r ? r.name : '', r ? r.market : '');
    });
  });
  cardsEl.querySelectorAll('.sc-pin').forEach((p) => {
    p.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePin(p.dataset.pin);
      refreshMainView();
    });
  });
}

const HANKU_COLS = [
  { title: '代號', field: 'ticker', width: 80, frozen: true,
    formatter: (cell) => `<a class="ticker-link" href="#" data-kline-ticker="${cell.getValue()}">${cell.getValue()}</a>`,
    cellClick: (e, cell) => {
      e.preventDefault();
      const r = cell.getRow().getData();
      openKlineModal(cell.getValue(), r.name, r.market);
    } },
  { title: '名稱', field: 'name', width: 100, frozen: true },
  { title: '產業', field: '_ind', width: 110 },
  { title: '狀態', field: 'state', width: 135 },
  { title: '當日%', field: 'chg_pct', width: 78, hozAlign: 'right', sorter: 'number', formatter: _hkPct(2) },
  { title: '現價', field: 'close', width: 76, hozAlign: 'right', sorter: 'number', formatter: _hkNum(2) },
  { title: '報酬%', field: 'ret_pct', width: 80, hozAlign: 'right', sorter: 'number', formatter: _hkPct(1) },
  { title: '進場日', field: 'entry_date', width: 104 },
  { title: '進場價', field: 'entry_px', width: 78, hozAlign: 'right', sorter: 'number', formatter: _hkNum(2) },
  { title: '發散%', field: 'gap', width: 74, hozAlign: 'right', sorter: 'number', formatter: _hkNum(2) },
  { title: '週9停損', field: 'w9_stop', width: 84, hozAlign: 'right', sorter: 'number', formatter: _hkNum(2) },
  { title: '距9週%', field: 'dist_w9', width: 80, hozAlign: 'right', sorter: 'number', formatter: _hkPct(1) },
  { title: '週4守線', field: 'w4', width: 84, hozAlign: 'right', sorter: 'number', formatter: _hkNum(2) },
  { title: '日47', field: 'ma47', width: 76, hozAlign: 'right', sorter: 'number', formatter: _hkNum(2) },
  { title: '破47', field: 'warn47', width: 58, hozAlign: 'center', formatter: (c) => c.getValue() ? '⚠️' : '' },
  { title: '4T下彎', field: 'w4_down', width: 70, hozAlign: 'center', formatter: (c) => c.getValue() ? '⚠️' : '' },
  { title: '出場日', field: 'exit_date', width: 104 },
];

async function loadHanku() {
  if (hankuState.loaded && hankuState.loadedDate === currentDate) { renderHanku(); return; }
  const metaEl = document.getElementById('hanku-meta');
  const sumEl = document.getElementById('hanku-summary');
  const entry = (indexMeta?.dates || []).find(
    e => e.date === currentDate && (e.has || []).includes('hanku'));
  let hkDate = currentDate;
  if (!entry) {
    const fb = (indexMeta?.dates || []).find(e => (e.has || []).includes('hanku'));
    if (!fb) {
      metaEl.textContent = '無 Hanku 資料';
      sumEl.innerHTML = '<div style="padding:20px;color:#aaa">該日期未提供 Hanku 波段資料。請跑 export_hanku_to_json.py。</div>';
      document.getElementById('hanku-table').innerHTML = '';
      return;
    }
    hkDate = fb.date;
  }
  metaEl.textContent = `載入中... (${hkDate})`;
  try {
    hankuState.data = await fetchJsonGz(`data/daily/${hkDate}/hanku.json.gz`);
    hankuState.loaded = true;
    hankuState.loadedDate = currentDate;
    (hankuState.data.rows || []).forEach(r => { r._ind = tickerIndustry[r.ticker] || ''; });
    populateIndustrySelect(document.getElementById('hanku-industry'), hankuState.data.rows);
    const d = hankuState.data;
    metaEl.textContent = `資料日 ${d.trading_date}　|　${d.rows.length} 檔　|　更新 ${(d.generated_at || '').slice(11, 16)}`;
    renderHanku();
  } catch (err) {
    metaEl.textContent = `載入失敗：${err.message}`;
  }
}

function renderHanku() {
  if (!hankuState.data) return;
  const stSel = document.getElementById('hanku-state').value;
  const indSel = (document.getElementById('hanku-industry') || {}).value || 'all';
  const q = String(document.getElementById('hanku-search').value || '').trim().toLowerCase();

  let rows = hankuState.data.rows.slice();
  if (stSel !== 'all') rows = rows.filter(r => r.state === stSel);
  if (indSel !== 'all') rows = rows.filter(r => r._ind === indSel);
  if (q) rows = rows.filter(r =>
    (r.ticker || '').toLowerCase().includes(q) || (r.name || '').toLowerCase().includes(q));
  const sortKey = (document.getElementById('hanku-sort') || {}).value || 'fresh';
  rows.sort(HANKU_SORT[sortKey] || HANKU_SORT.fresh);

  const sm = hankuState.data.states || [];
  document.getElementById('hanku-summary').innerHTML =
    `<span style="font-size:15px;font-weight:600">狀態分布：</span>` +
    sm.map(s => `<span style="margin-left:10px">${s.code} <b>${s.count}</b></span>`).join('') +
    `<span style="margin-left:14px;color:#888">顯示 ${rows.length} 檔</span>` +
    (hankuState.data.note ? `<div style="margin-top:4px;color:#888;font-size:11px">${hankuState.data.note}</div>` : '');

  const view = hankuState.view || (hankuState.view = getTabView('hanku'));
  syncViewToggle('hanku-viewtoggle', view);
  const cardsEl = document.getElementById('hanku-cards');
  const tableEl = document.getElementById('hanku-table');
  if (view === 'card') {
    if (hankuState.table) { hankuState.table.destroy(); hankuState.table = null; }
    if (tableEl) tableEl.style.display = 'none';
    if (cardsEl) cardsEl.style.display = '';
    renderStockCards('hanku-cards', rows, hankuCardHtml);
  } else {
    if (cardsEl) { cardsEl.style.display = 'none'; cardsEl.innerHTML = ''; }
    if (tableEl) tableEl.style.display = '';
    if (hankuState.table) hankuState.table.destroy();
    hankuState.table = new Tabulator('#hanku-table', {
      data: rows,
      layout: 'fitDataTable',
      height: 'calc(100vh - 320px)',
      columns: HANKU_COLS,
      placeholder: '無符合條件的個股',
    });
  }
}

function initHankuControls() {
  ['hanku-state', 'hanku-industry', 'hanku-sort', 'hanku-search'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const ev = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(ev, () => { if (hankuState.loaded) renderHanku(); });
  });
  const vt = document.getElementById('hanku-viewtoggle');
  if (vt) vt.querySelectorAll('.vt-btn').forEach(b => b.addEventListener('click', () => {
    hankuState.view = b.dataset.view;
    setTabView('hanku', b.dataset.view);
    if (hankuState.loaded) renderHanku();
  }));
}
document.addEventListener('DOMContentLoaded', initHankuControls);

// ═════════════════════════════════════════════════════════
//  🌊 艾略特第三浪（過1浪高+滾量 進場）分頁
//  讀 data/daily/{date}/wave3.json.gz → 狀態清單 + 建議價位 + 點代號開 K 線
// ═════════════════════════════════════════════════════════
const wave3State = { loaded: false, loadedDate: null, data: null, table: null, view: null };

const WAVE3_COLS = [
  { title: '代號', field: 'ticker', width: 80, frozen: true,
    formatter: (cell) => `<a class="ticker-link" href="#" data-kline-ticker="${cell.getValue()}">${cell.getValue()}</a>`,
    cellClick: (e, cell) => {
      e.preventDefault();
      const r = cell.getRow().getData();
      openKlineModal(cell.getValue(), r.name, r.market);
    } },
  { title: '名稱', field: 'name', width: 100, frozen: true },
  { title: '產業', field: '_ind', width: 110 },
  { title: '狀態', field: 'state', width: 150 },
  { title: '當日%', field: 'chg_pct', width: 78, hozAlign: 'right', sorter: 'number', formatter: _hkPct(2) },
  { title: '現價', field: 'close', width: 76, hozAlign: 'right', sorter: 'number', formatter: _hkNum(2) },
  { title: '觸發(過1浪高)', field: 'trigger', width: 110, hozAlign: 'right', sorter: 'number', formatter: _hkNum(2) },
  { title: '距觸發%', field: 'dist_trig', width: 84, hozAlign: 'right', sorter: 'number', formatter: _hkPct(1) },
  { title: '停損(2浪低)', field: 'stop', width: 100, hozAlign: 'right', sorter: 'number', formatter: _hkNum(2) },
  { title: '目標(Fib)', field: 'target', width: 92, hozAlign: 'right', sorter: 'number', formatter: _hkNum(2) },
  { title: 'R:R', field: 'rr', width: 64, hozAlign: 'right', sorter: 'number',
    formatter: (c) => { const v = c.getValue(); if (v == null) return ''; const col = v >= 2 ? '#22c55e' : (v >= 1 ? '#f5b942' : '#888'); return `<span style="color:${col}">${Number(v).toFixed(2)}</span>`; } },
  { title: '報酬%', field: 'ret_pct', width: 78, hozAlign: 'right', sorter: 'number', formatter: _hkPct(1) },
  { title: '1浪幅', field: 'w1', width: 72, hozAlign: 'right', sorter: 'number', formatter: _hkNum(2) },
  { title: '2浪回檔', field: 'retr', width: 78, hozAlign: 'right', sorter: 'number',
    formatter: (c) => { const v = c.getValue(); return v == null ? '' : (v * 100).toFixed(0) + '%'; } },
  { title: '大盤', field: 'bull', width: 56, hozAlign: 'center',
    formatter: (c) => { const v = c.getValue(); return v == null ? '' : (v ? '多✓' : '空'); } },
];

async function loadWave3() {
  if (wave3State.loaded && wave3State.loadedDate === currentDate) { renderWave3(); return; }
  const metaEl = document.getElementById('wave3-meta');
  const sumEl = document.getElementById('wave3-summary');
  const entry = (indexMeta?.dates || []).find(
    e => e.date === currentDate && (e.has || []).includes('wave3'));
  let wvDate = currentDate;
  if (!entry) {
    const fb = (indexMeta?.dates || []).find(e => (e.has || []).includes('wave3'));
    if (!fb) {
      metaEl.textContent = '無 第三浪 資料';
      sumEl.innerHTML = '<div style="padding:20px;color:#aaa">該日期未提供第三浪資料。請跑 export_wave3_to_json.py。</div>';
      document.getElementById('wave3-table').innerHTML = '';
      return;
    }
    wvDate = fb.date;
  }
  metaEl.textContent = `載入中... (${wvDate})`;
  try {
    wave3State.data = await fetchJsonGz(`data/daily/${wvDate}/wave3.json.gz`);
    wave3State.loaded = true;
    wave3State.loadedDate = currentDate;
    (wave3State.data.rows || []).forEach(r => { r._ind = tickerIndustry[r.ticker] || ''; });
    populateIndustrySelect(document.getElementById('wave3-industry'), wave3State.data.rows);
    const d = wave3State.data;
    metaEl.textContent = `資料日 ${d.trading_date}　|　${d.rows.length} 檔　|　更新 ${(d.generated_at || '').slice(11, 16)}`;
    renderWave3();
  } catch (err) {
    metaEl.textContent = `載入失敗：${err.message}`;
  }
}

function renderWave3() {
  if (!wave3State.data) return;
  const stSel = document.getElementById('wave3-state').value;
  const indSel = (document.getElementById('wave3-industry') || {}).value || 'all';
  const q = String(document.getElementById('wave3-search').value || '').trim().toLowerCase();

  let rows = wave3State.data.rows.slice();
  if (stSel !== 'all') rows = rows.filter(r => r.state === stSel);
  if (indSel !== 'all') rows = rows.filter(r => r._ind === indSel);
  if (q) rows = rows.filter(r =>
    (r.ticker || '').toLowerCase().includes(q) || (r.name || '').toLowerCase().includes(q));

  const sm = wave3State.data.states || [];
  document.getElementById('wave3-summary').innerHTML =
    `<span style="font-size:15px;font-weight:600">狀態分布：</span>` +
    sm.map(s => `<span style="margin-left:10px">${s.code} <b>${s.count}</b></span>`).join('') +
    `<span style="margin-left:14px;color:#888">顯示 ${rows.length} 檔</span>` +
    (wave3State.data.note ? `<div style="margin-top:4px;color:#888;font-size:11px">${wave3State.data.note}</div>` : '');

  const view = wave3State.view || (wave3State.view = getTabView('wave3'));
  syncViewToggle('wave3-viewtoggle', view);
  const cardsEl = document.getElementById('wave3-cards');
  const tableEl = document.getElementById('wave3-table');
  if (view === 'card') {
    if (wave3State.table) { wave3State.table.destroy(); wave3State.table = null; }
    if (tableEl) tableEl.style.display = 'none';
    if (cardsEl) cardsEl.style.display = '';
    renderStockCards('wave3-cards', rows, wave3CardHtml);
  } else {
    if (cardsEl) { cardsEl.style.display = 'none'; cardsEl.innerHTML = ''; }
    if (tableEl) tableEl.style.display = '';
    if (wave3State.table) wave3State.table.destroy();
    wave3State.table = new Tabulator('#wave3-table', {
      data: rows,
      layout: 'fitDataTable',
      height: 'calc(100vh - 320px)',
      columns: WAVE3_COLS,
      placeholder: '無符合條件的個股',
      initialSort: [{ column: 'rr', dir: 'desc' }],
    });
  }
}

function initWave3Controls() {
  ['wave3-state', 'wave3-industry', 'wave3-search'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const ev = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(ev, () => { if (wave3State.loaded) renderWave3(); });
  });
  const vt = document.getElementById('wave3-viewtoggle');
  if (vt) vt.querySelectorAll('.vt-btn').forEach(b => b.addEventListener('click', () => {
    wave3State.view = b.dataset.view;
    setTabView('wave3', b.dataset.view);
    if (wave3State.loaded) renderWave3();
  }));
}
document.addEventListener('DOMContentLoaded', initWave3Controls);

// ═════════════════════════════════════════════════════════
//  族群資金流向（sector-flow）— 三大法人合計淨買超+加速度四象限
//  讀 data/daily/{date}/sector_flow.json.gz；引擎 services/sector_flow_service.py
// ═════════════════════════════════════════════════════════
const sectorFlowState = { loaded: false, loadedDate: null, data: null, table: null, stockTable: null };

const _sfNum = (dp) => (cell) => {
  const v = cell.getValue();
  return (v == null || isNaN(v)) ? '' : Number(v).toFixed(dp);
};
const _sfYi = (cell) => {
  const v = cell.getValue();
  if (v == null || isNaN(v)) return '';
  const s = Number(v), c = s > 0 ? '#00d4aa' : (s < 0 ? '#ef5350' : '#aaa');
  return `<span style="color:${c}">${s > 0 ? '+' : ''}${s.toFixed(1)}</span>`;
};

const SECTORFLOW_COLS = [
  { title: '族群', field: 'sector', width: 150, frozen: true },
  { title: '狀態', field: 'state', width: 90, hozAlign: 'center' },
  { title: '當日淨買(億)', field: 'net_1d', width: 110, hozAlign: 'right', sorter: 'number', formatter: _sfYi },
  { title: '近5日淨買(億)', field: 'net_5d', width: 120, hozAlign: 'right', sorter: 'number', formatter: _sfYi },
  { title: '近20日累計(億)', field: 'net_20d', width: 124, hozAlign: 'right', sorter: 'number', formatter: _sfYi },
  { title: '加速度', field: 'accel', width: 90, hozAlign: 'right', sorter: 'number', formatter: _sfNum(2) },
  { title: 'RFI', field: 'rfi', width: 80, hozAlign: 'right', sorter: 'number', formatter: _sfNum(3) },
  { title: '位置', field: 'position', width: 72, hozAlign: 'right', sorter: 'number', formatter: _sfNum(0) },
  { title: '5日漲幅%', field: 'chg_5d', width: 90, hozAlign: 'right', sorter: 'number', formatter: _sfNum(1) },
  { title: '檔數', field: 'n', width: 62, hozAlign: 'right', sorter: 'number' },
  { title: '黑馬', field: 'hm', width: 74, hozAlign: 'center' },
];
const SECTORFLOW_STOCK_COLS = [
  { title: '代號', field: 'code', width: 80, frozen: true,
    formatter: (c) => `<a class="ticker-link" href="#" data-kline-ticker="${c.getValue()}">${c.getValue()}</a>`,
    cellClick: (e, c) => { e.preventDefault(); const r = c.getRow().getData(); openKlineModal(c.getValue(), r.name, r.market); } },
  { title: '名稱', field: 'name', width: 100, frozen: true },
  { title: '收盤', field: 'close', width: 80, hozAlign: 'right', sorter: 'number', formatter: _sfNum(2) },
  { title: '漲跌%', field: 'pct_change', width: 80, hozAlign: 'right', sorter: 'number', formatter: _sfNum(2) },
  { title: '近5日淨買(億)', field: 'net5_yi', width: 120, hozAlign: 'right', sorter: 'number', formatter: _sfYi },
  { title: 'RFI', field: 'rfi', width: 80, hozAlign: 'right', sorter: 'number', formatter: _sfNum(3) },
  { title: '位置', field: 'position', width: 72, hozAlign: 'right', sorter: 'number', formatter: _sfNum(0) },
];

async function loadSectorFlow() {
  if (sectorFlowState.loaded && sectorFlowState.loadedDate === currentDate) { renderSectorFlow(); return; }
  const metaEl = document.getElementById('sf-meta');
  metaEl.textContent = '載入中...';
  try {
    sectorFlowState.data = await fetchJsonGz(dailyPath('sector_flow'));
    sectorFlowState.loaded = true;
    sectorFlowState.loadedDate = currentDate;
    const d = sectorFlowState.data;
    metaEl.textContent = `資料日 ${d.as_of}　|　大盤：${d.regime}　|　${d.sectors.length} 族群　|　更新 ${(d.generated_at || '').slice(11, 16)}`;
    renderSectorFlow();
  } catch (err) {
    metaEl.textContent = `載入失敗：${err.message}（該日無 sector_flow）`;
    document.getElementById('sf-table').innerHTML = '';
  }
}

function renderSectorFlow() {
  if (!sectorFlowState.data) return;
  const stSel = document.getElementById('sf-state').value;
  const q = String(document.getElementById('sf-search').value || '').trim().toLowerCase();
  let rows = sectorFlowState.data.sectors.slice();
  if (stSel !== 'all') rows = rows.filter(r => r.state === stSel);
  if (q) rows = rows.filter(r => (r.sector || '').toLowerCase().includes(q));

  const sm = {};
  sectorFlowState.data.sectors.forEach(r => { sm[r.state] = (sm[r.state] || 0) + 1; });
  document.getElementById('sf-summary').innerHTML =
    `<span style="font-weight:600">狀態分布：</span>` +
    ['🟢主力', '🟡輪動', '⚪觀望', '🔴退潮'].map(s => `<span style="margin-left:10px">${s} <b>${sm[s] || 0}</b></span>`).join('') +
    `<span style="margin-left:14px;color:#888">顯示 ${rows.length} 族群</span>`;

  if (sectorFlowState.table) sectorFlowState.table.destroy();
  sectorFlowState.table = new Tabulator('#sf-table', {
    data: rows, layout: 'fitDataTable', height: 'calc(100vh - 430px)',
    columns: SECTORFLOW_COLS, placeholder: '無符合條件的族群',
    initialSort: [{ column: 'net_5d', dir: 'desc' }],
  });
  sectorFlowState.table.on('rowClick', (e, row) => renderSectorFlowStocks(row.getData().sector));
}

function renderSectorFlowStocks(sector) {
  const stocks = (sectorFlowState.data.stocks || {})[sector] || [];
  document.getElementById('sf-stocks-title').textContent = `　${sector}　成分股（依近5日淨買排序）`;
  if (sectorFlowState.stockTable) sectorFlowState.stockTable.destroy();
  sectorFlowState.stockTable = new Tabulator('#sf-stocks-table', {
    data: stocks, layout: 'fitDataTable', height: '320px',
    columns: SECTORFLOW_STOCK_COLS, placeholder: '無成分股資料',
    initialSort: [{ column: 'net5_yi', dir: 'desc' }],
  });
}

function initSectorFlowControls() {
  ['sf-state', 'sf-search'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const ev = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(ev, () => { if (sectorFlowState.loaded) renderSectorFlow(); });
  });
}
document.addEventListener('DOMContentLoaded', initSectorFlowControls);

// ═════════════════════════════════════════════════════════
//  站內 K 線彈窗（lightweight-charts v4）
//  價格主圖（K + SMA20/VWAP20/MA60 + 量 + 訊號marker）
//  + 法人副圖（外資 net 量柱 + 投信線）+ 融資券副圖
// ═════════════════════════════════════════════════════════
const klineState = {
  charts: [],          // [priceChart, instChart, marginChart]
  candleSeries: null,
  syncing: false,
  cache: {},           // ticker -> payload
  current: null,
};

const LC = () => window.LightweightCharts;

function klBaseOpts(height) {
  return {
    autoSize: true,
    height,
    layout: { background: { color: '#16161f' }, textColor: '#c8c8d4', fontSize: 11 },
    grid: { vertLines: { color: '#23232f' }, horzLines: { color: '#23232f' } },
    rightPriceScale: { borderColor: '#2a2a3e' },
    timeScale: { borderColor: '#2a2a3e', rightOffset: 4 },
    crosshair: { mode: 0 },
    handleScale: { axisPressedMouseMove: true },
  };
}

// 把 (dates[], values[]) 轉成 lightweight-charts 資料，跳過 null
function klSeriesData(dates, vals) {
  const out = [];
  for (let i = 0; i < dates.length; i++) {
    const v = vals ? vals[i] : null;
    if (v == null) continue;
    out.push({ time: dates[i], value: v });
  }
  return out;
}

function klDestroy() {
  klineState.charts.forEach(c => { try { c.remove(); } catch (e) {} });
  klineState.charts = [];
  klineState.candleSeries = null;
  ['kc-price', 'kc-inst', 'kc-margin'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '';
  });
}

// 三圖時間軸同步
function klSyncTimeScales() {
  const charts = klineState.charts;
  charts.forEach((src) => {
    src.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (klineState.syncing || !range) return;
      klineState.syncing = true;
      charts.forEach((dst) => {
        if (dst !== src) dst.timeScale().setVisibleLogicalRange(range);
      });
      klineState.syncing = false;
    });
  });
}

function klBuild(d) {
  if (!LC()) { document.getElementById('kline-status').textContent = '圖表庫載入失敗'; return; }
  klDestroy();

  const showMA     = document.getElementById('kl-ma').checked;
  const showInst   = document.getElementById('kl-inst').checked && d.has_inst;
  const showMargin = document.getElementById('kl-margin').checked && d.has_margin;
  const showHanku  = !!(document.getElementById('kl-hanku')?.checked && d.hanku);

  document.getElementById('kc-inst').style.display   = showInst ? '' : 'none';
  document.getElementById('kc-margin').style.display = showMargin ? '' : 'none';

  // ── 價格主圖 ──
  const priceEl = document.getElementById('kc-price');
  const pChart = LC().createChart(priceEl, klBaseOpts(360));
  const candle = pChart.addCandlestickSeries({
    upColor: '#ef5350', downColor: '#26a69a',       // 台股紅漲綠跌
    wickUpColor: '#ef5350', wickDownColor: '#26a69a', borderVisible: false,
  });
  const candleData = d.dates.map((t, i) => ({
    time: t, open: d.o[i], high: d.h[i], low: d.l[i], close: d.c[i],
  })).filter(x => x.open != null && x.close != null);
  candle.setData(candleData);
  klineState.candleSeries = candle;

  // 均線
  if (showMA) {
    const sma = pChart.addLineSeries({ color: '#42a5f5', lineWidth: 1, lastValueVisible: false, priceLineVisible: false });
    sma.setData(klSeriesData(d.dates, d.sma20));
    const vwap = pChart.addLineSeries({ color: '#ffa726', lineWidth: 1, lastValueVisible: false, priceLineVisible: false });
    vwap.setData(klSeriesData(d.dates, d.vwap20));
    const ma60 = pChart.addLineSeries({ color: '#ab47bc', lineWidth: 1, lastValueVisible: false, priceLineVisible: false });
    ma60.setData(klSeriesData(d.dates, d.ma60));
  }

  // Hanku 波段：週4(紅) / 週9(青) 兩線 + 日47季線(虛線，黃綠)
  if (showHanku) {
    const hk = d.hanku;
    const w4 = pChart.addLineSeries({ color: '#ff4081', lineWidth: 2, lastValueVisible: false, priceLineVisible: false });
    w4.setData(klSeriesData(d.dates, hk.w4));
    const w9 = pChart.addLineSeries({ color: '#00bcd4', lineWidth: 2, lastValueVisible: false, priceLineVisible: false });
    w9.setData(klSeriesData(d.dates, hk.w9));
    const m47 = pChart.addLineSeries({ color: '#cddc39', lineWidth: 1, lineStyle: 2, lastValueVisible: false, priceLineVisible: false });
    m47.setData(klSeriesData(d.dates, hk.ma47));
  }

  // 量（疊在主圖底部）
  const vol = pChart.addHistogramSeries({
    priceFormat: { type: 'volume' }, priceScaleId: '', lastValueVisible: false,
  });
  vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  vol.setData(d.dates.map((t, i) => ({
    time: t, value: d.v[i],
    color: (d.c[i] >= d.o[i]) ? 'rgba(239,83,80,0.45)' : 'rgba(38,166,154,0.45)',
  })).filter(x => x.value != null));

  // 自家訊號 marker（anchor 進場 ↑ + §5 出貨警訊 ↓）
  const _mk = [];
  if (d.markers) d.markers.forEach(m => _mk.push({
    time: m.date, position: 'belowBar', color: '#FFD700', shape: 'arrowUp', text: m.type,
  }));
  if (d.dist_markers) d.dist_markers.forEach(m => _mk.push({
    time: m.date, position: 'aboveBar', color: '#ef5350', shape: 'arrowDown',
    text: '出貨' + (m.vr ? ' ' + m.vr + 'x' : ''),
  }));
  // Hanku 波段：金叉發散進場 ▲ / 死叉出場 ▼
  if (showHanku) {
    (d.hanku.entries || []).forEach(e => _mk.push({
      time: e.date, position: 'belowBar', color: '#00e676', shape: 'arrowUp', text: '進',
    }));
    (d.hanku.exits || []).forEach(x => _mk.push({
      time: x.date, position: 'aboveBar', color: '#d500f9', shape: 'arrowDown', text: '出',
    }));
  }
  if (_mk.length) {
    _mk.sort((a, b) => (a.time < b.time ? -1 : (a.time > b.time ? 1 : 0)));  // LC 要求時間遞增
    candle.setMarkers(_mk);
  }

  // 主升 回後買上漲 / 盤整突破：進場/觸發/停損/目標 價位線（advice.js 純前端推算）
  try {
    const lv = (window.AdvicePanel && window.AdvicePanel.mainupLevels)
      ? window.AdvicePanel.mainupLevels(d, klineState.row) : null;
    if (lv) {
      const pl = (price, color, title, style) => {
        if (price != null && isFinite(price))
          candle.createPriceLine({ price: +price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title });
      };
      pl(lv.entry,   '#26a69a', `進 ${lv.entry != null ? (+lv.entry).toFixed(2) : ''}`, 0);                       // 實線：進場(收盤)
      pl(lv.trigger, '#90a4ae', `${lv.triggerLabel} ${lv.trigger != null ? (+lv.trigger).toFixed(2) : ''}`, 1);   // 點線：觸發
      pl(lv.stop,    '#ef5350', `損 ${lv.stop != null ? (+lv.stop).toFixed(2) : ''}`, 2);                          // 虛線：停損
      pl(lv.target,  '#ffd54f', `標 ${lv.target != null ? (+lv.target).toFixed(2) : ''}`, 2);                      // 虛線：目標
    }
  } catch (e) { /* 價位線非關鍵，失敗不影響主圖 */ }

  // 出場價位線：守MA20（點線）/ 出場MA60（紅虛線）。僅在「非回後買上漲/盤整突破」時畫，避免與進場線打架
  try {
    const lv = (window.AdvicePanel && window.AdvicePanel.mainupLevels)
      ? window.AdvicePanel.mainupLevels(d, klineState.row) : null;
    const hl = (window.AdvicePanel && window.AdvicePanel.holdLevels)
      ? window.AdvicePanel.holdLevels(d) : null;
    if (!lv && hl) {
      const pl = (price, color, title, style) => {
        if (price != null && isFinite(price))
          candle.createPriceLine({ price: +price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title });
      };
      pl(hl.ma20, '#90a4ae', `守20 ${hl.ma20 != null ? (+hl.ma20).toFixed(2) : ''}`, 1);   // 點線：守MA20（早期警示）
      pl(hl.ma60, '#ef5350', `出60 ${hl.ma60 != null ? (+hl.ma60).toFixed(2) : ''}`, 2);   // 虛線：出場MA60（現股出場）
    }
  } catch (e) { /* 出場線非關鍵，失敗不影響主圖 */ }

  klineState.charts.push(pChart);

  // ── 法人副圖 ──
  if (showInst) {
    const ic = LC().createChart(document.getElementById('kc-inst'), klBaseOpts(120));
    const fh = ic.addHistogramSeries({ priceFormat: { type: 'volume' }, lastValueVisible: false, title: '外資' });
    fh.setData(d.dates.map((t, i) => ({
      time: t, value: d.inst_foreign[i],
      color: (d.inst_foreign[i] >= 0) ? 'rgba(239,83,80,0.6)' : 'rgba(38,166,154,0.6)',
    })).filter(x => x.value != null));
    const tl = ic.addLineSeries({ color: '#ffca28', lineWidth: 1, lastValueVisible: false, priceLineVisible: false, title: '投信' });
    tl.setData(klSeriesData(d.dates, d.inst_trust));
    klineState.charts.push(ic);
  }

  // ── 融資券副圖 ──
  if (showMargin) {
    const mc = LC().createChart(document.getElementById('kc-margin'), klBaseOpts(120));
    const ml = mc.addLineSeries({ color: '#ffd54f', lineWidth: 1, lastValueVisible: false, priceLineVisible: false, title: '融資餘' });
    ml.setData(klSeriesData(d.dates, d.margin_bal));
    const sl = mc.addLineSeries({ color: '#4dd0e1', lineWidth: 1, lastValueVisible: false, priceLineVisible: false, title: '融券餘' });
    sl.setData(klSeriesData(d.dates, d.short_bal));
    klineState.charts.push(mc);
  }

  klSyncTimeScales();
  klineState.charts.forEach(c => c.timeScale().fitContent());

  // legend
  const parts = [];
  if (showMA) parts.push('<span style="color:#42a5f5">━ SMA20</span>',
                         '<span style="color:#ffa726">━ VWAP20</span>',
                         '<span style="color:#ab47bc">━ MA60</span>');
  if (showHanku) {
    parts.push('｜<span style="color:#ff4081">━ 週4</span> <span style="color:#00bcd4">━ 週9</span> <span style="color:#cddc39">┄ 日47季線</span> <span style="color:#00e676">▲進</span> <span style="color:#d500f9">▼出</span>');
    const hs = d.hanku.state || {};
    if (hs.狀態) {
      let badge = `｜波段：<b>${hs.狀態}</b>`;
      if (hs.進場日) {
        const rc = (hs.報酬 != null && hs.報酬 >= 0) ? '#ef5350' : '#26a69a';
        badge += ` (進 ${hs.進場日} @${hs.進場價}` +
                 (hs.報酬 != null ? `，報酬 <span style="color:${rc}">${hs.報酬 > 0 ? '+' : ''}${hs.報酬}%</span>` : '') + ')';
      }
      if (hs.週9停損 != null) badge += `　守9週停損≈${hs.週9停損}`;
      parts.push(badge);
    }
  }
  if (showInst)   parts.push('｜法人：<span style="color:#ef5350">外資量柱</span> <span style="color:#ffca28">投信線</span>');
  if (showMargin) parts.push('｜<span style="color:#ffd54f">融資餘</span> <span style="color:#4dd0e1">融券餘</span>');
  if (d.dist_markers && d.dist_markers.length) parts.push('｜<span style="color:#ef5350">▽ 出貨警訊</span>');
  document.getElementById('kline-legend').innerHTML = parts.join('  ');

  const warn = [];
  if (!d.has_inst)   warn.push('無法人資料');
  if (!d.has_margin) warn.push('融資券資料稀疏');
  document.getElementById('kline-status').textContent =
    `${d.dates.length} 個交易日　${d.dates[0]} ~ ${d.dates[d.dates.length - 1]}` +
    (warn.length ? `　（${warn.join('、')}）` : '');
}

async function openKlineModal(ticker, name, market) {
  const modal = document.getElementById('kline-modal');
  modal.hidden = false;
  document.getElementById('kline-title').textContent = `${ticker}　${name || ''}`;
  document.getElementById('kline-tv').href = tvUrl(ticker, market);
  document.getElementById('kline-status').textContent = '載入中...';
  document.getElementById('kline-legend').innerHTML = '';
  // 每次開新代號回到 K 線 subtab
  document.querySelectorAll('.kl-subtab-btn').forEach(b => b.classList.toggle('active', b.dataset.kltab === 'kline'));
  const klw = document.getElementById('kc-klinewrap'); if (klw) klw.style.display = '';
  const kcb = document.getElementById('kc-build'); if (kcb) kcb.style.display = 'none';
  const kca = document.getElementById('kc-advice'); if (kca) kca.style.display = 'none';
  klDestroy();

  // 從主篩選資料查回這一列（不論從哪個表點開都用主表的權威訊號列）
  const advRow = (state.data && state.data.rows)
    ? state.data.rows.find(r => String(r.ticker) === String(ticker)) || null : null;
  klineState.row = advRow;   // 供 klBuild 畫主升進場/停損/目標價位線（切換勾選重建圖也在）

  try {
    let d = klineState.cache[ticker];
    if (!d) {
      d = await fetchJsonGz(`data/kline/${ticker}.json.gz`);
      klineState.cache[ticker] = d;
    }
    klineState.current = d;
    klBuild(d);
    if (window.QEFCalc) window.QEFCalc.onKline(ticker, name, d);
    if (window.AdvicePanel) { window.AdvicePanel.onKline(ticker, name, d, advRow); window.AdvicePanel.renderBar(); }
  } catch (err) {
    console.error(err);
    document.getElementById('kline-status').textContent =
      `載入 ${ticker} K 線失敗：${err.message}`;
  }
}

function closeKlineModal() {
  document.getElementById('kline-modal').hidden = true;
  klDestroy();
  klineState.current = null;
  klineState.row = null;
}

function initKlineModal() {
  document.querySelectorAll('[data-kline-close]').forEach(el =>
    el.addEventListener('click', closeKlineModal));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('kline-modal').hidden)
      closeKlineModal();
  });
  ['kl-ma', 'kl-hanku', 'kl-inst', 'kl-margin'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => {
      if (klineState.current) klBuild(klineState.current);
    });
  });
}
document.addEventListener('DOMContentLoaded', initKlineModal);
