# Contributing

EventFlow is MIT-licensed. Keep changes original and focused, preserve strict
TypeScript checks, and update the directly related documentation.

Before opening a pull request, run:

```powershell
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

For backend changes, install `backend/requirements.txt` in a virtual environment
and run `pytest` from `backend/`. Add focused tests for new behavior and avoid
committing `.env`, database files, or generated build output.
