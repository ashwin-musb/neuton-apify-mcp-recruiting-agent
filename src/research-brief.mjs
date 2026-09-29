const TERMS = [
  ['Python', /\bpython\b/i],
  ['RAG', /\brag\b|\bretrieval[ -]augmented generation\b/i],
  ['embeddings', /\bembeddings?\b/i],
  ['evaluation', /\bevaluations?\b/i],
  ['monitoring', /\bmonitoring\b/i],
  ['guardrails', /\bguardrails?\b/i],
];

export function buildResearchBrief(rows, expectedJobIds, searchRowCount) {
  if (!Array.isArray(rows) || !Array.isArray(expectedJobIds)
      || !expectedJobIds.length || expectedJobIds.length > 2
      || new Set(expectedJobIds).size !== expectedJobIds.length
      || expectedJobIds.some((id) => typeof id !== 'string' || !/^\d+$/.test(id))
      || !Number.isInteger(searchRowCount) || searchRowCount < expectedJobIds.length) {
    throw new Error('Invalid bounded research sample.');
  }
  const seen = new Set();
  for (const row of rows) {
    const required = ['jobId', 'title', 'company', 'description', 'jobUrl'];
    if (!row || row.detailEnriched !== true
        || required.some((key) => typeof row[key] !== 'string' || !row[key].trim())
        || !expectedJobIds.includes(row.jobId) || seen.has(row.jobId)) {
      throw new Error('Incomplete, duplicate or unexpected detail row; inspect the existing run.');
    }
    const url = new URL(row.jobUrl);
    if (url.protocol !== 'https:' || !['linkedin.com', 'www.linkedin.com'].includes(url.hostname)
        || url.username || url.password || url.port
        || url.pathname.replace(/\/$/, '') !== `/jobs/view/${row.jobId}`) {
      throw new Error('Detail row identity does not match its public job URL.');
    }
    seen.add(row.jobId);
  }
  if (seen.size !== expectedJobIds.length) {
    throw new Error('Not every selected job has a complete detail row; no brief generated.');
  }

  return {
    method: 'deterministic-literal-term-matches-not-an-LLM-summary',
    searchRows: searchRowCount,
    enrichedPostings: rows.length,
    observedCompanies: [...new Set(rows.map((row) => row.company.trim()))],
    observedTerms: TERMS.flatMap(([term, pattern]) => {
      const evidence = rows.flatMap((row) => {
        const text = row.description.replace(/\s+/g, ' ').trim();
        const match = pattern.exec(text);
        if (!match) return [];
        const start = Math.max(0, match.index - 60);
        const end = Math.min(text.length, match.index + match[0].length + 100);
        return [{jobId: row.jobId, jobUrl: row.jobUrl, excerpt: text.slice(start, end)}];
      });
      return evidence.length ? [{term, postingsWithMention: evidence.length, evidence}] : [];
    }),
    caveat: `This sample contains ${searchRowCount} search rows and ${rows.length} enriched postings. `
      + 'Literal mentions can be negated, optional or historical; they are not verified requirements, '
      + 'buying intent or a market-wide trend. No model selected tools or interpreted these descriptions.',
  };
}
