# Specialized Program Files

This directory contains specialized `program.md` files for non-protocol autoresearch targets.

The default `program.md` (one level up at `.autoresearch/program.md`) is designed for optimizing agent protocol files (markdown commands). When optimizing a different kind of target — such as JavaScript infrastructure code — you need different constraints and strategies.

## Usage

1. Copy the relevant program file to `.autoresearch/program.md` before running autoresearch:

   ```bash
   cp .autoresearch/programs/briefing-program.md .autoresearch/program.md
   ```

2. Run autoresearch with the target file:

   ```bash
   npx agent-pipeline autoresearch --target lib/distill-briefing.js --benchmark build-basic
   ```

3. When done, restore the default program.md if switching back to protocol optimization:

   ```bash
   git checkout .autoresearch/program.md
   ```

## Available Programs

| File | Target | Description |
|------|--------|-------------|
| `briefing-program.md` | `lib/distill-briefing.js` | Optimizes the briefing generator that produces `.ship/briefing.md` context documents for agents. Better briefings improve all downstream agent benchmarks. |
