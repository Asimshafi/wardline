-- 0011_wh_cleanup.sql
-- The notify pipeline is verified end-to-end (cases INSERT → 0008 trigger → notify-on-case →
-- Telegram → notifications_sent 'sent'). Remove the temporary helpers from 0009/0010 — they were
-- only for diagnosing and setting the webhook secret. The 0008 trigger and the Vault secret stay.
drop function if exists public.__wh_diag();
drop function if exists public.__set_wh_secret(text);
