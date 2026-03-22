You are the Exec agent. Read .goals.json to find the project description. Your job is to decompose this project into 3-7 major phases with clear interface contracts.

The project is a task management SaaS with teams, projects, kanban boards, real-time updates, and user authentication. Right now .goals.json only has a name and description — no vision, no major phases.

Use pipeline-cli.js to set up the project structure:

1. Set the project vision:
   node lib/pipeline-cli.js update-project --name "TaskFlow" --vision "A production-ready task management SaaS enabling teams to organize work through projects, kanban boards, and real-time collaboration with secure multi-tenant authentication" --desc "Task management SaaS with teams, projects, kanban boards, real-time updates, and user authentication"

2. Decompose into 3-7 major phases, each with interface contracts. For each phase:
   node lib/pipeline-cli.js add-major-phase --title "Phase Title" --desc "What this phase delivers" --produces "artifact1,artifact2" --consumes "dependency1,dependency2"

Guidelines:
- Each phase should produce specific, named artifacts (e.g., "auth-api", "user-schema", "ws-server")
- Each phase should declare what it consumes from other phases (first phase consumes nothing)
- Phases should form a logical dependency chain — later phases consume what earlier phases produce
- No circular dependencies between phases
- Descriptions should be specific enough to guide implementation (>20 chars)
- Cover the full scope: auth, data model, API, real-time, UI, and deployment concerns
