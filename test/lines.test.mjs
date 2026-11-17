import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readLines } from '../src/core/lines.js'

function file(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ivsb-lines-'))
  const f = path.join(dir, 'x.jsonl')
  fs.writeFileSync(f, text)
  return f
}

function collect(f, offset, opts) {
  const got = []
  const end = readLines(f, offset, (text, at) => got.push([text, at]), opts)
  return { got, end }
}

test('gives each complete line with its byte offset, at any chunk size', () => {
  const text = 'alpha\nbé\n\nlonger line here\n'
  const want = [['alpha', 0], ['bé', 6], ['longer line here', 11]]
  for (const chunkBytes of [1, 2, 3, 5, 64, 1 << 20]) {
    const { got, end } = collect(file(text), 0, { chunkBytes })
    assert.deepEqual(got, want, `chunk ${chunkBytes}`)
    assert.equal(end, Buffer.byteLength(text))
  }
})

test('a last line without a newline is left for later', () => {
  const f = file('one\ntwo\nthr')
  const { got, end } = collect(f, 0, { chunkBytes: 4 })
  assert.deepEqual(got.map((g) => g[0]), ['one', 'two'])
  assert.equal(end, 8)
  fs.appendFileSync(f, 'ee\n')
  const again = collect(f, end, { chunkBytes: 4 })
  assert.deepEqual(again.got, [['three', 8]])
  assert.equal(again.end, 14)
})

test('Windows line endings lose their carriage return', () => {
  const { got } = collect(file('a\r\nb\r\n'), 0, { chunkBytes: 2 })
  assert.deepEqual(got, [['a', 0], ['b', 3]])
})

test('lines without any marker are skipped before decoding, offsets still right', () => {
  const text = 'skip me\n{"usage":1}\nnope\n{"x":"turn_context"}\n'
  const { got, end } = collect(file(text), 0, { chunkBytes: 3, markers: ['"usage"', 'turn_context'] })
  assert.deepEqual(got, [['{"usage":1}', 8], ['{"x":"turn_context"}', 25]])
  assert.equal(end, Buffer.byteLength(text))
})

test('a line far longer than a chunk is read whole', () => {
  const long = 'x'.repeat(10000)
  const { got } = collect(file(`a\n${long}\nb\n`), 0, { chunkBytes: 7 })
  assert.deepEqual(got.map((g) => g[0].length), [1, 10000, 1])
})

test('reading from the end returns nothing', () => {
  const f = file('a\nb\n')
  const { got, end } = collect(f, 4)
  assert.deepEqual(got, [])
  assert.equal(end, 4)
})
