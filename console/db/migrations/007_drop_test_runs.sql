-- 007_drop_test_runs.sql
-- 移除服务器页面「测试」功能（run_test action + test_runs 历史）
DROP TABLE IF EXISTS test_runs;
