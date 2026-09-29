import assert from 'node:assert/strict';
import test from 'node:test';
import { buildResearchBrief } from './research-brief.mjs';

const row = (id, description) => ({
  jobId: id, description, company: 'Example', title: 'Engineer',
  detailEnriched: true, jobUrl: `https://www.linkedin.com/jobs/view/${id}`,
});

test('unrelated descriptions do not inherit historical AI claims', () => {
  const brief = buildResearchBrief([row('1', 'Excel and accounting')], ['1'], 3);
  assert.deepEqual(brief.observedTerms, []);
  assert.equal(brief.enrichedPostings, 1);
  assert.match(brief.caveat, /3 search rows and 1 enriched postings/);
  assert.match(brief.method, /not-an-LLM/);
});

test('each term counts postings once and includes exact source evidence', () => {
  const rows = [row('1', 'Python Python and embeddings.'), row('2', 'Python with RAG.')];
  const brief = buildResearchBrief(rows, ['1', '2'], 5);
  const python = brief.observedTerms.find((item) => item.term === 'Python');
  assert.equal(python.postingsWithMention, 2);
  assert.equal(brief.observedTerms.find((item) => item.term === 'RAG').postingsWithMention, 1);
  for (const item of brief.observedTerms) {
    for (const evidence of item.evidence) {
      assert.ok(rows.find((entry) => entry.jobId === evidence.jobId).description.includes(evidence.excerpt));
    }
  }
});

test('negated mentions stay literal, not a skill requirement', () => {
  const brief = buildResearchBrief([row('1', 'Python is not required.')], ['1'], 1);
  assert.equal(brief.observedTerms[0].evidence[0].excerpt, 'Python is not required.');
  assert.match(brief.caveat, /negated/);
  assert.match(brief.caveat, /not verified requirements/);
});

test('empty, missing, duplicate and unrelated rows fail closed', () => {
  for (const rows of [[], [row('1', '')], [row('1', 'Python'), row('1', 'Python')],
    [row('3', 'Python')], [row('1', 'Python')]]) {
    assert.throws(() => buildResearchBrief(rows, ['1', '2'], 5));
  }
});

test('incomplete and spoofed records cannot support a brief', () => {
  for (const patch of [{company: ''}, {detailEnriched: false},
    {jobUrl: 'https://linkedin.com.evil.test/jobs/view/1'},
    {jobUrl: 'https://www.linkedin.com/jobs/view/2'},
    {jobUrl: 'https://user:pass@www.linkedin.com/jobs/view/1'}]) {
    assert.throws(() => buildResearchBrief([{...row('1', 'Python'), ...patch}], ['1'], 1));
  }
});

test('invalid sample sizes and selected IDs are rejected', () => {
  for (const ids of [[], ['1', '1'], ['1', '2', '3'], ['wrong'], [1]]) {
    assert.throws(() => buildResearchBrief([row('1', 'Python')], ids, 5));
  }
  assert.throws(() => buildResearchBrief([row('1', 'Python')], ['1'], 0));
});

test('a partial one-job search reports its actual size', () => {
  const brief = buildResearchBrief([row('1', 'Java development')], ['1'], 1);
  assert.equal(brief.searchRows, 1);
  assert.equal(brief.enrichedPostings, 1);
  assert.deepEqual(brief.observedCompanies, ['Example']);
});
