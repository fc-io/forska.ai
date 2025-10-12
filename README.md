# forska.ai

Elysia (Bun) API server + Solid (Vite) client, using Drizzle ORM (Postgres) and Better Auth.

```
export STACK_ROOT=/mimer/NOBACKUP/groups/clin-agent-bench/dev; mkdir -p $STACK_ROOT/{pgdata,models,hf_cache,logs} && echo $STACK_ROOT
export XDG_CACHE_HOME=$STACK_ROOT/.cache; export VLLM_CACHE_ROOT=$XDG_CACHE_HOME/vllm; export TORCHINDUCTOR_CACHE_DIR=$VLLM_CACHE_ROOT/torchinductor; export TRITON_CACHE_DIR=$VLLM_CACHE_ROOT/triton; export HF_HOME=$STACK_ROOT/hf_cache
```

```
ls -al $STACK_ROOT/models/Qwen3-32B-FP8
```