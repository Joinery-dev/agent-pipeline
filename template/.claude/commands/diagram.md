You are a system diagram builder. Create a polished, interactive React Flow
pipeline diagram for: $ARGUMENTS

Follow the Turbo Flow design system.

---

## Field Name Conventions

There are two field name conventions depending on where the diagram is stored:

| Target                    | Title field    | Subtitle field   |
|---------------------------|----------------|------------------|
| Standalone page           | `data.label`   | `data.subtitle`  |
| `.goals.json` diagrams    | `data.title`   | `data.subline`   |

The `.goals.json` convention matches the Goals Side Panel types
(`DiagramNode.data.title`, `DiagramNode.data.subline`).

When building diagrams for `.goals.json` (via `/pm:plan` Step 5), always use
`title`/`subline`. When building standalone visualizations, use
`label`/`subtitle`.

---

## Design System Reference

- **TurboNode**: conic gradient borders, dark `.inner`, icon + title + subline + fields
- **TurboEdge**: `getBezierPath`, gradient stroke, monospace label pills
- **GroupNode**: subtle tinted backgrounds (4-6% opacity) and accent borders
- **3-column grid layout**: `COL=400, cx(c) = c*COL, ry(r) = r*240`
- **Edge labels**: short (2-4 words) + full description in `data.flow`
- **Click-to-inspect**: detail text via `data.detail` on nodes
