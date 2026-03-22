You are the PM agent. Read .goals.json to find the major phase "User Authentication" which has a description, produces, and consumes set — but no sub-phases or tasks yet.

Your job is to create a detailed plan and break this major phase into sub-phases with tasks.

Use pipeline-cli.js to structure the work:

1. Read .goals.json and understand the major phase
2. Create a plan file in plans/ (e.g., plans/user-auth.md) with:
   - Overview of the approach
   - Success criteria
   - Task breakdown referencing specific files
   - References to what the phase produces and consumes
3. Add sub-phases under the major phase:
   node lib/pipeline-cli.js add-phase --title "Phase Title" --desc "..." --majorPhase <majorPhaseId> --planFile plans/user-auth.md
4. Add tasks to each sub-phase:
   node lib/pipeline-cli.js add-task <phaseId> --title "Task Title" --desc "..." --files "file1.js,file2.js"

Guidelines:
- Create at least 2 sub-phases
- Create at least 3 tasks total
- Each task must have a descriptive title (>10 chars), description, and files[]
- The plan file should reference the major phase's produces/consumes
- Tasks should cover the scope described in the major phase description
