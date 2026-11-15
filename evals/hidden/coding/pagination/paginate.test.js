import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginate, pageCount } from '../src/paginate.js';

const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

test('page 1 starts at the first item', () => assert.deepEqual(paginate(ten, 1, 3), [1, 2, 3]));
test('middle page', () => assert.deepEqual(paginate(ten, 2, 3), [4, 5, 6]));
test('partial last page', () => assert.deepEqual(paginate(ten, 4, 3), [10]));
test('page past the end is empty', () => assert.deepEqual(paginate(ten, 5, 3), []));
test('pageCount rounds up a partial page', () => assert.equal(pageCount(10, 3), 4));
test('pageCount exact multiple', () => assert.equal(pageCount(9, 3), 3));
test('pageCount of nothing', () => assert.equal(pageCount(0, 3), 0));
