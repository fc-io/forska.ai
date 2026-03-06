# forska.ai - AI Agents for systematic reviews in healthcare

Local-first deep research agent for systematic reviews.

Goal: standalone single-user app (your own computer). No admin role. No hosted multi-tenant web app.

Current: Bun/Elysia API, SolidJS/Vite client, Drizzle+Postgres+Better Auth (temporary).
Roadmap: admin-free -> remove Better Auth/users -> SQLite app DB -> DuckDB analytics (drop ClickHouse).

Plans: `REMOVE_ADMIN_AND_USERS.md`, `SQLITE_PLAN.md`, `DUCK_PLAN.md`.

## Abstract

This project aims to enable automatized systematic reviews with a focus on healthcare and medicine.

We have built and tested our system on a local workstation, but to scale up to handle more articles and allow testing from a broader community, we need a suitable storage and application platform.

Background:
Creating high quality systematic reviews is an arduous process – formulating an exhaustive search strategy, screening many thousands of abstracts, resolving ambiguous inclusion decisions, extracting heterogeneous data, assessing bias, synthesizing and presenting findings. Keeping up with evolving evidence and tools makes the whole endeavor complex and highly time-consuming. AI has shown promise in streamlining this process, but current deep research offerings, including those aimed at the scientific community, suffer from poor search and screening implementations. The cause is the inherited fundamentals of todays AI models and RAG systems. This has led to an increase in low quality review papers.

With this project we will propose a human-centered, human-in-the-loop workflow that accelerates searching and screening while preserving accountability at every step. Reviewers define the question and criteria; assistive agents help expand search terms, filter and organize results, de-duplicate records, and surface likely inclusions. Every decision is transparent, logged, and revisitable. Rather than replacing expert judgment, the system enhances it. The platform supports calibration on small sets, structured reasons for inclusion or exclusion, disagreement resolution, and iterative refinement of search strategies as gaps are discovered. The system also allows for blinded comparison of AI and human decisions and output.

Goal and outcomes:
The goal is to both publish review papers in the healthcare domain and papers on the technical aspects and quality of the system.

Expected outcomes are higher-quality systematic reviews delivered faster and with defensible documentation.

We also plan to release all the code for the system as open source.

## Resource Usage

The system will store article "meta data" from openalex and a large amount of open access pdfs. These articles will then be connected to a client facing api and a app server on the same server. These will in turn be connected to our hpc resources where we do inference.

The system used docker with postgres, aws cli and bun.

Out plan is that the system will be efficiently run on a:
ssc.large.highmem, 4 vCPU, 16 GB RAM with 4-8 TB of additional storage

The openalex dataset is about 1.6 TB uncompressed. To store and index naively in postgres would be about 3 TB more. Though for our use case we will dynamically store only what is needed which would be less. We don't have an exact number, but rough guess based on our current test set would indicate about ~30-60GB. Then above this we would like to cache a large number of pdfs (~1m), which could add a few additional terabytes.

## Run locally

[RUN LOCAL ](./docs/README_RUN_LOCAL.md)

## Run remotely on HPC:

[RUN REMOTE](./docs/README_RUN_REMOTE.md)

## For running with SLURM/SBATCH

[SBATCH.md](./docs/README_SBATCH.md)

## For syncing the dbs of the remote with our local db

[SYNC DB FROM REMOTE.md](./docs/README_DB_SYNC_FROM_REMOTE.md)
