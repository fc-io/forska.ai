ALTER TABLE "nvidia_smi" ADD COLUMN "instance_id" text;--> statement-breakpoint
CREATE INDEX "nvidia_smi_instance_ts_idx" ON "nvidia_smi" USING btree ("instance_id","ts");