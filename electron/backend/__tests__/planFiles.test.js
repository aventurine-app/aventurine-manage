'use strict';

// The exported plan file's format, and what is accepted back.

const test = require('node:test');
const assert = require('node:assert/strict');

const PlanFiles = require('../services/planFiles');

test('a plan file is readable JSON that names its format and keeps the plan whole', () => {
    const plan = { id: 'p_1', name: 'Home', nodes: [], links: [] };
    const text = PlanFiles.serialize(plan, new Date('2026-05-01T00:00:00.000Z'));
    assert.deepEqual(JSON.parse(text), {
        format: 'citrine-plan', version: 1, exportedAt: '2026-05-01T00:00:00.000Z', plan,
    });
    assert.ok(text.includes('\n'), 'indented, so it can be read in a text editor');
});

test('parsing unwraps a plan file, and passes a bare plan through', () => {
    const plan = { id: 'p_1', name: 'Home' };
    assert.deepEqual(PlanFiles.parse(PlanFiles.serialize(plan)), plan);
    assert.deepEqual(PlanFiles.parse(JSON.stringify(plan)), plan);
});

test('parsing refuses text that is not JSON or is too large', () => {
    assert.throws(() => PlanFiles.parse('not json'), { status: 422, message: 'not an Aventurine Planner plan file' });
    assert.throws(() => PlanFiles.parse(' '.repeat(PlanFiles.MAX_IMPORT_BYTES + 1)), { status: 422 });
    assert.throws(() => PlanFiles.parse(null), { status: 422 });
});

test('file names drop what file systems refuse and are never empty', () => {
    assert.equal(PlanFiles.fileName('Retire: 2040?'), 'Retire 2040.json');
    assert.equal(PlanFiles.fileName('a/b\\c'), 'abc.json');
    assert.equal(PlanFiles.fileName('???'), 'plan.json');
    assert.equal(PlanFiles.fileName(''), 'plan.json');
    assert.equal(PlanFiles.fileName('x'.repeat(100)).length, 60 + '.json'.length);
});
