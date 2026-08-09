# Neuton recruiting research agent with Apify MCP

This is the tested companion project for the Neuton Apify Content Program article. It is intended for developers who are new to Apify but already comfortable with Node.js, JSON, and environment variables.

## Prerequisites

- Node.js 22 or newer.
- An Apify account.
- An Apify API token from **Apify Console > Settings > Integrations**.

## Install

```bash
npm install
```

## Inspect the Actor tools

Set your token in the shell without committing it:

```bash
export APIFY_TOKEN="your-token"
npm run inspect
```

This prints the MCP tool names and input schemas exposed for the two Neuton Actors.

## Run the two-Actor workflow

```bash
npm start
```

The script:

1. Calls the LinkedIn Jobs Search Actor through MCP for five recent Bengaluru AI roles.
2. Reads the default dataset through the MCP `get-dataset-items` tool.
3. Passes two returned job IDs to the LinkedIn Job Details Actor.
4. Reads the enriched dataset and writes `run-output.json`.

Successful output includes both run IDs, both dataset IDs, the selected records, and a short evidence-based brief. If a run fails, the script reports the Actor name, run ID, status, and the next action returned by Apify MCP.

## Verified workflow screenshots

![Successful Apify MCP LinkedIn jobs search run with five dataset rows](screenshots/apify-mcp-linkedin-search-success.png)

![Bounded LinkedIn job details input with two job IDs](screenshots/apify-mcp-linkedin-details-input.png)

![Successful LinkedIn job details run with two enriched rows](screenshots/apify-mcp-linkedin-details-success.png)

## First-run troubleshooting

- **`MCP error -32000: Connection closed`**: launch the package's declared executable entry point, `dist/stdio.js`, rather than importing its library entry point.
- **No Actor tool appears**: confirm the Actor full name in `src/mcp-client.mjs` and run `npm run inspect`.
- **Authentication fails**: check that `APIFY_TOKEN` exists in the same shell that runs `npm start`.
- **The search returns zero rows**: broaden the date window or location, but keep `maxResultsPerQuery` small while testing.
- **A run remains active after 30 seconds**: use the returned run ID with the MCP `get-actor-run` tool instead of starting another run.

## Safety and cost

The example limits the search to one keyword, one location, and five rows. Do not remove result limits until you have verified the workflow and understand the Actor pricing shown in Apify Store.

Never commit `.env` or an Apify API token. Use only public job information and follow applicable platform terms, privacy rules, and local laws.

## Dependency audit note

`npm audit` currently reports four moderate findings that trace to `@hono/node-server` below 2.0.5 through the pinned Apify MCP server dependency. The advisory concerns encoded-backslash path traversal in Windows static-file serving. This companion uses the local MCP standard-input/output transport and does not serve static files, so that vulnerable path is not exercised here. Recheck the audit when updating `@apify/actors-mcp-server`; avoid forcing a transitive major-version override without retesting the MCP workflow.
