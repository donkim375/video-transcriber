import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeCookiesFile } from '../../src/services/youtube-cookies.js'

const NETSCAPE_HEADER = '# Netscape HTTP Cookie File\n'
const SAMPLE_COOKIES = NETSCAPE_HEADER +
  '# https://curl.se/docs/http-cookies.html\n' +
  '.youtube.com\tTRUE\t/\tTRUE\t9999999999\tSID\tabc123\n'

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64')
}

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), 'cookies-test-'))
}

describe('writeCookiesFile', () => {
  it('decodes base64 and writes the file to <dir>/youtube-cookies.txt', () => {
    const dir = mkTmp()
    try {
      const path = writeCookiesFile(b64(SAMPLE_COOKIES), dir)
      expect(path).toBe(join(dir, 'youtube-cookies.txt'))
      expect(readFileSync(path, 'utf8')).toBe(SAMPLE_COOKIES)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes the file with mode 0600', () => {
    const dir = mkTmp()
    try {
      const path = writeCookiesFile(b64(SAMPLE_COOKIES), dir)
      const mode = statSync(path).mode & 0o777
      expect(mode).toBe(0o600)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('accepts the alternate "# HTTP Cookie File" header', () => {
    const dir = mkTmp()
    try {
      const content = '# HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t9\tSID\tx\n'
      const path = writeCookiesFile(b64(content), dir)
      expect(readFileSync(path, 'utf8')).toBe(content)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('throws when decoded content lacks a Netscape cookies header', () => {
    const dir = mkTmp()
    try {
      expect(() => writeCookiesFile(b64('not a cookies file\n'), dir))
        .toThrow(/Netscape cookies\.txt/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('throws when the base64 decodes to empty bytes', () => {
    const dir = mkTmp()
    try {
      expect(() => writeCookiesFile('', dir)).toThrow(/Netscape cookies\.txt/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
