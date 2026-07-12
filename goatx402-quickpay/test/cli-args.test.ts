import { describe, expect, it } from 'vitest'
import {
  HELP_TEXT,
  parseArgs,
  shouldShowHelp,
} from '../src/cli-args.js'

describe('QuickPay CLI help', () => {
  it('recognizes --help and -h without consuming a command', () => {
    expect(parseArgs(['--help'])).toEqual({
      command: undefined,
      positional: [],
      flags: { help: true },
    })

    expect(parseArgs(['-h'])).toEqual({
      command: undefined,
      positional: [],
      flags: { help: true },
    })
  })

  it('supports help globally and after a command', () => {
    expect(shouldShowHelp('help', {})).toBe(true)

    const parsed = parseArgs(['inspect', '--help'])
    expect(parsed.command).toBe('inspect')
    expect(shouldShowHelp(parsed.command, parsed.flags)).toBe(true)
  })

  it('does not intercept normal commands', () => {
    const parsed = parseArgs(['inspect', 'https://example.com/agent.md'])
    expect(shouldShowHelp(parsed.command, parsed.flags)).toBe(false)
  })

  it('lists every public command', () => {
    for (const command of ['inspect', 'pay-x402', 'pay-product', 'pay-mpp']) {
      expect(HELP_TEXT).toContain(command)
    }
  })
})
