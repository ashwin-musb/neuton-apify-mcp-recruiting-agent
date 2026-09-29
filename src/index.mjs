import { writeFile } from 'node:fs/promises';
import { connectToApify, findActorTool } from './mcp-client.mjs';
import { buildResearchBrief } from './research-brief.mjs';
import { payloadFrom, runWithCheckpoint } from './run-checkpoint.mjs';

const checkpointDir = '.neuton-run-checkpoints';
const { client, transport } = await connectToApify();

try {
  const { tools } = await client.listTools();
  const searchTool = findActorTool(tools, 'linkedin-jobs-search-scraper');
  const detailsTool = findActorTool(tools, 'linkedin-job-details-scraper');

  const searchRun = await runWithCheckpoint({
    client, checkpointDir, step: 'search', toolName: searchTool.name,
    actorName: 'neuton/linkedin-jobs-search-scraper',
    input: {
      queries: ['AI engineer'],
      locations: ['Bengaluru'],
      datePosted: 'r604800',
      includeDescriptions: false,
      maxResultsPerQuery: 5,
      waitSecs: 30,
    },
  });
  const searchDatasetId = searchRun.storages.datasets.default.id;

  const searchRowsResult = await client.callTool({
    name: 'get-dataset-items',
    arguments: {
      datasetId: searchDatasetId,
      clean: true,
      limit: 5,
      fields: 'jobId,title,company,location,postedDate,jobUrl',
    },
  });
  const searchRows = payloadFrom(searchRowsResult).items ?? [];
  const jobIds = [...new Set(searchRows.map((row) => row.jobId)
    .filter((id) => typeof id === 'string' && /^\d+$/.test(id)))].slice(0, 2);

  if (jobIds.length === 0) {
    throw new Error('The search succeeded but returned no job IDs to enrich.');
  }

  const detailsRun = await runWithCheckpoint({
    client, checkpointDir, step: 'details', toolName: detailsTool.name,
    actorName: 'neuton/linkedin-job-details-scraper',
    input: {
      jobUrlsOrIds: jobIds,
      maxResults: jobIds.length,
      waitSecs: 30,
    },
  });
  const detailsDatasetId = detailsRun.storages.datasets.default.id;

  const detailRowsResult = await client.callTool({
    name: 'get-dataset-items',
    arguments: {
      datasetId: detailsDatasetId,
      clean: true,
      limit: jobIds.length,
      fields:
        'jobId,title,company,location,employment_type,seniority_level,description,jobUrl,detailEnriched',
    },
  });
  const detailRows = payloadFrom(detailRowsResult).items ?? [];

  const output = {
    testedAt: new Date().toISOString(),
    question: 'What are companies seeking in recent AI engineer roles in Bengaluru?',
    searchRun: {
      runId: searchRun.runId,
      status: searchRun.status,
      runTimeSecs: searchRun.stats?.runTimeSecs,
      datasetId: searchDatasetId,
      rows: searchRows.length,
    },
    detailsRun: {
      runId: detailsRun.runId,
      status: detailsRun.status,
      runTimeSecs: detailsRun.stats?.runTimeSecs,
      datasetId: detailsDatasetId,
      rows: detailRows.length,
    },
    evidence: {
      searchRows,
      detailRows,
    },
    brief: buildResearchBrief(detailRows, jobIds, searchRows.length),
  };

  await writeFile('run-output.json', `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output, null, 2));
} finally {
  await client.close();
  await transport.close();
}
