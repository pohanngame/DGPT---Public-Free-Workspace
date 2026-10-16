export interface ParsedSemester {
  code: string
  label: string
  isCurrent: boolean
}

export interface ParsedCollege {
  code: string
  name: string
  shortCode: string | null
}

export interface ParsedTeacherPage {
  semesters: ParsedSemester[]
  kbjcmsid: string
  colleges: ParsedCollege[]
}

const SELECT_PATTERN = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi
const OPTION_PATTERN = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi
const ATTR_PATTERN = (name: string) =>
  new RegExp(String.raw`\b${name}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))`, 'i')
const BRACKET_PREFIX = /^\[([^\]]+)\]\s*/

interface SelectOption {
  value: string
  label: string
  selected: boolean
}

export function parseTeacherPage(html: string): ParsedTeacherPage {
  const selects = indexSelects(html)
  return {
    semesters: readOptions(selects, 'xnxqh').map((option) => ({
      code: option.value,
      label: option.label,
      isCurrent: option.selected,
    })),
    kbjcmsid: readKbjcmsid(readOptions(selects, 'kbjcmsid')),
    colleges: readOptions(selects, 'skyx')
      .filter((option) => option.value !== '')
      .map(toCollege),
  }
}

function readKbjcmsid(options: SelectOption[]): string {
  const usable = options.filter((option) => option.value !== '')
  if (usable.length === 1) {
    return usable[0]?.value ?? ''
  }
  const selected = usable.filter((option) => option.selected)
  if (selected.length === 1) {
    return selected[0]?.value ?? ''
  }
  const error = new Error('kbjcmsid has no single usable option')
  Object.assign(error, { code: 'KBJCMSID_AMBIGUOUS' })
  throw error
}

function toCollege(option: SelectOption): ParsedCollege {
  const bracket = BRACKET_PREFIX.exec(option.label)
  return {
    code: option.value,
    name: bracket ? option.label.slice(bracket[0].length) : option.label,
    shortCode: bracket?.[1] ?? null,
  }
}

function indexSelects(html: string): Map<string, SelectOption[]> {
  const selects = new Map<string, SelectOption[]>()
  for (const match of html.matchAll(SELECT_PATTERN)) {
    const name = attr(match[1] ?? '', 'name') ?? attr(match[1] ?? '', 'id')
    if (!name || selects.has(name)) {
      continue
    }
    selects.set(name, readSelectOptions(match[2] ?? ''))
  }
  return selects
}

function readOptions(selects: Map<string, SelectOption[]>, name: string): SelectOption[] {
  const options = selects.get(name)
  if (!options) {
    throw new Error(`missing select ${name}`)
  }
  return options
}

function readSelectOptions(body: string): SelectOption[] {
  const options: SelectOption[] = []
  for (const match of body.matchAll(OPTION_PATTERN)) {
    const attrs = match[1] ?? ''
    const value = attr(attrs, 'value')
    if (value === null) {
      continue
    }
    options.push({
      value,
      label: decodeBasicEntities(stripTags(match[2] ?? '')).trim(),
      selected: /\bselected\b/i.test(attrs),
    })
  }
  return options
}

function attr(tag: string, name: string): string | null {
  const match = ATTR_PATTERN(name).exec(tag)
  if (!match) {
    return null
  }
  return match[1] ?? match[2] ?? match[3] ?? ''
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, '')
}

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
}
