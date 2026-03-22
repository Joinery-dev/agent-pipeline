# Project Conventions

## Module System
- Use ES modules exclusively (`import`/`export`). Never use CommonJS (`require`, `module.exports`).

## Environment Configuration
- Never hardcode API URLs, secrets, or configuration values. Always read from environment variables (`process.env`).

## Error Handling
- All async functions must include error handling — either a `try/catch` block or a `.catch()` handler on returned promises.
- Unhandled promise rejections crash the process. Every async path must be covered.

## Logging
- Do not use `console.log` in production code. Use the project logger (`import { log } from './logger.js'`).
- Logging sensitive data (tokens, passwords, keys) is a security violation regardless of which logger is used.

## Input Validation
- All public functions must validate their inputs. Check for `undefined`, `null`, and invalid types before proceeding.
- Throw descriptive errors on invalid input rather than silently proceeding.
