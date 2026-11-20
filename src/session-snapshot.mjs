// Bounded, read-only transcript snapshots. These rows are mutable; a pagination
// cursor is not an event cursor and cannot detect later updates to earlier rows.
import { withDb } from "./store.mjs";

const MAX_CONTENT_BYTES = 8192;

export function readSessionParts(db, { taskId, after = "", limit = 25, includeContent = false }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("limit must be between 1 and 50");
  const exists = db.prepare("select 1 from session where id = ?").get(taskId);
  if (!exists) throw new Error("No such ZCode session");
  const rows = db.prepare(`
    select p.id, p.message_id, p.sequence, p.time_created, p.time_updated,
           json_extract(p.data, '$.type') as type,
           json_extract(p.data, '$.tool') as tool,
           json_extract(p.data, '$.callID') as call_id,
           json_extract(p.data, '$.state.status') as tool_status,
           length(cast(p.data as blob)) as content_bytes,
           case when ? and length(cast(p.data as blob)) <= ? then p.data end as content
      from part p join message m on m.id = p.message_id and m.session_id = p.session_id
     where p.session_id = ? and p.id > ?
       and json_extract(m.data, '$.role') = 'assistant'
       and json_extract(p.data, '$.type') in ('text', 'tool')
     order by p.id limit ?
  `).all(includeContent ? 1 : 0, MAX_CONTENT_BYTES, taskId, after, limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    taskId,
    source: "sqlite.part",
    semantics: "mutable_snapshot",
    note: "Pagination is by part ID, not chronology or an event cursor; updates to earlier parts can be missed. Re-read from the start for a fresh snapshot.",
    parts: page.map(({ content, content_bytes, call_id, tool_status, ...row }) => ({
      ...row,
      callId: call_id,
      toolStatus: tool_status,
      contentBytes: content_bytes,
      ...(includeContent && content !== null ? { content: JSON.parse(content) } : {}),
      ...(includeContent && content === null ? { contentOmitted: "exceeds 8192 bytes" } : {}),
    })),
    nextAfter: hasMore ? page.at(-1).id : null,
  };
}

export function sessionParts(options) {
  return withDb((db) => readSessionParts(db, options));
}

// Content is the UTF-8 encoded JSON of one part. A version check detects normal
// updates between pages; millisecond timestamps cannot prove byte identity.
export function readSessionPartContent(db, { taskId, partId, offset = 0, limit = 8192, expected }) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset === Number.MAX_SAFE_INTEGER) throw new Error("offset must be a nonnegative safe integer");
  if (!Number.isInteger(limit) || limit < 1 || limit > 8192) throw new Error("limit must be between 1 and 8192");
  if (offset > 0 && !expected) throw new Error("expected version is required after offset 0");
  const row = db.prepare(`
    select p.time_updated, length(cast(p.data as blob)) as content_bytes,
           substr(cast(p.data as blob), ?, ?) as content
      from part p join message m on m.id = p.message_id and m.session_id = p.session_id
     where p.session_id = ? and p.id = ? and json_extract(m.data, '$.role') = 'assistant'
       and json_extract(p.data, '$.type') in ('text', 'tool')
  `).get(offset + 1, limit, taskId, partId);
  if (!row) throw new Error("No such assistant text or tool part in this session");
  if (expected && (expected.updatedAt !== row.time_updated || expected.contentBytes !== row.content_bytes))
    throw new Error("Part changed while reading; restart from offset 0");
  if (offset > row.content_bytes) throw new Error("offset exceeds content length");
  const bytes = Buffer.from(row.content ?? []);
  const next = offset + bytes.length;
  return { taskId, partId, source: "sqlite.part", semantics: "mutable_snapshot", encoding: "base64",
    version: { updatedAt: row.time_updated, contentBytes: row.content_bytes }, offset,
    content: bytes.toString("base64"), nextOffset: next < row.content_bytes ? next : null,
    note: "Pass version as expected on later pages. Same-millisecond, same-length updates may not be detected." };
}

export function sessionPartContent(options) {
  return withDb((db) => readSessionPartContent(db, options));
}
