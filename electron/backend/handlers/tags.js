'use strict';

// Tags routes: the tag vocabulary the Transactions page draws from and manages.
// A transaction picks its one tag with tag_id on the transaction routes; these
// routes create, rename, merge and delete the tags themselves.
//
//   GET    /api/tags                      every tag with its transaction count
//   POST   /api/tags                      { name } → a new tag
//   PUT    /api/tags/<id>                 { name } → rename
//   POST   /api/tags/<id>/merge           { into } → move its rows, then delete it
//   DELETE /api/tags/<id>                 untag its rows, then delete it
//
// Names are unique ignoring case (services/tags.js), so creating or renaming
// onto a name another tag already holds is a 409. Folding one tag into another
// is a merge, a separate and explicit request.

const { bad } = require('../validate');
const {
  MAX_TAG_NAME_LEN,
  cleanTagName,
  serialiseTag,
  listTags,
  getTag,
  findTagByName,
} = require('../services/tags');

const NAME_ERROR = `name must be 1 to ${MAX_TAG_NAME_LEN} characters`;

function requireTag(db, id) {
  const tag = getTag(db, id);
  if (!tag) bad('not found', 404);
  return tag;
}

function list(ctx) {
  const db = ctx.db();
  const counts = new Map(
    db.prepare('SELECT tag_id, COUNT(*) AS n FROM transactions WHERE tag_id IS NOT NULL GROUP BY tag_id')
      .all()
      .map((r) => [r.tag_id, r.n])
  );
  return {
    tags: listTags(db).map((t) => ({ ...serialiseTag(t), transactions: counts.get(t.id) || 0 })),
  };
}

function create(ctx, { body }) {
  const db = ctx.db();
  const name = cleanTagName((body || {}).name);
  if (!name) bad(NAME_ERROR);
  if (findTagByName(db, name)) bad('tag already exists', 409);
  const id = db.prepare('INSERT INTO tags (name) VALUES (?)').run(name).lastInsertRowid;
  return { ok: true, tag: serialiseTag(getTag(db, id)) };
}

function rename(ctx, { params, body }) {
  const db = ctx.db();
  const tag = requireTag(db, params.tag_id);
  const name = cleanTagName((body || {}).name);
  if (!name) bad(NAME_ERROR);
  // A change of case alone is still this tag; any other holder is a clash.
  const holder = findTagByName(db, name);
  if (holder && holder.id !== tag.id) bad('tag already exists', 409);
  db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(name, tag.id);
  return { ok: true, tag: serialiseTag({ id: tag.id, name }) };
}

function merge(ctx, { params, body }) {
  const db = ctx.db();
  const from = requireTag(db, params.tag_id);
  const intoId = (body || {}).into;
  if (!Number.isInteger(intoId)) bad('into must be a tag id');
  if (intoId === from.id) bad('a tag cannot be merged into itself');
  const into = getTag(db, intoId);
  if (!into) bad('unknown into', 404);
  const moved = db.transaction(() => {
    const n = db.prepare('UPDATE transactions SET tag_id = ? WHERE tag_id = ?').run(into.id, from.id).changes;
    db.prepare('DELETE FROM tags WHERE id = ?').run(from.id);
    return n;
  })();
  return { ok: true, moved, tag: serialiseTag(into) };
}

function remove(ctx, { params }) {
  const db = ctx.db();
  const tag = requireTag(db, params.tag_id);
  const cleared = db.transaction(() => {
    const n = db.prepare('UPDATE transactions SET tag_id = NULL WHERE tag_id = ?').run(tag.id).changes;
    db.prepare('DELETE FROM tags WHERE id = ?').run(tag.id);
    return n;
  })();
  return { ok: true, cleared };
}

const routes = [
  ['GET', '/api/tags', list],
  ['POST', '/api/tags', create],
  ['PUT', '/api/tags/<int:tag_id>', rename],
  ['POST', '/api/tags/<int:tag_id>/merge', merge],
  ['DELETE', '/api/tags/<int:tag_id>', remove],
];

module.exports = { routes };
