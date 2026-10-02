const assert = require('node:assert/strict');
const sum = require('./sum');
assert.equal(sum(2, 3), 5);
assert.equal(sum(-2, 3), 1);
assert.equal(sum(0, 0), 0);
console.log('PASS');
