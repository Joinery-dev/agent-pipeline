# Screenshot Review Notes

These notes describe the current visual state of each page as observed from screenshots taken at 1280x800 viewport.

---

## Page: Homepage (`/`)

**Layout:** Hero section at top with large heading, subtext, and a CTA button. Below are 3 feature cards in a row.

**Observations:**
- The hero heading uses Inter font at 32px, weight 600 — correct.
- The subtext is Inter 16px, color #202124 — correct.
- The CTA button has a **red background (#ff0000)** instead of the brand primary blue. The text is white, padding looks correct at 8px 16px. The border-radius is 12px — correct radius.
- The feature cards use #f8f9fa background, #dadce0 border, 12px radius, 16px padding — all correct.
- Spacing between sections follows the 8px grid — correct.

**Summary:** The button color is wrong — uses #ff0000 red instead of #1a73e8 primary blue.

---

## Page: Dashboard (`/dashboard`)

**Layout:** 4 stat cards at top in a grid, data table below, action buttons at bottom.

**Observations:**
- Stat cards: #f8f9fa background, #dadce0 border, 12px radius — correct.
- Card headings: Inter 24px weight 600 — correct.
- Card body text: Inter 16px weight 400, color #202124 — correct.
- Data table: proper borders using #dadce0, text is Inter — correct.
- Action buttons: background #1a73e8, white text, 12px border-radius, Inter 600 — all correct.
- Spacing: consistent 8px grid throughout — correct.
- Secondary text uses #5f6368 — correct.

**Summary:** No violations found. All elements match the visual language specification.

---

## Page: Settings (`/settings`)

**Layout:** Form with labeled input fields, toggle switches, and a save button at bottom.

**Observations:**
- Section headings use **Arial font** instead of Inter. Size is 24px, weight 600 — correct size and weight but wrong font family.
- Body text and labels also use **Arial** instead of Inter.
- Input fields have a **4px border-radius** instead of the specified 12px. They have correct border color #dadce0.
- Toggle switches look fine, using #1a73e8 for active state — correct.
- Save button: #1a73e8 background, white text, but has **4px border-radius** instead of 12px. Font on button is also Arial instead of Inter.
- Card containers for form sections: #f8f9fa background, 12px radius — correct radius on cards.
- Spacing follows 8px grid — correct.
- Text color #202124 — correct.

**Summary:** Two types of violations: (1) Arial font used instead of Inter throughout the page, (2) 4px border-radius on inputs and buttons instead of 12px.
