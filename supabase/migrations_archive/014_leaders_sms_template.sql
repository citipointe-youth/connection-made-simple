-- 014: Custom SMS template per leader (call-sheet "Message Custom" option).
-- "<first name>" in the template is substituted with the recipient's first
-- name at send time (SPA-side); null means no custom template configured.

alter table leaders add column sms_template text;
