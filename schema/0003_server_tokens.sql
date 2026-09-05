-- A saved server may hold an ABS access token instead of (or as well as) a
-- password. The ABS_shim "Open Pholia" hand-off signs the user in with a
-- token only — the shim never sees the password — and that is the only
-- credential we can put in the vault for them. Same AES-GCM wrapping as
-- encrypted_password. encrypted_password stays NOT NULL for the old rows;
-- token-only rows store '' there.
ALTER TABLE abs_servers ADD COLUMN encrypted_token TEXT;
