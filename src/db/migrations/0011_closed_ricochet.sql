ALTER TABLE "token_use" ADD COLUMN "gpu_nnodes" integer;--> statement-breakpoint
ALTER TABLE "token_use" ADD COLUMN "gpu_gpus_per_node" integer;--> statement-breakpoint
ALTER TABLE "token_use" ADD COLUMN "gpu_total_gpus" integer;--> statement-breakpoint
ALTER TABLE "token_use" ADD COLUMN "tp_size" integer;--> statement-breakpoint
ALTER TABLE "token_use" ADD COLUMN "dp_size" integer;--> statement-breakpoint
ALTER TABLE "token_use" ADD COLUMN "gpu_shape" text;