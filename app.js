// ─────────────────────────────────────────────────────────
//  右側突破篩選器 — 雲端 MVP 前端
//  讀 web/data/latest.json → 渲染表格 + 多條件篩選
// ─────────────────────────────────────────────────────────

const PRESET_STORAGE_KEY = 'screener_presets_v1';

// 介面版本 — 顯示在頁尾，方便確認是否載到最新版(避開瀏覽器快取舊檔)
const APP_VERSION = '20260705d';
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
    loadResonanceData().then(updateSnapshotReso);
    loadMarketSnapshot();
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
  // 島狀反轉：off|top|bottom|any（後端已判定缺口孤立，前端只篩 island_top/island_bottom 是否有值）
  islandMode: 'off',
  // 型態訊號（ep10缺口/ep11 N字/ep14圓弧/ep15黃金分割 新欄；勾選任一即入選=群內 OR）
  patternSignals: new Set(),
};

// 型態訊號 勾選值 → row 判定（欄位下次 export 才有值，缺值一律不中）
const PATTERN_SIG_TEST = {
  gap_hold:    (row) => /✅/.test(row.gap_state || ''),
  gap_fill:    (row) => /⛔/.test(row.gap_state || ''),
  nbase_break: (row) => /🔥|回後/.test(row.nbase_state || ''),
  nbase_lock:  (row) => /鎖股/.test(row.nbase_state || ''),
  fib_buy:     (row) => /黃金買點/.test(row.fib_state || ''),
  round_buy:   (row) => /剛突破|回後買點/.test(row.rounding_state || ''),
  round_lock:  (row) => /鎖股/.test(row.rounding_state || ''),
  sr_clear:    (row) => /✅/.test(row.sr_overhead || ''),
  sr_break:    (row) => /⛔/.test(row.sr_state || ''),
};

// 代號→產業 對照表（供 hanku 等資料無產業欄的分頁，借主表 row 的 industry）
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

// ── 跨策略共振：把 Hanku 的 actionable 清單併進每日看板 ──
//   resonance.hanku = { 代號: 狀態 }；共振數 = 突破(命中≥1)+Hanku 命中幾個
const resonance = { hanku: {} };

function _resoDate(kind) {
  const ds = indexMeta?.dates || [];
  return (ds.find(e => e.date === currentDate && (e.has || []).includes(kind))
       || ds.find(e => (e.has || []).includes(kind)) || {}).date;
}

async function loadResonanceData() {
  resonance.hanku = {};
  const grab = async (kind, store) => {
    try {
      const d = _resoDate(kind);
      if (!d) return;
      const j = await fetchJsonGz(`data/daily/${d}/${kind}.json.gz`);
      (j.rows || []).forEach(r => { if (r.ticker) store[r.ticker] = r.state || ''; });
    } catch (e) { /* 缺資料不影響主表 */ }
  };
  await grab('hanku', resonance.hanku);
  // 資料到位後重跑篩選（共振篩選/排序/徽章才正確）
  if (state.table) applyFilters();
}

function _resoCount(r) {
  let n = 0;
  if ((r.hits || 0) >= 1) n++;
  if (resonance.hanku[r.ticker]) n++;
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

// CB 監控分頁
const cbState = {
  loaded: false,
  data: null,
  table: null,
  loadedDate: null,
};

// 訊號成績單分頁（非日期化：web/data/signal_report.json.gz，回看近N日）
const signalReportState = { loaded: false, data: null };

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

// ── 1.5 今日市場快照（大盤籌碼 market.json + 漲跌家數 + 共振數） ──
function _msFmtZ(z) {
  if (z == null || isNaN(z)) return '--';
  return (z >= 0 ? '+' : '') + Number(z).toFixed(1);
}
function _msZCls(z) {
  if (z == null || isNaN(z)) return '';
  return z > 0 ? 'pos' : (z < 0 ? 'neg' : '');
}

async function loadMarketSnapshot() {
  const el = document.getElementById('mkt-snapshot');
  if (!el) return;
  // 該日是否有 market.json（index.json 的 has 清單）
  let mkt = null;
  const entry = (indexMeta?.dates || []).find(e => e.date === currentDate);
  if (entry && (entry.has || []).includes('market')) {
    try { mkt = await fetchJsonGz(dailyPath('market')); }
    catch (e) { console.warn('market.json 載入失敗', e); }
  }
  renderSnapshot(state.data, mkt);
}

function renderSnapshot(d, mkt) {
  const el = document.getElementById('mkt-snapshot');
  if (!el || !d) return;
  const tiles = [];

  // ① 大盤籌碼狀態（market.json chip_score）
  const cs = mkt?.chip_score;
  if (cs?.available) {
    const score = cs.composite_score;
    const bull = score != null && score > 0;
    tiles.push(`<div class="ms-tile ${score != null ? (bull ? 'ms-state-bull' : 'ms-state-bear') : ''}">
      <span class="ms-k">🏛 大盤籌碼</span>
      <span class="ms-v">${cs.state || '--'}<small>${score != null ? (score >= 0 ? '+' : '') + Number(score).toFixed(1) : ''}</small></span>
      <span class="ms-sub">現貨 ${cs.equity_date || '--'}｜期貨 ${cs.futures_date || '--'}</span>
    </div>`);
  }

  // ② 漲跌家數（latest.json breadth，舊資料日可能沒有）
  const br = d.breadth;
  if (br && br.total) {
    const upPct = (br.up / br.total * 100).toFixed(0);
    tiles.push(`<div class="ms-tile">
      <span class="ms-k">📶 漲跌家數</span>
      <span class="ms-v"><span class="pos">${br.up}</span><small>／</small><span class="neg">${br.down}</span></span>
      <div class="ms-bar"><span class="up" style="flex:${br.up}"></span><span class="down" style="flex:${br.down}"></span></div>
      <span class="ms-sub">上漲 ${upPct}%（共 ${br.total} 檔）</span>
    </div>`);
  }

  // ③④⑤ 法人 z 分數
  if (cs?.available) {
    tiles.push(`<div class="ms-tile">
      <span class="ms-k">🌏 外資現貨 z</span>
      <span class="ms-v ${_msZCls(cs.fo_z)}">${_msFmtZ(cs.fo_z)}</span>
      <span class="ms-sub">${cs.fo_value != null ? Number(cs.fo_value).toLocaleString() + ' 百萬' : ''}</span>
    </div>`);
    tiles.push(`<div class="ms-tile">
      <span class="ms-k">🏦 投信現貨 z</span>
      <span class="ms-v ${_msZCls(cs.ic_z)}">${_msFmtZ(cs.ic_z)}</span>
      <span class="ms-sub">${cs.ic_value != null ? Number(cs.ic_value).toLocaleString() + ' 百萬' : ''}</span>
    </div>`);
    tiles.push(`<div class="ms-tile">
      <span class="ms-k">📜 外資期貨 z</span>
      <span class="ms-v ${_msZCls(cs.fu_z)}">${_msFmtZ(cs.fu_z)}</span>
      <span class="ms-sub">${cs.fu_value != null ? '淨OI ' + Number(cs.fu_value).toLocaleString() + ' 口' : ''}</span>
    </div>`);
    if (cs.pcr != null) {
      const pcrCls = (cs.pcr > 1.3 || cs.pcr < 0.7) ? 'warn' : '';
      tiles.push(`<div class="ms-tile">
        <span class="ms-k">⚖️ PCR</span>
        <span class="ms-v ${pcrCls}">${Number(cs.pcr).toFixed(2)}</span>
        <span class="ms-sub">${cs.pcr > 1.3 ? '偏空保護濃' : cs.pcr < 0.7 ? '過度樂觀' : '中性'}</span>
      </div>`);
    }
  }

  // ⑥ 法人連買廣度（export_market 的 inst_breadth；連買/連賣 ≥3 天家數）
  const ib = mkt?.inst_breadth;
  if (ib && ib.universe) {
    tiles.push(`<div class="ms-tile">
      <span class="ms-k">🌏 外資連買廣度</span>
      <span class="ms-v"><span class="pos">${ib.foreign_buy3}</span><small>／</small><span class="neg">${ib.foreign_sell3}</span></span>
      <span class="ms-sub">連買≥3天／連賣≥3天（共 ${ib.universe} 檔）</span>
    </div>`);
    tiles.push(`<div class="ms-tile">
      <span class="ms-k">🏦 投信連買廣度</span>
      <span class="ms-v"><span class="pos">${ib.trust_buy3}</span><small>／</small><span class="neg">${ib.trust_sell3}</span></span>
      <span class="ms-sub">連買≥3天／連賣≥3天（共 ${ib.universe} 檔）</span>
    </div>`);
  }

  // ⑦ 共振檔數（等 loadResonanceData 完成後由 updateSnapshotReso 填值）
  tiles.push(`<div class="ms-tile">
    <span class="ms-k">⚡ 多策略共振</span>
    <span class="ms-v accent" id="ms-reso-v">--</span>
    <span class="ms-sub">突破＋Hanku命中 ≥2</span>
  </div>`);

  // 評論列（market.json commentary + signals，最多 4 則）
  const notes = [...(mkt?.commentary || []), ...(mkt?.signals || [])].slice(0, 4)
    .map(n => `<span class="ms-note ${n.level || ''}">${n.text}</span>`).join('');

  el.innerHTML = `<div class="ms-tiles">${tiles.join('')}</div>` +
                 (notes ? `<div class="ms-notes">${notes}</div>` : '');
  el.hidden = false;
  updateSnapshotReso();
}

function updateSnapshotReso() {
  const v = document.getElementById('ms-reso-v');
  if (!v || !state.data) return;
  const n = (state.data.rows || []).filter(r => _resoCount(r) >= 2).length;
  v.textContent = `${n} 檔`;
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
    // 只看共振（同時被 ≥2 策略 actionable：突破/Hanku）
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

    // 島狀反轉：top=頂部(出場/做空)｜bottom=底部(進場/做多)｜any=任一
    if (state.islandMode === 'top' && !row.island_top) return false;
    if (state.islandMode === 'bottom' && !row.island_bottom) return false;
    if (state.islandMode === 'any' && !row.island_top && !row.island_bottom) return false;

    // 型態訊號（勾選任一即入選）
    if (state.patternSignals.size > 0) {
      let any = false;
      for (const k of state.patternSignals) {
        const f = PATTERN_SIG_TEST[k];
        if (f && f(row)) { any = true; break; }
      }
      if (!any) return false;
    }

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
const ISLAND_MODE_LABEL = { top: '頂部', bottom: '底部', any: '任一' };

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
  if (state.islandMode !== 'off') add('island', `島狀:${ISLAND_MODE_LABEL[state.islandMode]}`);
  if (state.patternSignals.size) add('pattern', `型態:${state.patternSignals.size}訊號`);
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
                    (state.mainupEntry ? 1 : 0) + (state.mainupExclDist ? 1 : 0) +
                    (state.islandMode !== 'off' ? 1 : 0) +
                    (state.patternSignals.size ? 1 : 0));
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
    case 'island':
      state.islandMode = 'off';
      { const r = document.querySelector('input[name="island-mode"][value="off"]'); if (r) r.checked = true; }
      break;
    case 'pattern':
      state.patternSignals.clear();
      document.querySelectorAll('input[name="pattern-sig"]').forEach(cb => { cb.checked = false; });
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

  // 島狀反轉模式 radio
  document.querySelectorAll('input[name="island-mode"]').forEach(r => {
    r.addEventListener('change', e => { state.islandMode = e.target.value; applyFilters(); });
  });

  // 型態訊號 checkbox（缺口/N字/黃金分割/圓弧）
  document.querySelectorAll('input[name="pattern-sig"]').forEach(cb => {
    cb.addEventListener('change', e => {
      if (e.target.checked) state.patternSignals.add(e.target.value);
      else state.patternSignals.delete(e.target.value);
      applyFilters();
    });
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
  state.islandMode = 'off';
  state.patternSignals.clear();
  document.querySelectorAll('input[name="pattern-sig"]').forEach(cb => { cb.checked = false; });

  document.querySelectorAll('.cat-chip input').forEach(cb => { cb.checked = false; cb.parentElement.classList.remove('checked'); });
  document.querySelector('input[name="mode"][value="OR"]').checked = true;
  const muOff = document.querySelector('input[name="mainup-mode"][value="off"]');
  if (muOff) muOff.checked = true;
  document.querySelectorAll('input[name="mainup-sig"]').forEach(cb => { cb.checked = true; });
  const muSig = document.getElementById('mainup-signals'); if (muSig) muSig.hidden = true;
  const muE = document.getElementById('mainup-entry'); if (muE) muE.value = '';
  const muD = document.getElementById('mainup-excl-dist'); if (muD) muD.checked = false;
  const islOff = document.querySelector('input[name="island-mode"][value="off"]'); if (islOff) islOff.checked = true;
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
        title: '⚡共振', field: '_reso', widthGrow: 0.9, headerSort: false,
        formatter: (cell) => {
          const r = cell.getRow().getData();
          const hk = resonance.hanku[r.ticker];
          const n = _resoCount(r);
          const badges =
            (n >= 2 ? '<span class="sc-zap">⚡' + n + '</span> ' : '') +
            (hk ? '<span class="reso-badge reso-hk">🌀波段</span>' : '');
          return badges || '<span class="muted">—</span>';
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
      if (tab === 'cb') {
        loadCB();
      }
      if (tab === 'signal-report') {
        loadSignalReport();
      }
      if (tab === 'disposition') {
        loadDisposition();
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
    loadResonanceData().then(updateSnapshotReso);
    loadMarketSnapshot();
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

// ── 訊號成績單：回看N日各分類 1/5/20 日 forward return ──────
async function loadSignalReport() {
  if (signalReportState.loaded) { renderSignalReport(); return; }
  const metaEl = document.getElementById('sr-meta');
  metaEl.textContent = '載入中...';
  try {
    signalReportState.data = await fetchJsonGz('data/signal_report.json.gz');
    signalReportState.loaded = true;
    renderSignalReport();
  } catch (err) {
    metaEl.textContent = `載入失敗：${err.message}（尚未產生 signal_report.json.gz？）`;
  }
}

function _srCell(h) {
  if (!h || !h.n) return `<td class="sr-td sr-empty">—</td>`;
  const avgCls = h.avg > 0 ? 'num-pos' : (h.avg < 0 ? 'num-neg' : '');
  const hitCls = h.hit_rate >= 50 ? 'num-pos' : 'num-neg';
  return `<td class="sr-td">
    <div class="sr-avg ${avgCls}">${h.avg > 0 ? '+' : ''}${h.avg}%</div>
    <div class="sr-sub">中位 ${h.median > 0 ? '+' : ''}${h.median}%　勝率 <span class="${hitCls}">${h.hit_rate}%</span></div>
    <div class="sr-n">n=${h.n.toLocaleString()}</div>
  </td>`;
}

function renderSignalReport() {
  const d = signalReportState.data;
  const metaEl = document.getElementById('sr-meta');
  const bodyEl = document.getElementById('sr-body');
  if (!d) return;
  metaEl.textContent =
    `回看 ${d.window_days} 個交易日（${fmtDate8(d.window_from)} ~ ${fmtDate8(d.window_to)}）　|　` +
    `更新 ${d.generated_at.slice(0, 16).replace('T', ' ')}　|　` +
    `各分類「入選當天 → 隔N日」forward return 統計，樣本＝該分類在回看期間每次入選事件`;

  if (!d.categories.length) {
    bodyEl.innerHTML = '<div class="muted" style="padding:20px">尚無足夠資料。</div>';
    return;
  }

  const rows = d.categories.map(c => `
    <tr>
      <td class="sr-cat"><span class="cat-tag" style="background:${c.color}">${c.code}</span>${c.label}</td>
      ${_srCell(c.horizons['1'])}
      ${_srCell(c.horizons['5'])}
      ${_srCell(c.horizons['20'])}
    </tr>`).join('');

  bodyEl.innerHTML = `
    <table class="sr-table">
      <thead><tr>
        <th>分類</th><th>隔日 (1日)</th><th>隔週 (5日)</th><th>隔月 (20日)</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="sr-foot muted">僅供策略事後檢核，非投資建議；樣本數 n 越小越不穩定，20日欄位受限於資料窗口通常樣本最少。</div>`;
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

// ── 卡片檢視（各分頁共用） ──────────────────
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

// 進場天數(交易日) → 新鮮度徽章：0天今日／1-3天綠／4-10天藍(仍在new_win觀察窗)；>10天狀態已轉「守4週持有」不特別標
function _hankuFreshBadge(days) {
  if (days == null) return '';
  if (days === 0) return '<span class="sc-new">🆕今日進場</span>';
  if (days <= 3) return `<span class="sc-new">🟢${days}天前進場</span>`;
  if (days <= 10) return `<span class="sc-new sc-new-mid">🔵${days}天前進場</span>`;
  return '';
}

function hankuCardHtml(r) {
  const warns = [];
  if (r.warn47) warns.push('⚠️破47');
  if (r.w4_down) warns.push('⚠️4T下彎');
  const days = r.entry_days;
  const freshBadge = _hankuFreshBadge(days);
  const dayNote = days != null ? `<small class="sc-days">·${days}日前</small>` : '';
  return `<button type="button" class="stk-card" data-ticker="${r.ticker}">
    <div class="sc-head">
      <span class="sc-id"><b>${r.ticker}</b> ${r.name || ''}${freshBadge ? ' ' + freshBadge : ''}</span>
      <span class="sc-state">${r.state || ''}</span>
    </div>
    <div class="sc-price">${_chgSpan(Number(r.chg_pct))}<span class="sc-close">現價 ${_cardNum(r.close)}</span></div>
    <div class="sc-grid">
      <div class="sc-cell"><span class="k">進場</span><span class="v">${_cardNum(r.entry_px)} <small>${r.entry_date ? r.entry_date.slice(5) : ''}</small>${dayNote}</span></div>
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
  foreign:     (a, b) => (b.foreign_streak ?? -1e9) - (a.foreign_streak ?? -1e9),
  trust:       (a, b) => (b.trust_streak ?? -1e9) - (a.trust_streak ?? -1e9),
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

  // 法人連買/連賣 ≥3 天才顯示（雜訊過濾）
  const instBits = [];
  if (r.foreign_streak >= 3) instBits.push(`<span class="tag tag-good">外資連買${r.foreign_streak}日</span>`);
  else if (r.foreign_streak <= -3) instBits.push(`<span class="tag tag-warn">外資連賣${-r.foreign_streak}日</span>`);
  if (r.trust_streak >= 3) instBits.push(`<span class="tag tag-good">投信連買${r.trust_streak}日</span>`);
  else if (r.trust_streak <= -3) instBits.push(`<span class="tag tag-warn">投信連賣${-r.trust_streak}日</span>`);
  const instHtml = instBits.join('');

  // 跨策略共振徽章
  const hk = resonance.hanku[r.ticker];
  const resoN = _resoCount(r);
  const resoBadges =
    (hk ? `<span class="reso-badge reso-hk">🌀${_stripLeadEmoji(hk)}</span>` : '');
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
      ${instHtml}
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
  { title: '進場天數', field: 'entry_days', width: 80, hozAlign: 'right', sorter: 'number' },
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
// 個股自身動能（非族群內排名比較）：accel=近5日/日均−近20日/日均，momentum 沿用族群同一套詞彙
const MOMENTUM_ICON = { '主力': '🟢', '輪動': '🟡', '觀望': '⚪', '退潮': '🔴' };
const SECTORFLOW_STOCK_COLS = [
  { title: '代號', field: 'code', width: 80, frozen: true,
    formatter: (c) => `<a class="ticker-link" href="#" data-kline-ticker="${c.getValue()}">${c.getValue()}</a>`,
    cellClick: (e, c) => { e.preventDefault(); const r = c.getRow().getData(); openKlineModal(c.getValue(), r.name, r.market); } },
  { title: '名稱', field: 'name', width: 100, frozen: true },
  { title: '收盤', field: 'close', width: 80, hozAlign: 'right', sorter: 'number', formatter: _sfNum(2) },
  { title: '漲跌%', field: 'pct_change', width: 80, hozAlign: 'right', sorter: 'number', formatter: _sfNum(2) },
  { title: '近5日淨買(億)', field: 'net5_yi', width: 120, hozAlign: 'right', sorter: 'number', formatter: _sfYi },
  { title: '動能', field: 'momentum', width: 84, hozAlign: 'center',
    headerTooltip: '個股自身趨勢（近5日/日均買超 vs 近20日/日均），非族群內排名比較，不受同儕強弱影響',
    formatter: (c) => { const v = c.getValue(); return v ? `${MOMENTUM_ICON[v] || ''}${v}` : '<span class="muted">--</span>'; } },
  { title: '加速度', field: 'accel', width: 84, hozAlign: 'right', sorter: 'number', formatter: _sfNum(2) },
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
//  個股彈窗共用狀態（kline payload 快取：摘要卡籌碼區 / 期貨計算機共用）
// ═════════════════════════════════════════════════════════
const klineState = {
  cache: {},           // ticker -> payload
};

// ── 個股摘要卡（取代舊 K線/進出場/建倉 三分頁）─────────────
// 資料：主篩選表 row（訊號/題材/價位）＋ kline payload（法人連買、融資，非同步補上）
const svEsc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const svHas = (v) => v != null && String(v).trim() !== '' && String(v).trim() !== '—' && String(v) !== 'None';
const svNum = (v) => { const n = parseFloat(v); return isFinite(n) ? n : null; };
const svTruthy = (v) => v === 1 || v === true || v === '1' || v === 1.0;

// 尾端 None 跳過後：連續同向天數 + 近5個有效日合計；回傳 {streak, sum5, asofIdx} 或 null
function svInstStreak(arr) {
  if (!arr || !arr.length) return null;
  let i = arr.length - 1;
  while (i >= 0 && (arr[i] == null || !isFinite(arr[i]))) i--;
  if (i < 0) return null;
  const asofIdx = i;
  const sign = arr[i] > 0 ? 1 : arr[i] < 0 ? -1 : 0;
  let streak = 0;
  for (let j = i; j >= 0; j--) {
    const v = arr[j];
    if (v == null || !isFinite(v)) break;
    if ((v > 0 ? 1 : v < 0 ? -1 : 0) !== sign || sign === 0) break;
    streak++;
  }
  let sum5 = 0, k = 0;
  for (let j = i; j >= 0 && k < 5; j--) {
    const v = arr[j];
    if (v == null || !isFinite(v)) continue;
    sum5 += v; k++;
  }
  return { streak, sign, sum5, asofIdx };
}
function svInstBit(label, r) {
  if (!r || r.sign === 0) return null;
  const verb = r.sign > 0 ? '連買' : '連賣';
  const col = r.sign > 0 ? '#ef5350' : '#26a69a';
  return `${label}<b style="color:${col}">${verb}${r.streak}日</b>` +
    `（5日${r.sum5 > 0 ? '+' : ''}${Math.round(r.sum5).toLocaleString()}張）`;
}

function svRow(icon, title, html) {
  if (!html) return '';
  return `<div class="sv-row"><span class="sv-ic">${icon}</span>
    <div class="sv-main"><div class="sv-t">${title}</div><div class="sv-c">${html}</div></div></div>`;
}

function renderStockSummary(ticker, name, market, row) {
  const el = document.getElementById('kc-summary');
  if (!el) return;
  if (!row) {
    el.innerHTML = `<div class="sv-none">此標的不在今日篩選結果中（自選/其他分頁點入）。` +
      `<br>直接開 <a href="${tvUrl(ticker, market)}" target="_blank" class="kline-tv">TradingView ↗</a> 看圖。</div>`;
    return;
  }
  const G = (k) => row[k];

  // ① 價格 + 結論
  const chg = svNum(G('chg_pct'));
  const chgCol = chg == null ? '#888' : chg >= 0 ? '#ef5350' : '#26a69a';
  const priceRow = `<div class="sv-price">收盤 <b>${svHas(G('close')) ? G('close') : '--'}</b>` +
    (chg != null ? `　<b style="color:${chgCol}">${chg > 0 ? '+' : ''}${chg}%</b>` : '') +
    (svHas(G('streak_note')) ? `　<span class="sv-mut">${svEsc(G('streak_note'))}</span>` : '') + `</div>` +
    (svHas(G('verdict')) ? `<div class="sv-verdict">${svEsc(G('verdict'))}</div>` : '');

  // ② 入選分類 badge（用主表 categories 的 label/color）
  const catMeta = {};
  ((state.data && state.data.categories) || []).forEach(c => { catMeta[c.code] = c; });
  const badges = (G('categories') || []).map(code => {
    const m = catMeta[code] || {};
    return `<span class="sv-badge" style="border-color:${m.color || '#555'}">${svEsc(m.label || code)}</span>`;
  }).join('');
  const scoreBits = [];
  if (svNum(G('score')) != null) scoreBits.push(`分數 <b>${Math.round(svNum(G('score')))}</b>`);
  if (svNum(G('hits')) != null) scoreBits.push(`命中 ${G('hits')} 類`);
  const catHtml = (badges || scoreBits.length)
    ? `${badges}${scoreBits.length ? `<span class="sv-mut" style="margin-left:8px">${scoreBits.join('　')}</span>` : ''}` : '';

  // ③ 訊號明細（為什麼被篩出來）
  const S = [['s1', 'S1長底'], ['s2', 'S2爆量'], ['s3', 'S3多排'], ['s4', 'S4突破'], ['s5', 'S5題材']];
  const C = [['c1', 'C1多頭'], ['c2', 'C2黃金交叉'], ['c3', 'C3進場點']];
  const sLit = S.filter(([k]) => svTruthy(G(k))).map(([, n]) => n);
  const cLit = C.filter(([k]) => svTruthy(G(k))).map(([, n]) => n);
  const sig = [];
  if (svHas(G('mainup_tag'))) sig.push(`<b style="color:#ffd54f">${svEsc(G('mainup_tag'))}</b>`);
  if (svHas(G('mainup_entry'))) sig.push(`<b style="color:#22c55e">${svEsc(G('mainup_entry'))}</b>`);
  if (svNum(G('mainup_n')) != null) sig.push(`飆股5訊號 ${G('mainup_n')}/5${sLit.length ? '（' + sLit.join('、') + '）' : ''}`);
  if (svNum(G('win_n')) != null) sig.push(`高勝率 ${G('win_n')}/3${cLit.length ? '（' + cLit.join('、') + '）' : ''}`);
  if (svTruthy(G('weekly_lit'))) sig.push('週線亮燈');
  if (svHas(G('reaction_bar_type'))) sig.push(`反應K：${svEsc(G('reaction_bar_type'))}`);
  if (svHas(G('strength'))) sig.push(svEsc(G('strength')));
  if (svHas(G('bb_squeeze')) && G('bb_squeeze') !== '') sig.push(`BB壓縮 ${svEsc(G('bb_squeeze'))}`);
  if (svHas(G('overhead'))) sig.push(svEsc(G('overhead')));
  if (svTruthy(G('mainup_dist')) || (svNum(G('dist_risk')) || 0) > 0)
    sig.push(`<b style="color:#ff5252">⚠出貨警訊${svHas(G('dist_signal')) ? '：' + svEsc(G('dist_signal')) : ''}</b>`);
  // 圓弧底/黃金分割狀態（欄位下次 export 才有值，缺值不顯示）
  const rSt = G('rounding_state'), fSt = G('fib_state');
  if (svHas(rSt)) sig.push(`圓弧底 <b style="color:${/剛突破|回後買點/.test(rSt) ? '#22c55e' : /已達標/.test(rSt) ? '#f5b942' : '#8fa3b8'}">${svEsc(rSt)}</b>`);
  if (svHas(fSt)) sig.push(`黃金分割 <b style="color:${/買點/.test(fSt) ? '#22c55e' : /失效|過深/.test(fSt) ? '#ff5252' : '#8fa3b8'}">${svEsc(fSt)}</b>` +
    (svNum(G('fib_retrace')) != null ? `<span class="sv-mut">（回檔${G('fib_retrace')}）</span>` : ''));
  const gSt = G('gap_state'), nSt = G('nbase_state');
  if (svHas(gSt)) sig.push(`缺口 <b style="color:${/⛔/.test(gSt) ? '#ff5252' : /✅/.test(gSt) ? '#22c55e' : '#8fa3b8'}">${svEsc(gSt)}</b>`);
  if (svHas(nSt)) sig.push(`N字底 <b style="color:${/🔥|回後/.test(nSt) ? '#22c55e' : /已達標/.test(nSt) ? '#f5b942' : '#8fa3b8'}">${svEsc(nSt)}</b>`);
  const sSt = G('sr_state'), oSt = G('sr_overhead');
  if (svHas(oSt)) sig.push(`上檔 <b style="color:${/✅/.test(oSt) ? '#22c55e' : /⚠/.test(oSt) ? '#f5b942' : '#8fa3b8'}">${svEsc(oSt)}</b>`);
  if (svHas(sSt)) sig.push(`支撐 <b style="color:${/⛔/.test(sSt) ? '#ff5252' : /撐住/.test(sSt) ? '#22c55e' : '#8fa3b8'}">${svEsc(sSt)}</b>`);

  // ④ 題材 / 族群
  const th = [];
  if (svHas(G('industry'))) th.push(`${svEsc(G('industry'))}${svHas(G('sub_industry')) ? ' › ' + svEsc(G('sub_industry')) : ''}`);
  if (svHas(G('hot_sector'))) th.push(`🔥 ${svEsc(G('hot_sector'))}`);
  if (svHas(G('hot_concept'))) th.push(`💡 ${svEsc(G('hot_concept'))}`);
  const dConcept = (G('d_concept') || []).filter(x => svHas(x));
  if (dConcept.length) th.push(`題材：${dConcept.map(svEsc).join('、')}`);

  // ⑤ 關鍵價位（帶去 TradingView 畫線用）
  const px = [];
  if (svHas(G('buy_point'))) px.push(`買點 <b style="color:#22c55e">${svEsc(G('buy_point'))}</b>`);
  if (svNum(G('defense')) != null) px.push(`防守 <b>${G('defense')}</b>`);
  if (svNum(G('stop_loss')) != null) px.push(`停損 <b style="color:#ff5252">${G('stop_loss')}</b>` +
    (svNum(G('stop_loss_pct')) != null ? `（−${G('stop_loss_pct')}%）` : ''));
  if (svNum(G('target')) != null) px.push(`目標 <b style="color:#ffd54f">${G('target')}</b>`);
  if (svNum(G('rounding_target')) != null)
    px.push(`圓弧測幅 <b style="color:#ffd54f">${G('rounding_target')}</b><span class="sv-mut">（120根內達標≈66%）</span>`);
  if (svNum(G('nbase_target')) != null)
    px.push(`N字測幅 <b style="color:#ffd54f">${G('nbase_target')}</b><span class="sv-mut">（停損守第二腳低，勿守突破K低）</span>`);
  if (svNum(G('gap_support')) != null) px.push(`缺口支撐 <b>${G('gap_support')}</b>`);
  if (svNum(G('sr_support')) != null)
    px.push(`支撐位 <b>${G('sr_support')}</b>` +
      ((svNum(G('sr_confluence')) || 0) > 1 ? `<span class="sv-mut">（疊撐${G('sr_confluence')}層）</span>` : ''));
  const rrV = svNum(G('rr_ratio')) != null ? svNum(G('rr_ratio')) : svNum(G('rr'));
  if (rrV != null) px.push(`R:R <b style="color:${rrV >= 2 ? '#22c55e' : rrV >= 1 ? '#f5b942' : '#888'}">${rrV.toFixed(2)}</b>`);
  const pxNote = svHas(G('entry_method')) ? `<div class="sv-mut" style="margin-top:3px">${svEsc(G('entry_method'))}</div>` : '';

  el.innerHTML = `<div class="sv-wrap">
    ${priceRow}
    ${catHtml ? `<div class="sv-cats">${catHtml}</div>` : ''}
    ${svRow('📌', '訊號', sig.join('　·　'))}
    ${svRow('🏭', '題材族群', th.join('　｜　'))}
    ${svRow('💰', '籌碼', `<span id="sv-chip">載入中…</span>`)}
    ${svRow('📐', '關鍵價位', px.length ? px.join('　｜　') + pxNote : '')}
    <div class="sv-foot">訊號為策略輔助、非投資建議 — 進出場請至 TradingView 自行判斷。</div>
  </div>`;
}

// 籌碼區塊：kline payload 載完後補上
function patchChipBlock(d) {
  const el = document.getElementById('sv-chip');
  if (!el) return;
  if (!d || !d.has_inst) { el.textContent = '無法人資料'; return; }
  const f = svInstStreak(d.inst_foreign), t = svInstStreak(d.inst_trust);
  const bits = [svInstBit('外資', f), svInstBit('投信', t)].filter(Boolean);
  // 融資5日增減
  const mb = (d.margin_bal || []).filter(v => v != null && isFinite(v));
  if (d.has_margin && mb.length >= 6) {
    const diff = mb[mb.length - 1] - mb[mb.length - 6];
    bits.push(`融資5日${diff > 0 ? '+' : ''}${Math.round(diff).toLocaleString()}張`);
  }
  // 法人資料落後標註
  let lag = '';
  if (f && d.dates && f.asofIdx < d.dates.length - 1)
    lag = `<span class="sv-mut">（法人至 ${svEsc(d.dates[f.asofIdx])}）</span>`;
  el.innerHTML = bits.length ? bits.join('　｜　') + '　' + lag : '外資/投信近日無明顯方向 ' + lag;
}

async function openKlineModal(ticker, name, market) {
  const modal = document.getElementById('kline-modal');
  modal.hidden = false;
  document.getElementById('kline-title').textContent = `${ticker}　${name || ''}`;
  document.getElementById('kline-tv').href = tvUrl(ticker, market);

  // 主表權威列（不論從哪個表點開）
  const row = (state.data && state.data.rows)
    ? state.data.rows.find(r => String(r.ticker) === String(ticker)) || null : null;
  renderStockSummary(ticker, name, market, row);
  renderDispositionRisk(ticker);

  try {
    let d = klineState.cache[ticker];
    if (!d) {
      d = await fetchJsonGz(`data/kline/${ticker}.json.gz`);
      klineState.cache[ticker] = d;
    }
    patchChipBlock(d);
  } catch (err) {
    const el = document.getElementById('sv-chip');
    if (el) el.textContent = '籌碼資料載入失敗';
  }
}

function closeKlineModal() {
  document.getElementById('kline-modal').hidden = true;
}

function initKlineModal() {
  document.querySelectorAll('[data-kline-close]').forEach(el =>
    el.addEventListener('click', closeKlineModal));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('kline-modal').hidden)
      closeKlineModal();
  });
}
document.addEventListener('DOMContentLoaded', initKlineModal);

// ── 處置雷達：處置股 / 潛在注意股（卡片格線，仿attnup排版）───
const dispState = { loaded: false, loadedDate: null, data: null };

function _dispSigned(v, digits) {
  if (v == null) return '--';
  const n = Number(v);
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}`;
}

function _dispCardHtml(r, bucket) {
  const slopeCls = (r.ma20_slope || 0) > 0 ? 'num-pos' : ((r.ma20_slope || 0) < 0 ? 'num-neg' : '');
  const declineCls = (r.cumulative_decline_pct || 0) > 0 ? 'num-pos' : ((r.cumulative_decline_pct || 0) < 0 ? 'num-neg' : '');
  const chgCls = (r.chg_pct || 0) > 0 ? 'num-pos' : ((r.chg_pct || 0) < 0 ? 'num-neg' : '');
  const cycleBadge = r.matching_cycle_minutes
    ? `<span class="disp-badge disp-badge-amber">${r.matching_cycle_minutes}分盤</span>` : '';
  const statusBadge = bucket === 'punish'
    ? `<span class="disp-badge ${r.est_days_to_exit <= 3 ? 'disp-badge-red' : (r.est_days_to_exit <= 7 ? 'disp-badge-amber' : 'disp-badge-green')}">出關${r.est_days_to_exit}日</span>`
    : `<span class="disp-badge disp-badge-amber">近10日注意${r.watch_count_10d}次</span>`;
  const repeatIcon = r.repeat_disposition_flag ? ' ⚠️二度' : '';
  const fullDeliveryIcon = r.full_delivery_flag ? ' 🈵全額' : '';
  const declineLine = bucket === 'punish'
    ? `累幅<span class="${declineCls}">${_dispSigned(r.cumulative_decline_pct, 1)}%</span>　`
    : '';
  const volTxt = r.volume != null ? `${Math.round(r.volume).toLocaleString()}張` : '--';
  const turnoverTxt = r.turnover_pct != null ? `${r.turnover_pct.toFixed(1)}%` : '--';
  return `<button type="button" class="disp-card" data-ticker="${r.ticker}">
    <div class="disp-card-head">
      <span class="disp-card-code">${r.ticker}</span>
      <span class="disp-card-name">${r.name || ''}</span>
      <span class="disp-card-market">${r.market || ''}</span>
    </div>
    <div class="disp-card-price">${r.close ?? '--'}<span class="${chgCls}" style="font-size:13px;margin-left:6px">${_dispSigned(r.chg_pct, 2)}%</span></div>
    <div class="disp-card-badges">${cycleBadge} ${statusBadge}${repeatIcon}${fullDeliveryIcon}</div>
    <div class="disp-card-meta">量${volTxt}　週轉率${turnoverTxt}</div>
    <div class="disp-card-meta">位階${_dispSigned(r.position_index, 1)}　月線斜率<span class="${slopeCls}">${_dispSigned(r.ma20_slope, 1)}%</span></div>
    <div class="disp-card-meta">${declineLine}距高點${_dispSigned(r.drawdown_from_high, 1)}%</div>
  </button>`;
}

function _bindDispCards(container, rows) {
  container.querySelectorAll('.disp-card').forEach(card => {
    const t = card.dataset.ticker;
    const r = rows.find(x => String(x.ticker) === t);
    if (r) card.addEventListener('click', () => openKlineModal(r.ticker, r.name, r.market));
  });
}

async function loadDisposition() {
  if (dispState.loaded && dispState.loadedDate === currentDate) {
    renderDisposition(); return;
  }
  const metaEl = document.getElementById('disp-meta');
  const entry = (indexMeta?.dates || []).find(
    e => e.date === currentDate && (e.has || []).includes('disposition'));
  let dDate = currentDate;
  if (!entry) {
    const fallback = (indexMeta?.dates || []).find(e => (e.has || []).includes('disposition'));
    if (!fallback) {
      metaEl.textContent = '無處置雷達資料';
      document.getElementById('disp-punish-table').innerHTML = '';
      document.getElementById('disp-watch-table').innerHTML = '';
      return;
    }
    dDate = fallback.date;
  }
  metaEl.textContent = '載入中...';
  try {
    dispState.data = await fetchJsonGz(`data/daily/${dDate}/disposition.json.gz`);
    dispState.loaded = true;
    dispState.loadedDate = currentDate;
    metaEl.textContent = `資料日 ${dispState.data.trading_date}　|　處置中 ${dispState.data.punish.length} 檔　|　`
      + `潛在注意股 ${dispState.data.watch.length} 檔　|　更新 ${dispState.data.generated_at.slice(11, 16)}`;
    renderDisposition();
  } catch (err) {
    metaEl.textContent = `載入失敗：${err.message}`;
  }
}

function _drChip(r) {
  const cycleTxt = r.matching_cycle_minutes ? `${r.matching_cycle_minutes}分盤` : '';
  return `<button type="button" class="dr-daily-chip" data-ticker="${r.ticker}">` +
    `${r.ticker} ${r.name || ''}${cycleTxt ? ` <span class="disp-badge disp-badge-amber">${cycleTxt}</span>` : ''}` +
    `</button>`;
}

function _bindDrChips(container, rows) {
  container.querySelectorAll('.dr-daily-chip').forEach(chip => {
    const t = chip.dataset.ticker;
    const r = rows.find(x => String(x.ticker) === t);
    if (r) chip.addEventListener('click', () => openKlineModal(r.ticker, r.name, r.market));
  });
}

function renderDispFocusStrip(data) {
  const el = document.getElementById('disp-focus-strip');
  if (!el) return;
  const upcoming = data.upcoming || [];
  const newToday = data.new_today || [];
  const exiting = (data.punish || []).slice()
    .sort((a, b) => (a.est_days_to_exit ?? 999) - (b.est_days_to_exit ?? 999))
    .slice(0, 12);

  if (!upcoming.length && !newToday.length && !exiting.length) {
    el.hidden = true; el.innerHTML = ''; return;
  }
  el.hidden = false;
  el.innerHTML = `<div class="dr-daily-wrap">
    <div class="dr-daily-col">
      <div class="dr-daily-title">⚠️ 即將處置 <span class="fs-sub">${upcoming.length}</span></div>
      <div class="dr-daily-chips">${upcoming.length ? upcoming.map(_drChip).join('') : '<span class="sv-mut">目前無</span>'}</div>
    </div>
    <div class="dr-daily-col">
      <div class="dr-daily-title">🔶 今日進處置 <span class="fs-sub">${newToday.length}</span></div>
      <div class="dr-daily-chips">${newToday.length ? newToday.map(_drChip).join('') : '<span class="sv-mut">目前無</span>'}</div>
    </div>
    <div class="dr-daily-col">
      <div class="dr-daily-title">🔷 近期出關 <span class="fs-sub">${exiting.length}</span></div>
      <div class="dr-daily-chips">${exiting.length ? exiting.map(_drChip).join('') : '<span class="sv-mut">目前無</span>'}</div>
    </div>
  </div>`;
  _bindDrChips(el, [...upcoming, ...newToday, ...exiting]);
}

function renderDisposition() {
  if (!dispState.data) return;
  renderDispFocusStrip(dispState.data);
  const punishRows = dispState.data.punish || [];
  const watchRows = dispState.data.watch || [];

  const pEl = document.getElementById('disp-punish-table');
  pEl.innerHTML = punishRows.length
    ? `<div class="disp-card-grid">${punishRows.map(r => _dispCardHtml(r, 'punish')).join('')}</div>`
    : `<div class="sv-none">目前無處置中股票</div>`;
  _bindDispCards(pEl, punishRows);

  const wEl = document.getElementById('disp-watch-table');
  wEl.innerHTML = watchRows.length
    ? `<div class="disp-card-grid">${watchRows.map(r => _dispCardHtml(r, 'watch')).join('')}</div>`
    : `<div class="sv-none">目前無潛在注意股</div>`;
  _bindDispCards(wEl, watchRows);
}

// ── K線彈窗內「處置風險分析」區塊（點任何分頁的個股都會查一次）──
async function _ensureDispDataLoaded() {
  if (dispState.data) return dispState.data;
  const entry = (indexMeta?.dates || []).find(
    e => e.date === currentDate && (e.has || []).includes('disposition'));
  const fallback = entry ? null : (indexMeta?.dates || []).find(e => (e.has || []).includes('disposition'));
  const dDate = entry ? currentDate : (fallback ? fallback.date : null);
  if (!dDate) return null;
  try {
    dispState.data = await fetchJsonGz(`data/daily/${dDate}/disposition.json.gz`);
    return dispState.data;
  } catch (err) {
    return null;
  }
}

const DR_LEVEL_MARK = { triggered: '⚠️', close: '🟡', far: '·', unavailable: '？' };
const DR_LEVEL_CLS  = { triggered: 'hit-true', close: 'hit-close', far: 'hit-false', unavailable: 'hit-null' };

function _drClauseItem(no, c) {
  const level = c.level || (c.hit === true ? 'triggered' : (c.hit === false ? 'far' : 'unavailable'));
  const mark = DR_LEVEL_MARK[level] || '？';
  const cls = DR_LEVEL_CLS[level] || 'hit-null';
  const windowsTxt = (c.windows || []).map(w =>
    `${w.days}日${w.level === 'triggered' ? '⚠️' : (w.level === 'close' ? '🟡' : '·')}`).join(' ');
  return `<div class="dr-clause-item ${cls}"><span class="dr-mark">${mark}</span>` +
    `<span>第${no}款 ${svEsc(c.name)}<br><span class="sv-mut">${svEsc(c.text)}</span>` +
    (windowsTxt ? `<br><span class="sv-mut">${windowsTxt}</span>` : '') + `</span></div>`;
}

function _drHistoryItem(h) {
  const nos = (h.clauses || []).map(n => `第${n}款`).join('、');
  return `<div class="dr-hist-row"><span>${fmtDate8(h.date)}</span><span class="sv-mut">${svEsc(nos)}</span></div>`;
}

async function renderDispositionRisk(ticker) {
  const el = document.getElementById('dr-block');
  if (!el) return;
  el.innerHTML = '';
  const data = await _ensureDispDataLoaded();
  if (!data) return;
  const r = [...(data.punish || []), ...(data.watch || [])]
    .find(x => String(x.ticker) === String(ticker));
  if (!r) return;   // 不在處置/潛在注意名單內，不顯示這個區塊

  const isPunish = r.punish_start_date != null;
  const bannerCls = isPunish ? 'punish' : 'watch';
  const bannerText = isPunish
    ? `🚨 處置中　撮合${r.matching_cycle_minutes}分盤　處置期${fmtDate8(r.punish_start_date)}起第${r.days_in_punish}天`
    : `👀 潛在注意股（尚未處置）`;
  const bannerSub = isPunish
    ? `估計出關倒數 ${r.est_days_to_exit} 個交易日${r.repeat_disposition_flag ? '（⚠️近期二度以上處置）' : ''}`
    : `近10日觸發注意${r.watch_count_10d}次　近30日${r.watch_count_30d}次`;

  // ① 觸發條件 + 預測細節（14款清單，含條款詳細數值色階與30/60/90日子窗）
  const clauses = r.clauses || {};
  const clauseHtml = Object.keys(clauses).length
    ? `<div class="dr-clause-grid">${Object.entries(clauses).map(([no, c]) => _drClauseItem(no, c)).join('')}</div>`
    : '';

  // ② 除外情形（目前只做第2款，官方規則第3條第3/4款，見disposition_rules.py）
  const ex2 = r.exemption_clause2;
  const exemptionHtml = (ex2 && ex2.checked) ? `<div class="dr-section-title">第2款除外情形</div>
    <div class="dr-exemption ${ex2.exempt ? 'exempt' : ''}">
      <div>${ex2.exempt ? '✅ 符合除外情形' : '❌ 不符合除外情形'}</div>
      <div class="sv-mut">${svEsc(ex2.text)}</div>
    </div>` : '';

  // ③ 處置期間累計（官方第6條四計數器）
  const w = r.disposition_windows || {};
  const windowsHtml = w.streak3_of_c1 != null ? `<div class="dr-section-title">處置期間累計</div>
  <div class="dr-windows">
    <div class="dr-window-cell"><b>${w.streak3_of_c1}/3</b><span>連續三次(第1款)</span></div>
    <div class="dr-window-cell"><b>${w.streak5_of_c1to8}/5</b><span>連續五次(第1-8款)</span></div>
    <div class="dr-window-cell"><b>${w.count10_of_c1to8}/6</b><span>10日內(第1-8款)</span></div>
    <div class="dr-window-cell"><b>${w.count30_of_c1to8}/12</b><span>30日內(第1-8款)</span></div>
  </div>` : '';

  // ④ 估值與融資融券
  const val = r.valuation || {};
  const valCell = (label, v, digits, suffix) =>
    `<div class="dr-val-cell"><b>${v != null ? v.toFixed(digits) + (suffix || '') : '--'}</b><span>${label}</span></div>`;
  const valHtml = `<div class="dr-section-title">估值與融資融券</div><div class="dr-val-grid">
    ${valCell('本益比', val.pe_ratio, 1, '')}
    ${valCell('股價淨值比', val.pbr, 2, '')}
    ${valCell('週轉率', val.turnover_pct, 1, '%')}
    ${valCell('融資使用率', val.margin_usage_pct, 1, '%')}
    ${valCell('融券使用率', val.short_usage_pct, 1, '%')}
    ${valCell('券資比', val.short_margin_ratio, 1, '%')}
  </div>`;

  // ⑤ 注意股歷史（近30日，逐日觸發哪幾款）
  const hist = r.alert_history || [];
  const histHtml = hist.length ? `<div class="dr-section-title">注意股歷史（近30日）</div>
    <div class="dr-hist-list">${hist.map(_drHistoryItem).join('')}</div>` : '';

  el.innerHTML = `<div class="dr-wrap">
    <div class="dr-banner ${bannerCls}">${bannerText}<div class="dr-banner-sub">${bannerSub}</div></div>
    <div class="dr-section-title">14款觸發狀態（⚠️觸發／🟡接近門檻／·未觸發／？無法判定，見說明文字）</div>
    ${clauseHtml}
    ${exemptionHtml}
    ${windowsHtml}
    ${valHtml}
    ${histHtml}
  </div>`;
}
