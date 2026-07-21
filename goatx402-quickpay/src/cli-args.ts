export type Flags = Record<string, string | boolean>

export interface ParsedArgs {
  command?: string
  positional: string[]
  flags: Flags
}

export const HELP_TEXT =
  [
    'Usage: goatflow-quickpay <command> [options]',
    '',
    'Commands:',
    '  inspect <agent_md_or_manifest_url>',
    '  pay-x402 <url> --amount <a> (--token <symbol> | --token-contract <address>) --chain <id>',
    '  pay-product <url> --product <key> (--token <symbol> | --token-contract <address>) --chain <id>',
    '  pay-mpp <url> --route <route>',
    '',
    'Options:',
    '  -h, --help  Show this help message',
  ].join('\n') + '\n'

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Flags = {}
  const positional: string[] = []
  let command: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (arg === '-h' || arg === '--help') {
      flags.help = true
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]

      // A following flag is a boundary, not this flag's value. `--` covers long
      // flags (including `--help`); `-h` is the only short flag, and it must
      // still trigger help right after a valueless flag (e.g. `--json -h`) —
      // otherwise a payment CLI could proceed instead of showing help.
      if (next === undefined || next.startsWith('--') || next === '-h') {
        flags[key] = true
      } else {
        flags[key] = next
        i++
      }
    } else if (command === undefined) {
      command = arg
    } else {
      positional.push(arg)
    }
  }

  return { command, positional, flags }
}

export function shouldShowHelp(command: string | undefined, flags: Flags): boolean {
  return command === 'help' || flags.help === true
}
