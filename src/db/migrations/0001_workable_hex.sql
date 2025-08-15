CREATE TABLE "judgement_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"judgement_id" uuid NOT NULL,
	"assessed_by" text NOT NULL,
	"assessment_is_correct" boolean NOT NULL,
	"assessment_comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "judgements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
ALTER TABLE "prompts" ADD COLUMN "type" text;--> statement-breakpoint
ALTER TABLE "judgement_assessments" ADD CONSTRAINT "judgement_assessments_judgement_id_judgements_id_fk" FOREIGN KEY ("judgement_id") REFERENCES "public"."judgements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judgement_assessments" ADD CONSTRAINT "judgement_assessments_assessed_by_user_id_fk" FOREIGN KEY ("assessed_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judgements" ADD CONSTRAINT "judgements_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judgements" ADD CONSTRAINT "judgements_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_reviewer_id_user_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_article_id_unique" UNIQUE("article_id");