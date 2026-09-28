-- The retention mark only tracked the flag-gated row-level retention cleanup. The projector worker now purges failed
-- and retired snapshots one snapshot at a time and keeps no marks.
DROP TABLE IF EXISTS app.review_serving_retention_mark;

-- Empty copies left behind by July startup repairs that swapped a table outside a transaction.
DROP TABLE IF EXISTS mart."review_article_filter_posting_serving_v4_startup_repair_2026_07_20T04_51_01_138Z_8ad6f4ba_e26d_4495_a08b_362903bcbd67";
DROP TABLE IF EXISTS mart."review_article_judgment_detail_serving_v4_startup_repair_2026_07_09T07_52_46_601Z_0e39cf75_887e_4221_ad44_e67c5e6f9af5";
DROP TABLE IF EXISTS mart."review_article_serving_v4_startup_repair_2026_07_09T07_59_40_396Z_3e972f40_3065_4a53_8f71_ca5c10946a85";
DROP TABLE IF EXISTS mart."review_article_serving_v4_startup_repair_2026_07_09T08_01_49_917Z_917ddde6_a7e7_4c85_a5fe_a48cab7435a1";
