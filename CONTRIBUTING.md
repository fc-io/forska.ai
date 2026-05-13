# Contributing

Thanks for your interest in contributing to Forska.

## Development Setup

Install dependencies:

```bash
bun install
```

Initialize the local database:

```bash
bun run db:mig
```

Start the local API/server stack:

```bash
bun run dev:server
```

Start the web app:

```bash
bun run dev:app
```

Default local endpoints:

- Web app: `http://127.0.0.1:3000`
- API: `http://127.0.0.1:3001`

## Checks

Run the relevant checks before opening a pull request:

```bash
bun test
bun run lint
```

For UI or runtime-path changes, also run:

```bash
bun run build
```

## Development Notes

- Keep normal local development config in the app UI and local databases.
- Do not create or commit `.env` files for normal development.
- Do not commit provider credentials, API keys, tokens, private datasets, cached PDFs, logs, runtime database files, or generated build output.
- Prefer small focused changes with tests or clear manual verification.
- Keep public docs focused on supported local workflows.

## Security Issues

Report security issues privately. See `SECURITY.md` for details.
