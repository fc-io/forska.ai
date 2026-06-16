# forska.ai - AI Agents for research

Do you want to put scientists in a data center? Forska is a local-first,
privacy-conscious deep research application suitable for actual
science. It's also open source.

Forska is currently designed as a standalone single-user app. You can share
your results with others, but it is not a hosted multi-tenant web app suitable
for large teams (at least not yet). If you want that, then please reach out.

The current USP is that it can let LLMs run through millions of scientific
articles in days or hours. Perfect for finding obscure papers, keeping track of
the latest in your field, or helping you with your systematic reviews.

## Under active development

This project is set up to enable my PhD research. It's under active development
and sometimes buggy because of that. Feel free to file issues.

The goal with the project is to replace a lot of manual and tedious tasks
researchers of all stripes go through. The main focus is on AI and medical
research.

## To run:

Clone the repo and install dependencies


```bash
bun install
```

Then start the local API/server stack and web app:

```bash
bun run dev:start
```

Open the local URL printed by Vite after `bun run dev:app` starts.

More local runtime notes: [Run Local](./docs/README_RUN_LOCAL.md)

## Configure Providers

Configure models and providers in the Forska UI:

1. Open `/providers`.
2. Click `Add Provider`.
3. Add a local or remote provider connection.
4. Open the provider, click `Test`, then `Sync Models` or `Add Model`.
5. Enable the models you want and click `Save Models`.

Provider credentials and model settings should be entered through the app.

## Resource Usage

Forska stores article metadata, imported records, generated review state, and optional cached PDFs locally. Disk usage depends on the size of imported datasets and whether full text or PDFs are stored. Large review projects can require substantial local storage.

## License

Apache License 2.0. See [LICENSE](./LICENSE).
