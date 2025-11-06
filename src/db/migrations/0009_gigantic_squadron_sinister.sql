ALTER TABLE "llm_status" ADD COLUMN "prompt_tokens_total" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_status" ADD COLUMN "generation_tokens_total" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_status" ADD COLUMN "num_requests_total" bigint;--> statement-breakpoint
ALTER TABLE "llm_status" ADD COLUMN "cached_tokens_total" bigint;--> statement-breakpoint
ALTER TABLE "llm_status" ADD COLUMN "num_retractions_count" bigint;--> statement-breakpoint
ALTER TABLE "llm_status" ADD COLUMN "num_queue_reqs" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_status" ADD COLUMN "num_running_reqs" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_status" ADD COLUMN "num_grammar_queue_reqs" integer;--> statement-breakpoint
ALTER TABLE "llm_status" ADD COLUMN "num_running_reqs_offline_batch" integer;--> statement-breakpoint
ALTER TABLE "llm_status" ADD COLUMN "num_prefill_prealloc_queue_reqs" integer;--> statement-breakpoint
ALTER TABLE "llm_status" ADD COLUMN "num_prefill_inflight_queue_reqs" integer;--> statement-breakpoint
ALTER TABLE "llm_status" ADD COLUMN "num_decode_prealloc_queue_reqs" integer;--> statement-breakpoint
ALTER TABLE "llm_status" ADD COLUMN "num_decode_transfer_queue_reqs" integer;--> statement-breakpoint
ALTER TABLE "llm_status" ADD COLUMN "gen_throughput" double precision;--> statement-breakpoint
ALTER TABLE "llm_status" ADD COLUMN "token_usage" double precision;--> statement-breakpoint
ALTER TABLE "llm_status" ADD COLUMN "utilization" double precision;--> statement-breakpoint
ALTER TABLE "llm_status" ADD COLUMN "cache_hit_rate" double precision;--> statement-breakpoint
ALTER TABLE "llm_status" ADD COLUMN "spec_accept_rate" double precision;--> statement-breakpoint
ALTER TABLE "llm_status" ADD COLUMN "spec_accept_length" double precision;--> statement-breakpoint
ALTER TABLE "llm_status" ADD COLUMN "is_cuda_graph" boolean;--> statement-breakpoint
ALTER TABLE "llm_status" ADD COLUMN "swa_token_usage" double precision;--> statement-breakpoint
ALTER TABLE "llm_status" ADD COLUMN "mamba_usage" double precision;--> statement-breakpoint
ALTER TABLE "llm_status" ADD COLUMN "pending_prealloc_token_usage" double precision;--> statement-breakpoint
ALTER TABLE "llm_status" ADD COLUMN "kv_transfer_speed_gb_s" double precision;--> statement-breakpoint
ALTER TABLE "llm_status" ADD COLUMN "kv_transfer_latency_ms" double precision;--> statement-breakpoint
ALTER TABLE "llm_status" ADD COLUMN "kv_transfer_bootstrap_ms" double precision;--> statement-breakpoint
ALTER TABLE "llm_status" ADD COLUMN "kv_transfer_alloc_ms" double precision;--> statement-breakpoint
ALTER TABLE "llm_status" ADD COLUMN "time_to_first_token_seconds" jsonb;--> statement-breakpoint
ALTER TABLE "llm_status" ADD COLUMN "e2e_request_latency_seconds" jsonb;--> statement-breakpoint
ALTER TABLE "llm_status" ADD COLUMN "inter_token_latency_seconds" jsonb;--> statement-breakpoint
ALTER TABLE "llm_status" ADD COLUMN "per_stage_req_latency_seconds" jsonb;--> statement-breakpoint
ALTER TABLE "llm_status" ADD COLUMN "queue_time_seconds" jsonb;--> statement-breakpoint
ALTER TABLE "llm_status" DROP COLUMN "prefill_tokens_total";--> statement-breakpoint
ALTER TABLE "llm_status" DROP COLUMN "gen_tokens_total";--> statement-breakpoint
ALTER TABLE "llm_status" DROP COLUMN "request_success_total";--> statement-breakpoint
ALTER TABLE "llm_status" DROP COLUMN "request_error_total";--> statement-breakpoint
ALTER TABLE "llm_status" DROP COLUMN "preemptions_total";--> statement-breakpoint
ALTER TABLE "llm_status" DROP COLUMN "num_requests_waiting";--> statement-breakpoint
ALTER TABLE "llm_status" DROP COLUMN "num_requests_running";--> statement-breakpoint
ALTER TABLE "llm_status" DROP COLUMN "gpu_cache_usage_perc";--> statement-breakpoint
ALTER TABLE "llm_status" DROP COLUMN "num_requests_swapped";--> statement-breakpoint
ALTER TABLE "llm_status" DROP COLUMN "e2e_latency_buckets";--> statement-breakpoint
ALTER TABLE "llm_status" DROP COLUMN "ttft_latency_buckets";--> statement-breakpoint
ALTER TABLE "llm_status" DROP COLUMN "itl_latency_buckets";