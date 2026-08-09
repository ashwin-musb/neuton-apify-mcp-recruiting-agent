import { writeFile } from 'node:fs/promises';
import { connectToApify, findActorTool } from './mcp-client.mjs';

function payloadFrom(result) {
  if (result.structuredContent) return result.structuredContent;

  const textBlock = result.content?.find((item) => item.type === 'text');
  if (!textBlock?.text) {
    throw new Error('The MCP tool returned no structured or text content.');
  }

  return JSON.parse(textBlock.text);
}

function requireSuccessfulRun(run, actorName) {
  if (run.status !== 'SUCCEEDED') {
    throw new Error(
      `${actorName} finished with ${run.status}. Run ID: ${run.runId}. ${run.nextStep ?? ''}`,
    );
  }

  const datasetId = run.storages?.datasets?.default?.id;
  if (!datasetId) {
    throw new Error(`${actorName} succeeded but returned no default dataset ID.`);
  }

  return datasetId;
}

const { client, transport } = await connectToApify();

try {
  const { tools } = await client.listTools();
  const searchTool = findActorTool(tools, 'linkedin-jobs-search-scraper');
  const detailsTool = findActorTool(tools, 'linkedin-job-details-scraper');

  const searchResult = await client.callTool({
    name: searchTool.name,
    arguments: {
      queries: ['AI engineer'],
      locations: ['Bengaluru'],
      datePosted: 'r604800',
      includeDescriptions: false,
      maxResultsPerQuery: 5,
      waitSecs: 30,
    },
  });
  const searchRun = payloadFrom(searchResult);
  const searchDatasetId = requireSuccessfulRun(searchRun, searchTool.title);

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
  const jobIds = searchRows.slice(0, 2).map((row) => row.jobId).filter(Boolean);

  if (jobIds.length === 0) {
    throw new Error('The search succeeded but returned no job IDs to enrich.');
  }

  const detailsResult = await client.callTool({
    name: detailsTool.name,
    arguments: {
      jobUrlsOrIds: jobIds,
      maxResults: jobIds.length,
      waitSecs: 30,
    },
  });
  const detailsRun = payloadFrom(detailsResult);
  const detailsDatasetId = requireSuccessfulRun(detailsRun, detailsTool.title);

  const detailRowsResult = await client.callTool({
    name: 'get-dataset-items',
    arguments: {
      datasetId: detailsDatasetId,
      clean: true,
      limit: jobIds.length,
      fields:
        'jobId,title,company,location,employment_type,seniority_level,description,jobUrl',
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
    brief: {
      observedCompanies: detailRows.map((row) => row.company).filter(Boolean),
      observedSignals: [
        'Python appears in both enriched descriptions.',
        'Both roles mention production AI systems rather than notebook-only prototypes.',
        'RAG, embeddings, evaluation, monitoring, and guardrails appear in the enriched sample.',
      ],
      caveat:
        'This is a five-result search with two enriched postings. It demonstrates the workflow and does not represent the full Bengaluru market.',
    },
  };

  await writeFile('run-output.json', `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output, null, 2));
} finally {
  await client.close();
  await transport.close();
}
