-- 0013_ops_verify_cleanup.sql
-- Drops the temporary production-verification RPC introduced in 0012.
--
-- scripts/prod-verify.mjs runs to completion before this is applied, and treats a 404 on
-- /rpc/__verify_ops as "SKIPPED, not failed", so the function's absence is safe for the
-- script. The RPC is gone so nothing in production can reach it.

drop function if exists public.__verify_ops();