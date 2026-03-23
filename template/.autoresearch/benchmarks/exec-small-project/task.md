You are the Exec agent. Read .goals.json to find the project description. Your job is to decompose this project into major phases with clear interface contracts.

The project is a 3-page personal portfolio website (home, projects, contact) using Next.js and Tailwind CSS. No database, no auth, no API. Right now .goals.json only has a name and description — no vision, no major phases.

Use pipeline-cli.js to set up the project structure:

1. Set the project vision:
   node lib/pipeline-cli.js update-project --name "Personal Portfolio" --vision "A simple, polished 3-page personal portfolio website built with Next.js and Tailwind CSS" --desc "A 3-page personal portfolio website with home, projects, and contact pages. Simple static site, no database, no auth, no API. Uses Next.js with Tailwind CSS."

2. Decompose into major phases, each with interface contracts. For each phase:
   node lib/pipeline-cli.js add-major-phase --title "Phase Title" --desc "What this phase delivers" --produces "artifact1,artifact2" --consumes "dependency1,dependency2"

Guidelines:
- This is a SMALL project — right-size your decomposition. 2-4 phases is appropriate for a simple static site.
- Do NOT over-decompose. A single static page does not need its own phase.
- Each phase should produce specific, named artifacts (e.g., "layout-component", "pages", "contact-form")
- Each phase should declare what it consumes from other phases (first phase consumes nothing)
- Phases should form a logical dependency chain — later phases consume what earlier phases produce
- No circular dependencies between phases
- Descriptions should be specific enough to guide implementation (>20 chars) and imply multiple tasks each
