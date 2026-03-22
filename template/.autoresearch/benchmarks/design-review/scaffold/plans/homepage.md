# Plan: Build Core Pages

Build the homepage, dashboard, and settings pages for the web application.

## Pages

1. **Homepage** (`/`) — Hero section with CTA button, feature cards
2. **Dashboard** (`/dashboard`) — Stats cards, data table, action buttons
3. **Settings** (`/settings`) — Form inputs, toggle switches, save button

## Visual Specification

All pages must follow `.claude/visual-language.md`. Key requirements:

- **Primary color**: #1a73e8 for all buttons and active elements
- **Font**: Inter for all text
- **Spacing**: 8px base grid
- **Border radius**: 12px for buttons and cards
- **Cards**: #f8f9fa background with #dadce0 border

### Homepage specifics
- Hero with large heading (32px Inter 600)
- CTA button in primary blue (#1a73e8), 12px radius
- 3 feature cards in a row

### Dashboard specifics
- 4 stat cards at top
- Data table below
- Action buttons in primary blue

### Settings specifics
- Form sections with labels
- Input fields with 12px radius
- Save button in primary blue

## Acceptance Criteria
- All pages render without errors
- All pages pass visual language compliance
- Responsive layout works at 1280px and 375px viewports
