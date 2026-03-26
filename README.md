# forska.ai - AI Agents for systematic reviews in healthcare

Local-first deep research app for systematic reviews.

Core product config lives in the Forska UI and the local databases. Avoid `.env` setup for normal local dev. Use shell env only for one-off machine-local overrides, background jobs, or secrets.

Goal: standalone single-user app (your own computer). No admin role. No hosted multi-tenant web app.

Current: Bun/Elysia API, SolidJS/Vite client, DuckDB for local app/query data, and SQLite for local job/state storage.

## Abstract

This project aims to enable automatized systematic reviews with a focus on healthcare and medicine.

We have built and tested our system on a local workstation, but to scale up to handle more articles and allow testing from a broader community, we need a suitable storage and application platform.

Background:
Creating high quality systematic reviews is an arduous process – formulating an exhaustive search strategy, screening many thousands of abstracts, resolving ambiguous inclusion decisions, extracting heterogeneous data, assessing bias, synthesizing and presenting findings. Keeping up with evolving evidence and tools makes the whole endeavor complex and highly time-consuming. AI has shown promise in streamlining this process, but current deep research offerings, including those aimed at the scientific community, suffer from poor search and screening implementations. The cause is the inherited fundamentals of todays AI models and RAG systems. This has led to an increase in low quality review papers.

With this project we will propose a human-in-the-loop workflow that accelerates searching and screening while preserving accountability at every step. Reviewers define the question and criteria; assistive agents help expand search terms, filter and organize results, de-duplicate records, and surface likely inclusions. Every decision is transparent, logged, and revisitable. Rather than replacing expert judgment, the system enhances it. The platform supports calibration on small sets, structured reasons for inclusion or exclusion, disagreement resolution, and iterative refinement of search strategies as gaps are discovered. The system also allows for blinded comparison of AI and human decisions and output.

Goal and outcomes:
The goal is to both publish review papers in the healthcare domain and papers on the technical aspects and quality of the system.

Expected outcomes are higher-quality systematic reviews delivered faster and with defensible documentation.

We also plan to release all the code for the system as open source.

## Resource Usage

The app stores article metadata and cached PDFs locally with DuckDB and SQLite. The local API/app can call local/manual providers or tunnel to HPC-hosted inference.

Out plan is that the system will be efficiently run on a:
ssc.large.highmem, 4 vCPU, 16 GB RAM with 4-8 TB of additional storage

The imported article datasets can be very large. For our use case we will dynamically store only what is needed. We don't have an exact number, but rough guess based on our current test set would indicate about ~30-60GB. Then above this we would like to cache a large number of pdfs (~1m), which could add a few additional terabytes.

## Local dev

```bash
bun install
bun run db:mig
```

Terminal 1:

```bash
bun run dev:server
```

Terminal 2:

```bash
bun run dev:app
```

Open the local URL printed by Vite. Default local dev ports: app `3000`, API `3001`.

Do not create or edit `.env` files for normal local dev. Configure providers/models in the UI. For one-off machine-local overrides, pass shell env inline with the command.

## Local llama.cpp / llama-server

- Install `llama.cpp` / `llama-server`: [install guide](https://github.com/ggml-org/llama.cpp/blob/master/docs/install.md), [releases](https://github.com/ggml-org/llama.cpp/releases), or [build from source](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md)
- Model: [Qwen/Qwen3-4B-GGUF](https://huggingface.co/Qwen/Qwen3-4B-GGUF) and [files](https://huggingface.co/Qwen/Qwen3-4B-GGUF/tree/main). `-hf Qwen/Qwen3-4B-GGUF:Q4_K_M` downloads the GGUF into the Hugging Face cache automatically, so manual download is optional.

Run locally:

```bash
llama-server -hf Qwen/Qwen3-4B-GGUF:Q4_K_M --jinja --reasoning-format deepseek -c 8192 --temp 0.6 --top-k 20 --top-p 0.95 --min-p 0
```

Default `llama-server` port is `8080`, so Forska should usually point at `http://127.0.0.1:8080/v1`.

Optional check:

```bash
curl http://127.0.0.1:8080/v1/models
```

In the Forska UI:

- Open `/providers`
- Click `Add Provider`
- Choose `LM Studio` for a local OpenAI-compatible endpoint, set base URL to `http://127.0.0.1:8080/v1`, then create the provider
- Open that provider, click `Test`, then `Sync Models`
- Enable the discovered Qwen model and click `Save Models`
- If sync does not find the model, use `Add Model` and paste the model id returned by `/v1/models` into `Remote Model ID`

More local runtime notes: [RUN LOCAL](./docs/README_RUN_LOCAL.md)

## Run remotely on HPC:

[RUN REMOTE](./docs/README_RUN_REMOTE.md)

## Alvis Quick Start

- Sync the image to Alvis: `bun run alvis:sglang:pull`
- Launch the default Alvis shape: `bun run alvis:launch:a100:fat`
- Or launch the 4x non-fat A100 shape: `bun run alvis:launch:a100:4`
- Test the tunnel directly: `curl http://localhost:30001/v1/models`
- Optional local API dev server: `bun run alvis:dev:server`
- Optional local app: `bun run dev:app`
- Full setup and sbatch details: `docs/README_RUN_REMOTE.md`

## For running with SLURM/SBATCH

[SBATCH.md](./docs/README_SBATCH.md)
