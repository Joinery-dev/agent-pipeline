# Visual Language Specification

This is the visual constitution for the project. All pages must conform to these tokens.

---

## Color Palette

| Token             | Value     | Usage                        |
|-------------------|-----------|------------------------------|
| --color-primary   | #1a73e8   | Buttons, links, active states |
| --color-secondary | #5f6368   | Secondary text, icons         |
| --color-bg        | #ffffff   | Page background               |
| --color-surface   | #f8f9fa   | Card backgrounds, surfaces    |
| --color-border    | #dadce0   | Borders, dividers             |
| --color-text      | #202124   | Primary body text             |
| --color-error     | #d93025   | Error states only             |
| --color-success   | #1e8e3e   | Success states only           |

**Rule:** No colors outside this palette. Buttons MUST use --color-primary (#1a73e8).

---

## Typography

| Token              | Value              |
|--------------------|--------------------|
| --font-family      | Inter, sans-serif  |
| --font-size-h1     | 32px               |
| --font-size-h2     | 24px               |
| --font-size-body   | 16px               |
| --font-size-small  | 14px               |
| --font-weight-bold | 600                |
| --font-weight-normal | 400              |

**Rule:** All text must use the Inter font family. No other fonts allowed.

---

## Spacing

| Token           | Value |
|-----------------|-------|
| --space-base    | 8px   |
| --space-xs      | 4px   |
| --space-sm      | 8px   |
| --space-md      | 16px  |
| --space-lg      | 24px  |
| --space-xl      | 32px  |
| --space-2xl     | 48px  |

**Rule:** All spacing must be multiples of the 8px base unit.

---

## Border Radius

| Token              | Value |
|--------------------|-------|
| --radius-sm        | 8px   |
| --radius-md        | 12px  |
| --radius-lg        | 16px  |

**Rule:** Buttons and cards use --radius-md (12px). Small elements like chips use --radius-sm (8px).

---

## Components

### Buttons
- Background: --color-primary (#1a73e8)
- Text: #ffffff
- Border-radius: --radius-md (12px)
- Padding: --space-sm --space-md (8px 16px)
- Font: --font-family (Inter), --font-weight-bold (600)

### Cards
- Background: --color-surface (#f8f9fa)
- Border: 1px solid --color-border (#dadce0)
- Border-radius: --radius-md (12px)
- Padding: --space-md (16px)
