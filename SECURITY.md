# Security Policy

## Reporting A Vulnerability

Please report security issues privately through GitHub Security Advisories for this repository when available.

Do not post secrets, provider credentials, private datasets, article payloads, PDFs, logs, or exploit details in public issues or discussions.

If private reporting is unavailable, open a public issue with only a high-level description and ask for a private contact path. Do not include reproduction details that would expose users or data.

## Supported Versions

Security fixes are handled for the current public code line. Older snapshots, forks, or unpublished internal cleanup branches are not guaranteed to receive fixes.

## Local-First Security Model

Forska is intended to run as a local single-user app. The supported public workflow binds app and API services to loopback by default. Do not expose the local API to a LAN or the public internet unless you have reviewed and accepted the security implications.

Provider credentials and model settings should be configured through the app UI or local machine secret storage. Do not commit `.env` files, API keys, tokens, provider secrets, private datasets, cached PDFs, logs, or runtime database files.

## Disclosure

We aim to acknowledge valid private reports promptly and coordinate a fix before public disclosure when practical.
