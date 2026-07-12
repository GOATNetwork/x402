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

  it('triggers help when -h follows a valueless flag instead of being consumed as its value', () => {
    const parsed = parseArgs(['inspect', 'https://example.com/agent.md', '--json', '-h'])
    // -h is a flag boundary, so --json stays a boolean flag and help is set.
    expect(parsed.flags.json).toBe(true)
    expect(parsed.flags.help).toBe(true)
    expect(shouldShowHelp(parsed.command, parsed.flags)).toBe(true)

    const payArgs = parseArgs([
      'pay-x402',
      'https://example.com/agent.md',
      '--amount',
      '1',
      '--force',
      '-h',
    ])
    // A real value (--amount 1) is still consumed; only the trailing -h flips help.
    expect(payArgs.flags.amount).toBe('1')
    expect(payArgs.flags.force).toBe(true)
    expect(shouldShowHelp(payArgs.command, payArgs.flags)).toBe(true)
  })

  it('lists every public command', () => {
    for (const command of ['inspect', 'pay-x402', 'pay-product', 'pay-mpp']) {
      expect(HELP_TEXT).toContain(command)
    }
  })
})
