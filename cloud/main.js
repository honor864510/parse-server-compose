// cloud/main.js
// SyncQueue Cloud Code for 1C <-> Parse Server synchronization

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ACTION = { CREATE: 1, UPDATE: 2, DELETE: 3 };
const STATUS = { PENDING: 0, PROCESSING: 1, DONE: 2 };
const PRIORITY = { HEADER: 1, LINE_ITEM: 2 };
const SYNC_QUEUE_CLASS = "SyncQueue";
const BATCH_SIZE = 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true for classes that should be excluded from sync.
 * Private Parse classes start with "_".
 */
function isPrivateClass(className) {
  return className.startsWith("_") || className === SYNC_QUEUE_CLASS;
}

/**
 * Priority: classes ending with "_Items" are line items (lower priority).
 */
function getPriority(className) {
  return className.endsWith("_Items") ? PRIORITY.LINE_ITEM : PRIORITY.HEADER;
}

/**
 * Core upsert logic for SyncQueue.
 * - If a PENDING entry exists for targetObjectId → update updatedAt (touch)
 * - If a PROCESSING entry exists → create a new PENDING entry
 * - Otherwise → create a new PENDING entry
 */
async function enqueueSyncEntry({ targetObjectId, targetClass, actionType, externalId }) {
  const query = new Parse.Query(SYNC_QUEUE_CLASS);
  query.equalTo("targetObjectId", targetObjectId);
  query.containedIn("status", [STATUS.PENDING, STATUS.PROCESSING]);
  query.descending("createdAt");

  const existing = await query.first({ useMasterKey: true });

  if (existing && existing.get("status") === STATUS.PENDING) {
    // Touch the entry so updatedAt reflects the latest change time
    // Also update actionType in case it changed (e.g. CREATE then UPDATE)
    existing.set("actionType", actionType);
    if (externalId) existing.set("externalId", externalId);
    await existing.save(null, { useMasterKey: true });
    return;
  }

  // Either no entry, or existing is PROCESSING — create a new PENDING entry
  const SyncQueue = Parse.Object.extend(SYNC_QUEUE_CLASS);
  const entry = new SyncQueue();
  entry.set("targetObjectId", targetObjectId);
  entry.set("targetClass", targetClass);
  entry.set("actionType", actionType);
  entry.set("status", STATUS.PENDING);
  entry.set("priority", getPriority(targetClass));
  if (externalId) entry.set("externalId", externalId);

  await entry.save(null, { useMasterKey: true });
}

// ---------------------------------------------------------------------------
// Generic trigger registration for all tracked classes
// ---------------------------------------------------------------------------

function registerSyncTriggers(className) {
  if (isPrivateClass(className)) return;

  Parse.Cloud.afterSave(className, async (request) => {
    try {
      // Skip if the change originated from 1C to prevent sync loops
      if (request.context && request.context.syncSource === "1C") return;

      const obj = request.object;
      const isNew = request.original === undefined || request.original === null;
      const actionType = isNew ? ACTION.CREATE : ACTION.UPDATE;
      const externalId = obj.get("externalId") || null;

      await enqueueSyncEntry({
        targetObjectId: obj.id,
        targetClass: className,
        actionType,
        externalId,
      });
    } catch (err) {
      // Never block the original save — log and move on
      console.error(`[SyncQueue] afterSave error for ${className}:`, err.message);
    }
  });

  Parse.Cloud.afterDelete(className, async (request) => {
    try {
      // Skip if the change originated from 1C to prevent sync loops
      if (request.context && request.context.syncSource === "1C") return;

      const obj = request.object;
      const externalId = obj.get("externalId") || null;

      await enqueueSyncEntry({
        targetObjectId: obj.id,
        targetClass: className,
        actionType: ACTION.DELETE,
        externalId,
      });
    } catch (err) {
      console.error(`[SyncQueue] afterDelete error for ${className}:`, err.message);
    }
  });
}

// ---------------------------------------------------------------------------
// Dynamic trigger registration from Parse schema
// ---------------------------------------------------------------------------
// Runs once at startup. Fetches all existing public classes and registers
// afterSave/afterDelete triggers for each. If new classes are added,
// restart the container to pick them up.

async function registerAllTriggers() {
  try {
    const schemas = await Parse.Schema.all();
    const registered = [];

    for (const schema of schemas) {
      const className = schema.className;
      if (!isPrivateClass(className)) {
        registerSyncTriggers(className);
        registered.push(className);
      }
    }

    console.log(`[SyncQueue] Registered triggers for: ${registered.join(", ") || "(none)"}`);
  } catch (err) {
    console.error("[SyncQueue] Failed to register triggers from schema:", err.message);
  }
}

registerAllTriggers();

// ---------------------------------------------------------------------------
// Cloud Function: fetchSyncBatch
// ---------------------------------------------------------------------------
// Called by 1C to retrieve the next batch of pending changes.
// Returns up to BATCH_SIZE entries sorted by priority ASC, updatedAt ASC.
// Marks returned entries as PROCESSING.
//
// Request: no parameters
// Response: array of SyncQueue entry plain objects

Parse.Cloud.define("fetchSyncBatch", async (request) => {
  const query = new Parse.Query(SYNC_QUEUE_CLASS);
  query.equalTo("status", STATUS.PENDING);
  query.ascending("priority");
  query.addAscending("updatedAt");
  query.limit(BATCH_SIZE);

  const entries = await query.find({ useMasterKey: true });

  if (entries.length === 0) {
    return [];
  }

  // Mark all as PROCESSING
  entries.forEach((e) => e.set("status", STATUS.PROCESSING));
  await Parse.Object.saveAll(entries, { useMasterKey: true });

  return entries.map((e) => ({
    objectId: e.id,
    targetObjectId: e.get("targetObjectId"),
    targetClass: e.get("targetClass"),
    actionType: e.get("actionType"),
    status: e.get("status"),
    priority: e.get("priority"),
    externalId: e.get("externalId") || null,
    updatedAt: e.updatedAt,
  }));
});

// ---------------------------------------------------------------------------
// Cloud Function: confirmSyncBatch
// ---------------------------------------------------------------------------
// Called by 1C after it has stored the batch in its local database.
// Marks the given SyncQueue entries as DONE.
//
// Request: { ids: ["syncQueueObjectId1", "syncQueueObjectId2", ...] }
// Response: { updated: <number> }

Parse.Cloud.define("confirmSyncBatch", async (request) => {
  const ids = request.params.ids;

  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, "ids must be a non-empty array");
  }

  if (ids.length > BATCH_SIZE) {
    throw new Parse.Error(
      Parse.Error.INVALID_QUERY,
      `ids array exceeds maximum batch size of ${BATCH_SIZE}`
    );
  }

  const query = new Parse.Query(SYNC_QUEUE_CLASS);
  query.containedIn("objectId", ids);
  query.limit(BATCH_SIZE);

  const entries = await query.find({ useMasterKey: true });

  entries.forEach((e) => e.set("status", STATUS.DONE));
  await Parse.Object.saveAll(entries, { useMasterKey: true });

  return { updated: entries.length };
});

// ---------------------------------------------------------------------------
// Cloud Job: cleanSyncQueue
// ---------------------------------------------------------------------------
// Deletes DONE entries older than RETENTION_DAYS.
// Schedule via Parse Dashboard → Jobs, or trigger manually.

const RETENTION_DAYS = 30;

Parse.Cloud.job("cleanSyncQueue", async (request) => {
  const { message } = request;
  message("Starting SyncQueue cleanup...");

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const query = new Parse.Query(SYNC_QUEUE_CLASS);
  query.equalTo("status", STATUS.DONE);
  query.lessThan("updatedAt", cutoff);
  query.limit(BATCH_SIZE);

  let totalDeleted = 0;
  let batch;

  // Loop in case there are more than BATCH_SIZE done entries
  do {
    batch = await query.find({ useMasterKey: true });
    if (batch.length > 0) {
      await Parse.Object.destroyAll(batch, { useMasterKey: true });
      totalDeleted += batch.length;
      message(`Deleted ${totalDeleted} entries so far...`);
    }
  } while (batch.length === BATCH_SIZE);

  message(`Done. Total deleted: ${totalDeleted}`);
});