import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const ACTIVE = new Set(['READY', 'RUNNING', 'TIMING-OUT', 'ABORTING']);
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']);
const ACTORS = {
  search: 'neuton/linkedin-jobs-search-scraper',
  details: 'neuton/linkedin-job-details-scraper',
};
const validId = (id) => typeof id === 'string' && /^[a-zA-Z0-9]{3,64}$/.test(id);

export function payloadFrom(result) {
  if (!result || result.isError) throw new Error('MCP tool reported an error; no automatic restart.');
  let payload = result.structuredContent;
  if (payload == null) {
    const text = result.content?.find((item) => item.type === 'text')?.text;
    try { payload = JSON.parse(text); } catch {
      throw new Error('MCP tool returned invalid JSON; no automatic restart.');
    }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('MCP tool returned an invalid payload.');
  }
  return payload;
}

async function writeJournal(path, row, exclusive = false) {
  const target = exclusive ? path : `${path}.${randomUUID()}.tmp`;
  const file = await open(target, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(row, null, 2)}\n`);
    await file.sync();
  } finally { await file.close(); }
  if (!exclusive) {
    try { await rename(target, path); } catch (error) {
      await unlink(target).catch(() => {});
      throw error;
    }
  }
}

function validateRun(run, actorName, runId) {
  if (!validId(run.runId) || (runId && run.runId !== runId) || run.actorName !== actorName) {
    throw new Error('Run identity mismatch; inspect the recorded run in Apify Console.');
  }
  if (!ACTIVE.has(run.status) && !TERMINAL.has(run.status)) {
    throw new Error('Unknown run status; checkpoint retained, no automatic restart.');
  }
}

async function readRun(client, runId) {
  try {
    return payloadFrom(await client.callTool({ name: 'get-actor-run', arguments: { runId, waitSecs: 30 } }));
  } catch {
    throw new Error(`Could not read run ${runId}. Checkpoint retained; retry npm start, not a new Actor run.`);
  }
}

export async function runWithCheckpoint({ client, toolName, actorName, input, checkpointDir, step, maxPolls = 2 }) {
  if (!client || typeof client.callTool !== 'function'
      || ACTORS[step] !== actorName || typeof toolName !== 'string' || !toolName
      || !input || typeof input !== 'object' || Array.isArray(input)
      || typeof checkpointDir !== 'string' || !checkpointDir
      || !Number.isInteger(maxPolls) || maxPolls < 0 || maxPolls > 10) {
    throw new Error('Invalid checkpoint arguments; only the two Neuton workflow steps are supported.');
  }
  const fingerprint = createHash('sha256').update(JSON.stringify({ actorName, toolName, input })).digest('hex');
  await mkdir(checkpointDir, { recursive: true, mode: 0o700 });
  const path = join(checkpointDir, `${step}.json`);
  let journal;
  try { journal = JSON.parse(await readFile(path, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Invalid checkpoint; preserve it and inspect before restarting.');
  }
  let run;
  if (!journal) {
    journal = { version: 1, actorName, toolName, fingerprint, requestedAt: new Date().toISOString() };
    // Claim before dispatch: an interrupted/ambiguous start must never be replayed.
    try { await writeJournal(path, journal, true); } catch {
      throw new Error('Checkpoint already claimed or cannot be saved. No Actor was started by this invocation.');
    }
    try { run = payloadFrom(await client.callTool({ name: toolName, arguments: input })); } catch {
      throw new Error('Actor start outcome is ambiguous. Check Apify Console; do not delete the checkpoint or start again.');
    }
    if (!validId(run.runId)) throw new Error('Start returned no valid run ID. Checkpoint retained; inspect Console before retrying.');
    journal.runId = run.runId;
    await writeJournal(path, journal);
  } else {
    if (journal.version !== 1 || journal.actorName !== actorName || journal.toolName !== toolName
        || journal.fingerprint !== fingerprint) {
      throw new Error('Checkpoint input or Actor mismatch. Preserve the existing workflow; do not restart it.');
    }
    if (!validId(journal.runId)) {
      throw new Error('Ambiguous prior start without a recorded run ID. Inspect Console; no automatic restart.');
    }
    run = await readRun(client, journal.runId);
  }
  validateRun(run, actorName, journal.runId);
  for (let attempt = 0; ACTIVE.has(run.status) && attempt < maxPolls; attempt++) {
    run = await readRun(client, journal.runId);
    validateRun(run, actorName, journal.runId);
  }
  if (ACTIVE.has(run.status)) {
    throw new Error(`Run ${journal.runId} is still active. Rerun npm start to resume this same run. It has not been aborted.`);
  }
  if (run.status !== 'SUCCEEDED') {
    throw new Error(`Run ${journal.runId} ended ${run.status}. Inspect its log and RUN_SUMMARY in Console; no automatic restart.`);
  }
  if (!validId(run.storages?.datasets?.default?.id)) {
    throw new Error('Successful run has no valid default dataset ID. Checkpoint retained; no automatic restart.');
  }
  return run;
}
