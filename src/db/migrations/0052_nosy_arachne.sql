DROP INDEX "nvidia_smi_hostname_ts_idx";--> statement-breakpoint
ALTER TABLE "nvidia_smi" ALTER COLUMN "instance_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "nvidia_smi" DROP COLUMN "hostname";