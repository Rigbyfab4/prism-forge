import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, InstructionFile, PluginOptions, Register } from 'claude-code'

import type { PrismNotice, PrismState } from '../types'

// The two things this mod cannot derive from the environment. Everything else
// (the home folder, ~/.claude/CLAUDE.md) is read from USERPROFILE / HOME.
//
// Each can also be set per machine without editing this file, as the plugin's
// `node` and `cliFromHome` options (the config menu, or `pluginConfigs` in
// settings.json); an empty option falls back to the value here.
const CONFIG = {
  // The node executable that runs the prism-forge CLI. $.process.run starts a
  // program without a shell, so this must be the real node.exe: an npm .cmd
  // shim cannot be used. Change it if node lives elsewhere.
  NODE: 'C:\\Program Files\\nodejs\\node.exe',
  // Where bin/prism-forge.js of your prism-forge clone is, relative to the home
  // folder; joined to it at call time. Change it if the clone is elsewhere.
  CLI_FROM_HOME: 'Git_Repos\\prism-forge\\bin\\prism-forge.js',
}

type Settings = { node: string; cliFromHome: string }

function settingsFrom(options: PluginOptions): Settings {
  const pick = (value: unknown, fallback: string) =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
  return { node: pick(options.node, CONFIG.NODE), cliFromHome: pick(options.cliFromHome, CONFIG.CLI_FROM_HOME) }
}

// The user's home folder; the variable names must be string literals
async function homeDir($: Engine): Promise<string | undefined> {
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  return home ? home.replace(/[\\/]+$/, '') : undefined
}

// ~/.claude/CLAUDE.md, where prism-forge keeps its PRISM block
async function claudeMdPath($: Engine): Promise<string | undefined> {
  const home = await homeDir($)
  return home ? `${home}\\.claude\\CLAUDE.md` : undefined
}

// Sent beside the next prompt after a switch, so the model stops (or starts)
// following the PRISM instructions it already holds
const NOTICES: Record<'on' | 'off', string> = {
  off:
    'PRISM was just turned off with the prism-toggle switch. From this message on, ' +
    'do not use PRISM persona routing: no persona announcements and no ' +
    '**Name (Role):** attribution. Disregard the PRISM instructions and routing ' +
    'directives earlier in this conversation; they no longer apply.',
  on:
    'PRISM was just turned on with the prism-toggle switch. From this message on, ' +
    'follow the PRISM persona routing in ~/.claude/prism/routing/routing-engine.md, ' +
    'including persona announcements and **Name (Role):** attribution. Its files are ' +
    'no longer loaded automatically: Read ~/.claude/prism/routing/routing-engine.md now, ' +
    'and the persona files it points to as they are needed.',
}

// Colors from the Prism Forge logo
const BEAM = '#f4f8ff'
const ICE = '#a8d8f0'
const EMBER = '#f07a28'
const SPECTRUM = ['#e8352a', '#f58a1f', '#f5d21f', '#3fc23a', '#2f6fe0', '#8a3fd1']

const state = atom({ plugin: 'prism-toggle', key: 'state' } as const, 'unknown')
const isBusy = atom({ plugin: 'prism-toggle', key: 'isBusy' } as const, false)
const pending = atom({ plugin: 'prism-toggle', key: 'pending' } as const, null as PrismNotice)
const hasSwitched = atom({ plugin: 'prism-toggle', key: 'hasSwitched' } as const, false)

async function prismForge($: Engine, cfg: Settings, command: 'status' | 'enable' | 'disable', timeoutMs = 20_000) {
  try {
    const home = await homeDir($)
    if (!home) return { exitCode: 1, stdout: '', stderr: 'USERPROFILE and HOME are both unset' }
    return await $.process.run([cfg.node, `${home}\\${cfg.cliFromHome}`, command], { timeoutMs })
  } catch (err) {
    return { exitCode: 1, stdout: '', stderr: String(err) }
  }
}

function parseStatus(stdout: string): PrismState {
  if (stdout.startsWith('PRISM is enabled')) return 'on'
  if (stdout.startsWith('PRISM is disabled')) return 'off'
  if (stdout.includes('not installed')) return 'missing'
  return 'unknown'
}

async function refresh($: Engine, cfg: Settings, timeoutMs?: number): Promise<PrismState> {
  const ran = await prismForge($, cfg, 'status', timeoutMs)
  const now = parseStatus(ran.stdout)
  await update($, state, () => now)
  return now
}

// Switch PRISM on or off; returns a line describing what happened. It checks
// the real state itself, so a button drawn from an old state can't act on it.
async function setPrism($: Engine, cfg: Settings, wanted: 'on' | 'off'): Promise<string> {
  if (await read($, isBusy)) return 'PRISM is already switching.'
  await update($, isBusy, () => true)
  try {
    const before = await refresh($, cfg)
    if (before === 'missing') return 'PRISM is not installed.'
    if (before === wanted) return `PRISM is already ${before}.`

    const ran = await prismForge($, cfg, wanted === 'on' ? 'enable' : 'disable')
    const now = await refresh($, cfg)
    if (ran.exitCode !== 0) {
      const reason = (ran.stderr || ran.stdout).trim().split('\n')[0]
      return `Couldn't turn PRISM ${wanted}: ${reason}`
    }
    if (now !== wanted) return `prism-forge ran, but PRISM now reports "${now}".`

    // Tell the model with the next prompt, and have the engine recompute the
    // instruction files this conversation carries
    await update($, pending, () => wanted)
    await update($, hasSwitched, () => true)
    $.ui.invalidate('prompt.context')
    return `PRISM turned ${wanted}. Your next message follows the change; start a new session for the full effect.`
  } finally {
    await update($, isBusy, () => false)
  }
}

const normalize = (path: string) => path.replace(/\\/g, '/').toLowerCase()

// An instruction file's text as the engine loads it: frontmatter and HTML
// comments removed
function asLoaded(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').replace(/<!--[\s\S]*?-->/g, '')
}

async function readText($: Engine, path: string): Promise<string | undefined> {
  try {
    return asLoaded((await $.fs.read(path)) as string)
  } catch {
    return undefined
  }
}

// After a switch, CLAUDE.md takes the text on disk (prism-forge edits its PRISM
// block there). No other instruction file is added, dropped or changed: PRISM's
// own files live outside ~/.claude/rules/, so the engine never loads them.
async function syncClaudeMd($: Engine, files: readonly InstructionFile[]): Promise<InstructionFile[]> {
  const target = await claudeMdPath($)
  if (!target) return [...files]
  const wanted = normalize(target)

  const synced: InstructionFile[] = []
  for (const file of files) {
    if (file.kind === 'user' && normalize(file.path) === wanted) {
      const text = await readText($, file.path)
      synced.push(text !== undefined && text.trim() !== file.content.trim() ? { ...file, content: text } : file)
    } else {
      synced.push(file)
    }
  }
  return synced
}

export const register: Register = (on, options) => {
  const cfg = settingsFrom(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'prism',
      description: 'Turn PRISM on or off',
      argumentHint: '[on|off|status]',
    })
    // Known before the first prompt, so the band is there from the start; a
    // slow prism-forge gets a second, unhurried try in the background
    if ((await refresh($, cfg, 3_000)) === 'unknown') void refresh($, cfg)

    return next(e)
  })

  // /prism toggles; /prism on, /prism off, /prism status
  on('command.run', { command: 'prism' }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()
    const now = await refresh($, cfg)
    if (arg === 'status') {
      return { text: now === 'missing' ? 'PRISM is not installed.' : `PRISM is ${now}.` }
    }
    if (arg !== '' && arg !== 'on' && arg !== 'off') {
      return { text: 'Usage: /prism [on|off|status]' }
    }
    if (now === 'missing') return { text: 'PRISM is not installed.' }
    const wanted = arg === 'on' || arg === 'off' ? arg : now === 'on' ? 'off' : 'on'
    if (wanted === now) return { text: `PRISM is already ${now}.` }
    return { text: await setPrism($, cfg, wanted) }
  })

  // The first prompt after a switch carries the notice, once
  on('prompt.submit', async ($, e, next) => {
    const notice = await read($, pending)
    if (notice === null || e.command) return next(e)
    await update($, pending, () => null)
    return next({ ...e, context: [...(e.context ?? []), NOTICES[notice]] })
  })

  // After a switch, CLAUDE.md follows what is on disk now
  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    const files = result.instructionFiles ?? e.instructionFiles
    if (!files || !(await read($, hasSwitched))) return result
    return { ...result, instructionFiles: await syncClaudeMd($, files) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, state)
    if (e.props.hasSurvey || now === 'unknown' || now === 'missing') {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const busy = await read($, isBusy)
    const wanted = now === 'on' ? 'off' : 'on'
    const lit = now === 'on'

    // The Prism Forge logo in one row: white beam, ice prism, spectrum out
    return (
      <Box>
        <Text color={lit ? BEAM : undefined} dimColor={!lit}>━━</Text>
        <Text color={lit ? ICE : undefined} dimColor={!lit} weight="bold">▲</Text>
        {SPECTRUM.map((color, i) => (
          <Text key={`band-${i}`} color={lit ? color : undefined} dimColor={!lit}>━</Text>
        ))}
        <Text> </Text>
        <Text color={lit ? ICE : undefined} dimColor={!lit} weight="bold">PRISM</Text>
        <Text color={lit ? EMBER : undefined} dimColor={!lit}> {now} </Text>
        <Button
          key="toggle"
          label={busy ? 'Switching…' : `Turn ${wanted}`}
          onPress={async () => {
            $.ui.toast(await setPrism($, cfg, wanted))
          }}
        />
      </Box>
    )
  })
}
