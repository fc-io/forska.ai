CREATE TABLE "nvidia_smi" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"hostname" text NOT NULL,
	"gpu_index" integer NOT NULL,
	"gpu_uuid" text,
	"gpu_name" text,
	"temperature_gpu" integer,
	"utilization_gpu" integer,
	"utilization_memory" integer,
	"memory_total_mib" integer,
	"memory_used_mib" integer,
	"power_draw_watts" double precision,
	"power_limit_watts" double precision,
	"fan_speed" integer,
	"pstate" text
);
--> statement-breakpoint
CREATE INDEX "nvidia_smi_ts_idx" ON "nvidia_smi" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "nvidia_smi_hostname_ts_idx" ON "nvidia_smi" USING btree ("hostname","ts");--> statement-breakpoint
CREATE INDEX "nvidia_smi_gpu_uuid_ts_idx" ON "nvidia_smi" USING btree ("gpu_uuid","ts");