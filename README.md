# 台股技術面篩選看板

純前端版本，部署於 GitHub Pages。資料來源為本地端 Python screener 每日盤後產出的 JSON。

## 分頁

- 📊 每日看板（latest.json）
- 🌡 市場結構（market_structure.json / market_chips.json / txf_map.json）
- ⭐ 自選股（前端本地）
- 🌀 Hanku 波段（hanku.json）
- 🏦 法人買賣超（inst_rank.json）
- 📋 訊號成績單（signal_report.json）
- 🚨 處置雷達（disposition.json）
- 🧮 期貨計算機（前端本地）

大盤狀態併在每日看板的市場快照（market.json / margin_maint.json）。

2026-09-05 移除：💎 可轉債監控、💸 族群資金流向，以及沒有入口的
industry_ranking / industry_flow / theme_flow 三類 payload。

## 線上版

https://joecarolbrain-svg.github.io/tw-stock-screener/
