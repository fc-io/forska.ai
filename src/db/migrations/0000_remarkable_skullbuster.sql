CREATE TYPE "public"."judgments_job_status_enum" AS ENUM('not_started', 'waiting_on_llm_connection', 'waiting_on_db_connection', 'running', 'paused_by_user', 'paused_by_admin', 'failed', 'completed', 'project_removed');--> statement-breakpoint
CREATE TYPE "public"."judgments_jobs_articles_status_enum" AS ENUM('ready', 'sent', 'judged', 'judged_and_ready_to_remove_from_queue');--> statement-breakpoint
CREATE TYPE "public"."publication_status_enum" AS ENUM('preprint', 'submitted', 'accepted', 'published', 'retracted');--> statement-breakpoint
CREATE TABLE "article_route_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"article_id" uuid NOT NULL,
	"import_route_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"article_title" text NOT NULL,
	"article_authors" text[],
	"article_created_at" timestamp with time zone,
	"article_updated_at" timestamp with time zone,
	"article_id" text,
	"article_summary" text,
	"article_version" integer,
	"arxiv_id" text,
	"doi" text,
	"pubmed_id" text,
	"url" text,
	"content_hash" text,
	"import_route" text,
	"original_data" jsonb,
	"imported_by" text,
	"publication_status" "publication_status_enum",
	CONSTRAINT "articles_article_id_unique" UNIQUE("article_id")
);
--> statement-breakpoint
CREATE TABLE "datasource" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"last_import_at" timestamp with time zone,
	"items_after_last_import" integer DEFAULT 0,
	"import_route" text,
	"date_from" timestamp with time zone,
	"date_to" timestamp with time zone,
	"owner_id" text DEFAULT 'uv2Idd2BF6VNSNjwY5IKmIeoYMKq6zXw' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "datasource_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"datasource_id" uuid NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "datasource_route_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"datasource_id" uuid NOT NULL,
	"import_route_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_route" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"route" text NOT NULL,
	"name" text,
	"description" text,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "judgment_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"judgment_id" uuid NOT NULL,
	"assessed_by" text NOT NULL,
	"assessment_is_correct" boolean NOT NULL,
	"assessment_comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "judgments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"article_id" uuid NOT NULL,
	"model_id" uuid NOT NULL,
	"prompt_id" uuid NOT NULL,
	"review_id" uuid,
	"answered_original" text,
	"answered_transformed" text,
	"confidence_original" integer,
	"explanation" text,
	"quotes" jsonb
);
--> statement-breakpoint
CREATE TABLE "judgments_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"status" "judgments_job_status_enum" DEFAULT 'not_started' NOT NULL,
	"error" text[],
	"send_to_llm_batch_size" integer DEFAULT 5 NOT NULL,
	"send_to_llm_interval" integer DEFAULT 15 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "judgments_jobs_articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"job_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"server_id" text,
	"sent_at" timestamp with time zone,
	"judged_at" timestamp with time zone,
	"status" "judgments_jobs_articles_status_enum" DEFAULT 'ready' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"model_id" uuid NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"provider" text,
	"base_url" text,
	"model_name" text,
	"version" text,
	"api_key_variable" text,
	"owner_id" text DEFAULT 'uv2Idd2BF6VNSNjwY5IKmIeoYMKq6zXw' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_route_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"import_route_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"owner_id" text NOT NULL,
	"model_id" uuid NOT NULL,
	"date_from" timestamp with time zone,
	"date_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"original_text" text NOT NULL,
	"transformed_text" text,
	"prompt_heading" text,
	"order" integer,
	"archived" boolean DEFAULT false NOT NULL,
	"type" text
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"reviewer_id" text NOT NULL,
	"opened" boolean DEFAULT false NOT NULL,
	"reviewed_title" boolean DEFAULT false NOT NULL,
	"reviewed_title_comment" text,
	"reviewed_abstract" boolean DEFAULT false NOT NULL,
	"reviewed_abstract_comment" text,
	"reviewed_intro" boolean DEFAULT false NOT NULL,
	"reviewed_intro_comment" text,
	"reviewed_method" boolean DEFAULT false NOT NULL,
	"reviewed_method_comment" text,
	"reviewed_results" boolean DEFAULT false NOT NULL,
	"reviewed_results_comment" text,
	"reviewed_discussion" boolean DEFAULT false NOT NULL,
	"reviewed_discussion_comment" text,
	"reviewed_conclusion" boolean DEFAULT false NOT NULL,
	"reviewed_conclusion_comment" text,
	"reviewed_appendix" boolean DEFAULT false NOT NULL,
	"reviewed_appendix_comment" text,
	"reviewed_other" boolean DEFAULT false NOT NULL,
	"reviewed_other_comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_use" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" text,
	"session_id" text,
	"judgments_job_id" uuid,
	"requests" integer NOT NULL,
	"total_prompt_tokens" integer NOT NULL,
	"total_completion_tokens" integer NOT NULL,
	"total_tokens" integer NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration" integer
);
--> statement-breakpoint
CREATE TABLE "vllm_status" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"instance_id" text NOT NULL,
	"model_name" text NOT NULL,
	"vllm_version" text,
	"gpu_type" text,
	"gpu_count" integer,
	"poll_ms" integer DEFAULT 2000 NOT NULL,
	"prompt_tokens_total" bigint DEFAULT 0 NOT NULL,
	"generation_tokens_total" bigint DEFAULT 0 NOT NULL,
	"request_success_total" bigint,
	"request_error_total" bigint,
	"num_preemptions_total" bigint,
	"num_requests_waiting" integer DEFAULT 0 NOT NULL,
	"num_requests_running" integer DEFAULT 0 NOT NULL,
	"gpu_cache_usage_perc" double precision,
	"num_requests_swapped" integer,
	"prefill_tps" double precision,
	"gen_tps" double precision,
	"implied_rps" double precision,
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
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"impersonated_by" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"role" text,
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "article_route_link" ADD CONSTRAINT "article_route_link_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_route_link" ADD CONSTRAINT "article_route_link_import_route_id_import_route_id_fk" FOREIGN KEY ("import_route_id") REFERENCES "public"."import_route"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_imported_by_user_id_fk" FOREIGN KEY ("imported_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasource" ADD CONSTRAINT "datasource_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasource_access" ADD CONSTRAINT "datasource_access_datasource_id_datasource_id_fk" FOREIGN KEY ("datasource_id") REFERENCES "public"."datasource"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasource_access" ADD CONSTRAINT "datasource_access_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasource_route_link" ADD CONSTRAINT "datasource_route_link_datasource_id_datasource_id_fk" FOREIGN KEY ("datasource_id") REFERENCES "public"."datasource"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasource_route_link" ADD CONSTRAINT "datasource_route_link_import_route_id_import_route_id_fk" FOREIGN KEY ("import_route_id") REFERENCES "public"."import_route"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judgment_assessments" ADD CONSTRAINT "judgment_assessments_judgment_id_judgments_id_fk" FOREIGN KEY ("judgment_id") REFERENCES "public"."judgments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judgment_assessments" ADD CONSTRAINT "judgment_assessments_assessed_by_user_id_fk" FOREIGN KEY ("assessed_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judgments" ADD CONSTRAINT "judgments_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judgments" ADD CONSTRAINT "judgments_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judgments" ADD CONSTRAINT "judgments_prompt_id_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."prompts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judgments" ADD CONSTRAINT "judgments_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judgments_jobs" ADD CONSTRAINT "judgments_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judgments_jobs_articles" ADD CONSTRAINT "judgments_jobs_articles_job_id_judgments_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."judgments_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judgments_jobs_articles" ADD CONSTRAINT "judgments_jobs_articles_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_access" ADD CONSTRAINT "model_access_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_access" ADD CONSTRAINT "model_access_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "models" ADD CONSTRAINT "models_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_route_link" ADD CONSTRAINT "project_route_link_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_route_link" ADD CONSTRAINT "project_route_link_import_route_id_import_route_id_fk" FOREIGN KEY ("import_route_id") REFERENCES "public"."import_route"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_reviewer_id_user_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_use" ADD CONSTRAINT "token_use_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_use" ADD CONSTRAINT "token_use_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_use" ADD CONSTRAINT "token_use_judgments_job_id_judgments_jobs_id_fk" FOREIGN KEY ("judgments_job_id") REFERENCES "public"."judgments_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "article_route_link_unique" ON "article_route_link" USING btree ("article_id","import_route_id");--> statement-breakpoint
CREATE INDEX "article_route_link_article_idx" ON "article_route_link" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX "article_route_link_route_idx" ON "article_route_link" USING btree ("import_route_id");--> statement-breakpoint
CREATE INDEX "articles_article_created_created_id_idx" ON "articles" USING btree ("article_created_at","created_at","id");--> statement-breakpoint
CREATE INDEX "articles_created_idx" ON "articles" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "articles_article_updated_idx" ON "articles" USING btree ("article_updated_at");--> statement-breakpoint
CREATE INDEX "articles_import_route_article_created_idx" ON "articles" USING btree ("import_route","article_created_at");--> statement-breakpoint
CREATE INDEX "datasource_owner_idx" ON "datasource" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "datasource_access_datasource_idx" ON "datasource_access" USING btree ("datasource_id");--> statement-breakpoint
CREATE INDEX "datasource_access_user_idx" ON "datasource_access" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "datasource_route_link_unique" ON "datasource_route_link" USING btree ("datasource_id","import_route_id");--> statement-breakpoint
CREATE INDEX "datasource_route_link_datasource_idx" ON "datasource_route_link" USING btree ("datasource_id");--> statement-breakpoint
CREATE INDEX "datasource_route_link_route_idx" ON "datasource_route_link" USING btree ("import_route_id");--> statement-breakpoint
CREATE UNIQUE INDEX "import_route_route_unique" ON "import_route" USING btree ("route");--> statement-breakpoint
CREATE INDEX "import_route_active_idx" ON "import_route" USING btree ("active");--> statement-breakpoint
CREATE INDEX "judgments_article_prompt_idx" ON "judgments" USING btree ("article_id","prompt_id");--> statement-breakpoint
CREATE INDEX "judgments_article_prompt_answered_idx" ON "judgments" USING btree ("article_id","prompt_id","answered_original");--> statement-breakpoint
CREATE INDEX "judgments_prompt_article_idx" ON "judgments" USING btree ("prompt_id","article_id");--> statement-breakpoint
CREATE INDEX "judgments_jobs_project_idx" ON "judgments_jobs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "judgments_jobs_articles_job_idx" ON "judgments_jobs_articles" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "judgments_jobs_articles_job_status_idx" ON "judgments_jobs_articles" USING btree ("job_id","status");--> statement-breakpoint
CREATE INDEX "model_access_model_idx" ON "model_access" USING btree ("model_id");--> statement-breakpoint
CREATE INDEX "model_access_user_idx" ON "model_access" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "models_owner_idx" ON "models" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_route_link_unique" ON "project_route_link" USING btree ("project_id","import_route_id");--> statement-breakpoint
CREATE INDEX "project_route_link_project_idx" ON "project_route_link" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_route_link_route_idx" ON "project_route_link" USING btree ("import_route_id");--> statement-breakpoint
CREATE INDEX "prompts_project_idx" ON "prompts" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "token_use_job_created_idx" ON "token_use" USING btree ("judgments_job_id","created_at");--> statement-breakpoint
CREATE INDEX "vllm_status_ts_idx" ON "vllm_status" USING btree ("ts");--> statement-breakpoint
CREATE UNIQUE INDEX "vllm_status_instance_ts_idx" ON "vllm_status" USING btree ("instance_id","ts");--> statement-breakpoint
CREATE INDEX "vllm_status_model_ts_idx" ON "vllm_status" USING btree ("model_name","ts");