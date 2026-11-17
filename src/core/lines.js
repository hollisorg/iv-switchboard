// Reads a growing log file line by line from a byte offset, a chunk at a time, so a 600 MB transcript
// never sits in memory. Only complete lines (ending in \n) are given; a half-written last line is left
// for the next read. With `markers`, a line that contains none of them is skipped without decoding it.
import fs from 'node:fs'

const NEWLINE = 0x0a

// onLine(text, byteOffset) is called for each line. Returns the byte offset just after the last
// complete line, which is where the next read should start.
export function readLines(filePath, fromOffset, onLine, { chunkBytes = 4 * 1024 * 1024, markers = null } = {}) {
  const size = fs.statSync(filePath).size
  if (fromOffset >= size) return fromOffset
  const needles = markers ? markers.map((m) => Buffer.from(m)) : null
  const fd = fs.openSync(filePath, 'r')
  let pos = fromOffset // file offset of the next byte to read
  let carry = Buffer.alloc(0) // bytes of an unfinished line, which start at pos - carry.length
  try {
    while (pos < size) {
      const chunk = Buffer.alloc(Math.min(chunkBytes, size - pos))
      const got = fs.readSync(fd, chunk, 0, chunk.length, pos)
      if (got === 0) break
      const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, got)]) : chunk.subarray(0, got)
      const dataStart = pos - carry.length
      pos += got
      let start = 0
      for (;;) {
        const nl = data.indexOf(NEWLINE, start)
        if (nl === -1) break
        const line = data.subarray(start, nl)
        const wanted = !needles || needles.some((n) => line.indexOf(n) !== -1)
        if (wanted && line.length) {
          let end = line.length
          if (line[end - 1] === 0x0d) end--
          if (end > 0) onLine(line.toString('utf8', 0, end), dataStart + start)
        }
        start = nl + 1
      }
      carry = Buffer.from(data.subarray(start))
    }
  } finally {
    fs.closeSync(fd)
  }
  return pos - carry.length
}
