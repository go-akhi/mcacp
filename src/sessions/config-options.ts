import type {
  SessionConfigOption, SessionConfigSelect, SessionConfigSelectOption, SessionConfigSelectGroup,
  SessionConfigValue,
} from '../types/acp.js';

/** Flatten a select option list, expanding groups. */
export function flattenChoices(option: SessionConfigSelect): SessionConfigSelectOption[] {
  const out: SessionConfigSelectOption[] = [];
  for (const o of option.options ?? []) {
    if ('group' in o) out.push(...(o as SessionConfigSelectGroup).options);
    else out.push(o as SessionConfigSelectOption);
  }
  return out;
}

/** Fallback id/name patterns for agents that don't set a category. */
const CATEGORY_HINTS: Record<string, RegExp> = {
  model: /\bmodel\b/i,
  thought_level: /thought|thinking|reason|effort/i,
  mode: /\bmode\b/i,
};

/**
 * Find the select option for a category, preferring an explicit category over
 * name hints. Boolean options are skipped: agents also tag toggles such as
 * "auto approve" with category "mode", but only a select can hold a mode,
 * model, or level.
 */
export function findOptionByCategory(
  options: SessionConfigOption[] | undefined, category: string,
): SessionConfigSelect | undefined {
  const selects = (options ?? []).filter((o): o is SessionConfigSelect => o.type !== 'boolean');
  const exact = selects.find(o => o.category === category);
  if (exact) return exact;
  const hint = CATEGORY_HINTS[category];
  if (!hint) return undefined;
  return selects.find(o => !o.category && (hint.test(o.id) || hint.test(o.name)));
}

const TRUE_WORDS = new Set(['true', 'on', 'yes', '1', 'enable', 'enabled']);
const FALSE_WORDS = new Set(['false', 'off', 'no', '0', 'disable', 'disabled']);

/**
 * Resolve a caller-supplied value against an option. Boolean options accept a
 * boolean or a word like "on"/"off"; select options match the exact value
 * first, then a case-insensitive value or display name.
 * Throws with the list of valid values when nothing matches.
 */
export function resolveChoice(option: SessionConfigOption, input: SessionConfigValue): SessionConfigValue {
  if (option.type === 'boolean') {
    if (typeof input === 'boolean') return input;
    const word = input.trim().toLowerCase();
    if (TRUE_WORDS.has(word)) return true;
    if (FALSE_WORDS.has(word)) return false;
    throw new Error(`"${input}" is not a valid value for "${option.name}". Valid values: true, false`);
  }

  const text = String(input);
  const choices = flattenChoices(option);
  if (choices.length === 0) return text;
  const exact = choices.find(c => c.value === text);
  if (exact) return exact.value;
  const lower = text.toLowerCase();
  const loose = choices.find(c => c.value.toLowerCase() === lower || c.name.toLowerCase() === lower);
  if (loose) return loose.value;
  const valid = choices.map(c => c.name === c.value ? c.value : `${c.value} (${c.name})`).join(', ');
  throw new Error(`"${text}" is not a valid value for "${option.name}". Valid values: ${valid}`);
}
