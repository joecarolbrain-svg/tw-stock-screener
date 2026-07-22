// ─────────────────────────────────────────────────────────
//  右側突破篩選器 — 雲端 MVP 前端
//  讀 web/data/latest.json → 渲染表格 + 多條件篩選
// ─────────────────────────────────────────────────────────

const PRESET_STORAGE_KEY = 'screener_presets_v1';

// 介面版本 — 顯示在頁尾，方便確認是否載到最新版(避開瀏覽器快取舊檔)
const APP_VERSION = '20260705h';
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
    await mergeInstNet(data);
    await loadMarginMaint();
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
  // 只看今日外資或投信買超
  onlyInstBuy: false,
  // 只看籌碼面偏多（chipAdvice 判定 法人強力同買 / 法人偏買）
  onlyChipBull: false,
  onlyMaintAlert: false,
  // 卡片分組檢視是否展開「未上榜」段（有搜尋字串時自動展開，不動此旗標）
  showUnlisted: false,
  // 只看有個股期貨（大型或小型）
  onlyStf: false,
  // 只看今日收紅K（陽線：收盤>開盤，或漲停）
  onlyRedK: false,
  // 只看量能跟上（量比≥1.2 或 一字鎖漲停 或 處置股例外）
  onlyVolUp: false,
  // 排名延續快捷視圖（互斥）：null|new(新進)|surge(衝榜中)|fade(掉分)
  persistView: null,
  // 主表欄位密度：2026-07-22 起統一完整模式（user 要求砍掉精簡）——表格全欄、卡片一律展開細節
  tableFull: true,
  // 主升策略：off|sig|A|B；sig 模式用 mainupSignals 勾選的旗標(5訊號+3條件+季線突破)
  mainupMode: 'off',
  mainupSignals: new Set(['s1', 's2', 's3', 's4', 's5', 'c1', 'c2', 'c3', 'mainup_ma60']),
  mainupEntry: '',        // 進場型態篩選（空=不限）；任何模式皆生效
  mainupExclDist: false,  // 排除出貨警訊；任何模式皆生效
  deductTurn: false,      // 扣抵轉揚↑（三線皆將上彎，實證edge+1.2）；任何模式皆生效
  deductUp2: false,       // 扣抵上彎≥2條（較寬）；任何模式皆生效
  deductExclWarn: false,  // 排除陰跌警訊（月/季線將下彎）；任何模式皆生效
  weeklyLit: false,       // 🌱週線亮燈（週爆量∩週多排）
  instStreak3: false,     // 🌱法人連買≥3日
  boGood: false,          // 🚀✅真突破（強K非爆量/回測撐住；bt_breakout 校準）
  exclSrBreak: false,     // 📈排除跌破支撐⛔
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

// ── 融資維持率雷達 ──────────────────────────────────
// 維持率 = 收盤 ÷ (推估平均融資成本 × 0.6)。跟「各股自己在 2025-04-09 關稅崩盤
// 低點的維持率」比，不是統一門檻（137 那種數字只對台積電成立，國巨的地板是 107）。
const maintState = { map: {}, detail: {}, newToday: [], baseDate: '', counts: {} };

async function loadMarginMaint() {
  maintState.map = {}; maintState.detail = {}; maintState.newToday = [];
  try {
    const d = await fetchJsonGz(dailyPath('margin_maint'));
    ['broken', 'reached', 'approaching', 'extreme'].forEach(k => {
      (d[k] || []).forEach(v => { maintState.map[String(v.ticker)] = v; });
    });
    (d.new_today || []).forEach(v => {
      const e = maintState.map[String(v.ticker)];
      if (e) e.isNew = true; else maintState.map[String(v.ticker)] = { ...v, isNew: true };
    });
    maintState.detail = d.detail || {};
    maintState.newToday = d.new_today || [];
    maintState.baseDate = d.base_date || '';
    maintState.counts = d.counts || {};
    maintState.note = d.note || '';
  } catch (_) { /* 沒有當日檔就整個功能靜默停用 */ }
}

// gap_base_pct：還要漲/跌幾% 才回到基準日水位。>0＝已比關稅時更痛。
function maintTone(m) {
  if (!m) return null;
  if (m.state === 'broken') return { cls: 'mt-broken', ico: '🔴', txt: '已破關稅低點' };
  if (m.state === 'reached') return { cls: 'mt-reached', ico: '🩸', txt: '已達關稅低點' };
  const gap = `距關稅低點 ${Math.abs(m.gap_base_pct).toFixed(0)}%`;
  if (m.state === 'approaching') return { cls: 'mt-near', ico: '🟠', txt: gap };
  if (m.state === 'loose') return { cls: 'mt-loose', ico: '🟡', txt: gap };
  return { cls: 'mt-safe', ico: '⚪', txt: gap };
}

function maintLineHtml(r) {
  const m = maintState.map[String(r.ticker)];
  if (!m) return '';
  const t = maintTone(m);
  const tip = `融資維持率 ${m.mr}%（基準日 ${maintState.baseDate} 為 ${m.mr_base}%）`
    + `｜歷史危機地板 ${m.floor_mr}% ≈ ${m.floor_px} 元｜全期百分位 ${m.pctile}%`;
  return `<div class="sc-maint ${t.cls}" title="${tip}">`
    + `<span class="sc-maint-ico">${t.ico}</span><b>融資維持率 ${m.mr}%</b>`
    + `<span class="sc-maint-detail">${t.txt}${m.floor_px ? `｜地板 ${m.floor_px}` : ''}</span>`
    + (m.isNew ? '<span class="sc-maint-new">⚡今日新進</span>' : '') + `</div>`;
}

// 把當日法人買賣超(inst_rank)的外資/投信/自營淨額 join 進主表 rows（P3 看板整合）
async function mergeInstNet(data) {
  const rows = data.rows || [];
  try {
    const inst = await fetchJsonGz(dailyPath('inst_rank'));
    const map = {};
    (inst.rows || []).forEach(r => { map[String(r.code)] = r; });
    rows.forEach(row => {
      const m = map[String(row.ticker)];
      row.foreign_net = m ? m.f : null;
      row.trust_net = m ? m.t : null;
      row.dealer_net = m ? m.d : null;
    });
  } catch (_) {
    rows.forEach(row => { row.foreign_net = row.trust_net = row.dealer_net = null; });
  }
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
// 2026-07-22 重設計：三階段(時間軸)+風險。「籌碼/族群」不是階段是證據——
// M_Accumulate 歸醞釀、GroupResonance 跨階段(落到🏷其他,卡片上有🔥族群標)。
// 每階段該看的確認/否決訊號集中在對應的階段區塊(index.html stage-blk)。
const CAT_GROUPS = [
  { title: '🌱 醞釀(還沒突破)', hint: '蓄勢打底+主力吸籌', codes: ['A_VCP', 'A_Coil', 'N_NearHigh', 'R_Neckline', 'M_Accumulate'] },
  { title: '🚀 發動(突破中)',   hint: '剛突破、發動點',     codes: ['B_Day0', 'B_Recent', 'R_Breakout'] },
  { title: '📈 趨勢(突破後持有)', hint: '沿均線續攻、持有管理', codes: ['S_MA3Rider', 'S_MA5Rider'] },
  { title: '👁 風險/觀察',      hint: '謹慎、別追',         codes: ['P_Watch', 'P_PunishExit', 'P_PostExit'] },
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
// 精簡模式核心欄（+ 合併的 persist）；其餘欄「完整」模式才顯示
const MAIN_CORE_IDS = new Set([
  'ticker', 'name', 'chg_pct', 'hits', 'score', 'category_main', 'persist',
  'verdict', 'strength', 'entry_price', 'stop_loss', 'rr', 'ind_top3_share', 'exit_warn',
]);
// 退掉的欄（與新「延續」重複的舊連續欄）
const MAIN_HIDE_IDS = new Set(['streak_days', 'streak_note']);

// 延續徽章（卡片 + 主表「延續」欄共用）：連N日 / 升降階 / Δ分
// slim=true（分組卡片用）：省略與段落標題重複的 🆕新進榜、🔼升階/⬇️降階 字樣，只留數字
function persistBadgesHtml(r, slim = false) {
  if (r.board_streak == null) return '';
  // 今日上榜（streak==1，含斷檔後回歸）：段標已表達則 slim 省略；streak==1 無 Δ分
  if (r.board_streak === 1) {
    return slim ? '' : '<span class="pst pst-new">🆕今日上榜</span>';
  }
  const bits = [];
  const sCls = r.board_streak >= 5 ? 'pst-hot' : (r.board_streak >= 3 ? 'pst-mid' : '');
  bits.push(`<span class="pst ${sCls}">連${r.board_streak}日</span>`);
  if (!slim) {
    if (r.stage_move === '🔼升階') bits.push('<span class="pst pst-up">🔼升階</span>');
    else if (r.stage_move === '⬇️降階') bits.push('<span class="pst pst-down">⬇️降階</span>');
  }
  if (r.score_delta != null && r.score_delta !== 0) {
    bits.push(`<span class="pst ${r.score_delta > 0 ? 'pst-up' : 'pst-down'}">${r.score_delta > 0 ? '+' : ''}${r.score_delta}分</span>`);
  }
  return bits.join('');
}

// 延續生命週期分組：new(今日上榜) / surge(加溫) / fade(轉弱) / flat(持平)；非命中回 null
function persistBucket(r) {
  const s = r.board_streak;
  if (s == null) return null;
  if (s <= 1) return 'new';
  if (r.score_delta < 0 || r.stage_move === '⬇️降階') return 'fade';
  if (r.score_delta > 0 || r.stage_move === '🔼升階') return 'surge';
  return 'flat';
}

// 分數走勢 unicode sparkline（score_hist = [{d,s}…] 舊→新）
function persistSparkline(hist) {
  if (!Array.isArray(hist) || !hist.length) return '';
  const bars = '▁▂▃▄▅▆▇█';
  const vals = hist.map(h => h.s).filter(v => v != null);
  if (!vals.length) return '';
  const mn = Math.min(...vals), mx = Math.max(...vals), rng = (mx - mn) || 1;
  return hist.map(h => h.s == null ? ' ' : bars[Math.round((h.s - mn) / rng * 7)]).join('');
}

// ── 籌碼面建議 ────────────────────────────────────────
// 只有 foreign_streak/foreign_sum5/trust_streak/trust_sum5 四個欄位可用（broker_net/foreign_net
// 目前後端沒產，全為 null，不要拿來判斷）。主訊號用 streak：方向持續性與股本大小無關，
// 對大型股/小型股都公平；sum5 只做「5日累計同向確認」與量級標註，不單獨當門檻
// （5000張對小型股是天量、對台積電是雜訊，絕對張數門檻會失真）。
// 每邊（外資/投信）-7 ~ +7：連買天數給主分，5日累計同向 +1、背離 -1。
// 連 1 日只給 ±1（單日進出是雜訊，不足以構成方向），連 3 日以上才明顯加權。
function _chipSideScore(streak, sum5) {
  if (streak == null) return null;
  const d = Math.abs(streak);
  const w = d >= 5 ? 6 : d >= 3 ? 4 : d >= 2 ? 2 : d >= 1 ? 1 : 0;
  let s = Math.sign(streak) * w;
  if (s !== 0 && sum5 != null && sum5 !== 0) {
    const agree = (sum5 > 0) === (s > 0);
    s += agree ? Math.sign(s) : -Math.sign(s);
  }
  return s;
}

function _chipSideText(label, streak, sum5) {
  if (streak == null) return '';
  const d = Math.abs(streak);
  const dir = streak > 0 ? `連買${d}日` : (streak < 0 ? `連賣${d}日` : '持平');
  const amt = (sum5 == null) ? ''
    : `（5日${sum5 > 0 ? '+' : ''}${Math.round(sum5).toLocaleString()}張）`;
  return `${label}${dir}${amt}`;
}

// 散戶軸：融資餘額 5 日增減率 → -2(大減) ~ +2(大增)
// 融資是散戶槓桿的代理變數。融資減＝散戶下車、籌碼往法人手上集中；融資暴增＝浮額變多。
// ⚠️ 融資使用率過低（多見於金融股/大型權值）代表融資盤子極小，此時增減率是雜訊
//    （例：合庫金融資餘額僅 2,010 張、使用率 0.05%，−29.8% 其實只有幾百張），一律視為無訊號。
const MARGIN_UTIL_FLOOR = 1.0;   // 融資使用率 %(融資餘額/融資限額) 低於此值不採計
function _marginFlowTier(pct, util) {
  if (pct == null) return 0;
  if (util != null && util < MARGIN_UTIL_FLOOR) return 0;
  if (pct <= -5) return -2;
  if (pct <= -1) return -1;
  if (pct >= 10) return 2;
  if (pct >= 3) return 1;
  return 0;
}

const CHIP_ADVICE_MAP = {
  concentrating: { icon: '🟢', label: '法人買·散戶退場', advice: '法人加碼同時融資減少 — 籌碼由散戶轉到法人手上，結構最乾淨，回檔可承接' },
  strong:        { icon: '🟢', label: '法人強力同買',   advice: '外資投信同方向加碼，籌碼扎實 — 回檔可承接、拉回不輕易砍' },
  bull:          { icon: '🟢', label: '法人偏買',       advice: '籌碼偏多，可順技術面訊號進場' },
  bull_loose:    { icon: '🟡', label: '法人買·融資追高', advice: '法人雖買，但融資同步大增、浮額變多 — 容易被洗盤，部位放小、停損抓緊' },
  retail_hot:    { icon: '🟡', label: '融資急增·法人未進場', advice: '散戶單邊加碼而法人沒跟 — 籌碼鬆散，不宜追價' },
  split:         { icon: '🟡', label: '法人分歧',       advice: '外資投信不同調，籌碼未歸邊 — 進場減量、抓緊停損' },
  flat:          { icon: '⚪', label: '法人無明顯方向', advice: '籌碼中性，勝負看技術面與族群' },
  bear:          { icon: '🔴', label: '法人偏賣',       advice: '籌碼轉弱，反彈不宜追價' },
  retail_catch:  { icon: '🔴', label: '法人賣·散戶接刀', advice: '法人調節、融資反而增加 — 最差的籌碼結構，避開' },
  dump:          { icon: '🔴', label: '法人同步棄守',   advice: '外資投信同步調節，籌碼面不宜作多' },
  na:            { icon: '⚫', label: '無法人資料',     advice: '' },
};

// 籌碼四象限：法人軸(外資+投信連買) × 散戶軸(融資5日增減)
// 回傳 { key, icon, label, advice, detail, total, marginFlow, bullish }
function chipAdvice(r) {
  const f = _chipSideScore(r.foreign_streak, r.foreign_sum5);
  const t = _chipSideScore(r.trust_streak, r.trust_sum5);
  if (f == null && t == null) {
    return { key: 'na', total: 0, marginFlow: 0, bullish: false, detail: '', ...CHIP_ADVICE_MAP.na };
  }
  const fs = f || 0, ts = t || 0, total = fs + ts;
  const mFlow = _marginFlowTier(r.margin_chg5_pct, r.margin_util);
  // 分歧＝兩邊都有明確方向(|分|≥2 ≈ 連≥2日)且方向相反；單邊只連1日不算分歧
  const oppose = ((fs >= 2 && ts <= -2) || (fs <= -2 && ts >= 2));

  let key;
  if (oppose) key = 'split';
  else if (total >= 4) {                       // 法人偏買
    if (mFlow <= -1) key = 'concentrating';    //   ＋融資減 → 籌碼集中（最佳）
    else if (mFlow >= 2) key = 'bull_loose';   //   ＋融資暴增 → 浮額多
    else key = total >= 8 ? 'strong' : 'bull';
  } else if (total <= -4) {                    // 法人偏賣
    if (mFlow >= 2) key = 'retail_catch';      //   ＋融資增 → 散戶接刀（最差）
    else key = total <= -8 ? 'dump' : 'bear';
  } else {                                     // 法人沒方向
    key = mFlow >= 2 ? 'retail_hot' : 'flat';
  }

  const bits = [_chipSideText('外資', r.foreign_streak, r.foreign_sum5),
                _chipSideText('投信', r.trust_streak, r.trust_sum5)];
  // 自營商雜訊高（含權證避險部位），只在連≥3日時才列出，且不參與判定
  if (Math.abs(r.dealer_streak || 0) >= 3) bits.push(_chipSideText('自營', r.dealer_streak, r.dealer_sum5));
  if (r.margin_chg5_pct != null && mFlow !== 0) {
    bits.push(`融資5日${r.margin_chg5_pct > 0 ? '+' : ''}${r.margin_chg5_pct.toFixed(1)}%`);
  } else if (r.margin_util != null && r.margin_util < MARGIN_UTIL_FLOOR) {
    bits.push('融資盤極小');
  }
  return {
    key, total, marginFlow: mFlow,
    bullish: key === 'concentrating' || key === 'strong' || key === 'bull',
    detail: bits.filter(Boolean).join('　｜　'),
    ...CHIP_ADVICE_MAP[key],
  };
}

// 法人買賣超張數格式（正綠負紅、千分位）
function _instNetFmt(v) {
  if (v == null) return '';
  const cls = v > 0 ? 'num-pos' : (v < 0 ? 'num-neg' : '');
  return `<span class="${cls}">${v > 0 ? '+' : ''}${v.toLocaleString()}</span>`;
}

// 依 state.tableFull 顯示/隱藏非核心欄
function applyTableDensity() {
  if (!state.table) return;
  state.table.getColumns().forEach(col => {
    const f = col.getField();
    if (!f || f === 'persist') return;         // pin / 延續 複合欄一律保留
    if (state.tableFull || MAIN_CORE_IDS.has(f)) col.show();
    else col.hide();
  });
  const btn = document.getElementById('btn-table-density');
  if (btn) btn.textContent = state.tableFull ? '⊞ 完整' : '⊟ 精簡';
}

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

  const baseCols = data.column_meta.filter(c => !MAIN_HIDE_IDS.has(c.id)).map(c => {
    const def = {
      title: c.label,
      field: c.id,
      headerFilter: false,
      headerTooltip: c.label,
      visible: state.tableFull || MAIN_CORE_IDS.has(c.id),   // 精簡=只核心
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
        if (['dist_high', 'dist_year_high', 'risk_pct', 'stop_loss_pct', 'chg_pct', 'score_delta'].includes(c.id)) {
          const cls = v > 0 ? 'num-pos' : (v < 0 ? 'num-neg' : '');
          const sign = (c.id === 'chg_pct' || c.id === 'score_delta') && v > 0 ? '+' : '';
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
    // 連續上榜欄：≥5 螢光、≥3 橘（延續愈久＝訊號愈成熟）
    if (c.id === 'board_streak') {
      def.formatter = (cell) => {
        const v = cell.getValue();
        if (v == null || v === 0) return '';
        if (v >= 5) return `<span class="hits-strong" title="連續上榜${v}個交易日">${v}日</span>`;
        if (v >= 3) return `<span class="hits-mid" title="連續上榜${v}個交易日">${v}日</span>`;
        return `<span>${v}日</span>`;
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
  });

  // 合併「延續」複合欄（連N日/升降階/Δ分，hover=軌跡），插在 主分類 之後
  const persistCol = {
    title: '延續', field: 'persist', headerSort: false, width: 150, visible: true,
    headerTooltip: '排名延續：連續上榜天數 / 分類升降階 / 較前一交易日分數變化',
    formatter: (cell) => {
      const r = cell.getRow().getData();
      const html = persistBadgesHtml(r);
      if (!html) return '';
      return `<span title="分類軌跡 ${r.cat_path || '—'}">${html}</span>`;
    },
  };
  const ci = baseCols.findIndex(c => c.field === 'category_main');
  if (ci >= 0) baseCols.splice(ci + 1, 0, persistCol);
  else baseCols.push(persistCol);

  // 法人今日買賣超（張，前端 join 自 inst_rank）— 非核心，完整模式才顯示
  ['foreign_net', 'trust_net'].forEach(fid => {
    baseCols.push({
      title: fid === 'foreign_net' ? '外資買超' : '投信買超', field: fid,
      hozAlign: 'right', sorter: 'number', width: 92,
      visible: state.tableFull, headerTooltip: '今日' + (fid === 'foreign_net' ? '外資' : '投信') + '買賣超（張）',
      formatter: (cell) => _instNetFmt(cell.getValue()),
    });
  });

  const cols = [pinCol, ...baseCols];

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
    applyTableDensity();   // 同步精簡/完整按鈕文字與欄位可見性
  });
  updatePinSummary();
}

// ── 6. 篩選邏輯 ─────────────────────────────────────
function applyFilters() {
  if (!state.table) return;

  state.table.setFilter((row) => {
    // 搜尋優先：輸入代號/名稱時，直接短路、凌駕所有發現型篩選（分類/維度/快捷鈕/分數門檻）。
    // 明確查某一檔就一定看得到，即使該檔沒命中任何策略（hits=0、categories空、score=null）。
    if (state.search) {
      const q = state.search.toLowerCase();
      const t = (row.ticker || '').toLowerCase();
      const n = (row.name || '').toLowerCase();
      return t.includes(q) || n.includes(q);
    }
    // 只看勾選
    if (state.onlyPinned && !state.pinned.has(row.ticker)) return false;
    // 只看共振（同時被 ≥2 策略 actionable：突破/Hanku）
    if (state.onlyResonance && _resoCount(row) < 2) return false;
    // 只顯示族群 z≥1
    if (state.onlyHotGroup && (row.max_group_z == null || row.max_group_z < 1)) return false;
    // 只看法人買超（外資或投信今日買超；streak≥1 即代表最新一日是買方）
    // 註：原本用 foreign_net/trust_net，但後端從未輸出這兩欄（全 null），此鈕等於永遠篩空。
    if (state.onlyInstBuy && !((row.foreign_streak || 0) >= 1 || (row.trust_streak || 0) >= 1)) return false;
    // 只看籌碼面偏多（連買天數＋5日累計綜合，見 chipAdvice）
    if (state.onlyChipBull && !chipAdvice(row).bullish) return false;
    if (state.onlyMaintAlert && !maintState.map[String(row.ticker)]) return false;
    // 只看有個股期貨（大型或小型）
    if (state.onlyStf && !row.stf && !row.stf_mini) return false;
    // 只看今日收紅K（陽線：收盤>開盤，或漲停）
    if (state.onlyRedK && !row.is_red_k) return false;
    // 只看量能跟上（量比≥1.2 或 一字鎖漲停 或 處置股例外[量能失真豁免]）
    if (state.onlyVolUp && !((row.vol_ratio || 0) >= 1.2 || row.is_limit_locked || row.is_disposition)) return false;
    // 排名延續快捷視圖（互斥）：對齊卡片三分段（加溫段=surge+持平），filter 與分組一致
    if (state.persistView) {
      const b = persistBucket(row);
      const sec = (b === 'surge' || b === 'flat') ? 'warm' : (b === 'fade' ? 'weak' : b);
      const want = { new: 'new', surge: 'warm', fade: 'weak' }[state.persistView];
      if (sec !== want) return false;
    }
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

    // （代號/名稱搜尋已移到本函式開頭做「搜尋優先」短路，見上）

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
    if (state.deductTurn && row.deduct_turn !== 1) return false;   // 扣抵轉揚↑（前瞻均線方向）
    if (state.deductUp2 && !((row.deduct_up_n ?? 0) >= 2)) return false;   // 扣抵上彎≥2條
    if (state.deductExclWarn && row.deduct_warn) return false;     // 排除陰跌警訊
    if (state.weeklyLit && row.weekly_lit !== 1) return false;     // 🌱週線亮燈
    if (state.instStreak3 && !((row.inst_streak ?? 0) >= 3)) return false; // 🌱法人連買≥3日
    if (state.boGood && !(row.bo_state && String(row.bo_state).startsWith('✅'))) return false; // 🚀✅真突破
    if (state.exclSrBreak && row.sr_state && String(row.sr_state).includes('⛔')) return false; // 📈排除破支撐

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
const PV_LABEL = { new: '🆕今日上榜', surge: '🔥延續加溫', fade: '⚠️延續轉弱' };

// 清除排名延續快捷視圖（狀態 + 按鈕 active 樣式）
function clearPersistView() {
  state.persistView = null;
  document.querySelectorAll('#persist-views .pv-btn').forEach(b => b.classList.remove('active'));
}

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
  if (state.deductTurn) add('deductTurn', '扣抵轉揚↑');
  if (state.deductUp2) add('deductUp2', '扣抵上彎≥2');
  if (state.deductExclWarn) add('deductExclWarn', '排除陰跌');
  if (state.weeklyLit) add('weeklyLit', '週線亮燈');
  if (state.instStreak3) add('instStreak3', '法人連買≥3');
  if (state.boGood) add('boGood', '✅真突破');
  if (state.exclSrBreak) add('exclSrBreak', '排除破支撐');
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
  if (state.onlyInstBuy) add('onlyInstBuy', '🏦法人買超');
  if (state.onlyChipBull) add('onlyChipBull', '💰籌碼偏多');
  if (state.onlyMaintAlert) add('onlyMaintAlert', '🩸融資斷頭級');
  if (state.onlyStf) add('onlyStf', '📈有股期');
  if (state.onlyRedK) add('onlyRedK', '🔴收紅K');
  if (state.onlyVolUp) add('onlyVolUp', '🔊量能跟上');
  if (state.persistView) add('persistView', PV_LABEL[state.persistView]);
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
                    (state.deductTurn ? 1 : 0) + (state.deductUp2 ? 1 : 0) + (state.deductExclWarn ? 1 : 0) +
                    (state.weeklyLit ? 1 : 0) + (state.instStreak3 ? 1 : 0) +
                    (state.boGood ? 1 : 0) + (state.exclSrBreak ? 1 : 0) +
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
    case 'deductTurn':
      state.deductTurn = false; { const e = document.getElementById('deduct-turn-up'); if (e) e.checked = false; }
      break;
    case 'deductUp2':
      state.deductUp2 = false; { const e = document.getElementById('deduct-up2'); if (e) e.checked = false; }
      break;
    case 'deductExclWarn':
      state.deductExclWarn = false; { const e = document.getElementById('deduct-excl-warn'); if (e) e.checked = false; }
      break;
    case 'weeklyLit':
      state.weeklyLit = false; { const e = document.getElementById('weekly-lit'); if (e) e.checked = false; }
      break;
    case 'instStreak3':
      state.instStreak3 = false; { const e = document.getElementById('inst-streak3'); if (e) e.checked = false; }
      break;
    case 'boGood':
      state.boGood = false; { const e = document.getElementById('bo-good'); if (e) e.checked = false; }
      break;
    case 'exclSrBreak':
      state.exclSrBreak = false; { const e = document.getElementById('excl-srbreak'); if (e) e.checked = false; }
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
    case 'onlyInstBuy': state.onlyInstBuy = false; { const e = document.getElementById('only-inst-buy'); if (e) e.checked = false; } break;
    case 'onlyChipBull': state.onlyChipBull = false; { const e = document.getElementById('only-chip-bull'); if (e) e.checked = false; } break;
    case 'onlyMaintAlert': state.onlyMaintAlert = false; { const e = document.getElementById('only-maint-alert'); if (e) e.checked = false; } break;
    case 'onlyStf': state.onlyStf = false; { const e = document.getElementById('only-stf'); if (e) e.checked = false; } break;
    case 'onlyRedK': state.onlyRedK = false; { const e = document.getElementById('only-red-k'); if (e) e.checked = false; } break;
    case 'onlyVolUp': state.onlyVolUp = false; { const e = document.getElementById('only-vol-up'); if (e) e.checked = false; } break;
    case 'persistView': clearPersistView(); break;
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
  const dedTurn = document.getElementById('deduct-turn-up');
  if (dedTurn) dedTurn.addEventListener('change', e => { state.deductTurn = e.target.checked; applyFilters(); });
  const dedUp2 = document.getElementById('deduct-up2');
  if (dedUp2) dedUp2.addEventListener('change', e => { state.deductUp2 = e.target.checked; applyFilters(); });
  const dedExW = document.getElementById('deduct-excl-warn');
  if (dedExW) dedExW.addEventListener('change', e => { state.deductExclWarn = e.target.checked; applyFilters(); });
  // 三階段訊號區：新增 4 個 AND 濾網 + 3 顆一鍵精選
  [['weekly-lit', 'weeklyLit'], ['inst-streak3', 'instStreak3'],
   ['bo-good', 'boGood'], ['excl-srbreak', 'exclSrBreak']].forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', e => { state[key] = e.target.checked; applyFilters(); });
  });
  ['brew', 'launch', 'trend'].forEach(k => {
    const b = document.getElementById('preset-' + k);
    if (b) b.addEventListener('click', () => applyStagePreset(k));
  });

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

  const instBuyChk = document.getElementById('only-inst-buy');
  if (instBuyChk) {
    instBuyChk.addEventListener('change', e => {
      state.onlyInstBuy = e.target.checked;
      applyFilters();
    });
  }

  const chipBullChk = document.getElementById('only-chip-bull');
  if (chipBullChk) {
    chipBullChk.addEventListener('change', e => {
      state.onlyChipBull = e.target.checked;
      applyFilters();
    });
  }

  const maintChk = document.getElementById('only-maint-alert');
  if (maintChk) {
    maintChk.addEventListener('change', e => {
      state.onlyMaintAlert = e.target.checked;
      applyFilters();
    });
  }

  const stfChk = document.getElementById('only-stf');
  if (stfChk) {
    stfChk.addEventListener('change', e => {
      state.onlyStf = e.target.checked;
      applyFilters();
    });
  }

  const redKChk = document.getElementById('only-red-k');
  if (redKChk) {
    redKChk.addEventListener('change', e => {
      state.onlyRedK = e.target.checked;
      applyFilters();
    });
  }

  const volUpChk = document.getElementById('only-vol-up');
  if (volUpChk) {
    volUpChk.addEventListener('change', e => {
      state.onlyVolUp = e.target.checked;
      applyFilters();
    });
  }

  // 主表精簡/完整切換
  const densBtn = document.getElementById('btn-table-density');
  if (densBtn) {
    densBtn.addEventListener('click', () => {
      state.tableFull = !state.tableFull;
      try { localStorage.setItem('tableFull', state.tableFull ? '1' : '0'); } catch (_) {}
      applyTableDensity();   // 表格：顯示/隱藏欄位
      refreshMainView();     // 卡片：重繪以展開/收合細節
    });
  }

  // 排名延續快捷視圖：互斥，點已啟用的鈕＝關閉
  document.querySelectorAll('#persist-views .pv-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const pv = btn.dataset.pv;
      const turningOff = state.persistView === pv;
      clearPersistView();
      if (!turningOff) { state.persistView = pv; btn.classList.add('active'); }
      applyFilters();
    });
  });

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

// ── 階段精選：一鍵套用「該階段分類 + 該階段訊號」（先清空全部條件再上組合，結果可預期）──
//   單項濾網皆有實證（扣抵edge+1.2/突破濾網/法人連買），組合本身待bt驗證（見按鈕title註記）。
const STAGE_PRESETS = {
  brew:   { cats: ['A_VCP', 'A_Coil', 'N_NearHigh', 'R_Neckline', 'M_Accumulate'],
            set: () => { state.deductTurn = true; state.instStreak3 = true; },
            boxes: ['deduct-turn-up', 'inst-streak3'] },
  launch: { cats: ['B_Day0', 'B_Recent', 'R_Breakout'],
            set: () => { state.boGood = true; },
            boxes: ['bo-good'] },
  trend:  { cats: ['S_MA3Rider', 'S_MA5Rider'],
            set: () => { state.deductExclWarn = true; state.mainupExclDist = true; state.exclSrBreak = true; },
            boxes: ['deduct-excl-warn', 'mainup-excl-dist', 'excl-srbreak'] },
};

function applyStagePreset(key) {
  const p = STAGE_PRESETS[key];
  if (!p) return;
  clearAllFilters();
  state.selectedCats = new Set(p.cats);
  document.querySelectorAll('.cat-chip').forEach(chip => {
    const on = state.selectedCats.has(chip.dataset.code);
    chip.classList.toggle('checked', on);
    const cb = chip.querySelector('input'); if (cb) cb.checked = on;
  });
  p.set();
  p.boxes.forEach(id => { const e = document.getElementById(id); if (e) e.checked = true; });
  applyFilters();
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
  state.deductTurn = false;
  state.deductUp2 = false;
  state.deductExclWarn = false;
  state.weeklyLit = false;
  state.instStreak3 = false;
  state.boGood = false;
  state.exclSrBreak = false;
  state.islandMode = 'off';
  clearPersistView();
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
  const dedT = document.getElementById('deduct-turn-up'); if (dedT) dedT.checked = false;
  const dedU = document.getElementById('deduct-up2'); if (dedU) dedU.checked = false;
  const dedW = document.getElementById('deduct-excl-warn'); if (dedW) dedW.checked = false;
  ['weekly-lit', 'inst-streak3', 'bo-good', 'excl-srbreak'].forEach(id => {
    const e = document.getElementById(id); if (e) e.checked = false;
  });
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
      {
        title: '名稱', field: 'name', widthGrow: 1,
        formatter: (cell) => {
          const r = cell.getRow().getData();
          return `${r.name || ''}${stfBadgeHtml(r)}${volBadgeHtml(r)}`;
        },
      },
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
      if (tab === 'inst-rank') {
        loadInstRank();
      }
      if (tab === 'cb') {
        loadCB();
      }
      if (tab === 'signal-report') {
        loadSignalReport();
      }
      if (tab === 'disposition') {
        loadDisposition();
        initDispSearch();
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
    await mergeInstNet(data);
    await loadMarginMaint();

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

// 個股期貨標記：有大型→[期]，有小型(每口100股)→再加[小期]。小型 ⊂ 大型。
function stfBadgeHtml(r) {
  if (!r.stf && !r.stf_mini) return '';
  let h = '';
  if (r.stf) h += '<span class="stf-badge stf-big" title="有大型個股期貨（每口2000股）">期</span>';
  if (r.stf_mini) h += '<span class="stf-badge stf-mini" title="有小型個股期貨（每口100股）">小期</span>';
  return h;
}

// 量能標註:一字鎖漲停⚡ / 爆量🔊(≥1.5) / 放量🔊(≥1.2) / 處置股⚖️(量門檻豁免)
function volBadgeHtml(r) {
  // 處置股量能失真 → 只標⚖️處置,不顯示會誤導的爆量/放量倍數
  if (r.is_disposition) return '<span class="stf-badge vol-disp" title="處置股:分盤撮合、量能失真,量門檻豁免">⚖️處置</span>';
  if (r.is_limit_locked) return '<span class="stf-badge vol-lock" title="一字鎖漲停:買不到、量自然小但最強">⚡一字</span>';
  const vr = r.vol_ratio;
  if (vr != null && vr >= 1.5) return `<span class="stf-badge vol-boom" title="爆量:量比≥1.5×5日均量">🔊爆量${vr.toFixed(1)}x</span>`;
  if (vr != null && vr >= 1.2) return `<span class="stf-badge vol-up" title="放量:量比≥1.2×5日均量">🔊放量${vr.toFixed(1)}x</span>`;
  return '';
}

function mainCardHtml(r, grouped = false) {
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
  // 扣抵值（前瞻均線方向）：轉揚=綠旗、陰跌警訊=紅旗（實證 edge+1.2 / 陰跌同級中較弱）
  if (r.deduct_turn === 1) flags.push(['🔥扣抵轉揚', 'f-good']);
  if (r.deduct_warn) flags.push([String(r.deduct_warn).split('(')[0], 'f-warn']);
  const flagHtml = flags.map(([t, c]) => `<span class="tag ${c}">${t}</span>`).join('');

  const hot = (r.max_group_z != null && r.max_group_z >= 1)
    ? '<span class="sc-hot">🔥族群</span>' : '';

  // 排名延續：連續上榜 / 升降階 / Δ分（卡片與主表共用；分組卡片用 slim 版避免與段標重複）
  const persistInner = persistBadgesHtml(r, grouped);
  const persistHtml = persistInner
    ? `<div class="sc-persist" title="分類軌跡 ${r.cat_path || '—'}">${persistInner}</div>` : '';

  // 籌碼面建議一行（結論 + 依據；無法人資料則整行不顯示）
  const ca = chipAdvice(r);
  const chipLine = ca.key === 'na' ? ''
    : `<div class="sc-chip chip-${ca.key}" title="${ca.advice}${ca.detail ? '｜' + ca.detail : ''}">`
      + `<span class="sc-chip-ico">${ca.icon}</span><b>${ca.label}</b>`
      + (ca.detail ? `<span class="sc-chip-detail">${ca.detail}</span>` : '') + `</div>`;

  // 法人連買/連賣 ≥3 天才顯示（雜訊過濾）
  const instBits = [];
  if (r.foreign_streak >= 3) instBits.push(`<span class="tag tag-good">外資連買${r.foreign_streak}日</span>`);
  else if (r.foreign_streak <= -3) instBits.push(`<span class="tag tag-warn">外資連賣${-r.foreign_streak}日</span>`);
  if (r.trust_streak >= 3) instBits.push(`<span class="tag tag-good">投信連買${r.trust_streak}日</span>`);
  else if (r.trust_streak <= -3) instBits.push(`<span class="tag tag-warn">投信連賣${-r.trust_streak}日</span>`);
  const instHtml = instBits.join('');

  // 完整模式：卡片展開細節（精簡模式不顯示）
  let detailHtml = '';
  if (state.tableFull) {
    const pairs = [];
    const addN = (label, v, dp = 2, suf = '') => { if (v != null) pairs.push([label, _cardNum(v, dp) + suf]); };
    const addT = (label, v) => { if (v != null && String(v).trim() && String(v) !== '—') pairs.push([label, String(v)]); };
    addN('MA5', r.ma5); addN('MA60', r.ma60);
    addN('距前高', r.dist_high, 1, '%'); addN('距年高', r.dist_year_high, 1, '%');
    addN('套牢密度', r.trap_density, 1); addT('上方賣壓', r.overhead);
    addN('防守', r.defense); addN('停損', r.stop_loss);
    addN('風險', r.risk_pct, 1, '%'); addN('部位', r.position_pct, 1, '%');
    addN('出貨風險', r.dist_risk, 0);
    addT('扣抵', r.deduct_dir); addT('季線展望', r.deduct_ma60_out);
    // 主力買超（券商分點 rank1）：來源已停更，一律帶資料日期避免被當成當日籌碼
    const bkAsof = (state.data && state.data.chip_asof && state.data.chip_asof.broker) || '';
    const bkSuf = bkAsof ? `<span class="sv-mut">（至${bkAsof}）</span>` : '';
    if (r.broker_net != null && String(r.broker_net) !== '—') pairs.push(['主力買超', r.broker_net + bkSuf]);
    if (r.broker_net_20 != null && String(r.broker_net_20) !== '—') pairs.push(['近20主力', r.broker_net_20 + bkSuf]);
    if (r.foreign_net != null && r.foreign_net !== 0) pairs.push(['外資買超', (r.foreign_net > 0 ? '+' : '') + r.foreign_net.toLocaleString()]);
    if (r.trust_net != null && r.trust_net !== 0) pairs.push(['投信買超', (r.trust_net > 0 ? '+' : '') + r.trust_net.toLocaleString()]);
    addT('主升', r.mainup_tag);
    [['圓弧', r.rounding_state], ['黃金', r.fib_state], ['缺口', r.gap_state],
     ['N字', r.nbase_state], ['支撐', r.sr_state], ['上檔', r.sr_overhead]]
      .forEach(([l, v]) => addT(l, v));
    if (pairs.length) {
      detailHtml = `<div class="sc-detail">` +
        pairs.map(([l, v]) => `<span class="d-item"><i>${l}</i>${v}</span>`).join('') + `</div>`;
    }
  }

  // 扣抵值一行（前瞻均線方向；有資料的卡片常駐顯示，不藏在細節）
  const dedLine = r.deduct_dir
    ? `<div class="sc-deduct" style="font-size:12px;margin:2px 0;color:#9fb4cc"`
      + ` title="扣抵值＝看「明天要被扣掉的舊價」預判均線彎向（領先斜率）；三線皆上彎=扣抵轉揚，實證fwd20+2.42%/edge+1.2">`
      + `🧭 <b style="letter-spacing:1px">${r.deduct_dir}</b>`
      + (r.deduct_ma60_out ? `｜季線${r.deduct_ma60_out}` : '')
      + (r.deduct_turn === 1 ? ' <span style="color:#3ddc84;font-weight:700">轉揚</span>' : '')
      + (r.deduct_warn ? ` <span style="color:#ff6b6b">${String(r.deduct_warn).split('(')[0]}</span>` : '')
      + `</div>`
    : '';

  // 階段徽章＋證據計數：主分類定階段，數「該階段該看的訊號」亮了幾個（hover 看明細）
  const _STAGE_IDX = { A_VCP: 0, A_Coil: 0, N_NearHigh: 0, R_Neckline: 0, M_Accumulate: 0,
                       B_Day0: 1, B_Recent: 1, R_Breakout: 1, S_MA3Rider: 2, S_MA5Rider: 2 };
  let stageBadge = '';
  const _si = _STAGE_IDX[r.category_main];
  if (_si != null) {
    const _defs = [
      ['🌱醞釀', [[r.deduct_turn === 1, '扣抵轉揚'], [(r.inst_streak ?? 0) >= 3, '法人連買≥3'],
                  [r.weekly_lit === 1, '週線亮燈'], [!!(r.sr_overhead && String(r.sr_overhead).includes('✅')), '上檔無壓']]],
      ['🚀發動', [[!!(r.bo_state && String(r.bo_state).startsWith('✅')), '真突破(強K非爆量)'],
                  [!!(r.gap_state && String(r.gap_state).includes('未補')), '缺口未補'],
                  [!!r.mainup_entry && r.mainup_entry !== '⚠過高勿追', '有進場型態']]],
      ['📈趨勢', [[!r.deduct_warn, '無陰跌'], [r.mainup_dist !== 1, '無出貨警訊'],
                  [!(r.sr_state && String(r.sr_state).includes('⛔')), '未破支撐']]],
    ];
    const [_nm, _checks] = _defs[_si];
    const _n = _checks.filter(c => c[0]).length;
    const _tip = _checks.map(c => `${c[0] ? '✅' : '▢'}${c[1]}`).join('　');
    const _c = _n === _checks.length ? '#3ddc84' : (_n >= _checks.length - 1 ? '#ffd166' : '#8899aa');
    stageBadge = `<span class="q-stage" style="color:${_c};font-weight:700" title="${_nm}階段證據：${_tip}">${_nm} ${_n}/${_checks.length}</span>`;
  }

  // 跨策略共振徽章
  const hk = resonance.hanku[r.ticker];
  const resoN = _resoCount(r);
  const resoBadges =
    (hk ? `<span class="reso-badge reso-hk">🌀${_stripLeadEmoji(hk)}</span>` : '');
  const resoRow = resoBadges ? `<div class="sc-reso">${resoBadges}</div>` : '';
  const zap = resoN >= 2 ? '<span class="sc-zap" title="多策略共振">⚡共振</span>' : '';

  return `<div class="stk-card main-card ${_hitTier(r.hits)}${resoN >= 2 ? ' is-reso' : ''}" data-ticker="${r.ticker}">
    <div class="sc-head">
      <span class="sc-id"><b>${r.ticker}</b> ${r.name || ''}${stfBadgeHtml(r)}${volBadgeHtml(r)}</span>
      <span class="sc-head-r">${zap}${hot}<span class="sc-pin ${pinned ? 'on' : ''}" data-pin="${r.ticker}">${pinned ? '★' : '☆'}</span></span>
    </div>
    <div class="sc-quality">
      <span class="q-hit">命中×${r.hits || 0}</span>
      <span class="q-score">分 ${r.score != null ? Math.round(r.score) : '--'}</span>
      <span class="q-rs">RS ${_cardNum(r.rs, 0)}</span>
      ${stageBadge}
    </div>
    ${persistHtml}
    <div class="sc-price">${_chgSpan(Number(r.chg_pct))}<span class="sc-close">現價 ${_cardNum(r.close)}</span><span class="sc-vol">量 ${_cardNum(r.vol_ratio, 1)}x</span></div>
    ${chipLine}
    ${maintLineHtml(r)}
    ${dedLine}
    <div class="sc-trade">
      <span><i>進場</i>${entry}</span>
      <span><i>目標</i>${_cardNum(r.target)}</span>
      <span><i>RR</i><b class="${rrCls}">${rr == null ? '--' : Number(rr).toFixed(2)}</b></span>
    </div>
    ${resoRow}
    ${detailHtml}
    <div class="sc-tags">
      ${r.industry ? `<span class="tag">${r.industry}</span>` : ''}
      ${flagHtml}
      ${instHtml}
      ${catTags}
    </div>
  </div>`;
}

// 依延續生命週期分組渲染卡片（段落標題跨欄）
// 未命中任何策略的股沒有 board_streak → persistBucket() 回 null，以前會被整個丟掉，
// 導致「搜尋得到卻看不到卡片」。現在一律收進第四段「未上榜」；因為全市場 2000+ 檔多數
// 落在這段，預設收合，有搜尋字串時自動展開。
function renderGroupedCards(active) {
  const SECT_CAP = 80;
  const byScore = (a, b) => (b.score || 0) - (a.score || 0);
  const byRs = (a, b) => (b.rs ?? -Infinity) - (a.rs ?? -Infinity);
  const buckets = { new: [], surge: [], fade: [], flat: [], none: [] };
  active.forEach(r => { const b = persistBucket(r); buckets[b || 'none'].push(r); });
  const noneOpen = !!state.search || state.showUnlisted;
  const sections = [
    { rows: buckets.new.sort(byScore), cls: 'sec-new',
      label: '🆕 今日上榜', note: '全新訊號 — 優先評估' },
    { rows: buckets.surge.sort(byScore).concat(buckets.flat.sort(byScore)), cls: 'sec-surge',
      label: '🔥 延續加溫', note: '連續在榜且加分/升階 — 進場續抱首選' },
    { rows: buckets.fade.sort(byScore), cls: 'sec-fade',
      label: '⚠️ 延續轉弱', note: '連續在榜但掉分/降階 — 留意減碼' },
    { rows: buckets.none.sort(byRs), cls: 'sec-none', key: 'none', collapsed: !noneOpen,
      label: '🔎 未上榜', note: '未命中任何策略 — 依 RS 排序，供搜尋/查價用' },
  ];
  let out = '';
  sections.forEach(sec => {
    if (!sec.rows.length) return;
    const caret = sec.key === 'none' ? `<span class="sg-caret">${sec.collapsed ? '▸' : '▾'}</span>` : '';
    out += `<div class="sc-group ${sec.cls}"${sec.key === 'none' ? ' data-toggle-unlisted="1"' : ''}>`
      + `${caret}<span class="sg-title">${sec.label}</span>`
      + `<span class="sg-n">${sec.rows.length}</span><span class="sg-note">${sec.note}</span></div>`;
    if (sec.collapsed) return;
    out += sec.rows.slice(0, SECT_CAP).map(r => mainCardHtml(r, true)).join('');
    if (sec.rows.length > SECT_CAP)
      out += `<div class="muted" style="padding:2px 8px;grid-column:1/-1">顯示前 ${SECT_CAP} / 共 ${sec.rows.length}</div>`;
  });
  return out;
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
  const active = state.table.getData('active');
  const sortKey = (sortEl && sortEl.value) || 'persist_group';
  let html;
  if (sortKey === 'persist_group') {
    html = renderGroupedCards(active);
  } else {
    const CAP = 200;
    active.sort(MAIN_CARD_SORT[sortKey] || MAIN_CARD_SORT.hits);
    const shown = active.slice(0, CAP);
    html = shown.map(r => mainCardHtml(r)).join('');
    if (active.length > CAP)
      html += `<div class="muted" style="padding:8px;grid-column:1/-1">顯示前 ${CAP} / 共 ${active.length} 檔（縮小篩選或切表格看全部）</div>`;
  }
  cardsEl.innerHTML = html || '<div class="muted" style="padding:20px">🔍 沒有符合條件的個股</div>';
  cardsEl.querySelectorAll('.main-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.sc-pin')) return;
      const t = card.dataset.ticker;
      const r = active.find(x => String(x.ticker) === String(t));
      openKlineModal(t, r ? r.name : '', r ? r.market : '');
    });
  });
  const unlistedHead = cardsEl.querySelector('[data-toggle-unlisted]');
  if (unlistedHead) unlistedHead.addEventListener('click', () => {
    state.showUnlisted = !state.showUnlisted;
    refreshMainView();
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

// ═════════════════════════════════════════════════════════
//  🏦 法人買賣超排行（inst-rank）— 個股外資/投信/自營/合計 買賣超雙欄 + 漲停
// ═════════════════════════════════════════════════════════
const instRankState = { loaded: false, loadedDate: null, data: null,
  inst: 'f', limitOnly: false, onlyHit: false, search: '' };
const INST_LABEL = { f: '外資', t: '投信', d: '自營', tot: '合計' };

async function loadInstRank() {
  if (instRankState.loaded && instRankState.loadedDate === currentDate) { renderInstRank(); return; }
  const body = document.getElementById('ir-body');
  const entry = (indexMeta?.dates || []).find(
    e => e.date === currentDate && (e.has || []).includes('inst_rank'));
  let date = currentDate;
  if (!entry) {
    const fb = (indexMeta?.dates || []).find(e => (e.has || []).includes('inst_rank'));
    if (!fb) { body.innerHTML = '<div style="padding:20px;color:#aaa">該日期無法人買賣超資料（跑 export_inst_rank.py）。</div>'; return; }
    date = fb.date;
  }
  try {
    instRankState.data = await fetchJsonGz(`data/daily/${date}/inst_rank.json.gz`);
    instRankState.loaded = true;
    instRankState.loadedDate = currentDate;
    renderInstRank();
  } catch (e) {
    body.innerHTML = `<div style="padding:20px;color:#f88">載入失敗：${e.message}</div>`;
  }
}

function _irRowHtml(r, i, inst) {
  const net = r[inst] || 0;
  const chgc = r.chg == null ? '' : (r.chg > 0 ? 'num-pos' : (r.chg < 0 ? 'num-neg' : ''));
  const mark = (r.hit ? '⭐' : '') + (r.up ? '🔥' : '');
  return `<div class="ir-row" data-code="${r.code}" data-name="${(r.name || '').replace(/"/g, '')}">`
    + `<span class="ir-rk">${i + 1}</span>`
    + `<span class="ir-nm">${mark}${r.code} ${r.name || ''}</span>`
    + `<span class="ir-lot ${net > 0 ? 'num-pos' : (net < 0 ? 'num-neg' : '')}">${net > 0 ? '+' : ''}${net.toLocaleString()}</span>`
    + `<span class="ir-cl">${r.close == null ? '--' : r.close}</span>`
    + `<span class="ir-chg ${chgc}">${r.chg == null ? '' : (r.chg > 0 ? '+' : '') + r.chg + '%'}</span>`
    + `</div>`;
}

function _irTable(title, rows, inst) {
  const hdr = `<div class="ir-h">${title}</div>`;
  if (!rows.length) return hdr + '<div class="muted" style="padding:12px">無</div>';
  const head = `<div class="ir-row ir-hdr"><span class="ir-rk">#</span><span class="ir-nm">名稱</span>`
    + `<span class="ir-lot">張數</span><span class="ir-cl">收盤</span><span class="ir-chg">幅度</span></div>`;
  return hdr + `<div class="ir-rows">${head}${rows.map((r, i) => _irRowHtml(r, i, inst)).join('')}</div>`;
}

function renderInstRank() {
  const d = instRankState.data;
  const body = document.getElementById('ir-body');
  if (!d) { body.innerHTML = '<div class="muted" style="padding:20px">無資料</div>'; return; }
  const inst = instRankState.inst;
  const q = (instRankState.search || '').toLowerCase();
  const rows = d.rows.filter(r => {
    if (instRankState.onlyHit && !r.hit) return false;
    if (q && !String(r.code).includes(q) && !(r.name || '').toLowerCase().includes(q)) return false;
    return true;
  });
  const metaEl = document.getElementById('ir-meta');
  if (metaEl) metaEl.textContent = `${d.trading_date}｜${d.count} 檔｜漲停 ${d.limit_up}`;

  if (instRankState.limitOnly) {
    const up = rows.filter(r => r.up).sort((a, b) => (b.chg || 0) - (a.chg || 0));
    body.innerHTML = `<div class="ir-single">${_irTable(`🔥 今日漲停（${up.length}）`, up, inst)}</div>`;
    _bindIrRows(); return;
  }
  const CAP = 50;
  const buy = rows.filter(r => (r[inst] || 0) > 0).sort((a, b) => b[inst] - a[inst]).slice(0, CAP);
  const sell = rows.filter(r => (r[inst] || 0) < 0).sort((a, b) => a[inst] - b[inst]).slice(0, CAP);
  body.innerHTML = `<div class="ir-cols">`
    + `<div class="ir-col">${_irTable(`${INST_LABEL[inst]} 買超`, buy, inst)}</div>`
    + `<div class="ir-col">${_irTable(`${INST_LABEL[inst]} 賣超`, sell, inst)}</div></div>`;
  _bindIrRows();
}

function _bindIrRows() {
  const mkt = {};
  ((state.data && state.data.rows) || []).forEach(r => { mkt[String(r.ticker)] = r.market; });
  document.querySelectorAll('#ir-body .ir-row[data-code]').forEach(el => {
    el.addEventListener('click', () =>
      openKlineModal(el.dataset.code, el.dataset.name, mkt[el.dataset.code] || ''));
  });
}

function initInstRankControls() {
  document.querySelectorAll('#ir-inst-toggle .ir-btn').forEach(b => {
    b.addEventListener('click', () => {
      instRankState.inst = b.dataset.inst;
      document.querySelectorAll('#ir-inst-toggle .ir-btn').forEach(x => x.classList.toggle('active', x === b));
      instRankState.limitOnly = false;
      document.getElementById('ir-limitup').classList.remove('btn-active');
      if (instRankState.loaded) renderInstRank();
    });
  });
  const lu = document.getElementById('ir-limitup');
  if (lu) lu.addEventListener('click', () => {
    instRankState.limitOnly = !instRankState.limitOnly;
    lu.classList.toggle('btn-active', instRankState.limitOnly);
    if (instRankState.loaded) renderInstRank();
  });
  const oh = document.getElementById('ir-only-hit');
  if (oh) oh.addEventListener('change', e => { instRankState.onlyHit = e.target.checked; if (instRankState.loaded) renderInstRank(); });
  const s = document.getElementById('ir-search');
  if (s) s.addEventListener('input', e => { instRankState.search = e.target.value.trim(); if (instRankState.loaded) renderInstRank(); });
}
document.addEventListener('DOMContentLoaded', initInstRankControls);

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
    (chg != null ? `　<b style="color:${chgCol}">${chg > 0 ? '+' : ''}${chg}%</b>` : '') + `</div>` +
    (svHas(G('verdict')) ? `<div class="sv-verdict">${svEsc(G('verdict'))}</div>` : '');

  // 延續面板：連續上榜徽章 + 分類軌跡 + 分數走勢 sparkline
  let persistPanel = '';
  if (svHas(G('board_streak'))) {
    const badges = persistBadgesHtml(row);
    const hist = G('score_hist') || [];
    const spk = persistSparkline(hist);
    const first = hist.length ? hist[0].s : null, last = hist.length ? hist[hist.length - 1].s : null;
    const spkLine = spk
      ? `<div class="sv-spark">${spk}<span class="sv-mut">　分數 ${first != null ? Math.round(first) : '--'}→${last != null ? Math.round(last) : '--'}</span></div>` : '';
    const trail = svHas(G('cat_path')) ? `<div class="sv-mut">分類軌跡 ${svEsc(G('cat_path'))}</div>` : '';
    persistPanel = `<div class="sv-persist-badges">${badges}</div>${trail}${spkLine}`;
  }

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

  // ⑥ 個股期貨（大型/小型）＋ 直達期貨計算機（自動帶每口股數）
  let futHtml = '';
  if (svTruthy(G('stf')) || G('stf') === true || svTruthy(G('stf_mini')) || G('stf_mini') === true) {
    const isMini = G('stf_mini') === true || svTruthy(G('stf_mini'));
    const bits = [];
    if (G('stf') === true || svTruthy(G('stf'))) bits.push('大型 <b>2,000</b>股/口');
    if (isMini) bits.push('<b style="color:#ffd7a8">小型 100股/口</b>');
    futHtml = `${stfBadgeHtml(row)}　${bits.join('　·　')}　` +
      `<button type="button" class="sv-calc-btn" onclick="openCalcFor('${svEsc(ticker)}',${isMini ? 100 : 2000})">🧮 期貨計算機試算</button>`;
  }

  el.innerHTML = `<div class="sv-wrap">
    ${priceRow}
    ${catHtml ? `<div class="sv-cats">${catHtml}</div>` : ''}
    ${svRow('📈', '延續', persistPanel)}
    ${svRow('📌', '訊號', sig.join('　·　'))}
    ${svRow('🏭', '題材族群', th.join('　｜　'))}
    ${svRow('💰', '籌碼', chipAdviceBlockHtml(row) + maintBlockHtml(row) + `<div id="sv-chip" class="sv-mut">融資/明細載入中…</div>`)}
    ${svRow('🧮', '個股期貨', futHtml)}
    ${svRow('📐', '關鍵價位', px.length ? px.join('　｜　') + pxNote : '')}
    <div class="sv-foot">訊號為策略輔助、非投資建議 — 進出場請至 TradingView 自行判斷。</div>
  </div>`;
}

// 彈窗籌碼建議區塊：結論一句話 + 依據（用主表 row，不必等 kline payload）
function chipAdviceBlockHtml(row) {
  if (!row) return '';
  const ca = chipAdvice(row);
  if (ca.key === 'na') return '';
  const asof = (state.data && state.data.chip_asof) || {};
  const stale = asof.broker && asof.margin && asof.broker !== asof.margin
    ? `<div class="sv-chip-asof">⚠️ 分點主力籌碼資料僅到 ${asof.broker}（來源停更中）；法人/融資為 ${asof.margin}</div>` : '';
  return `<div class="sv-chip-advice chip-${ca.key}">
    <div class="sca-verdict">${ca.icon} <b>${ca.label}</b></div>
    ${ca.advice ? `<div class="sca-advice">${svEsc(ca.advice)}</div>` : ''}
    ${ca.detail ? `<div class="sca-detail sv-mut">${svEsc(ca.detail)}</div>` : ''}
    ${stale}
  </div>`;
}

// 彈窗融資維持率區塊：全歷史危機表（每檔跟自己的四次危機比，不是統一門檻）
function maintBlockHtml(row) {
  if (!row) return '';
  // 彈窗吃 detail（全部通過 gate 的 ~1,000 檔），不是只吃進榜桶 —— 查個股時
  // 🟡鬆動/⚪安全 的股票也要看得到自己的危機表。
  const d = maintState.detail[String(row.ticker)];
  if (!d) return '';
  const m = d;
  const t = maintTone(m);
  const rows = (d.crisis || []).map(c =>
    `<tr class="${c.is_base ? 'mt-base' : ''}"><td>${c.label}${c.is_base ? ' 關稅' : ''}</td>`
    + `<td class="mt-num">${c.mr}%</td><td class="mt-num">${c.px}</td>`
    + `<td class="mt-num ${c.gap_pct >= 0 ? 'neg' : ''}">${c.gap_pct >= 0 ? '+' : ''}${c.gap_pct}%</td></tr>`
  ).join('');
  return `<div class="sv-maint ${t.cls}">
    <div class="svm-verdict">${t.ico} <b>融資維持率 ${m.mr}%</b>
      <span class="sv-mut">（推估平均融資成本 ${d.cost ?? '--'}，餘額 ${m.bal.toLocaleString()} 張，全期百分位 ${m.pctile}%）</span></div>
    <table class="svm-table"><thead><tr><th>事件</th><th>當時最低</th><th>今日對應價</th><th>距今</th></tr></thead>
    <tbody>${rows}<tr class="mt-now"><td>今天</td><td class="mt-num">${m.mr}%</td><td class="mt-num">${m.close}</td><td class="mt-num">—</td></tr></tbody></table>
    <div class="svm-note sv-mut">維持率到位是<b>必要非充分條件</b>：2018 年國巨到達後仍磨了 48 個交易日才落底。這是風險溫度計，不是買進訊號。</div>
  </div>`;
}

// 籌碼區塊：kline payload 載完後補上（逐日法人明細 + 融資）
function patchChipBlock(d) {
  const el = document.getElementById('sv-chip');
  if (!el) return;
  if (!d || !d.has_inst) { el.textContent = '無逐日法人明細'; return; }
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

// K線彈窗「🧮 期貨計算機試算」：切到頂部期貨計算機分頁，帶入代號＋每口股數(2000/100)
window.openCalcFor = function (ticker, mult) {
  const modal = document.getElementById('kline-modal');
  if (modal) modal.hidden = true;               // 收掉彈窗，露出分頁
  const btn = document.querySelector('.tab-btn[data-tab="calc"]');
  if (btn) btn.click();                          // 走既有切分頁流程
  if (window.QEFCalc && QEFCalc.loadTicker) QEFCalc.loadTicker(String(ticker), mult);
};

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

function _wave3PriceLine(r) {
  const w3 = r.wave3_signal || {};
  const wp = r.wave3_price || {};
  const active = w3.type === 'wave3_first' || w3.type === 'wave3_second' || w3.type === 'decline_only';
  if (active) {
    if (wp.entry_price_suggested == null) return '';
    return `<div class="disp-card-meta disp-card-wave3">💡建議進場≈${wp.entry_price_suggested}　東山再起停利≈${wp.takeprofit_price_suggested ?? '--'}</div>`;
  }
  if (wp.target_price_first == null && wp.target_price_decline_only == null) return '';
  const parts = [];
  if (wp.target_price_second != null) parts.push(`≤${wp.target_price_second}加碼`);
  if (wp.target_price_first != null) parts.push(`≤${wp.target_price_first}首次`);
  if (wp.target_price_decline_only != null) parts.push(`≤${wp.target_price_decline_only}跌幅`);
  const gateNote = wp.slope_gate_ok ? '' : '　<span class="num-neg">(斜率未達標)</span>';
  return `<div class="disp-card-meta disp-card-wave3">🎯浪子回頭門檻：${parts.join(' / ')}${gateNote}</div>`;
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
  const w3 = r.wave3_signal || {};
  const wave3Badge = w3.type === 'wave3_second' ? `<span class="disp-badge disp-badge-blue">🎯浪子回頭(加碼)</span>`
    : w3.type === 'wave3_first' ? `<span class="disp-badge disp-badge-blue">🎯浪子回頭</span>`
    : w3.type === 'decline_only' ? `<span class="disp-badge disp-badge-blue">處置後跌幅</span>` : '';
  const chipHint = r.chip_concentration_5d_positive === true ? ' 🟢籌碼佳'
    : r.chip_concentration_5d_positive === false ? ' 🔴籌碼弱' : '';
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
    <div class="disp-card-badges">${cycleBadge} ${statusBadge}${repeatIcon}${fullDeliveryIcon} ${wave3Badge}</div>
    <div class="disp-card-meta">量${volTxt}　週轉率${turnoverTxt}</div>
    <div class="disp-card-meta">位階${_dispSigned(r.position_index, 1)}　月線斜率<span class="${slopeCls}">${_dispSigned(r.ma20_slope, 1)}%</span>${chipHint}</div>
    <div class="disp-card-meta">${declineLine}距高點${_dispSigned(r.drawdown_from_high, 1)}%</div>
    ${_wave3PriceLine(r)}
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

// ── 處置雷達搜尋（全市場任意股票，含健康股）──────────────
let dispSearchInited = false;
function initDispSearch() {
  if (dispSearchInited) return;
  dispSearchInited = true;
  const input = document.getElementById('disp-search-input');
  const results = document.getElementById('disp-search-results');
  if (!input || !results) return;

  const bucketBadge = (ticker) => {
    const d = dispState.data;
    if (!d) return '';
    if ((d.punish || []).some(r => r.ticker === ticker)) return '<span class="disp-badge disp-badge-red">處置中</span>';
    if ((d.watch || []).some(r => r.ticker === ticker)) return '<span class="disp-badge disp-badge-amber">潛在注意</span>';
    return '<span class="disp-badge disp-badge-green">健康</span>';
  };

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { results.hidden = true; results.innerHTML = ''; return; }
    const rows = (state.data && state.data.rows) || [];
    const matches = rows.filter(r =>
      String(r.ticker).toLowerCase().includes(q) || (r.name || '').toLowerCase().includes(q)
    ).slice(0, 15);
    if (!matches.length) {
      results.hidden = false;
      results.innerHTML = `<div class="disp-search-item">查無符合的股票</div>`;
      return;
    }
    results.hidden = false;
    results.innerHTML = matches.map(r =>
      `<div class="disp-search-item" data-ticker="${r.ticker}" data-name="${svEsc(r.name || '')}" data-market="${r.market || ''}">` +
      `${r.ticker} ${svEsc(r.name || '')}${bucketBadge(r.ticker)}</div>`
    ).join('');
    results.querySelectorAll('.disp-search-item[data-ticker]').forEach(item => {
      item.addEventListener('click', () => {
        openKlineModal(item.dataset.ticker, item.dataset.name, item.dataset.market);
        results.hidden = true;
        input.value = '';
      });
    });
  });

  document.addEventListener('click', (e) => {
    if (!results.contains(e.target) && e.target !== input) results.hidden = true;
  });
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

const DR_LEVEL_MARK = { triggered: '🔴', close: '🟡', far: '⚪', unavailable: '？' };
const DR_LEVEL_CLS  = { triggered: 'hit-true', close: 'hit-close', far: 'hit-false', unavailable: 'hit-null' };

// 處置雷達前端只顯示「會進處置」的第1~8款；第9~14款(僅公告、不計入處置累計)後端引擎照算，
// 但前端不呈現。要恢復顯示全部14款：把 DR_SHOW_MAX 改回 14（下方 5 處 helper 會自動跟著還原）。
const DR_SHOW_MAX = 8;
const _drInShow = (no) => Number(no) <= DR_SHOW_MAX;

function _drClauseItem(no, c) {
  const level = c.level || (c.hit === true ? 'triggered' : (c.hit === false ? 'far' : 'unavailable'));
  const mark = DR_LEVEL_MARK[level] || '？';
  const cls = DR_LEVEL_CLS[level] || 'hit-null';
  const windowsTxt = (c.windows || []).map(w =>
    `${w.days}日${w.level === 'triggered' ? '🔴' : (w.level === 'close' ? '🟡' : '⚪')}`).join(' ');
  return `<div class="dr-clause-item ${cls}"><span class="dr-mark">${mark}</span>` +
    `<span>第${no}款 ${svEsc(c.name)}<br><span class="sv-mut">${svEsc(c.text)}</span>` +
    (windowsTxt ? `<br><span class="sv-mut">${windowsTxt}</span>` : '') + `</span></div>`;
}

function _drHistoryItem(h) {
  const shown = (h.clauses || []).filter(_drInShow);
  if (!shown.length) return '';   // 該日僅第9~14款(不進處置)，過濾後整列不顯示
  const nos = shown.map(n => `第${n}款`).join('、');
  return `<div class="dr-hist-row"><span>🕒 ${fmtDate8(h.date)}</span><span class="sv-mut">${svEsc(nos)}</span></div>`;
}

function _drProgressBar(cur, max, label, dateChips) {
  const pct = max > 0 ? Math.min(100, (cur / max) * 100) : 0;
  const cls = cur >= max ? 'full' : (pct >= 60 ? 'high' : '');
  const chipsHtml = (dateChips && dateChips.length)
    ? `<div class="dr-progress-dates">${dateChips.map(d => `<span class="dr-progress-date">${fmtDate8(d)}</span>`).join('')}</div>`
    : '';
  return `<div class="dr-progress-cell">
    <div class="dr-progress-label">${label}</div>
    <div class="dr-progress-track"><div class="dr-progress-fill ${cls}" style="width:${pct}%"></div></div>
    <div class="dr-progress-num">${cur}/${max}</div>
    ${chipsHtml}
  </div>`;
}

// 從alert_history(近30日逐日觸發款別)回推「哪幾天算進這個計數器」，比對attnup每個gauge旁的日期清單。
// alert_history只收錄「當天有任何觸發」的日子，但因此只要clause命中就一定會出現在清單裡，
// 從最新一天往回抓連續run（中間不能被非該clause的日子隔開）就是正確的streak组成日期。
function _drWindowDates(alertHistory, clauseSet, mode, limit) {
  if (!limit || limit <= 0) return [];
  // alert_history的clauses是JSON數字(Python int序列化結果)，clauseSet統一轉字串比對避免型別不符
  const set = clauseSet.map(String);
  const isHit = h => (h.clauses || []).some(c => set.includes(String(c)));
  const sorted = [...(alertHistory || [])].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (mode === 'streak') {
    // streak模式：必須是alert_history裡最前面連續的幾筆(沒有被其他日子插隊)才算連續
    const out = [];
    for (const h of sorted) {
      if (!isHit(h) || out.length >= limit) break;
      out.push(h.date);
    }
    return out;
  }
  return sorted.filter(isHit).slice(0, limit).map(h => h.date);
}

// 預測性風險提示：把現有計數器往前推一步，不是預測股價（見disposition_rules.forecast_disposition_risk）
function _drForecastHtml(fc) {
  if (!fc || !fc.checked || fc.already_at_risk || !fc.nearest) return '';
  const n = fc.nearest;
  return `<div class="dr-forecast-box">
    <div class="dr-forecast-title">📈 預測性風險提示</div>
    <div class="dr-forecast-row">若${svEsc(n.need)}，還差 <b>${n.gap}</b> 次可能達到「${svEsc(n.label)}」門檻</div>
  </div>`;
}

// 類股差幅（與大盤/與同類股的差幅，第1/3-5/7款判定用的分母）
function _drDiffsHtml(diffs) {
  if (!diffs || (diffs.market_diff_pct == null && diffs.sector_diff_pct == null)) return '';
  return `<div class="dr-section-title">類股差幅（第1/3-5/7款需≥20%）</div>
  <div class="dr-val-grid">
    <div class="dr-val-cell"><b>${diffs.market_diff_pct != null ? diffs.market_diff_pct.toFixed(1) + '%' : '--'}</b><span>與大盤</span></div>
    <div class="dr-val-cell"><b>${diffs.sector_diff_pct != null ? diffs.sector_diff_pct.toFixed(1) + '%' : '--'}</b><span>與同類股</span></div>
  </div>`;
}

// 官方第6條四計數器，用進度條呈現（比對attnup排版），旁邊附上實際計入的觸發日期
function _drWindowsHtml(w, alertHistory) {
  if (w.streak3_of_c1 == null) return '';
  const c1 = ['1'];
  const c18 = ['1', '2', '3', '4', '5', '6', '7', '8'];
  return `<div class="dr-section-title">處置期間累計</div>
    <div class="dr-progress-grid">
      ${_drProgressBar(w.streak3_of_c1, 3, '連續三次(第1款)', _drWindowDates(alertHistory, c1, 'streak', w.streak3_of_c1 || 0))}
      ${_drProgressBar(w.streak5_of_c1to8, 5, '連續五次(第1-8款)', _drWindowDates(alertHistory, c18, 'streak', w.streak5_of_c1to8 || 0))}
      ${_drProgressBar(w.count10_of_c1to8, 6, '10日內(第1-8款)', _drWindowDates(alertHistory, c18, 'count', w.count10_of_c1to8 || 0))}
      ${_drProgressBar(w.count30_of_c1to8, 12, '30日內(第1-8款)', _drWindowDates(alertHistory, c18, 'count', w.count30_of_c1to8 || 0))}
    </div>`;
}

// 今日實際觸發的款別（任一即可），對應attnup橘框「N/N 觸發條件」區塊
function _drTriggeredHtml(clauses) {
  // 已觸發 或 接近門檻(含明日可能觸發的價格提示) 都列進來，比對attnup「任一即可」的觸發條件框
  const active = Object.entries(clauses).filter(([no, c]) => _drInShow(no) && (c.level === 'triggered' || c.level === 'close'));
  if (!active.length) return '';
  return `<div class="dr-trigger-box">
    <div class="dr-trigger-title">◎ 觸發條件（任一即可）</div>
    ${active.map(([no, c]) => `<div class="dr-trigger-row">${no}. ${svEsc(c.text)} — 第${no}款</div>`).join('')}
  </div>`;
}

// 14款總覽checklist：計入處置累計(1-8) / 僅公告不計入累計(9-14)，色塊pill
// 紅=已觸發／黃=接近門檻／灰=未觸發／－=無法判定；僅公告組(9-14)另加藍色調跟計入累計組(1-8)區隔，比對attnup排版
function _drOverviewPill(no, c, isAnnounce) {
  const level = c.level || (c.hit === true ? 'triggered' : (c.hit === false ? 'far' : 'unavailable'));
  const cls = level === 'triggered' ? 'hit' : (level === 'close' ? 'close' : (level === 'unavailable' ? 'na' : ''));
  const mark = DR_LEVEL_MARK[level] || '？';
  return `<div class="dr-pill ${isAnnounce ? 'announce' : ''} ${cls}">${mark} 第${no}款</div>`;
}
function _drOverviewHtml(clauses) {
  if (!Object.keys(clauses).length) return '';
  const cum = [1, 2, 3, 4, 5, 6, 7, 8].filter(_drInShow)
    .map(n => _drOverviewPill(n, clauses[String(n)], false)).join('');
  const ann = [9, 10, 11, 12, 13, 14].filter(_drInShow)
    .map(n => _drOverviewPill(n, clauses[String(n)], true)).join('');
  const title = DR_SHOW_MAX >= 14 ? '14款觸發總覽' : '觸發款別總覽（計入處置的第1-8款）';
  return `<div class="dr-section-title">${title}</div>
    ${cum ? `<div class="sv-mut" style="margin-bottom:4px">計入處置累計（第1-8款）</div>
    <div class="dr-pill-grid">${cum}</div>` : ''}
    ${ann ? `<div class="sv-mut" style="margin:8px 0 4px">僅公告不計入累計（第9-14款）</div>
    <div class="dr-pill-grid">${ann}</div>` : ''}`;
}

const dispUniverseCache = {};
async function _fetchUniverseSnapshot(ticker) {
  if (ticker in dispUniverseCache) return dispUniverseCache[ticker];
  try {
    const d = await fetchJsonGz(`data/disposition_stock/${ticker}.json.gz`);
    dispUniverseCache[ticker] = d;
    return d;
  } catch (err) {
    dispUniverseCache[ticker] = null;
    return null;
  }
}

function _dispBanner(r, fromUniverse) {
  const isPunish = r.punish_start_date != null || r.bucket === 'punish';
  const isWatch = !isPunish && (r.bucket === 'watch' || r.watch_count_10d != null);
  if (fromUniverse) {
    const cls = r.banner || r.bucket || 'healthy';
    const text = {
      punish: '🚨 處置中（有其他款接近/已觸發，留意升級風險）',
      punish_stable: '🛡️ 處置中，目前無升級處置風險',
      watch: '👀 潛在注意股（尚未處置）',
      healthy: '✅ 狀態良好',
    }[cls] || '✅ 狀態良好';
    const sub = cls.startsWith('punish') ? '本頁為全市場搜尋輕量版，不含處置期間累計/注意股歷史' : '';
    return { cls, text, sub };
  }
  const cls = isPunish ? 'punish' : 'watch';
  const text = isPunish
    ? `🚨 處置中　撮合${r.matching_cycle_minutes}分盤　處置期${fmtDate8(r.punish_start_date)}起第${r.days_in_punish}天`
    : `👀 潛在注意股（尚未處置）`;
  const sub = isPunish
    ? `估計出關倒數 ${r.est_days_to_exit} 個交易日${r.repeat_disposition_flag ? '（⚠️近期二度以上處置）' : ''}${r.day1_avoid ? '（⚠️處置首日，統計上表現最弱，不建議追價進場）' : ''}`
    : `近10日觸發注意${r.watch_count_10d}次　近30日${r.watch_count_30d}次`;
  return { cls, text, sub };
}

async function renderDispositionRisk(ticker) {
  const el = document.getElementById('dr-block');
  if (!el) return;
  el.innerHTML = '';
  const data = await _ensureDispDataLoaded();
  let r = data ? [...(data.punish || []), ...(data.watch || [])]
    .find(x => String(x.ticker) === String(ticker)) : null;
  let fromUniverse = false;
  if (!r) {
    r = await _fetchUniverseSnapshot(ticker);
    fromUniverse = true;
  }
  if (!r) return;   // 全市場快照也查無此股(可能太新/資料不足)，不顯示這個區塊

  const banner = _dispBanner(r, fromUniverse);
  const bannerCls = banner.cls;
  const bannerText = banner.text;
  const bannerSub = banner.sub;

  const clauses = r.clauses || {};

  // ① 觸發條件（今日任一即可，只列有實際觸發的款）
  const triggeredHtml = _drTriggeredHtml(clauses);

  // ② 處置期間累計（官方第6條四計數器，進度條+觸發日期）
  const windowsHtml = _drWindowsHtml(r.disposition_windows || {}, r.alert_history || []);

  // ③ 預測細節（14款逐款詳解，含30/60/90日子窗與色階）
  const clauseHtml = Object.keys(clauses).length
    ? `<div class="dr-clause-legend">🔴已觸發　🟡接近門檻（近20%內）　⚪未觸發　？資料不足/無法判定</div>
       <div class="dr-clause-grid">${Object.entries(clauses).filter(([no]) => _drInShow(no)).map(([no, c]) => _drClauseItem(no, c)).join('')}</div>`
    : '';

  // ④ 除外情形（目前只做第2款，官方規則第3條第3/4款，見disposition_rules.py）——
  // 三個獨立框(30/60/90日)＋明日方向提示，比對attnup排版
  const ex2 = r.exemption_clause2;
  const exemptionHtml = (ex2 && ex2.checked) ? `<div class="dr-section-title">第2款除外情形（準確度有待驗證）</div>
    <div class="dr-exemption-summary ${ex2.exempt ? 'exempt' : ''}">
      ${ex2.exempt ? '✅ 符合除外情形' : '❌ 不符合除外情形'}
    </div>
    <div class="dr-exemption-grid">
      ${(ex2.periods || []).map(p => `<div class="dr-exemption-cell">
        <div class="dr-exemption-period">${p.days}日期間</div>
        <div class="sv-mut">${svEsc(p.text)}</div>
        ${p.tomorrow_hint ? `<div class="dr-exemption-hint">${svEsc(p.tomorrow_hint)}</div>` : ''}
      </div>`).join('')}
    </div>
    <div class="sv-mut" style="margin-top:4px;font-style:italic">
      * 此為條款尚未觸發時的預測，實際除外仍需符合完整條件</div>` : '';

  // ⑤ 14款觸發總覽（計入/不計入處置累計 分組色塊）
  const overviewHtml = _drOverviewHtml(clauses);

  // ⑥ 類股差幅
  const diffsHtml = _drDiffsHtml(r.category_diffs);

  // ⑦ 估值與融資融券
  const val = r.valuation || {};
  const valCell = (label, v, digits, suffix) =>
    `<div class="dr-val-cell"><b>${v != null ? v.toFixed(digits) + (suffix || '') : '--'}</b><span>${label}</span></div>`;
  const changeCell = (label, v) => {
    const cls = (v || 0) > 0 ? 'num-pos' : ((v || 0) < 0 ? 'num-neg' : '');
    return `<div class="dr-val-cell"><b class="${cls}">${v != null ? _dispSigned(v, 0) : '--'}</b><span>${label}</span></div>`;
  };
  const valHtml = `<div class="dr-section-title">估值與融資融券</div><div class="dr-val-grid">
    ${valCell('本益比', val.pe_ratio, 1, '')}
    ${valCell('股價淨值比', val.pbr, 2, '')}
    ${valCell('週轉率', val.turnover_pct, 1, '%')}
    ${valCell('融資使用率', val.margin_usage_pct, 1, '%')}
    ${valCell('融券使用率', val.short_usage_pct, 1, '%')}
    ${valCell('券資比', val.short_margin_ratio, 1, '%')}
    ${changeCell('融資增減(張)', val.margin_change)}
    ${changeCell('融券增減(張)', val.short_change)}
  </div>`;

  // ⑧ 注意股歷史（近30日，逐日觸發哪幾款）
  const hist = r.alert_history || [];
  const histRows = hist.map(_drHistoryItem).filter(Boolean);
  const histHtml = histRows.length ? `<div class="dr-section-title">注意股歷史（近30日）</div>
    <div class="dr-hist-list">${histRows.join('')}</div>` : '';

  el.innerHTML = `<div class="dr-wrap">
    <div class="dr-banner ${bannerCls}">${bannerText}<div class="dr-banner-sub">${bannerSub}</div></div>
    <div class="dr-footnote">${DR_SHOW_MAX >= 14
      ? 'ℹ️ 第9-14款為公告用途，觸發不計入處置累計次數（僅第1-8款計入）'
      : 'ℹ️ 僅顯示會進處置的第1-8款；第9-14款(僅公告、不計入處置)已隱藏'}</div>
    ${_drForecastHtml(r.risk_forecast)}
    ${windowsHtml}
    ${triggeredHtml}
    <div class="dr-section-title">預測細節</div>
    ${clauseHtml}
    ${exemptionHtml}
    ${overviewHtml}
    ${diffsHtml}
    ${valHtml}
    ${histHtml}
  </div>`;
}
