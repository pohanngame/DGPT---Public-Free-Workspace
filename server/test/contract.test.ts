import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SLOT_CODES } from '../src/contract.ts'

test('slot codes match the probed table', () => {
  assert.deepEqual(SLOT_CODES, ['0102', '0304', '0506', '0708', '0910', '1112'])
})
