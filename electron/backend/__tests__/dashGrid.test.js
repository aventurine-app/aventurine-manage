'use strict';

// The Dashboard's layout engine (static/js/widgets/dashgrid.js). The rules a
// user feels without being told: a card stays where it is put and nothing
// floats up into the space it left, a card it lands on is pushed down rather
// than aside, a dragged card settles below a neighbour once it passes that
// neighbour's middle, a resize pushes only what it now covers, and a new card
// takes the highest open spot, holes included.

const test = require('node:test');
const assert = require('node:assert');

const DashGrid = require('../../../static/js/widgets/dashgrid.js');

const card = (id, x, y, w, h) => ({ id, x, y, w, h });
/** Positions keyed by id, for readable assertions. */
const at = (cards) => Object.fromEntries(cards.map((c) => [c.id, [c.x, c.y, c.w, c.h]]));

test('grid: stack drops each card onto the skyline of its columns', () => {
  const out = DashGrid.stack([card('a', 0, 5, 4, 3), card('b', 4, 9, 4, 2), card('c', 0, 0, 8, 2)]);
  // a and b rise to the top; c lands under the taller of the two columns it spans.
  assert.deepStrictEqual(at(out), { a: [0, 0, 4, 3], b: [4, 0, 4, 2], c: [0, 3, 8, 2] });
});

test('grid: a card past the edge is pulled in, and one wider than the grid is narrowed', () => {
  const out = DashGrid.stack([card('a', 10, 0, 4, 2), card('b', 0, 0, 20, 2)]);
  assert.deepStrictEqual(at(out), { a: [8, 0, 4, 2], b: [0, 2, 12, 2] });
});

test('grid: settle keeps holes and only clears overlaps; the input is never mutated', () => {
  const layout = [card('a', 0, 3, 4, 3), card('b', 4, 6, 4, 2), card('c', 2, 4, 4, 2), card('d', 10, 0, 4, 1)];
  const copy = JSON.parse(JSON.stringify(layout));
  assert.deepStrictEqual(at(DashGrid.settle(layout)),
    { a: [0, 3, 4, 3], c: [2, 6, 4, 2], b: [4, 8, 4, 2], d: [8, 0, 4, 1] });
  DashGrid.arrangeMove(layout, { ...layout[0], x: 6, y: 5 });
  assert.deepStrictEqual(layout, copy);
});

test('grid: a moved card stays where it is dropped and nothing floats up after it', () => {
  const layout = [card('a', 0, 0, 4, 4), card('b', 4, 0, 4, 4), card('c', 0, 4, 4, 4)];
  const out = DashGrid.arrangeMove(layout, { ...layout[0], x: 8, y: 6 });
  assert.deepStrictEqual(at(out), { a: [8, 6, 4, 4], b: [4, 0, 4, 4], c: [0, 4, 4, 4] });
});

test('grid: a dragged card pushes the card below until it passes its middle, then settles under it', () => {
  const layout = [card('a', 0, 0, 4, 4), card('b', 0, 4, 4, 4)];
  assert.deepStrictEqual(at(DashGrid.arrangeMove(layout, { ...layout[0], y: 1 })), { a: [0, 1, 4, 4], b: [0, 5, 4, 4] });
  assert.deepStrictEqual(at(DashGrid.arrangeMove(layout, { ...layout[0], y: 4 })), { a: [0, 4, 4, 4], b: [0, 8, 4, 4] });
  // Past b's middle: a settles just under b, and b stays put.
  assert.deepStrictEqual(at(DashGrid.arrangeMove(layout, { ...layout[0], y: 5 })), { a: [0, 8, 4, 4], b: [0, 4, 4, 4] });
});

test('grid: a dragged card moves up past a card once it reaches its middle', () => {
  const layout = [card('a', 0, 0, 4, 4), card('b', 0, 4, 4, 4)];
  assert.deepStrictEqual(at(DashGrid.arrangeMove(layout, { ...layout[1], y: 1 })), at(layout));
  assert.deepStrictEqual(at(DashGrid.arrangeMove(layout, { ...layout[1], y: 0 })),
    { b: [0, 0, 4, 4], a: [0, 4, 4, 4] });
});

test('grid: dropping onto an occupied cell pushes the occupant down, not aside', () => {
  const layout = [card('a', 0, 0, 4, 3), card('b', 4, 0, 4, 3)];
  const out = DashGrid.arrangeMove(layout, { ...layout[0], x: 4 });
  assert.deepStrictEqual(at(out), { a: [4, 0, 4, 3], b: [4, 3, 4, 3] });
});

test('grid: a card dragged in from outside the layout is placed like a moved one', () => {
  const layout = [card('a', 0, 0, 6, 3), card('b', 6, 0, 6, 3)];
  const out = DashGrid.arrangeMove(layout, card('new', 6, 0, 6, 2));
  assert.deepStrictEqual(at(out), { a: [0, 0, 6, 3], new: [6, 0, 6, 2], b: [6, 2, 6, 3] });
});

test('grid: a resize keeps the card in place and pushes only what it covers', () => {
  const layout = [card('a', 0, 0, 4, 3), card('b', 4, 0, 4, 3), card('c', 0, 3, 4, 3), card('d', 8, 8, 4, 2)];
  assert.deepStrictEqual(at(DashGrid.arrangeInPlace(layout, { ...layout[0], h: 5 })),
    { a: [0, 0, 4, 5], b: [4, 0, 4, 3], c: [0, 5, 4, 3], d: [8, 8, 4, 2] });
  // Shrinking leaves the space: c does not rise to meet a.
  assert.deepStrictEqual(at(DashGrid.arrangeInPlace(layout, { ...layout[0], h: 2 })),
    { a: [0, 0, 4, 2], b: [4, 0, 4, 3], c: [0, 3, 4, 3], d: [8, 8, 4, 2] });
});

test('grid: the keyboard moves a row at a time, pushing what it lands on', () => {
  const layout = [card('a', 0, 0, 4, 2), card('b', 8, 0, 4, 2), card('c', 0, 3, 4, 2)];
  assert.deepStrictEqual(at(DashGrid.moveVertical(layout, 'a', 1)), { a: [0, 1, 4, 2], b: [8, 0, 4, 2], c: [0, 3, 4, 2] });
  assert.deepStrictEqual(at(DashGrid.moveVertical(layout, 'c', -1)), { c: [0, 2, 4, 2], a: [0, 0, 4, 2], b: [8, 0, 4, 2] });
  const touching = [card('a', 0, 0, 4, 2), card('c', 0, 2, 4, 2)];
  assert.deepStrictEqual(at(DashGrid.moveVertical(touching, 'c', -1)), { c: [0, 1, 4, 2], a: [0, 3, 4, 2] });
  assert.equal(DashGrid.moveVertical(layout, 'a', -1), null, 'already at the top');
  assert.equal(DashGrid.moveVertical(layout, 'c', 1), null, 'nothing but empty rows below');
  assert.equal(DashGrid.moveVertical(layout, 'missing', 1), null);
});

test('grid: a new card takes the highest open spot, holes included, leftmost on a tie', () => {
  const layout = [card('a', 0, 0, 4, 6), card('b', 4, 0, 4, 2), card('c', 8, 0, 4, 4)];
  assert.deepStrictEqual(DashGrid.firstFit(layout, 4, 2), { x: 4, y: 2 });
  assert.deepStrictEqual(DashGrid.firstFit(layout, 8, 2), { x: 4, y: 4 });
  assert.deepStrictEqual(DashGrid.firstFit(layout, 4, 5), { x: 4, y: 2 });
  const holed = [card('a', 0, 0, 12, 2), card('b', 0, 6, 12, 2)];
  assert.deepStrictEqual(DashGrid.firstFit(holed, 6, 4), { x: 0, y: 2 });
  assert.deepStrictEqual(DashGrid.firstFit(holed, 6, 5), { x: 0, y: 8 });
  assert.deepStrictEqual(DashGrid.firstFit([], 6), { x: 0, y: 0 });
  assert.equal(DashGrid.bottom(layout), 6);
  assert.equal(DashGrid.bottom([]), 0);
});
