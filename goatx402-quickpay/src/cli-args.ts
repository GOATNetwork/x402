export type Flags = Record<string, string | boolean>

export interface ParsedArgs {
  command?: string
  positional: string[]
  flags: Flags
}

export const HELP_TEXT =
  [
    'Usage: goatx402-quickpay <command> [options]',
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

      if (next === undefined || next.startsWith('--')) {
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
