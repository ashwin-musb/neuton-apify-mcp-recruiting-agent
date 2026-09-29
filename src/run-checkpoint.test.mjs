import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { payloadFrom, runWithCheckpoint } from './run-checkpoint.mjs';

const TOOL = 'apify--neuton--linkedin-jobs-search-scraper';
const ACTOR = 'neuton/linkedin-jobs-search-scraper';
const INPUT = {
  queries: ['AI engineer'],
  locations: ['Bengaluru'],
  maxResultsPerQuery: 5,
  waitSecs: 30,
};

function run(status = 'SUCCEEDED', overrides = {}) {
  return {
    runId: 'run001',
    actorId: 'actor001',
    actorName: ACTOR,
    status,
    storages: { datasets: { default: { id: 'dataset001' } } },
    summary: `${status} summary`,
    nextStep: `${status} next step`,
    ...overrides,
  };
}

function response(payload) {
  return { structuredContent: payload };
}

function mockClient(handler) {
  const calls = [];
  return {
    calls,
    async callTool(request) {
      calls.push(request);
      return handler(request, calls.length - 1);
    },
  };
}

async function tempCheckpointDir() {
  return mkdtemp(join(tmpdir(), 'run-checkpoint-test-'));
}

function options(client, checkpointDir, overrides = {}) {
  return {
    client,
    toolName: TOOL,
    actorName: ACTOR,
    input: INPUT,
    checkpointDir,
    step: 'search',
    ...overrides,
  };
}

async function onlyJournal(checkpointDir) {
  const files = (await readdir(checkpointDir)).filter((file) => file.endsWith('.json'));
  assert.equal(files.length, 1, 'exactly one JSON journal should exist for one step');
  return join(checkpointDir, files[0]);
}

test('returns an initially successful run and journals before launching it', async () => {
  const checkpointDir = await tempCheckpointDir();
  const client = mockClient(async (request) => {
    assert.equal(request.name, TOOL);
    assert.deepEqual(request.arguments, INPUT);
    const journal = await onlyJournal(checkpointDir);
    const journalText = await readFile(journal, 'utf8');
    assert.doesNotThrow(() => JSON.parse(journalText));
    return response(run());
  });

  const result = await runWithCheckpoint(options(client, checkpointDir));

  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.runId, 'run001');
  assert.equal(client.calls.length, 1);
  const journalText = await readFile(await onlyJournal(checkpointDir), 'utf8');
  assert.match(journalText, /run001/);
});

test('polls a running launch by run ID until it succeeds', async () => {
  const checkpointDir = await tempCheckpointDir();
  const client = mockClient((request) => {
    if (request.name === TOOL) return response(run('RUNNING'));
    assert.equal(request.name, 'get-actor-run');
    assert.deepEqual(request.arguments, { runId: 'run001', waitSecs: 30 });
    return response(run('SUCCEEDED'));
  });

  const result = await runWithCheckpoint(options(client, checkpointDir));

  assert.equal(result.status, 'SUCCEEDED');
  assert.deepEqual(client.calls.map((call) => call.name), [TOOL, 'get-actor-run']);
});

test('an exhausted active run resumes the same ID on the next invocation', async () => {
  const checkpointDir = await tempCheckpointDir();
  let launches = 0;
  let polls = 0;
  const client = mockClient((request) => {
    if (request.name === TOOL) {
      launches += 1;
      return response(run('RUNNING'));
    }
    assert.equal(request.name, 'get-actor-run');
    assert.deepEqual(request.arguments, { runId: 'run001', waitSecs: 30 });
    polls += 1;
    return response(run(polls === 1 ? 'RUNNING' : 'SUCCEEDED'));
  });

  await assert.rejects(
    runWithCheckpoint(options(client, checkpointDir, { maxPolls: 1 })),
    /active|progress|poll|running/i,
  );
  const result = await runWithCheckpoint(options(client, checkpointDir, { maxPolls: 1 }));

  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(launches, 1);
  assert.equal(polls, 2);
});

test('a terminal failure is retained and never relaunched', async () => {
  const checkpointDir = await tempCheckpointDir();
  let launches = 0;
  const client = mockClient((request) => {
    if (request.name === TOOL) launches += 1;
    else {
      assert.equal(request.name, 'get-actor-run');
      assert.deepEqual(request.arguments, { runId: 'run001', waitSecs: 30 });
    }
    return response(run('FAILED'));
  });

  await assert.rejects(runWithCheckpoint(options(client, checkpointDir)), /failed|terminal/i);
  await assert.rejects(runWithCheckpoint(options(client, checkpointDir)), /failed|terminal/i);
  assert.equal(launches, 1);
});

test('a changed input cannot reuse or replace an existing checkpoint', async () => {
  const checkpointDir = await tempCheckpointDir();
  let launches = 0;
  const client = mockClient(() => {
    launches += 1;
    return response(run());
  });
  await runWithCheckpoint(options(client, checkpointDir));

  await assert.rejects(
    runWithCheckpoint(options(client, checkpointDir, {
      input: { ...INPUT, maxResultsPerQuery: 6 },
    })),
    /fingerprint|input|match|checkpoint/i,
  );
  assert.equal(launches, 1);
});

test('malformed and structurally invalid checkpoint JSON fail closed', async (t) => {
  for (const [name, contents] of [
    ['malformed JSON', '{ definitely not JSON'],
    ['invalid checkpoint object', '{}'],
  ]) {
    await t.test(name, async () => {
      const checkpointDir = await tempCheckpointDir();
      let launches = 0;
      const client = mockClient(() => {
        launches += 1;
        throw new Error('launch outcome unknown');
      });

      await assert.rejects(runWithCheckpoint(options(client, checkpointDir)));
      await writeFile(await onlyJournal(checkpointDir), contents);
      await assert.rejects(
        runWithCheckpoint(options(client, checkpointDir)),
        /checkpoint|journal|json|invalid|corrupt/i,
      );
      assert.equal(launches, 1);
    });
  }
});

test('a launch exception leaves an ambiguous claim that cannot launch again', async () => {
  const checkpointDir = await tempCheckpointDir();
  let launches = 0;
  const client = mockClient(() => {
    launches += 1;
    throw new Error('connection dropped after request');
  });

  await assert.rejects(runWithCheckpoint(options(client, checkpointDir)));
  await assert.rejects(
    runWithCheckpoint(options(client, checkpointDir)),
    /ambiguous|claimed|requested|checkpoint|run ID/i,
  );
  assert.equal(launches, 1);
});

test('a start response without a run ID remains ambiguous and cannot relaunch', async () => {
  const checkpointDir = await tempCheckpointDir();
  let launches = 0;
  const client = mockClient(() => {
    launches += 1;
    return response({ actorName: ACTOR, status: 'RUNNING' });
  });

  await assert.rejects(
    runWithCheckpoint(options(client, checkpointDir)),
    /run ID|ambiguous|invalid|checkpoint/i,
  );
  await assert.rejects(
    runWithCheckpoint(options(client, checkpointDir)),
    /run ID|ambiguous|requested|checkpoint/i,
  );
  assert.equal(launches, 1);
});

test('concurrent callers start at most one Actor run for the same step', async () => {
  const checkpointDir = await tempCheckpointDir();
  let launches = 0;
  let announceStart;
  let releaseStart;
  const started = new Promise((resolve) => { announceStart = resolve; });
  const released = new Promise((resolve) => { releaseStart = resolve; });
  const client = mockClient(async (request) => {
    assert.equal(request.name, TOOL);
    launches += 1;
    announceStart();
    await released;
    return response(run());
  });

  const first = runWithCheckpoint(options(client, checkpointDir));
  await started;
  const second = runWithCheckpoint(options(client, checkpointDir));
  await new Promise((resolve) => setImmediate(resolve));
  releaseStart();
  const outcomes = await Promise.allSettled([first, second]);

  assert.equal(launches, 1);
  assert.ok(outcomes.some((outcome) => outcome.status === 'fulfilled'));
  for (const outcome of outcomes.filter((item) => item.status === 'fulfilled')) {
    assert.equal(outcome.value.status, 'SUCCEEDED');
  }
});

test('mismatched Actor and run identities are rejected', async (t) => {
  await t.test('Actor identity', async () => {
    const checkpointDir = await tempCheckpointDir();
    const client = mockClient(() => response(run('SUCCEEDED', {
      actorName: 'someone-else/different-actor',
    })));
    await assert.rejects(
      runWithCheckpoint(options(client, checkpointDir)),
      /actor|identity|match/i,
    );
  });

  await t.test('run identity while polling', async () => {
    const checkpointDir = await tempCheckpointDir();
    const client = mockClient((request) => response(
      request.name === TOOL ? run('RUNNING') : run('SUCCEEDED', { runId: 'run002' }),
    ));
    await assert.rejects(
      runWithCheckpoint(options(client, checkpointDir)),
      /run|identity|match/i,
    );
    assert.equal(client.calls.filter((call) => call.name === TOOL).length, 1);
  });
});

test('MCP errors are rejected without leaking their sensitive text', async () => {
  const checkpointDir = await tempCheckpointDir();
  const secret = 'token=super-secret-value';
  const client = mockClient(() => ({
    isError: true,
    content: [{ type: 'text', text: `provider failure: ${secret}` }],
  }));

  const error = await runWithCheckpoint(options(client, checkpointDir)).then(
    () => null,
    (caught) => caught,
  );
  assert.ok(error instanceof Error);
  assert.doesNotMatch(String(error), /super-secret-value/);
  assert.match(String(error), /MCP|tool|error|failed|actor|ambiguous/i);
});

test('payload parsing accepts supported forms and rejects invalid responses', () => {
  assert.deepEqual(payloadFrom({ structuredContent: { ok: true } }), { ok: true });
  assert.deepEqual(
    payloadFrom({ content: [{ type: 'text', text: '{"ok":true}' }] }),
    { ok: true },
  );
  assert.throws(() => payloadFrom({ content: [] }), /content|response|payload|invalid/i);
  assert.throws(
    () => payloadFrom({ content: [{ type: 'text', text: 'not JSON' }] }),
    /json|response|payload|invalid/i,
  );
  assert.throws(() => payloadFrom({ structuredContent: [] }), /payload|response|invalid/i);
});

test('a successful run without a default dataset is rejected', async () => {
  const checkpointDir = await tempCheckpointDir();
  const client = mockClient(() => response(run('SUCCEEDED', {
    storages: { datasets: {} },
  })));

  await assert.rejects(
    runWithCheckpoint(options(client, checkpointDir)),
    /dataset|storage/i,
  );
});

test('invalid arguments and poll bounds are rejected before any tool call', async () => {
  const invalid = [
    { client: null },
    { toolName: '' },
    { actorName: '' },
    { input: null },
    { input: [] },
    { checkpointDir: '' },
    { step: '' },
    { step: 'publish' },
    { maxPolls: -1 },
    { maxPolls: 11 },
    { maxPolls: 1.5 },
    { maxPolls: '2' },
  ];

  for (const patch of invalid) {
    const checkpointDir = await tempCheckpointDir();
    const client = mockClient(() => response(run()));
    await assert.rejects(runWithCheckpoint(options(client, checkpointDir, patch)));
    assert.equal(client.calls.length, 0);
  }
});

test('zero and ten are accepted poll bounds', async () => {
  for (const maxPolls of [0, 10]) {
    const checkpointDir = await tempCheckpointDir();
    const client = mockClient(() => response(run()));
    const result = await runWithCheckpoint(options(client, checkpointDir, { maxPolls }));
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(client.calls.length, 1);
  }
});

test('a transient polling failure preserves the handle and redacts transport details', async () => {
  const checkpointDir = await tempCheckpointDir();
  let launches = 0;
  let polls = 0;
  const client = mockClient((request) => {
    if (request.name === TOOL) { launches++; return response(run('RUNNING')); }
    polls++;
    if (polls === 1) throw new Error('sensitive transport token=do-not-print');
    return response(run());
  });
  await assert.rejects(runWithCheckpoint(options(client, checkpointDir)), (error) => {
    assert.doesNotMatch(String(error), /do-not-print/);
    return /checkpoint retained/i.test(String(error));
  });
  await runWithCheckpoint(options(client, checkpointDir));
  assert.equal(launches, 1);
});

test('resuming details reuses the completed search without either step launching twice', async () => {
  const checkpointDir = await tempCheckpointDir();
  const detailsActor = 'neuton/linkedin-job-details-scraper';
  const detailsTool = 'neuton-details';
  const client = mockClient((request) => {
    if (request.name === TOOL) return response(run());
    if (request.name === detailsTool) return response(run('RUNNING', { runId: 'details001', actorName: detailsActor }));
    return response(request.arguments.runId === 'run001' ? run()
      : run('SUCCEEDED', { runId: 'details001', actorName: detailsActor }));
  });
  const details = options(client, checkpointDir, {
    step: 'details', actorName: detailsActor, toolName: detailsTool,
    input: { jobUrlsOrIds: ['1234567890'], maxResults: 1 }, maxPolls: 0,
  });
  await runWithCheckpoint(options(client, checkpointDir));
  await assert.rejects(runWithCheckpoint(details), /still active/);
  await runWithCheckpoint(options(client, checkpointDir));
  await runWithCheckpoint(details);
  assert.equal(client.calls.filter((c) => c.name === TOOL).length, 1);
  assert.equal(client.calls.filter((c) => c.name === detailsTool).length, 1);
});
