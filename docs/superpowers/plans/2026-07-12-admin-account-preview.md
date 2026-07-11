# Admin Account Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin click "Preview" on any active grade/quad account (Admin → Accounts) and be
dropped into a real, fully-functional session as that account — same nav, same server-side RBAC
scoping, real reads and writes — with an amber banner and Exit button to return to their own
admin session.

**Architecture:** Reuse the existing `AuthService.issueTokenFor` token-minting (adding an optional
actor-override param) behind a new admin-only `POST /accounts/users/:id/preview` endpoint that
validates the target is an active grade/quad account and mints it a real session token. The
frontend swaps its stored token + `S.user` to the previewed account (stashing the admin's own
session so Exit can restore it), clears the client cache, and rebuilds the persistent shell —
which already derives nav/role-badge purely from `S.user`, so no scoping logic is duplicated
client-side.

**Tech Stack:** TypeScript/Express backend (`src/`), vitest for tests, vanilla-JS SPA in
`public/index.html` (no build step, no frontend test framework — verified via `node --check` on
the extracted inline script).

## Global Constraints

- No write-blocking, no audit logging, no confirmation modal before entering preview — decided
  explicitly during brainstorming (see
  `docs/superpowers/specs/2026-07-12-admin-account-preview-design.md`).
- Only `grade`/`quad` roles, and only `status: 'active'` accounts, get a Preview button.
- No new DB table, no migration.
- Follow this repo's existing service/controller/route conventions exactly (see Task file
  references below) rather than introducing new patterns.
- Do not perform browser verification — the user will test that themselves. Verify backend
  changes with `npm run typecheck` + `npm run test`; verify the frontend change by extracting the
  inline `<script>` and running `node --check` on it (no browser).

---

### Task 1: `AuthService.issueTokenFor` — optional actor overrides

**Files:**
- Modify: `src/services/auth.service.ts:94-105` (interface), `src/services/auth.service.ts:147-151` (implementation)
- Test: `src/tests/auth.service.test.ts`

**Interfaces:**
- Consumes: nothing new (existing `signSession`, `toActor`, `IUserRepository`).
- Produces: `issueTokenFor(userId: string, actorOverrides?: Partial<Actor>): Promise<string | null>`
  — same as before when called with one argument; when a second argument is passed, the returned
  token's embedded `Actor` has those fields overridden. Task 3 depends on this exact signature.

- [ ] **Step 1: Write the failing test**

Add to `src/tests/auth.service.test.ts`, inside the existing `describe('Auth Service —
mustChangePassword in the session', ...)` block (after the existing `'issueTokenFor returns null
for a missing or inactive user'` test, before the closing `});` of the describe block):

```ts
  it('issueTokenFor applies actorOverrides on top of the DB state', async () => {
    const { users, auth } = await seedUser(true); // mustChangePassword: true in the DB
    const token = await auth.issueTokenFor('u-1', { mustChangePassword: false });
    expect(token).not.toBeNull();
    const actor = await auth.resolveToken(token!);
    expect(actor?.mustChangePassword).toBe(false);
    // The override is token-only — it must not have touched the DB record.
    const stored = await users.findById('u-1');
    expect(stored?.mustChangePassword).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/auth.service.test.ts`
Expected: FAIL — `issueTokenFor` currently only accepts one argument, so the override is
silently ignored and `actor?.mustChangePassword` is `true`, not `false`.

- [ ] **Step 3: Implement the minimal change**

In `src/services/auth.service.ts`, update the interface (around line 104):

```ts
  // Mint a fresh session token from the user's CURRENT DB state. Needed after
  // any change that flips a claim baked into the token at login (right now:
  // mustChangePassword) — resolveToken() trusts the token's embedded actor and
  // never re-reads the DB, so without this the old token keeps enforcing the
  // stale claim for the rest of its 12h TTL. Returns null if the user no
  // longer exists/is inactive. `actorOverrides` layers additional fields onto
  // the freshly-derived actor before signing (used by the admin account-
  // preview feature to force mustChangePassword:false on a minted token
  // without touching the target account's real DB state).
  issueTokenFor(userId: string, actorOverrides?: Partial<Actor>): Promise<string | null>;
```

Update the implementation (around line 147-151):

```ts
    async issueTokenFor(userId: string, actorOverrides?: Partial<Actor>) {
      const user = await users.findById(userId);
      if (!user || user.status !== 'active') return null;
      const actor = actorOverrides ? { ...toActor(user), ...actorOverrides } : toActor(user);
      return signSession(actor, Date.now() + TOKEN_TTL_MS);
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tests/auth.service.test.ts`
Expected: PASS (all tests in the file, including the new one).

- [ ] **Step 5: Commit**

```bash
git add src/services/auth.service.ts src/tests/auth.service.test.ts
git commit -m "feat: allow issueTokenFor to override actor fields on the minted token"
```

---

### Task 2: `AccountService.previewAccount`

**Files:**
- Modify: `src/services/account.service.ts:63-81` (interface), insert new method after
  `toggleStatus` (currently `src/services/account.service.ts:214-230`, before `remove` at line 232)
- Test: `src/tests/account.service.test.ts`

**Interfaces:**
- Consumes: `assertCan` from `./access-control` (already imported), `NotFoundError`,
  `BadRequestError` from `../core/errors/app-error` (already imported), the closure's `users:
  IUserRepository` and local `toSafe(u: User): SafeUser` helper (both already defined in this
  file).
- Produces: `previewAccount(actor: Actor, id: string): Promise<SafeUser>`. Task 3's controller
  calls this, then separately calls `auth.issueTokenFor(user.id, { mustChangePassword: false })`
  (from Task 1) — `previewAccount` itself does NOT mint a token, it only validates and returns
  the target account.

- [ ] **Step 1: Write the failing tests**

Add to `src/tests/account.service.test.ts`. First, extend the existing imports at the top of the
file (`NotFoundError` and `ForbiddenError` are not yet imported there):

```ts
import { BadRequestError, UnauthorizedError, NotFoundError, ForbiddenError } from '../core/errors/app-error';
```

Then add a new describe block at the end of the file:

```ts
describe('Account Service — previewAccount()', () => {
  async function buildPreviewFixtures() {
    const users = new InMemoryUserRepository();
    await users.init();
    const now = new Date().toISOString();
    const mk = (over: Partial<Parameters<typeof users.save>[0]>) => users.save({
      id: over.id!, displayName: over.displayName!, email: over.email!, role: over.role!,
      grade: over.grade ?? null, quad: over.quad ?? null, status: over.status ?? 'active',
      passwordHash: 'x', mustChangePassword: over.mustChangePassword ?? false,
      createdAt: now, updatedAt: now,
    });
    const gradeUser = await mk({ id: 'u-grade', displayName: 'Grade 9', email: 'grade9g', role: 'grade', grade: 9 });
    const quadUser = await mk({ id: 'u-quad', displayName: 'Girls Yr 7-9', email: 'g79', role: 'quad', quad: 'g79' });
    const inactiveGrade = await mk({ id: 'u-inactive', displayName: 'Grade 10', email: 'grade10g', role: 'grade', grade: 10, status: 'inactive' });
    const directorUser = await mk({ id: 'u-director', displayName: 'Director', email: 'director', role: 'director' });
    const leaderUser = await mk({ id: 'u-leader', displayName: 'Leader', email: 'leader1', role: 'leader' });
    const settings = new InMemorySettingsRepository();
    await settings.init();
    const svc = makeAccountService(users, settings);
    return { svc, gradeUser, quadUser, inactiveGrade, directorUser, leaderUser };
  }

  it('rejects a non-admin actor', async () => {
    const { svc, gradeUser } = await buildPreviewFixtures();
    await expect(
      svc.previewAccount(actorFor('u-other-grade', 'grade'), gradeUser.id),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('404s for a missing account id', async () => {
    const { svc } = await buildPreviewFixtures();
    await expect(
      svc.previewAccount(actorFor('u-admin', 'admin'), 'no-such-id'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects an inactive account', async () => {
    const { svc, inactiveGrade } = await buildPreviewFixtures();
    await expect(
      svc.previewAccount(actorFor('u-admin', 'admin'), inactiveGrade.id),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('rejects a director account', async () => {
    const { svc, directorUser } = await buildPreviewFixtures();
    await expect(
      svc.previewAccount(actorFor('u-admin', 'admin'), directorUser.id),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('rejects a leader account', async () => {
    const { svc, leaderUser } = await buildPreviewFixtures();
    await expect(
      svc.previewAccount(actorFor('u-admin', 'admin'), leaderUser.id),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('returns a SafeUser (no passwordHash) for an active grade account', async () => {
    const { svc, gradeUser } = await buildPreviewFixtures();
    const result = await svc.previewAccount(actorFor('u-admin', 'admin'), gradeUser.id);
    expect(result.id).toBe(gradeUser.id);
    expect(result.role).toBe('grade');
    expect((result as any).passwordHash).toBeUndefined();
  });

  it('returns a SafeUser for an active quad account', async () => {
    const { svc, quadUser } = await buildPreviewFixtures();
    const result = await svc.previewAccount(actorFor('u-admin', 'admin'), quadUser.id);
    expect(result.id).toBe(quadUser.id);
    expect(result.role).toBe('quad');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/tests/account.service.test.ts`
Expected: FAIL — `svc.previewAccount` does not exist yet (TypeError / undefined is not a function).

- [ ] **Step 3: Implement the minimal change**

In `src/services/account.service.ts`, add to the `AccountService` interface (after the
`toggleStatus` line, around line 73):

```ts
  toggleStatus(actor: Actor, id: string): Promise<SafeUser>;
  // Admin-only: validates `id` is an active grade/quad account and returns it, for the
  // account-preview feature (Admin -> Accounts "Preview"). Does NOT mint a token itself —
  // the controller separately calls AuthService.issueTokenFor for that.
  previewAccount(actor: Actor, id: string): Promise<SafeUser>;
```

Add the implementation directly after the `toggleStatus` method body (after its closing `},` at
line 230, before `async remove(actor, id) {` at line 232):

```ts
    async previewAccount(actor, id) {
      assertCan(actor, 'admin:manage');
      const existing = await users.findById(id);
      if (!existing) throw new NotFoundError('Account not found');
      if (existing.status !== 'active') {
        throw new BadRequestError('Only active accounts can be previewed');
      }
      if (existing.role !== 'grade' && existing.role !== 'quad') {
        throw new BadRequestError('Only grade/quad accounts can be previewed');
      }
      return toSafe(existing);
    },

```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/tests/account.service.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add src/services/account.service.ts src/tests/account.service.test.ts
git commit -m "feat: add AccountService.previewAccount validation for the admin preview feature"
```

---

### Task 3: Controller method + route wiring

**Files:**
- Modify: `src/api/controllers/account.controller.ts:43-46` (insert `preview` method after
  `toggleStatus`)
- Modify: `src/api/http/router.ts:127` (insert new route after the `DELETE
  /accounts/users/:id` line)
- Test: `src/tests/account.controller.test.ts` (new file)

**Interfaces:**
- Consumes: `AccountService.previewAccount(actor, id): Promise<SafeUser>` (Task 2),
  `AuthService.issueTokenFor(userId, actorOverrides?): Promise<string | null>` (Task 1).
- Produces: `account.preview(req: HttpRequest): Promise<{ token: string; user: SafeUser }>`,
  wired to `POST /accounts/users/:id/preview`.

**Important correctness detail:** `previewAccount` returns the account's real DB
`mustChangePassword` value. If that's `true` (a seeded account nobody has logged into yet), the
raw value would make the *frontend* immediately show the forced-password-change gate for the
previewed account (`S.user.mustChangePassword` is checked client-side, separately from the
token). The controller must override it to `false` in the **response body**, not just in the
token, so the frontend's `S.user.mustChangePassword` reads `false` too.

- [ ] **Step 1: Write the failing test**

Create `src/tests/account.controller.test.ts`, following the stub pattern already used in
`src/tests/batch.controller.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { makeAccountController } from '../api/controllers/account.controller';
import { UnauthorizedError } from '../core/errors/app-error';
import type { Actor, SafeUser } from '../core/entities/user';
import type { HttpRequest } from '../api/http/types';

function actor(role = 'admin'): Actor {
  return { id: 'u-admin', role: role as any, displayName: 'Admin', grade: null as any, quad: null as any };
}

function req(id: string, ctx: Actor | null = actor()): HttpRequest {
  return { ctx, params: { id }, query: {}, body: undefined };
}

const targetUser: SafeUser = {
  id: 'u-grade', displayName: 'Grade 9', email: 'grade9g', role: 'grade', grade: 9 as any,
  quad: null, status: 'active', mustChangePassword: true,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

function makeStubbed() {
  const calls: { previewAccountId?: string; issueTokenForArgs?: [string, unknown] } = {};
  const deps = {
    account: {
      previewAccount: async (_actor: Actor, id: string) => { calls.previewAccountId = id; return targetUser; },
    },
    auth: {
      issueTokenFor: async (userId: string, overrides: unknown) => {
        calls.issueTokenForArgs = [userId, overrides];
        return 'fake-preview-token';
      },
    },
  } as unknown as Parameters<typeof makeAccountController>[0];
  return { ctrl: makeAccountController(deps), calls };
}

describe('account controller — preview', () => {
  it('throws UnauthorizedError with no ctx', async () => {
    const { ctrl } = makeStubbed();
    await expect(ctrl.preview(req('u-grade', null))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('delegates to account.previewAccount with the target id, then mints a token forcing mustChangePassword:false', async () => {
    const { ctrl, calls } = makeStubbed();
    await ctrl.preview(req('u-grade'));
    expect(calls.previewAccountId).toBe('u-grade');
    expect(calls.issueTokenForArgs).toEqual(['u-grade', { mustChangePassword: false }]);
  });

  it('returns the token and a user object with mustChangePassword forced false, even though the DB record has it true', async () => {
    const { ctrl } = makeStubbed();
    const result = await ctrl.preview(req('u-grade')) as { token: string; user: SafeUser };
    expect(result.token).toBe('fake-preview-token');
    expect(result.user.mustChangePassword).toBe(false);
    expect(result.user.id).toBe('u-grade');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/account.controller.test.ts`
Expected: FAIL — `ctrl.preview` does not exist.

- [ ] **Step 3: Implement the minimal change**

In `src/api/controllers/account.controller.ts`, add a new method after `toggleStatus` (after its
closing `},` at line 46, before `async remove`):

```ts
    async preview(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      const user = await deps.account.previewAccount(req.ctx, req.params['id']!);
      const token = await deps.auth.issueTokenFor(user.id, { mustChangePassword: false });
      return { token, user: { ...user, mustChangePassword: false } };
    },

```

In `src/api/http/router.ts`, add a new route after the `DELETE /accounts/users/:id` line
(currently line 127):

```ts
    { method: 'POST',   path: '/accounts/users/:id/preview',   auth: true, handler: (r) => account.preview(r) },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tests/account.controller.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full backend suite + typecheck**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run test`
Expected: all tests pass (186+ existing, plus the new ones from Tasks 1-3).

- [ ] **Step 6: Commit**

```bash
git add src/api/controllers/account.controller.ts src/api/http/router.ts src/tests/account.controller.test.ts
git commit -m "feat: add POST /accounts/users/:id/preview endpoint for admin account preview"
```

---

### Task 4: Frontend — Preview button, session swap, exit banner

**Files:**
- Modify: `public/index.html` (multiple locations, listed per step below)

**Interfaces:**
- Consumes: `POST /accounts/users/:id/preview` → `{ token: string, user: SafeUser }` (Task 3).
  Existing globals: `API` (get/post/setToken/token), `Cache` (clear), `S` (user/page/settings),
  `_shellReady`, `go(page)`, `esc()`, `icS(k)`, `toast(msg)`, `_initShell()`.
- Produces: `enterPreview(id: string)`, `exitPreview()` — global functions called from `onclick`
  handlers in the rendered HTML (same pattern as every other action in this file, e.g.
  `toggleUserStatus`, `doLogout`).

- [ ] **Step 1: Add the preview-session stash + boot-time restore**

In `public/index.html`, immediately after line 700 (`const S = { user: null, page: 'home',
settings: {} };`), add:

```js

// Preview session stash (Admin -> Accounts "Preview" feature). Non-null while the
// admin is viewing the app as a grade/quad account; holds the admin's own
// {token,user} so exitPreview() can restore it without a fresh login. Persisted to
// localStorage so a mid-preview page refresh doesn't strand the admin with no way
// back except logging out and back in.
let _previewStash = null;
try {
  const _rawPreviewStash = localStorage.getItem('yap_preview_stash');
  if (_rawPreviewStash) _previewStash = JSON.parse(_rawPreviewStash);
} catch (e) {}
```

- [ ] **Step 2: Fix the boot-time `/auth/me` refresh to not re-trigger the forced-password gate mid-preview**

`boot()` (around line 7157) re-fetches the current user from `/auth/me` on every page load,
which returns the account's raw DB `mustChangePassword` value (unlike the preview endpoint's
response, `/auth/me` has no override). Without this fix, refreshing the page mid-preview of an
account that has never logged in would incorrectly show that account's forced-password screen.

Find this block (around line 7157-7161):

```js
async function boot() {
  const token = localStorage.getItem('yap_token');
  if (token) {
    try { const user = await API.get('/auth/me'); S.user = user; } catch { API.setToken(null); }
  }
```

Replace with:

```js
async function boot() {
  const token = localStorage.getItem('yap_token');
  if (token) {
    try {
      const user = await API.get('/auth/me');
      // Mid-preview, mustChangePassword must stay forced false — /auth/me reads the
      // raw DB record, which doesn't know this is a preview session (see enterPreview()).
      S.user = _previewStash ? { ...user, mustChangePassword: false } : user;
    } catch { API.setToken(null); }
  }
```

- [ ] **Step 3: Add `enterPreview` / `exitPreview`**

Find `doDelUser` (around line 5951-5959):

```js
async function doDelUser(id) {
  try {
    await API.del(`/accounts/users/${id}`);
    Cache.del('/accounts/users');
    _adminData.users = _adminData.users.filter(u => u.id !== id);
    closeModal(); toast('Account deleted');
    renderAdminView(_adminData.settings, _adminData.users);
  } catch (e) { toast(e.message); }
}
```

Add immediately after it:

```js

// ── Admin account preview ("Preview" button, Admin -> Accounts) ──
async function enterPreview(id) {
  try {
    const res = await API.post(`/accounts/users/${id}/preview`, {});
    _previewStash = { token: API.token, user: S.user };
    try { localStorage.setItem('yap_preview_stash', JSON.stringify(_previewStash)); } catch (e) {}
    API.setToken(res.token);
    S.user = res.user;
    Cache.clear();
    _shellReady = false;
    go('home');
  } catch (e) { toast(e.message); }
}

function exitPreview() {
  if (!_previewStash) return;
  API.setToken(_previewStash.token);
  S.user = _previewStash.user;
  _previewStash = null;
  try { localStorage.removeItem('yap_preview_stash'); } catch (e) {}
  Cache.clear();
  _shellReady = false;
  go('home');
}
```

- [ ] **Step 4: Clear the stash on logout**

Find `doLogout` (around line 1610-1617):

```js
async function doLogout() {
  try { await API.post('/auth/logout', { token: API.token }); } catch {}
  API.setToken(null); S.user = null; S.page = 'home';
  _msLeader = null; _trTab = 'svc';
  _arFilter = { grade: null, gender: null };
  _bdayFilter = { grade: null, gender: null };
  render();
}
```

Replace with:

```js
async function doLogout() {
  try { await API.post('/auth/logout', { token: API.token }); } catch {}
  API.setToken(null); S.user = null; S.page = 'home';
  _msLeader = null; _trTab = 'svc';
  _arFilter = { grade: null, gender: null };
  _bdayFilter = { grade: null, gender: null };
  _previewStash = null;
  try { localStorage.removeItem('yap_preview_stash'); } catch (e) {}
  render();
}
```

- [ ] **Step 5: Add the Preview button to the Accounts screen**

Find the account row's action buttons in `renderAdminView` (around line 4595-4600):

```js
          <div class="li-right">
            <button class="btn btn-ghost btn-sm" onclick="showEditUser('${u.id}')" title="Edit account" aria-label="Edit ${esc(u.displayName)}">${icS('edit')}</button>
            <button class="btn btn-ghost btn-sm" onclick="showSetPassword('${u.id}')" title="Reset password" aria-label="Reset password for ${esc(u.displayName)}">${icS('key')}</button>
            <button class="btn btn-ghost btn-sm" ${isProtectedAdmin?'disabled':''} onclick="toggleUserStatus('${u.id}','${u.status}')" title="${lockTitle}" aria-label="${lockTitle}">${u.status==='active'?icS('lock'):icS('unlock')}</button>
            <button class="btn btn-ghost btn-sm" style="color:var(--danger)" ${isProtectedAdmin?'disabled':''} onclick="confirmDelUser('${u.id}')" title="${delTitle}" aria-label="${delTitle}">${icS('trash')}</button>
          </div>
        </div>`;
```

Replace with (inserts a Preview button after Reset Password, only for active grade/quad rows):

```js
          <div class="li-right">
            <button class="btn btn-ghost btn-sm" onclick="showEditUser('${u.id}')" title="Edit account" aria-label="Edit ${esc(u.displayName)}">${icS('edit')}</button>
            <button class="btn btn-ghost btn-sm" onclick="showSetPassword('${u.id}')" title="Reset password" aria-label="Reset password for ${esc(u.displayName)}">${icS('key')}</button>
            ${(u.role==='grade'||u.role==='quad') && u.status==='active' ? `<button class="btn btn-ghost btn-sm" onclick="enterPreview('${u.id}')" title="Preview as ${esc(u.displayName)}" aria-label="Preview as ${esc(u.displayName)}">${icS('id')}</button>` : ''}
            <button class="btn btn-ghost btn-sm" ${isProtectedAdmin?'disabled':''} onclick="toggleUserStatus('${u.id}','${u.status}')" title="${lockTitle}" aria-label="${lockTitle}">${u.status==='active'?icS('lock'):icS('unlock')}</button>
            <button class="btn btn-ghost btn-sm" style="color:var(--danger)" ${isProtectedAdmin?'disabled':''} onclick="confirmDelUser('${u.id}')" title="${delTitle}" aria-label="${delTitle}">${icS('trash')}</button>
          </div>
        </div>`;
```

- [ ] **Step 6: Add the preview banner to the persistent shell**

Find `_initShell()` (around line 1028-1051):

```js
function _initShell() {
  const u = S.user;
  if (!u) return;
  const items = navItems();
  const bn = bottomNavItems();
  const dlinks = items.map(it => `<a data-nav-page="${it.id}" onclick="go('${it.id}')">${icN(it.ic)}<span class="nav-lbl"> ${it.label}</span></a>`).join('');
  const mlinks = bn.map(it => `<a data-nav-page="${it.id}" onclick="go('${it.id}')">${icN(it.ic)}<span>${it.mbl||it.label}</span></a>`).join('');
  document.getElementById('app').innerHTML = `
    <div class="hdr">
      <div class="hdr-top">
        <div class="hdr-brand" id="hdr-brand"><span id="hdr-brand-ic">${_hdrBrandHtml()}</span><h1>${esc(appName())}</h1></div>
        <div class="hdr-meta">
          ${roleBadge(u)}
          <div class="btn-icon" onclick="doLogout()" title="Sign out" aria-label="Sign out">${icN('logout')}</div>
        </div>
      </div>
      <nav class="desk-nav">${dlinks}</nav>
    </div>
    <main id="page-main" class="pg"></main>
    <nav class="bot-nav">${mlinks}</nav>`;
  _shellReady = true;
  _positionNprog();
  _prefetch();
}
```

Replace with (adds the banner as the first child of `.hdr`, so it inherits the header's own
`position:sticky;top:0` — visible on every screen without any new positioning logic):

```js
function _previewBannerHtml(u) {
  return `<div class="preview-banner">
    <span>${icS('id')} Previewing: <strong>${esc(u.displayName)}</strong></span>
    <button class="btn btn-sm" onclick="exitPreview()">Exit Preview</button>
  </div>`;
}
function _initShell() {
  const u = S.user;
  if (!u) return;
  const items = navItems();
  const bn = bottomNavItems();
  const dlinks = items.map(it => `<a data-nav-page="${it.id}" onclick="go('${it.id}')">${icN(it.ic)}<span class="nav-lbl"> ${it.label}</span></a>`).join('');
  const mlinks = bn.map(it => `<a data-nav-page="${it.id}" onclick="go('${it.id}')">${icN(it.ic)}<span>${it.mbl||it.label}</span></a>`).join('');
  document.getElementById('app').innerHTML = `
    <div class="hdr">
      ${_previewStash ? _previewBannerHtml(u) : ''}
      <div class="hdr-top">
        <div class="hdr-brand" id="hdr-brand"><span id="hdr-brand-ic">${_hdrBrandHtml()}</span><h1>${esc(appName())}</h1></div>
        <div class="hdr-meta">
          ${roleBadge(u)}
          <div class="btn-icon" onclick="doLogout()" title="Sign out" aria-label="Sign out">${icN('logout')}</div>
        </div>
      </div>
      <nav class="desk-nav">${dlinks}</nav>
    </div>
    <main id="page-main" class="pg"></main>
    <nav class="bot-nav">${mlinks}</nav>`;
  _shellReady = true;
  _positionNprog();
  _prefetch();
}
```

- [ ] **Step 7: Add CSS for the banner and tighten the accounts-row icon gap**

Find line 169:

```css
.li-right{display:flex;align-items:center;gap:6px;flex-shrink:0}
```

Replace with:

```css
.li-right{display:flex;align-items:center;gap:4px;flex-shrink:0}
```

Find the `.lock-banner` rule (around line 339):

```css
.lock-banner{background:var(--warn-light);border:1.5px solid var(--warn);color:#92400e;padding:10px 14px;border-radius:var(--radius-sm);font-size:13px;font-weight:600;margin-bottom:12px;display:flex;align-items:center;gap:8px}
```

Add immediately after it:

```css
.preview-banner{background:var(--warn);color:#1a1200;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 12px;border-radius:var(--radius-sm);font-size:12px;font-weight:700;margin-bottom:8px}
.preview-banner .btn{background:rgba(0,0,0,.15);color:#1a1200;border:none;padding:4px 10px;font-size:11px}
```

- [ ] **Step 8: Syntax-check the SPA's inline script (no browser)**

Run:

```bash
sed -n '536,7188p' public/index.html > /tmp/cms-spa-check.js
node --check /tmp/cms-spa-check.js
rm /tmp/cms-spa-check.js
```

(Line range is approximate — first confirm the current `<script>`/`</script>` line numbers with
`grep -n "^<script>\|^</script>" public/index.html`, since earlier edits in this task shift line
numbers; use those exact line numbers instead of 536/7188 if they've moved.)

Expected: no output from `node --check` (silence = valid syntax). If it reports a
`SyntaxError`, it will include a line number relative to the extracted range — add back the
offset (the first extracted line number) to find the real line in `public/index.html`.

- [ ] **Step 9: Commit**

```bash
git add public/index.html
git commit -m "feat: add admin account preview (Preview button, session swap, exit banner)"
```

---

## Notes for whoever executes this plan

- No browser verification is expected from you — the user will test the feature themselves after
  this lands. Steps 8 in Task 4 (`node --check`) is the only frontend verification; Task 3 Step 5
  is the full backend verification.
- This plan does not touch `src/repositories/`, any migration, or `src/core/`. If any step seems
  to require touching those, stop and re-read the design doc — that would indicate a
  misunderstanding of the design, not a missing step.
