# Linear Design System - Complete Documentation

## System Overview

Linear's marketing design system centers on an extremely dark canvas (`#010102`) paired with a single chromatic accent—lavender-blue (`#5e6ad2`)—used sparingly on brand marks, focus rings, and primary CTAs. The palette employs a four-step surface ladder for depth without shadows, light gray text (`#f7f8f8`), and densely framed product UI screenshots as the visual protagonist.

---

## Color Palette

### Brand & Accent Colors
| Token | Value | Purpose |
|---|---|---|
| primary | #5e6ad2 | Signature lavender-blue accent |
| on-primary | #ffffff | Text on lavender backgrounds |
| primary-hover | #828fff | Lighter lavender hover state |
| primary-focus | #5e69d1 | Focus-ring tint |
| brand-secure | #7a7fad | Muted lavender-gray for security surfaces |

### Surface Hierarchy
| Token | Value | Level |
|---|---|---|
| canvas | #010102 | Base—near-black page background |
| surface-1 | #0f1011 | Card/panel lift (charcoal) |
| surface-2 | #141516 | Featured card lift |
| surface-3 | #18191a | Sub-nav/dropdown backgrounds |
| surface-4 | #191a1b | Deepest lift level |

### Border & Divider Colors
| Token | Value | Use |
|---|---|---|
| hairline | #23252a | Standard 1px card borders |
| hairline-strong | #34343a | Stronger borders, input focus rings |
| hairline-tertiary | #3e3e44 | Nested surface dividers |

### Text Colors
| Token | Value | Hierarchy |
|---|---|---|
| ink | #f7f8f8 | Primary text (headlines, body emphasis) |
| ink-muted | #d0d6e0 | Secondary text (meta information) |
| ink-subtle | #8a8f98 | Tertiary text (deselected states, footer) |
| ink-tertiary | #62666d | Quaternary (disabled, footnotes) |

### Inverse & Semantic
| Token | Value | Context |
|---|---|---|
| inverse-canvas | #ffffff | White inverse CTA surfaces |
| inverse-surface-1 | #f5f6f6 | One step above white |
| inverse-surface-2 | #f6f7f7 | Two steps above white |
| inverse-ink | #000000 | Text on white surfaces |
| semantic-success | #27a644 | Status indicators, success badges |
| semantic-overlay | #000000 | Modal/overlay scrims |

---

## Typography System

### Font Families
- **Linear Display**: Custom display sans (fallback: SF Pro Display, -apple-system, system-ui, Segoe UI, Roboto)
- **Linear Text**: Custom text-optimized sans (same fallback stack)
- **Linear Mono**: Custom monospace (fallback: ui-monospace, SF Mono, Menlo)

### Type Scale & Specifications

| Token | Size | Weight | Line Height | Letter Spacing | Application |
|---|---|---|---|---|---|
| display-xl | 80px | 600 | 1.05 | -3.0px | Largest hero headlines |
| display-lg | 56px | 600 | 1.10 | -1.8px | Section openers |
| display-md | 40px | 600 | 1.15 | -1.0px | Sub-section headers |
| headline | 28px | 600 | 1.20 | -0.6px | Pricing tiers, CTA banners |
| card-title | 22px | 500 | 1.25 | -0.4px | Feature card headers |
| subhead | 20px | 400 | 1.40 | -0.2px | Lead paragraphs |
| body-lg | 18px | 400 | 1.50 | -0.1px | Hero subheads |
| body | 16px | 400 | 1.50 | -0.05px | Default body copy |
| body-sm | 14px | 400 | 1.50 | 0 | Card content, footer columns |
| caption | 12px | 400 | 1.40 | 0 | Captions, metadata |
| button | 14px | 500 | 1.20 | 0 | All button labels |
| eyebrow | 13px | 500 | 1.30 | +0.4px | Section taxonomy labels |
| mono | 13px | 400 | 1.50 | 0 | Code in product screenshots |

### Typography Principles
- Display weights range 500–700; body holds at 400 for single-voice continuity
- Negative letter-spacing scales aggressively: -3.0px at 80px, tapering to 0 by body sizes
- Eyebrow uniquely uses positive tracking (+0.4px) to contrast display's negative pull
- Mono reserved for code contexts only—never marketing chrome

---

## Spacing System

**Base unit**: 4px

| Token | Value | Use |
|---|---|---|
| xxs | 4px | Minimal gaps |
| xs | 8px | Compact spacing |
| sm | 12px | Small gaps |
| md | 16px | Default margins |
| lg | 24px | Card padding, section gaps |
| xl | 32px | Testimonial card padding |
| xxl | 48px | CTA banner padding |
| section | 96px | Major section separators |

### Padding Specifications
- Feature/pricing cards: `{spacing.lg}` (24px)
- Testimonial cards: `{spacing.xl}` (32px)
- CTA banners: `{spacing.xxl}` (48px)
- Button (pill): 8px vertical × 14px horizontal
- Form inputs: 8px vertical × 12px horizontal

---

## Border Radius Scale

| Token | Value | Application |
|---|---|---|
| xs | 4px | Small chips, badges |
| sm | 6px | Inline tags |
| md | 8px | Buttons, form inputs |
| lg | 12px | Pricing/feature/testimonial cards |
| xl | 16px | Product screenshot panels |
| xxl | 24px | Oversized CTA banners |
| pill | 9999px | Toggle tabs, status pills |
| full | 9999px | Avatar circles |

---

## Component Specifications

### Primary Buttons
**`button-primary`**
- Background: `{colors.primary}` (#5e6ad2)
- Text: `{colors.on-primary}` (#ffffff)
- Type: `{typography.button}`
- Padding: 8px 14px
- Radius: `{rounded.md}` (8px)
- Hover state: `button-primary-hover` → `{colors.primary-hover}` (#828fff)
- Pressed state: `button-primary-pressed` → `{colors.primary-focus}` (#5e69d1)

### Secondary Buttons
**`button-secondary`**
- Background: `{colors.surface-1}` (#0f1011)
- Text: `{colors.ink}` (#f7f8f8)
- Border: 1px `{colors.hairline}` (#23252a)
- Padding: 8px 14px
- Radius: `{rounded.md}`

### Tertiary & Inverse Buttons
**`button-tertiary`**
- Background: `{colors.canvas}` (#010102)
- Text: `{colors.ink}`
- Padding: 8px 14px
- Radius: `{rounded.md}`

**`button-inverse`**
- Background: `{colors.inverse-canvas}` (#ffffff)
- Text: `{colors.inverse-ink}` (#000000)
- Padding: 8px 14px
- Radius: `{rounded.md}`

### Pricing Components
**`pricing-tab-default`**
- Background: `{colors.canvas}`
- Text: `{colors.ink-subtle}` (#8a8f98)
- Type: `{typography.button}`
- Padding: 6px 14px
- Radius: `{rounded.pill}`

**`pricing-tab-selected`**
- Background: `{colors.surface-2}` (#141516)
- Text: `{colors.ink}` (#f7f8f8)
- Padding: 6px 14px

**`pricing-card`**
- Background: `{colors.surface-1}`
- Text: `{colors.ink}`
- Type: `{typography.body}`
- Padding: 24px
- Radius: `{rounded.lg}` (12px)
- Border: 1px `{colors.hairline}`

**`pricing-card-featured`**
- Background: `{colors.surface-2}` (lift for recommended tier)
- Otherwise identical to pricing-card

### Card Components
**`feature-card`**
- Background: `{colors.surface-1}`
- Text: `{colors.ink}`
- Padding: 24px
- Radius: `{rounded.lg}`

**`product-screenshot-card`** (dominant card type)
- Background: `{colors.surface-1}`
- Padding: 24px
- Radius: `{rounded.xl}` (16px)
- Border: 1px `{colors.hairline}`

**`testimonial-card`**
- Background: `{colors.surface-1}`
- Text: `{colors.ink}`
- Type: `{typography.body-lg}`
- Padding: 32px
- Radius: `{rounded.lg}`

**`customer-logo-tile`**
- Background: `{colors.canvas}`
- Text: `{colors.ink-subtle}`
- Type: `{typography.caption}`
- Padding: 16px
- Radius: `{rounded.xs}` (4px)

**`cta-banner`** (closing section CTA)
- Background: `{colors.surface-1}`
- Text: `{colors.ink}`
- Type: `{typography.headline}`
- Padding: 48px
- Radius: `{rounded.lg}`

### Form Components
**`text-input`** & **`text-input-focused`**
- Background: `{colors.surface-1}`
- Text: `{colors.ink}`
- Type: `{typography.body}`
- Padding: 8px 12px
- Radius: `{rounded.md}`
- Focus ring: 2px `{colors.primary-focus}` outline at 50% opacity

### Status & Navigation
**`status-badge`**
- Background: `{colors.surface-2}`
- Text: `{colors.ink-muted}`
- Type: `{typography.caption}`
- Padding: 2px 8px
- Radius: `{rounded.pill}`

**`changelog-row`** (/build page)
- Background: `{colors.canvas}`
- Text: `{colors.ink}`
- Padding: 24px 0
- Border: 1px `{colors.hairline}` (bottom)

**`top-nav`** (sticky header)
- Background: `{colors.canvas}`
- Text: `{colors.ink}`
- Type: `{typography.body-sm}`
- Height: 56px

**`footer`**
- Background: `{colors.canvas}`
- Text: `{colors.ink-subtle}`
- Type: `{typography.caption}`
- Padding: 64px 32px

---

## Elevation & Depth Model

| Level | Treatment | Application |
|---|---|---|
| 0 (flat) | No shadow, no border | Body text, hero type, footers |
| 1 (charcoal) | `{colors.surface-1}` + 1px `{colors.hairline}` | Default cards, product panels |
| 2 (featured) | `{colors.surface-2}` + 1px `{colors.hairline-strong}` | Featured pricing, hover states |
| 3 (dropdown) | `{colors.surface-3}` background | Sub-nav, menus |
| 4 (focus) | 2px `{colors.primary-focus}` outline @ 50% opacity | Focused input, button |

**Depth Principles**
- Four-step surface ladder replaces shadows entirely
- Product UI screenshots dominate as visual depth
- No atmospheric gradients or spotlight cards
- Subtle white edge highlight on lifted panel tops adds "pixel-rendered" quality
- Linear resists drop shadows on dark surfaces

---

## Layout & Grid

### Container & Breakpoints

| Breakpoint | Width | Key Changes |
|---|---|---|
| Desktop-XL | 1440px | Default layout |
| Desktop | 1280px | 3-column card grid maintained |
| Tablet | 1024px | 3-column → 2-column grid |
| Mobile-Lg | 768px | Hamburger nav, accordion pricing comparison |
| Mobile | 480px | 1-column layout, display-xl scales ~80px → ~36px |

### Grid Behavior
- Card grids: 3-up (desktop) → 2-up (1024px) → 1-up (768px)
- Pricing tier cards: 3-column at all widths until mobile-lg
- Product screenshots: Full content-width span
- Max content width: ~1280px

### Responsive Adjustments
- Display-xl scales from 80px (desktop) toward 40px on mobile
- Pricing comparison table collapses to accordion below 768px
- Top nav links collapse to hamburger below 768px
- Customer logo marquee: 6-up → 3-up below 768px
- Product UI mockups maintain aspect ratio (no crop)

### Touch Targets
- CTAs: minimum 40px tap height (≥44px on touch devices)
- Pricing tab pills: ≥36px tap height (≥44px on touch)
- Form inputs: ≥44px touch target

---

## Design Principles & Constraints

### Core Directives
- "The deepest dark surface in this collection" — `#010102` as unshakeable anchor
- Lavender reserved strictly for: brand mark, primary CTA, focus ring, link emphasis
- Hierarchy via four-step surface ladder (never skip levels)
- Display weight 600 paired with body weight 400 (avoid 700+ displays)
- Aggressive negative letter-spacing on display; body at -0.05px minimum
- Product UI screenshots as protagonist—every section leads with high-fidelity mockup
- All buttons: `{rounded.md}` (8px), never pill-rounded

### Chromatic Restraint
- Single accent color (lavender-blue)
- No secondary chromatic accent for marketing
- Semantic-success (#27a644) for status only
- No orange, pink, red, or green in marketing chrome
- Multi-color palettes reserved for product UI shown in mockups

### Forbidden Patterns
- Light mode not shipped
- Lavender as section background or card fill
- Atmospheric gradients or spotlight effects
- True black (#000000) as canvas substitute
- Multiple bright accents in mock-ups

---

## Composition & Content Patterns

### Page Rhythm
Dense product screenshots framed in `{colors.surface-1}` panels (`{rounded.xl}` 16px corners) dominate visual hierarchy. Marketing chrome is minimal—the app is the star.

### Hero Sections
- Headline: `{typography.display-xl}` or `{typography.display-lg}` in `{colors.ink}`
- Subhead: `{typography.body-lg}` in `{colors.ink-muted}`
- Primary CTA: `button-primary` with lavender background
- Optional screenshot: Full-width product panel below

### Feature/Benefit Grids
- 3-up card layout at desktop
- Each card: `feature-card` component
- Title: `{typography.card-title}`
- Body: `{typography.body}`
- Card title color: `{colors.ink}`

### Pricing Section
- Section header: `{typography.display-lg}`
- Toggle tabs: `pricing-tab-default` / `pricing-tab-selected` in pill shape
- Three tier columns:
  - Standard: `pricing-card`
  - Recommended: `pricing-card-featured` (surface lift)
  - Enterprise: `pricing-card`
- Tier title: `{typography.headline}`
- Comparison table below (accordion on mobile)

### Testimonials
- 2–3 card layout
- Each card: `testimonial-card` component
- Quote: `{typography.body-lg}` in `{colors.ink}`
- Avatar: 32–40px circle, `{rounded.full}`
- Name + role: `{typography.caption}` in `{colors.ink-muted}`

### CTA Banners
- Background: `{colors.surface-1}`
- Headline: `{typography.headline}` in `{colors.ink}`
- Supporting text: `{typography.body}` in `{colors.ink-muted}`
- Primary button: `button-primary` on right
- Padding: `{spacing.xxl}` (48px)

### Changelog (Build Page)
- Each row: `changelog-row` component
- Version label: `{typography.mono}`
- Date: `{typography.caption}` in `{colors.ink-subtle}`
- Changes list: bullet points in `{typography.body-sm}`
- Status badge: `status-badge` (optional)

---

## Form Interactions & Validation

### Input Focus
- Default state: `text-input` with `{colors.surface-1}` background
- Focused state: Same background + 2px `{colors.primary-focus}` outline at 50% opacity
- Placeholder text: `{colors.ink-subtle}`
- Error styling: Not documented (not visible on inspected pages)
- Validation styling: Not documented

---

## Animation & Micro-interactions

*(Not explicitly documented in source; system is presumed static)*

### Assumed Defaults
- Button hover: Background shift to `button-primary-hover` or `button-secondary-hover`
- Button press: Background shift to `button-primary-pressed`
- Link hover: Lavender underline or text color shift
- Pricing tab selection: Instant tab background fill transition
- Form input focus: Outline appearance (no transition duration specified)

---

## Accessibility Considerations

### Color Contrast
- `{colors.ink}` (#f7f8f8) on `{colors.canvas}` (#010102): ~18:1 ratio ✓
- `{colors.ink}` on `{colors.surface-1}` (#0f1011): ~17:1 ratio ✓
- `{colors.primary}` (#5e6ad2) on `{colors.surface-1}`: ~4.8:1 ratio (AA compliant for large text)

### Interactive Elements
- All buttons ≥40px height on desktop; ≥44px on touch
- Focus ring: 2px outline in `{colors.primary-focus}` at 50% opacity
- No color-only state indicators (text labels + status badges)

### Typography
- Body text sized 16px minimum
- Line height ≥1.4 for body copy (1.5 standard)
- Letter-spacing preserves readability even at negative values on display

---

## Implementation Notes

### Font Substitutes (Open Source)
- **Display/Text**: Inter (weights 500/600/700) or Geist Sans
- **Mono**: JetBrains Mono or Geist Mono at weight 400

### Vendor CSS Variables
Linear's production system uses CSS custom properties:
- `--color-bg-level-0` = canvas
- `--color-bg-level-1` = surface-1
- `--color-bg-level-2` = surface-2
- `--color-line-tint` = hairline
- `--color-brand-primary` = primary lavender

### Known Gaps
- Form error/validation styling not documented
- Light mode not provided
- Product-internal color tags (issue priorities, project labels) not exported to marketing palette
- Custom Linear typeface is proprietary; open-source substitutes acceptable

---

## Checklist for Component Creation

1. Reference by `components:` token name
2. Decide surface lift level (canvas → surface-1 → surface-2, etc.)
3. Default body to `{typography.body}` (16px, weight 400)
4. Apply negative letter-spacing only to display sizes (80px–28px range)
5. Use lavender sparingly: brand mark + primary CTA + focus ring only
6. Lead every major section with a product UI screenshot
7. Compose CTAs as `{rounded.md}` (8px corners)
8. Maintain ≥40px button height on desktop, ≥44px on touch
9. Test contrast ratios for text ≥4.5:1 (AA standard)
10. Validate spacing against `{spacing.*}` tokens

---

## References & Source Pages

Inspected surfaces:
- linear.app (home)
- /intake
- /pricing
- /contact/sales
- /build (changelog)

---

**Design System Version**: Alpha
**Last Updated**: (As documented in source)
**Status**: Production-ready for dark-mode marketing surfaces

---

## 套用到贏窟的轉譯備忘(非原文,套用時的取捨)

贏窟是**資訊密集的交易看板**,不是行銷頁,Linear這份文件是行銷站規格,套用時要做以下轉譯,不能整段照搬:

- **保留**:canvas/surface-1~4 四階表面階梯、hairline邊框系統(取代陰影)、ink文字階層、lavender(#5e6ad2)當唯一強調色(勾選態/連結/主要按鈕)、8px圓角(button-md)、Inter字體
- **調整**:display-xl/lg這類巨大標題尺寸用不到(贏窟沒有hero區),字級表要整體往下壓縮到body~card-title這個區間,用在頁面標題/區塊小標即可
- **新增(Linear文件沒有的,贏窟需要自己定的)**:表格列高/斑馬紋、勾選框(checkbox)樣式、多筆chip堆疊的排版、漲跌色(紅漲綠跌,台股慣例,不在Linear色板裡,需另外定義且不能被lavender強調色搶走視覺優先權)
