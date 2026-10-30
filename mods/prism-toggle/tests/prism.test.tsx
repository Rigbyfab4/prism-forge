import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'prism-toggle',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 60,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

// A fake home that is not the real one: nothing in the mod may depend on it
const HOME = 'C:\\Users\\Tester'
const CLAUDE_MD = `${HOME}\\.claude\\CLAUDE.md`
const OTHER_MD = `${HOME}\\.claude\\rules\\other.md`
// A file left over from the old install location: the mod never touches it
const LEGACY_MD = `${HOME}\\.claude\\rules\\prism\\routing\\routing-engine.md`
const NODE = 'C:\\Program Files\\nodejs\\node.exe'

const same = (a: string, b: string) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()

// Stands in for the prism-forge CLI: answers status/enable/disable like the real one
function fakeCli(
  on: any,
  start: 'on' | 'off' | 'missing',
  timeouts: number[] = [],
  env: Record<string, string> = { USERPROFILE: HOME },
) {
  let now = start
  const calls: string[] = []
  const argvs: (readonly string[])[] = []
  mock.env(on, env)
  // The disk as prism-forge leaves it: the CLAUDE.md block only while on
  on('fs.read', (_: unknown, e: { path: string }) => {
    if (same(e.path, CLAUDE_MD)) return { value: now === 'on' ? '# Mine\n## Persona Routing System\n' : '# Mine\n' }
    return { deny: 'ENOENT' }
  })
  on('process.run', (_: unknown, e: { argv: readonly string[]; init?: { timeoutMs?: number } }) => {
    const cmd = e.argv[2] ?? ''
    argvs.push(e.argv)
    timeouts.push(e.init?.timeoutMs ?? 0)
    calls.push(cmd)
    if (cmd === 'enable' && now !== 'missing') now = 'on'
    if (cmd === 'disable' && now !== 'missing') now = 'off'
    const stdout =
      now === 'missing' ? 'PRISM is not installed at ~/.claude/prism/.\n'
      : now === 'on' ? 'PRISM is enabled (~/.claude/prism/).\n'
      : 'PRISM is disabled since 2026-10-29T23:11:02.636Z.\n'
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
  return {
    calls,
    argvs,
    // Changes the real state behind the mod's back, as another terminal would
    setState: (next: 'on' | 'off' | 'missing') => {
      now = next
    },
  }
}


async function start($: any, on: any, toasts: string[] = []) {
  on('command.register', () => ({ value: { command: 'prism' } }))
  on('ui.toast', (_: unknown, e: { text?: string; message?: string }) => {
    toasts.push(String(e.text ?? e.message ?? ''))
    return { value: undefined }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('prompt.submit', (_: unknown, e: { text: string; context?: string[] }) => ({ text: e.text, context: e.context }))
  on('prompt.context', (_: unknown, e: any) => ({ blocks: e.blocks, instructionFiles: e.instructionFiles }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
}


test('the band shows the state and its button switches PRISM off', async ($, on) => {
  const { calls } = fakeCli(on, 'on')
  await start($, on)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: 'PRISM' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' on ' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ key: 'toggle' }))?.props.label).toBe('Turn off')
  await ui.press({ key: 'toggle' })
  expect(calls).toContain('disable')
  expect(await ui.find({ type: 'Text', text: ' off ' })).toBeDefined()
  expect((await ui.find({ key: 'toggle' }))?.props.label).toBe('Turn on')
  await ui.unmount()
})

test('a band drawn from an old state does not act on it', async ($, on) => {
  const toasts: string[] = []
  const cli = fakeCli(on, 'on')
  await start($, on, toasts)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ key: 'toggle' }))?.props.label).toBe('Turn off')

  // Someone else turned PRISM off after the band was drawn
  cli.setState('off')
  await ui.press({ key: 'toggle' })

  expect(cli.calls).not.toContain('disable')
  expect(cli.calls).not.toContain('enable')
  expect(toasts).toEqual(['PRISM is already off.'])
  expect(await ui.find({ type: 'Text', text: ' off ' })).toBeDefined()
  expect((await ui.find({ key: 'toggle' }))?.props.label).toBe('Turn on')
  // Nothing was switched here, so the model is told nothing
  expect((await $.prompt.submit({ text: 'hi', origin: { kind: 'user' } })).context).toBe(undefined)
  await ui.unmount()
})

test('a band for PRISM that was uninstalled meanwhile says so and runs nothing', async ($, on) => {
  const toasts: string[] = []
  const cli = fakeCli(on, 'on')
  await start($, on, toasts)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  cli.setState('missing')
  await ui.press({ key: 'toggle' })

  expect(cli.calls).not.toContain('disable')
  expect(toasts).toEqual(['PRISM is not installed.'])
  await ui.unmount()
})

test('the band is there as soon as the session has started', async ($, on) => {
  const timeouts: number[] = []
  fakeCli(on, 'off', timeouts)
  await start($, on)

  expect(timeouts).toEqual([3_000])
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: ' off ' })).toBeDefined()
  await ui.unmount()
})

test('the band draws nothing when PRISM is not installed', async ($, on) => {
  fakeCli(on, 'missing')
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await start($, on)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /PRISM/ })).toBe(undefined)
  await ui.unmount()
})

const SWITCHED = 'Your next message follows the change; start a new session for the full effect.'

test('/prism toggles, and takes on, off and status', async ($, on) => {
  const { calls } = fakeCli(on, 'off')
  await start($, on)

  expect((await $.command.run({ command: 'prism', args: 'status' })).text).toBe('PRISM is off.')
  expect((await $.command.run({ command: 'prism' })).text).toBe(`PRISM turned on. ${SWITCHED}`)
  expect((await $.command.run({ command: 'prism', args: 'on' })).text).toBe('PRISM is already on.')
  expect((await $.command.run({ command: 'prism', args: 'off' })).text).toBe(`PRISM turned off. ${SWITCHED}`)
  expect((await $.command.run({ command: 'prism', args: 'sideways' })).text).toBe('Usage: /prism [on|off|status]')
  expect(calls.filter(c => c !== 'status')).toEqual(['enable', 'disable'])
})

test('the CLI is run from the home folder the environment names', async ($, on) => {
  const { argvs } = fakeCli(on, 'on')
  await start($, on)
  await $.command.run({ command: 'prism', args: 'off' })

  expect(argvs.length).toBeGreaterThan(1)
  for (const argv of argvs) {
    expect(argv[0]).toBe(NODE)
    expect(argv[1]).toBe(`${HOME}\\Git_Repos\\prism-forge\\bin\\prism-forge.js`)
    expect(argv.length).toBe(3)
  }
  expect(argvs.map(a => a[2])).toEqual(['status', 'status', 'status', 'disable', 'status'])
  expect(JSON.stringify(argvs)).not.toContain('Rigby')
})

test('HOME stands in when USERPROFILE is not set', async ($, on) => {
  const { argvs } = fakeCli(on, 'on', [], { HOME: 'C:\\Users\\Other\\' })
  await start($, on)

  expect(argvs[0]?.[1]).toBe('C:\\Users\\Other\\Git_Repos\\prism-forge\\bin\\prism-forge.js')
})

test('without a home folder nothing is run and the band stays away', async ($, on) => {
  const { argvs } = fakeCli(on, 'on', [], {})
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await start($, on)

  expect(argvs).toEqual([])
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /PRISM/ })).toBe(undefined)
  await ui.unmount()
})

test(
  'the node and CLI locations can be set in the plugin options',
  { options: { node: 'D:\\tools\\node\\node.exe', cliFromHome: 'src\\prism\\cli.js' } },
  async ($, on) => {
    const { argvs } = fakeCli(on, 'on')
    await start($, on)

    expect(argvs[0]).toEqual(['D:\\tools\\node\\node.exe', `${HOME}\\src\\prism\\cli.js`, 'status'])
  },
)

const LOADED = [
  { path: CLAUDE_MD, kind: 'user', content: '# Mine\n## Persona Routing System\n' },
  { path: LEGACY_MD, kind: 'user', content: '# Routing' },
  { path: OTHER_MD, kind: 'user', content: '# Other' },
] as const

test('nothing changes until PRISM is switched', async ($, on) => {
  fakeCli(on, 'on')
  await start($, on)

  expect((await $.prompt.submit({ text: 'hi', origin: { kind: 'user' } })).context).toBe(undefined)
  const ctx = await $.prompt.context({ blocks: [], instructionFiles: LOADED })
  expect(ctx.instructionFiles).toEqual(LOADED)
})

test('turning off tells the model once and takes the PRISM block out of CLAUDE.md', async ($, on) => {
  fakeCli(on, 'on')
  await start($, on)
  await $.command.run({ command: 'prism', args: 'off' })

  const first = await $.prompt.submit({ text: 'hi', origin: { kind: 'user' } })
  expect(first.context?.[0]).toMatch(/PRISM was just turned off/)
  expect((await $.prompt.submit({ text: 'again', origin: { kind: 'user' } })).context).toBe(undefined)

  // Only CLAUDE.md changes: no other file is dropped or touched
  const ctx = await $.prompt.context({ blocks: [], instructionFiles: LOADED })
  expect(ctx.instructionFiles).toEqual([
    { path: CLAUDE_MD, kind: 'user', content: '# Mine\n' },
    { path: LEGACY_MD, kind: 'user', content: '# Routing' },
    { path: OTHER_MD, kind: 'user', content: '# Other' },
  ])
})

test('turning on tells the model and puts the PRISM block back in CLAUDE.md', async ($, on) => {
  fakeCli(on, 'off')
  await start($, on)
  await $.command.run({ command: 'prism', args: 'on' })

  const first = await $.prompt.submit({ text: 'hi', origin: { kind: 'user' } })
  expect(first.context?.[0]).toMatch(/PRISM was just turned on/)
  expect(first.context?.[0]).toMatch(/Read ~\/\.claude\/prism\/routing\/routing-engine\.md/)

  // Nothing is appended: PRISM's files are not loaded as instructions
  const ctx = await $.prompt.context({
    blocks: [],
    instructionFiles: [
      { path: CLAUDE_MD, kind: 'user', content: '# Mine\n' },
      { path: OTHER_MD, kind: 'user', content: '# Other' },
    ],
  })
  expect(ctx.instructionFiles).toEqual([
    { path: CLAUDE_MD, kind: 'user', content: '# Mine\n## Persona Routing System\n' },
    { path: OTHER_MD, kind: 'user', content: '# Other' },
  ])
})

test('CLAUDE.md is found whatever the slashes and casing of its path', async ($, on) => {
  fakeCli(on, 'on')
  await start($, on)
  await $.command.run({ command: 'prism', args: 'off' })

  const odd = 'c:/users/tester/.claude/claude.md'
  const ctx = await $.prompt.context({
    blocks: [],
    instructionFiles: [
      { path: odd, kind: 'user', content: '# Mine\n## Persona Routing System\n' },
      { path: OTHER_MD, kind: 'user', content: '# Other' },
    ],
  })
  expect(ctx.instructionFiles).toEqual([
    { path: odd, kind: 'user', content: '# Mine\n' },
    { path: OTHER_MD, kind: 'user', content: '# Other' },
  ])
})

test('a CLAUDE.md under another home folder is left alone', async ($, on) => {
  fakeCli(on, 'on')
  await start($, on)
  await $.command.run({ command: 'prism', args: 'off' })

  const files = [
    { path: 'C:\\Users\\Rigby\\.claude\\CLAUDE.md', kind: 'user', content: '# Theirs\n## Persona Routing System\n' },
    { path: 'C:\\proj\\CLAUDE.md', kind: 'project', content: '# Project' },
  ] as const
  expect((await $.prompt.context({ blocks: [], instructionFiles: files })).instructionFiles).toEqual(files)
})

test('a slash command does not use up the notice', async ($, on) => {
  fakeCli(on, 'on')
  await start($, on)
  await $.command.run({ command: 'prism', args: 'off' })

  const cmd = await $.prompt.submit({ text: '/help', command: { name: 'help', args: '' }, origin: { kind: 'user' } })
  expect(cmd.context).toBe(undefined)
  expect((await $.prompt.submit({ text: 'hi', origin: { kind: 'user' } })).context?.[0]).toMatch(/turned off/)
})
