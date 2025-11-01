CREATE TYPE "public"."engine_enum" AS ENUM('sglang', 'vllm');--> statement-breakpoint
CREATE TABLE "llm_status" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"engine" "engine_enum" NOT NULL,
	"instance_id" text NOT NULL,
	"model_name" text NOT NULL,
	"engine_version" text,
	"gpu_type" text,
	"gpu_count" integer,
	"poll_ms" integer DEFAULT 2000 NOT NULL,
	"prefill_tokens_total" bigint DEFAULT 0 NOT NULL,
	"gen_tokens_total" bigint DEFAULT 0 NOT NULL,
	"request_success_total" bigint,
	"request_error_total" bigint,
	"preemptions_total" bigint,
	"num_requests_waiting" integer DEFAULT 0 NOT NULL,
	"num_requests_running" integer DEFAULT 0 NOT NULL,
	"gpu_cache_usage_perc" double precision,
	"num_requests_swapped" integer,
	"prefill_tps" double precision,
	"gen_tps" double precision,
	"rps" double precision,
	"target_gen_tps" double precision,
	"target_prefill_tps" double precision,
	"in_flight" integer,
	"max_in_flight" integer,
	"last_action" text,
	"e2e_latency_buckets" jsonb,
	"ttft_latency_buckets" jsonb,
	"itl_latency_buckets" jsonb
);
--> statement-breakpoint
CREATE INDEX "llm_status_ts_idx" ON "llm_status" USING btree ("ts");--> statement-breakpoint
CREATE UNIQUE INDEX "llm_status_engine_instance_ts_idx" ON "llm_status" USING btree ("engine","instance_id","ts");--> statement-breakpoint
CREATE INDEX "llm_status_model_ts_idx" ON "llm_status" USING btree ("model_name","ts");