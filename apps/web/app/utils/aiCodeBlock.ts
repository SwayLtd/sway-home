/**
 * Types and pure helpers for AiCodeBlock - a line-numbered code listing, or a unified diff
 * with word-level highlights (Beautiful UI). The tokenizer and the diff engine are plain data
 * functions so the component only has to turn tokens into coloured spans.
 */

export type CodeBlockVariant = 'Code' | 'Diff'
export type CodeBlockLanguage = 'json' | 'yaml' | 'ts' | 'js' | 'text'

/** A syntax colour bucket. The component maps each to a token colour/weight. */
export type CodeBlockTokenTone = 'keyword' | 'string' | 'number' | 'function' | 'key' | 'comment'
export type CodeBlockToken = { text: string; tone?: CodeBlockTokenTone }

/** A run of text within a diff row; `change` tints it as a word-level add/del. */
export type CodeBlockPiece = { text: string; change?: 'add' | 'del' }
/** One row of a unified diff: old/new line numbers, its kind, and its pieces. */
export type CodeBlockDiffRow = {
  old: number | null
  cur: number | null
  type: 'ctx' | 'add' | 'del'
  pieces: CodeBlockPiece[]
}

export type CodeBlockLabels = { copy: string; copied: string }

export const CODE_BLOCK_DEFAULT_LABELS: CodeBlockLabels = { copy: 'Copier', copied: 'Copié' }

/* ------------------------------------------------------------------------------------ */
/* Syntax tokenizer - one pass per line (or per diff piece, which is a line fragment)    */
/* ------------------------------------------------------------------------------------ */

const JS_KEYWORDS = new Set([
  'import', 'from', 'export', 'default', 'async', 'function', 'const', 'let', 'var', 'await', 'return',
  'if', 'else', 'for', 'while', 'new', 'throw', 'try', 'catch', 'null', 'true', 'false', 'undefined',
  'class', 'interface', 'type', 'extends', 'implements', 'of', 'in', 'void', 'this', 'super', 'switch',
  'case', 'break', 'continue', 'yield', 'typeof', 'instanceof', 'as', 'readonly', 'public', 'private',
  'protected', 'static', 'enum', 'namespace',
])
const JS_TOKEN =
  /\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`|\b\d+(?:\.\d+)?\b|\b(?:import|from|export|default|async|function|const|let|var|await|return|if|else|for|while|new|throw|try|catch|null|true|false|undefined|class|interface|type|extends|implements|of|in|void|this|super|switch|case|break|continue|yield|typeof|instanceof|as|readonly|public|private|protected|static|enum|namespace)\b|[A-Za-z_$][\w$]*(?=\s*\()/g

function tokenizeJs(text: string): CodeBlockToken[] {
  const tokens: CodeBlockToken[] = []
  let last = 0
  for (const match of text.matchAll(JS_TOKEN)) {
    const idx = match.index ?? 0
    const t = match[0]
    if (idx > last) tokens.push({ text: text.slice(last, idx) })
    if (t.startsWith('//')) tokens.push({ text: t, tone: 'comment' })
    else if (/^["'`]/.test(t)) tokens.push({ text: t, tone: 'string' })
    else if (/^\d/.test(t)) tokens.push({ text: t, tone: 'number' })
    else if (JS_KEYWORDS.has(t)) tokens.push({ text: t, tone: 'keyword' })
    else tokens.push({ text: t, tone: 'function' })
    last = idx + t.length
  }
  if (last < text.length) tokens.push({ text: text.slice(last) })
  return tokens
}

const JSON_TOKEN = /"(?:\\.|[^"\\])*"|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\btrue\b|\bfalse\b|\bnull\b/g

function tokenizeJson(text: string): CodeBlockToken[] {
  const tokens: CodeBlockToken[] = []
  let last = 0
  for (const match of text.matchAll(JSON_TOKEN)) {
    const idx = match.index ?? 0
    const t = match[0]
    if (idx > last) tokens.push({ text: text.slice(last, idx) })
    if (t.startsWith('"')) {
      const after = text.slice(idx + t.length).trimStart()
      tokens.push({ text: t, tone: after.startsWith(':') ? 'key' : 'string' })
    } else if (t === 'true' || t === 'false' || t === 'null') {
      tokens.push({ text: t, tone: 'keyword' })
    } else {
      tokens.push({ text: t, tone: 'number' })
    }
    last = idx + t.length
  }
  if (last < text.length) tokens.push({ text: text.slice(last) })
  return tokens
}

const YAML_VALUE_TOKEN = /#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|-?\b\d+(?:\.\d+)?\b|\b(?:true|false|null|yes|no)\b/gi

function tokenizeYamlValue(text: string): CodeBlockToken[] {
  if (/^\s*#/.test(text)) return [{ text, tone: 'comment' }]
  const tokens: CodeBlockToken[] = []
  let last = 0
  for (const match of text.matchAll(YAML_VALUE_TOKEN)) {
    const idx = match.index ?? 0
    const t = match[0]
    if (idx > last) tokens.push({ text: text.slice(last, idx) })
    if (t.startsWith('#')) tokens.push({ text: t, tone: 'comment' })
    else if (/^["']/.test(t)) tokens.push({ text: t, tone: 'string' })
    else if (/^-?\d/.test(t)) tokens.push({ text: t, tone: 'number' })
    else tokens.push({ text: t, tone: 'keyword' })
    last = idx + t.length
  }
  if (last < text.length) tokens.push({ text: text.slice(last) })
  return tokens
}

const YAML_KEY = /^(\s*(?:-\s+)?)([A-Za-z0-9_.-]+)(:)/

function tokenizeYaml(text: string): CodeBlockToken[] {
  const m = YAML_KEY.exec(text)
  if (m && m.index === 0) {
    const whole = m[0] ?? ''
    const indent = m[1] ?? ''
    const key = m[2] ?? ''
    const tokens: CodeBlockToken[] = []
    if (indent) tokens.push({ text: indent })
    tokens.push({ text: key, tone: 'key' })
    tokens.push({ text: ':' })
    tokens.push(...tokenizeYamlValue(text.slice(whole.length)))
    return tokens
  }
  return tokenizeYamlValue(text)
}

/** Tokenizes one line (or diff-piece fragment) of source text for the given language. */
export function codeBlockHighlight(text: string, language: CodeBlockLanguage): CodeBlockToken[] {
  if (!text) return []
  switch (language) {
    case 'json':
      return tokenizeJson(text)
    case 'yaml':
      return tokenizeYaml(text)
    case 'ts':
    case 'js':
      return tokenizeJs(text)
    default:
      return [{ text }]
  }
}

/* ------------------------------------------------------------------------------------ */
/* Diff engine - line-level LCS, then word-level LCS for a 1:1 replacement pair          */
/* ------------------------------------------------------------------------------------ */

type LcsOp<T> = { type: 'ctx' | 'add' | 'del'; value: T }

/** Classic LCS-backtrack diff. Small inputs only (guarded by callers): O(n*m) time and space. */
function lcsDiff<T>(a: T[], b: T[]): LcsOp<T>[] {
  const n = a.length
  const m = b.length
  // Rectangular, fully-populated by construction - indices below always land in bounds.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i] as number[]
    const nextRow = dp[i + 1] as number[]
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (nextRow[j + 1] as number) + 1 : Math.max(nextRow[j] as number, row[j + 1] as number)
    }
  }
  const ops: LcsOp<T>[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    const av = a[i] as T
    const bv = b[j] as T
    if (av === bv) {
      ops.push({ type: 'ctx', value: av })
      i += 1
      j += 1
    } else if ((dp[i + 1] as number[])[j]! >= (dp[i] as number[])[j + 1]!) {
      ops.push({ type: 'del', value: av })
      i += 1
    } else {
      ops.push({ type: 'add', value: bv })
      j += 1
    }
  }
  while (i < n) {
    ops.push({ type: 'del', value: a[i] as T })
    i += 1
  }
  while (j < m) {
    ops.push({ type: 'add', value: b[j] as T })
    j += 1
  }
  return ops
}

function pushPiece(list: CodeBlockPiece[], text: string, change?: 'add' | 'del') {
  const last = list.at(-1)
  if (last && last.change === change) {
    last.text += text
    return
  }
  list.push(change ? { text, change } : { text })
}

/** Splits a line into words/runs of punctuation, keeping whitespace as its own token. */
function splitWords(line: string): string[] {
  return line.match(/\s+|[A-Za-z0-9_$]+|[^\sA-Za-z0-9_$]/g) ?? []
}

/** Word-level diff of a single replaced line, split back into the del and add piece lists. */
function wordDiff(oldLine: string, newLine: string): [CodeBlockPiece[], CodeBlockPiece[]] {
  const a = splitWords(oldLine)
  const b = splitWords(newLine)
  if (a.length * b.length > 6000) return [[{ text: oldLine, change: 'del' }], [{ text: newLine, change: 'add' }]]
  const ops = lcsDiff(a, b)
  const delPieces: CodeBlockPiece[] = []
  const addPieces: CodeBlockPiece[] = []
  for (const op of ops) {
    if (op.type === 'ctx') {
      pushPiece(delPieces, op.value)
      pushPiece(addPieces, op.value)
    } else if (op.type === 'del') {
      pushPiece(delPieces, op.value, 'del')
    } else {
      pushPiece(addPieces, op.value, 'add')
    }
  }
  return [delPieces, addPieces]
}

/**
 * Computes a unified diff between two code texts: context lines, then word-level highlights
 * for any single line replaced by a single line (the common case for a routine edit).
 */
export function codeBlockDiffLines(before: string, after: string): CodeBlockDiffRow[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const ops = a.length * b.length > 40000
    ? [...a.map((value): LcsOp<string> => ({ type: 'del', value })), ...b.map((value): LcsOp<string> => ({ type: 'add', value }))]
    : lcsDiff(a, b)

  const rows: CodeBlockDiffRow[] = []
  let oldNum = 1
  let curNum = 1
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k] as LcsOp<string>
    if (op.type === 'ctx') {
      rows.push({ old: oldNum++, cur: curNum++, type: 'ctx', pieces: [{ text: op.value }] })
      continue
    }
    if (op.type === 'del') {
      const next = ops[k + 1]
      if (next && next.type === 'add') {
        const [delPieces, addPieces] = wordDiff(op.value, next.value)
        rows.push({ old: oldNum++, cur: null, type: 'del', pieces: delPieces })
        rows.push({ old: null, cur: curNum++, type: 'add', pieces: addPieces })
        k += 1
        continue
      }
      rows.push({ old: oldNum++, cur: null, type: 'del', pieces: [{ text: op.value }] })
      continue
    }
    rows.push({ old: null, cur: curNum++, type: 'add', pieces: [{ text: op.value }] })
  }
  return rows
}
