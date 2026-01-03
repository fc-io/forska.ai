# HPC prompt processing — requirements

- local API -> HPC too slow; move logic to HPC
- HPC workers run judgments/prompts only
- worker impl ok: python or bun
- local node orchestrate workers
- HPC workers must assume no stable link to local; disconnect ok; resume on reconnect
- compute nodes: no outbound connections
- shared filesystem visible to all nodes
- worker must know nothing about other workers
- “worker” may span multi-node (LLM sharded); still treat as 1 worker unit
- only send data to HPC while Slurm `sbatch` running
- setup complexity ok (not constraint)
- want each worker/job/script behave like “http/trcp api” (req/resp semantics) – does not actually need to send http requests/responses, but the interface should look like it
- Slurm runtime cap: 72h
- output: final judgment only (no streaming)
- throughput target: ~1,400,000 tokens/min/worker
- context length max: 32,768 tokens
