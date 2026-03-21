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
- **Edge labels**: short (2-4 words) + full description in `data.flow`
- **Click-to-inspect**: detail text via `data.detail` on nodes

## Layout

No hardcoded grid — adapt spacing to the content:
- Nodes must never overlap or crowd. Leave generous whitespace.
- Edges should be readable — no spaghetti. Rearrange nodes if edges cross.
- Group related nodes visually with GroupNode.
- Scale spacing to node count — fewer nodes = tighter, more nodes = wider.
- Flow direction: left-to-right for data flow, top-to-bottom for hierarchy.
  Pick whichever fits the content.

---

## Diagram Levels

Diagrams are created at project, major phase, and phase levels only.
Do NOT create diagrams for individual tasks — the code is the source of truth at that level.

| Level      | Node granularity           | Edge meaning         |
|------------|---------------------------|----------------------|
| Project    | One per major phase        | Phase dependencies   |
| MajorPhase | One per phase              | Sequence / data flow |
| Phase      | One per task + key modules | Task deps, data contracts |

---

## Storage

**ALWAYS store diagrams in .goals.json via the CLI. NEVER write diagram nodes/edges
directly into app/visualize/page.js or any source file.** The visualize page is a
viewer — it reads from .goals.json automatically.

Store via:
```bash
node lib/pipeline-cli.js add-diagram <entityId> --title "Title" --jsonFile /tmp/diagram.json
```

View them at `/visualize` in your app (requires `@xyflow/react` dependency).
The API at `/api/diagrams` serves all diagrams from `.goals.json`.
