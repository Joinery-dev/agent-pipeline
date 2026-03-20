You are a system diagram builder. Create a polished, interactive React Flow
pipeline diagram for: $ARGUMENTS

Follow the Turbo Flow design system (see `app/visualize/` for the renderer).

---

## Field Name Conventions

Diagrams stored in `.goals.json` use these field names on nodes:

| Field          | Purpose           |
|----------------|-------------------|
| `data.title`   | Node title        |
| `data.subline`  | Subtitle text     |
| `data.icon`     | Emoji icon        |
| `data.fields`   | `[{ name, type }]` |
| `data.detail`   | Click-to-inspect text |
| `data.color`    | Group node tint (`purple`, `amber`, `blue`, `green`, `pink`) |

The viewer at `app/visualize/page.js` supports both conventions
(`title`/`subline` and `label`/`subtitle`) automatically.

---

## Design System Reference

- **TurboNode**: conic gradient borders, dark `.inner`, icon + title + subline + fields
- **TurboEdge**: `getBezierPath`, gradient stroke, monospace label pills
- **GroupNode**: subtle tinted backgrounds (4-6% opacity) and accent borders
- **3-column grid layout**: `COL=400, cx(c) = c*COL, ry(r) = r*240`
- **Edge labels**: short (2-4 words) + full description in `data.flow`
- **Click-to-inspect**: detail text via `data.detail` on nodes

---

## Viewing Diagrams

Diagrams are stored in `.goals.json` via:
```bash
node lib/pipeline-cli.js add-diagram <entityId> --title "Title" --jsonFile /tmp/diagram.json
```

View them at `/visualize` in your app (requires `@xyflow/react` dependency).
The API at `/api/diagrams` serves all diagrams from `.goals.json`.
