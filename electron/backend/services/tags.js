'use strict';

// Transaction tags: the rules a tag name follows and the lookups the handlers
// share. A tag is a second grouping beside the category (a trip, a project,
// "reimbursable"). Each transaction carries at most one (transactions.tag_id),
// so a report split by tag never counts the same money twice.
//
// Names are unique ignoring case: "Vacation" and "vacation" are one tag, which
// the database enforces with ix_tags_name (COLLATE NOCASE). Every lookup by
// name here uses the same collation so the code and the index agree.

// Short enough to sit in a ledger cell and on a Sankey label without wrapping.
const MAX_TAG_NAME_LEN = 30;

/** A tag name as stored: trimmed, inner runs of whitespace collapsed to one
 *  space. Returns null when the result is empty or too long. */
function cleanTagName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name || name.length > MAX_TAG_NAME_LEN) return null;
  return name;
}

function serialiseTag(row) {
  return { id: row.id, name: row.name };
}

/** Every tag, alphabetical ignoring case. */
function listTags(db) {
  return db.prepare('SELECT id, name FROM tags ORDER BY name COLLATE NOCASE, id').all();
}

function getTag(db, id) {
  return db.prepare('SELECT id, name FROM tags WHERE id = ?').get(id);
}

/** The tag named `name` ignoring case, or undefined. */
function findTagByName(db, name) {
  return db.prepare('SELECT id, name FROM tags WHERE name = ? COLLATE NOCASE').get(name);
}

module.exports = { MAX_TAG_NAME_LEN, cleanTagName, serialiseTag, listTags, getTag, findTagByName };
