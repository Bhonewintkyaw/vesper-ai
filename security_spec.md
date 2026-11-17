# Security Specification & Threat Model

## 1. Data Invariants
1. **Strict Ownership Isolation**: A user can only read, list, create, update, or delete their own `/users/{userId}`, `/users/{userId}/threads/{threadId}`, and `/users/{userId}/threads/{threadId}/messages/{messageId}` documents. Cross-user reads and writes are forbidden.
2. **Verified Email Mandate**: All authenticated read/write operations require `request.auth != null` and `request.auth.token.email_verified == true`.
3. **Immutable Identity & Linkage**: `uid`, `ownerId`, `threadId`, `role`, and `createdAt` cannot be modified after document creation.
4. **Master Gate Parent Integrity**: A `ChatMessage` cannot be created, updated, or deleted unless its parent `ChatThread` exists in Firestore and is owned by `request.auth.uid` (verified via `get()`).
5. **Bounded Payloads & Anti-DoS**: Every string field has strict `.size()` caps (`text <= 50000`, `systemInstruction <= 4000`, `title <= 140`), arrays are bounded (`sources <= 15`, `attachmentNames <= 5`), and all document IDs match `^[a-zA-Z0-9_\-]+$` with length `<= 128`.
6. **Temporal Integrity**: `createdAt` must equal `request.time` on creation; `updatedAt` must equal `request.time` on creation and update.
7. **Zero Shadow Fields**: `keys().hasAll(...)` and `keys().hasOnly(...)` on create, and `diff(existing()).affectedKeys().hasOnly(...)` on update, prevent unapproved or shadow fields.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Unauthenticated Read/Write**: Read `/users/u1/threads/t1` with `auth = null` -> `PERMISSION_DENIED`.
2. **Unverified Email Spoof**: Write `/users/u1` with `auth = { uid: 'u1', token: { email_verified: false } }` -> `PERMISSION_DENIED`.
3. **Cross-User Thread Read**: User `u2` reads `/users/u1/threads/t1` -> `PERMISSION_DENIED`.
4. **Cross-User List Bypass**: User `u2` queries `/users/u1/threads` -> `PERMISSION_DENIED`.
5. **Identity Spoofing on Create**: User `u1` creates `/users/u1/threads/t1` with `ownerId: 'u2'` -> `PERMISSION_DENIED`.
6. **Shadow Field Injection (UserProfile)**: User `u1` creates `/users/u1` with extra field `isAdmin: true` -> `PERMISSION_DENIED`.
7. **Shadow Field Injection on Update (Thread)**: User `u1` updates `/users/u1/threads/t1` adding `ghostField: 123` -> `PERMISSION_DENIED`.
8. **Immutable Field Mutation**: User `u1` updates `/users/u1/threads/t1` changing `createdAt` or `ownerId` -> `PERMISSION_DENIED`.
9. **Client-Forged Timestamp**: User `u1` creates `/users/u1/threads/t1` with `createdAt: Timestamp(2020-01-01)` instead of `request.time` -> `PERMISSION_DENIED`.
10. **Path ID Poisoning**: User `u1` creates `/users/u1/threads/invalid$id!with.bad.chars` -> `PERMISSION_DENIED`.
11. **Orphan Message Write**: User `u1` creates `/users/u1/threads/nonexistent/messages/m1` -> `PERMISSION_DENIED` (blocked by parent `get()`).
12. **Unbounded Array / Payload Exhaustion**: User `u1` creates a message with `sources` having 20 items (`> 15`) or `text` exceeding 50,000 chars -> `PERMISSION_DENIED`.
