import type {
  SessionConfigOption, SessionConfigSelectOption, SessionConfigSelectGroup,
} from '../types/acp.js';

/** Flatten a select option list, expanding groups. */
export function flattenChoices(option: SessionConfigOption): SessionConfigSelectOption[] {
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

/** Find the config option for a category, preferring an explicit category over name hints. */
export function findOptionByCategory(
  options: SessionConfigOption[] | undefined, category: string,
): SessionConfigOption | undefined {
  if (!options) return undefined;
  const exact = options.find(o => o.category === category);
  if (exact) return exact;
  const hint = CATEGORY_HINTS[category];
  if (!hint) return undefined;
  return options.find(o => !o.category && (hint.test(o.id) || hint.test(o.name)));
}

/**
 * Resolve a caller-supplied value against an option's choices. Matches the
 * exact value first, then a case-insensitive value or display name.
 * Throws with the list of valid choices when nothing matches.
 */
export function resolveChoice(option: SessionConfigOption, input: string): string {
  const choices = flattenChoices(option);
  if (choices.length === 0) return input;
  const exact = choices.find(c => c.value === input);
  if (exact) return exact.value;
  const lower = input.toLowerCase();
  const loose = choices.find(c => c.value.toLowerCase() === lower || c.name.toLowerCase() === lower);
  if (loose) return loose.value;
  const valid = choices.map(c => c.name === c.value ? c.value : `${c.value} (${c.name})`).join(', ');
  throw new Error(`"${input}" is not a valid value for "${option.name}". Valid values: ${valid}`);
}
