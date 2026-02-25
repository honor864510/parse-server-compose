# parse-server-compose

## Parse Server instance for 1C ↔ Parse Server integration

This setup provides a Parse Server instance with MongoDB, Parse Dashboard, and Cloud Code for synchronizing data between **1C Enterprise** and **Parse Server**.

---

## Architecture

- **1C → Parse**: 1C pulls changes from `SyncQueue` via Cloud Functions, then confirms processed items.
- **Parse → 1C**: Parse Server generates `SyncQueue` entries automatically via Cloud Code triggers (`afterSave`, `afterDelete`) whenever tracked data changes.
- **Trigger**: Manual sync initiated from 1C side (polling on demand).

---

## Stack

| Service | Image | Port |
|---|---|---|
| MongoDB | `mongo:8.2.5` | internal |
| Parse Server | `parseplatform/parse-server:9.2.0` | `1337` |
| Parse Dashboard | `parseplatform/parse-dashboard:9.0.0` | `4040` |

---

## Project Structure

```
.
├── docker-compose.yml
├── config/
│   ├── parse-server.json
│   └── parse-dashboard.json
└── cloud/
    └── main.js           # Cloud Code: triggers + sync functions
```

---

## SyncQueue Schema

The `SyncQueue` class is the core of the sync mechanism. Parse Server populates it automatically; 1C only reads from it and confirms processed entries.

| Field | Type | Description |
|---|---|---|
| `objectId` | String | Parse auto-generated ID |
| `targetObjectId` | String | `objectId` of the changed Parse object |
| `targetClass` | String | Class name of the changed object |
| `actionType` | Number | `1` = CREATE, `2` = UPDATE, `3` = DELETE |
| `status` | Number | `0` = pending, `1` = processing, `2` = done |
| `priority` | Number | `1` = header table, `2` = line items (`*_Items` tables) |
| `externalId` | String | GUID from 1C — snapshot stored at write time, critical for DELETE |
| `createdAt` | Date | Parse auto-managed |
| `updatedAt` | Date | Parse auto-managed — updated on deduplication, used for ordering |

### Deduplication Rules

When an object changes, Cloud Code checks for an existing `SyncQueue` entry for that `targetObjectId`:

- **Existing entry is `pending` (0)** → update `updatedAt` only, no new entry
- **Existing entry is `processing` (1)** → create a new `pending` entry (change arrived mid-batch)
- **Existing entry is `done` (2)** → create a new `pending` entry
- **No existing entry** → create a new `pending` entry

### Class Filtering

Only public classes are tracked. Classes whose names begin with `_` (e.g. `_User`, `_Session`) are excluded from sync.

Triggers are registered **dynamically at startup** by fetching the full Parse schema via `Parse.Schema.all()`. If you add a new public class, restart the Parse Server container to pick it up.

---

## Preventing Sync Loops

When 1C pushes data into Parse tables directly, `afterSave`/`afterDelete` triggers would normally fire and create a `SyncQueue` entry — which 1C would then redundantly pull back.

To prevent this, 1C must pass `syncSource: "1C"` in the request context when writing to Parse. Cloud Code checks for this flag and skips enqueueing.

### How to pass context from 1C

Use a Cloud Function when writing objects from 1C, passing the context field:

```
POST /parse/functions/saveObject
X-Parse-Application-Id: myAppId
X-Parse-REST-API-Key: 123
Content-Type: application/json

{
  "className": "Product",
  "data": { "externalId": "some-guid", "name": "Widget" },
  "context": { "syncSource": "1C" }
}
```

Or from within any Cloud Function triggered by 1C:

```js
await obj.save(null, {
  useMasterKey: true,
  context: { syncSource: "1C" }
});
```

> **Important:** Direct REST `PUT /parse/classes/ClassName/:id` calls do **not** support context. Always go through a Cloud Function when 1C needs to write data, so context can be forwarded correctly.

---

## Cloud Functions

### `fetchSyncBatch`

Called by 1C to retrieve the next batch of changes.

- Returns up to **1000** `pending` entries
- Sorted by `priority` ASC, then `updatedAt` ASC (FIFO within priority)
- Marks returned entries as `processing` (status `1`)
- Response is JSON; 1C should send `Accept-Encoding: gzip` for ~50–80 KB compressed batches

**Request:** no parameters required

**Response:**
```json
[
  {
    "objectId": "SyncQueue objectId — use this to confirm",
    "targetObjectId": "...",
    "targetClass": "...",
    "actionType": 1,
    "externalId": "GUID",
    "priority": 1,
    "updatedAt": "..."
  }
]
```

---

### `confirmSyncBatch`

Called by 1C after it has stored the batch locally.

- Accepts an array of `SyncQueue` `objectId`s
- Marks them as `done` (status `2`)
- Done entries are kept for audit and cleaned up manually or by schedule

**Request:**
```json
{
  "ids": ["objectId1", "objectId2", "..."]
}
```

**Response:**
```json
{ "updated": 42 }
```

---

## Sync Flow

```
1C                            Parse Server
 |                                 |
 |--- fetchSyncBatch() ----------->|
 |<-- [{objectId, targetClass,     |
 |      actionType, externalId}]---|
 |                                 |
 | (store batch locally in 1C DB)  |
 |                                 |
 |--- confirmSyncBatch([ids]) ---->|
 |<-- { updated: N } --------------|
```

---

## Security

### SyncQueue Access Control

All writes to `SyncQueue` go exclusively through Cloud Code using `masterKey`, so no client needs write access. The class-level permissions (CLP) reflect this:

| Operation | Access |
|---|---|
| `find` / `count` / `get` | `role:sync-agent` only |
| `create` / `update` / `delete` / `addField` | nobody (locked) |

### Setting up the `sync-agent` role

Do this once in Parse Dashboard or via the REST API:

**1. Create the role** — Dashboard → Roles → `+` → name it `sync-agent`

**2. Create the 1C user** — Dashboard → Users → `+`:
- Username: `1c-integration` (or whatever you prefer)
- Password: a strong secret

**3. Assign the user to the role** — Dashboard → Roles → `sync-agent` → Users → add `1c-integration`

**4. Apply the schema** — import `SyncQueue.json` via Dashboard → Schema → Import, or via REST:

```
<!-- OR "PUT" -->
curl -X POST http://192.168.1.73:1337/parse/schemas/SyncQueue \
  -H "X-Parse-Application-Id: myAppId" \
  -H "X-Parse-Master-Key: myMasterKey" \
  -H "Content-Type: application/json" \
  -d @config/SyncQueue.json
```

### 1C authentication

1C should authenticate once per session and reuse the session token:

```
POST /parse/login
X-Parse-Application-Id: myAppId
X-Parse-REST-API-Key: 123
Content-Type: application/json

{ "username": "1c-integration", "password": "..." }
```

Response contains `sessionToken` — use it in all subsequent requests:

```
X-Parse-Session-Token: <sessionToken>
```

---

## Setup

### 1. Clone and configure

```bash
mkdir parse-server-compose && cd parse-server-compose
mkdir config cloud
```

Copy `parse-server.json` and `parse-dashboard.json` into `config/`, and your `main.js` into `cloud/`.

### 2. Start services

```bash
docker compose up -d
```

### 3. Access

- **Parse Server API**: `http://<host>:1337/parse`
- **Parse Dashboard**: `http://<host>:4040`

---

## Configuration Notes

- `allowClientClassCreation: false` — classes must be created manually or via migrations
- `masterKeyIps: ["0.0.0.0/0"]` — restrict this in production to trusted IPs only
- `PARSE_DASHBOARD_ALLOW_INSECURE_HTTP=1` — for local/internal use only; use HTTPS in production

---

## Cleanup

Done entries in `SyncQueue` accumulate over time. Clean them up manually from the Dashboard or schedule a Cloud Job:

```js
// Example Cloud Job: delete SyncQueue entries with status=2 older than 30 days
Parse.Cloud.job("cleanSyncQueue", async () => {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const query = new Parse.Query("SyncQueue");
  query.equalTo("status", 2);
  query.lessThan("updatedAt", cutoff);
  query.limit(1000);
  const results = await query.find({ useMasterKey: true });
  await Parse.Object.destroyAll(results, { useMasterKey: true });
});
```