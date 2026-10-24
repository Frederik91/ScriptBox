// Word matching for docs search, the same algorithm as the .NET host's
// DocsSearchScoring so both rank the same files the same way. It finds names
// and words, not meanings: a source that should find "export to IFC" from
// "save as IFC" needs a search of its own.

const stopWords = new Set(['a', 'an', 'and', 'the', 'to', 'of', 'in', 'on', 'for', 'with', 'by', 'from', 'is', 'it', 'or', 'how', 'do', 'i']);

const letterOrDigit = /[\p{L}\p{N}]/u;
const upper = /\p{Lu}/u;
const lower = /\p{Ll}/u;

/** The words of a text, lower case, with camelCase and snake_case names split into their parts. */
export function searchTerms(text: string | null | undefined): string[] {
  const terms: string[] = [];
  if (text === null || text === undefined) {
    return terms;
  }
  let word = '';
  const flush = (): void => {
    if (word.length > 1) {
      const term = stem(word.toLowerCase());
      if (!stopWords.has(term) && !terms.includes(term)) {
        terms.push(term);
      }
    }
    word = '';
  };
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (!letterOrDigit.test(c)) {
      flush();
      continue;
    }
    if (upper.test(c) && word.length > 0 && lower.test(text.charAt(i - 1))) {
      flush();
    }
    word += c;
  }
  flush();
  return terms;
}

/** How well a file matches the query's terms: 3 for a term in the path, 2 in the summary, 0.2 per occurrence in the text (up to 5). */
export function searchScore(terms: readonly string[], path: string, summary: string | null | undefined, content: string): number {
  if (terms.length === 0) {
    return 0;
  }
  const pathTerms = searchTerms(path);
  const summaryTerms = searchTerms(summary);
  const lowerContent = content.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (pathTerms.includes(term)) {
      score += 3;
    }
    if (summaryTerms.includes(term)) {
      score += 2;
    }
    score += Math.min(occurrences(lowerContent, term), 5) * 0.2;
  }
  return roundHalfEven(score / terms.length, 3);
}

function stem(term: string): string {
  return term.length > 3 && term.endsWith('s') && !term.endsWith('ss') ? term.slice(0, -1) : term;
}

function occurrences(text: string, term: string): number {
  let count = 0;
  for (let i = text.indexOf(term); i >= 0; i = text.indexOf(term, i + term.length)) {
    count++;
  }
  return count;
}

/** .NET's Math.Round(value, digits): ties go to the even digit. */
function roundHalfEven(value: number, digits: number): number {
  const factor = 10 ** digits;
  const scaled = value * factor;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  const epsilon = 1e-9;
  let rounded: number;
  if (diff > 0.5 + epsilon) {
    rounded = floor + 1;
  } else if (diff < 0.5 - epsilon) {
    rounded = floor;
  } else {
    rounded = floor % 2 === 0 ? floor : floor + 1;
  }
  return rounded / factor;
}
