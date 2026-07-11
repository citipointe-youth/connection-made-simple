-- Seeds the ministry user accounts with a shared default (bootstrap-only)
-- password. Consolidates archived migrations 002 + 005 + the relevant part
-- of 017 (must_change_password is now set inline here instead of a separate
-- email-matching UPDATE pass over both legacy naming conventions).
--
-- Login identities are bare usernames, not fake emails (the app already
-- treats this field as a free-form username everywhere — see CLAUDE.md's
-- "Username convention" section). Grade accounts use the CURRENT g(irls)/
-- b(oys) suffix convention directly (archived migration 005 originally used
-- f/m, later renamed) — there is no legacy f/m seed in a fresh deployment.
--
-- ON CONFLICT DO NOTHING: safe to re-run, never overwrites a changed password.
-- Do not restore a plaintext default password to this comment.
insert into users (display_name, email, role, grade, quad, status, password_hash, must_change_password)
values
  ('Admin',           'admin',     'admin',    null, null,    'active', '7759d4a2e75601f277f0b150a13face8:81288b510e9570aad85a816dbd134a48535a6d93964916e3ecf685b718ff958a', true),
  ('Director',        'director',  'director', null, null,    'active', '200d0ad2d4ed33b88089ecc8e632a813:4eb81e4e10713463c50fd123f7f3078edbe7a33536618a3b04b8c6634cd0a443', true),
  ('Girls Yr 7-9',    'g79',       'quad',     null, 'g79',   'active', 'f9baba7871f5e1b5893c61abffc7396b:17ea274458ed50db10e9379f1b1e275b7afeb2ac4aa4e373be4fecf915f7384b', true),
  ('Boys Yr 7-9',     'b79',       'quad',     null, 'b79',   'active', '71ae68769705f02c5951911760c83fa5:7617679f623efbb04b014f4a8941e8ba555ca358a873224a74fa4e1e37485627', true),
  ('Girls Yr 10-12',  'g1012',     'quad',     null, 'g1012', 'active', '30dca6e09b33ac6a8a88b48dbd0a634c:dcd6ecae81f0373c938cfcd245e30b9bf8b1def6f0b2e92db01b86c6242cdca5', true),
  ('Boys Yr 10-12',   'b1012',     'quad',     null, 'b1012', 'active', '2792547bd7060b9ae19cdac56822a008:fd28beceff2bb002c66cf788fd34e5eb24f4ec9f17b046a5158055c6d5c4d875', true),
  ('Grade 7 Girls',   'grade7g',   'grade',    7,    null,    'active', '43111ad633d059b70fa96871441cbd35:fce97c662d659c3576d3320095066596342af19db3dd6297ff8cfc43ccc9fe0c', true),
  ('Grade 7 Boys',    'grade7b',   'grade',    7,    null,    'active', '0e78d8f1d63e30a34a0890ddce904073:abf64f7420261e2bbf6b38b7df73955b7d06820e2d61062402386498d85f12b2', true),
  ('Grade 8 Girls',   'grade8g',   'grade',    8,    null,    'active', '620258b70a0c0ea7168510e8aec6e000:8fe0626d9d1ade5a40bdd2608c475747b2dd2056908f88b8b108f928337ba617', true),
  ('Grade 8 Boys',    'grade8b',   'grade',    8,    null,    'active', '5c11846a9e318bdbd1204545d9bb6a37:0468e5dc5f0f5fd0ff19e0ba1a4900615b75a5f4eef85084d717d9e16cb124b1', true),
  ('Grade 9 Girls',   'grade9g',   'grade',    9,    null,    'active', '1fb875304832f0c0e1d119fee2e23be2:5cb771d40352d14b5b92c44ca08d6d385b9d72d31802dd52c628a894caff1e9b', true),
  ('Grade 9 Boys',    'grade9b',   'grade',    9,    null,    'active', 'd6c84e8531ef77c1015a6f3b06f3d8ed:f1c305b33e7225b1cc7f360c75c86809287a53af92150ab9a358affc9579eb8c', true),
  ('Grade 10 Girls',  'grade10g',  'grade',    10,   null,    'active', 'd8a2b028bdd74149f2b62ecf76cf7a5b:c8e3b768203cf85417f174fc69e8447e5e6da8e0eb053a201062ad22f1663ebc', true),
  ('Grade 10 Boys',   'grade10b',  'grade',    10,   null,    'active', '6db16dec0dfe389f0de7c0bfd72b38d0:4f2f4fb13ba867ac4416f78d7b83e9cb1f0d028bef70dd9cb297c14b60440cc2', true),
  ('Grade 11 Girls',  'grade11g',  'grade',    11,   null,    'active', 'f67f7614d10a81f3e50aa1a4d5d1c18a:ee96290cb7b90db0fafcd82b330f90a5ed2ccf9ce38205ccae470c8a69525a68', true),
  ('Grade 11 Boys',   'grade11b',  'grade',    11,   null,    'active', '90d85f42c4c74de5642f078b689b670e:29d33af8e50a45d3a87c576d2260012a6a3f0aa2019ae95dc9b6bc71897b4b7f', true),
  ('Grade 12 Girls',  'grade12g',  'grade',    12,   null,    'active', '69674658b88ff310301b76dfa8b0efa2:d8e7fdaf66d1c2285f7a1b3daa20b3e2c2fa76ec80d7baa4c12ae48a10b0b9e7', true),
  ('Grade 12 Boys',   'grade12b',  'grade',    12,   null,    'active', 'a0b88a7bd1acc523d901778a375232c9:de331842d8570f777ce40ecba067a2b36ae39849888225de1d9ae529f76af88b', true)
on conflict (email) do nothing;
