---
title: Stack Search
description: Full-text search across stacks with tag filtering and cursor-based pagination.
---

Procella indexes all stack metadata into PostgreSQL's full-text search engine. You can search by stack name, project name, or tags — with filtering, sorting, and cursor-based pagination that stays performant even across thousands of stacks.

## Dashboard Search

The stack list in the dashboard has a search bar at the top. Type any part of a stack name or project name and results update in real time. You can also filter by tag using the tag filter controls.

## API Reference

```
GET /api/stacks
```

All parameters are optional.

| Parameter | Type | Description |
|---|---|---|
| `query` | string | Full-text search string. Matches stack name, project name. |
| `project` | string | Filter to a specific project name (exact match). |
| `tagName` | string | Filter by tag name (use with `tagValue` for exact match). |
| `tagValue` | string | Filter by tag value. Requires `tagName`. |
| `sortBy` | string | Sort field: `name`, `lastUpdated`, `created`. Default: `name`. |
| `sortOrder` | string | `asc` or `desc`. Default: `asc`. |
| `pageSize` | number | Results per page. Default: 50, max: 200. |
| `continuationToken` | string | Cursor from a previous response to fetch the next page. |

### Examples

Search for stacks with "prod" in the name:

```bash
curl "https://your-procella.example.com/api/stacks?query=prod" \
  -H "Authorization: token $PULUMI_ACCESS_TOKEN"
```

Filter to a specific project:

```bash
curl "https://your-procella.example.com/api/stacks?project=my-app" \
  -H "Authorization: token $PULUMI_ACCESS_TOKEN"
```

Filter by tag:

```bash
curl "https://your-procella.example.com/api/stacks?tagName=env&tagValue=production" \
  -H "Authorization: token $PULUMI_ACCESS_TOKEN"
```

Combine search with tag filter and sort:

```bash
curl "https://your-procella.example.com/api/stacks?query=api&tagName=region&tagValue=us-east-1&sortBy=name&sortOrder=asc" \
  -H "Authorization: token $PULUMI_ACCESS_TOKEN"
```

### Response Shape

```json
{
  "stacks": [
    {
      "orgName": "my-org",
      "projectName": "my-app",
      "stackName": "production",
      "tags": { "env": "production", "region": "us-east-1" },
      "lastUpdate": "2024-03-15T10:42:00Z",
      "resourceCount": 42,
      "url": "https://your-procella.example.com/api/stacks/my-org/my-app/production"
    }
  ],
  "continuationToken": "eyJvcmciOiJteS1vcmciLCJwcm9qIjoibXktYXBwIn0="
}
```

When `continuationToken` is absent from the response, you've reached the last page.

## Pagination

Procella uses cursor-based pagination rather than offset-based. This matters at scale: offset pagination (`LIMIT 20 OFFSET 2000`) requires PostgreSQL to scan and discard 2000 rows on every page. A cursor encodes the position of the last seen row, so each page fetch is equally fast regardless of which page you're on.

To paginate through all stacks:

```typescript
async function listAllStacks(baseUrl: string, token: string) {
  const stacks = [];
  let cursor: string | undefined;

  do {
    const url = new URL("/api/stacks", baseUrl);
    url.searchParams.set("pageSize", "100");
    if (cursor) url.searchParams.set("continuationToken", cursor);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `token ${token}` },
    });
    const data = await res.json();

    stacks.push(...data.stacks);
    cursor = data.continuationToken;
  } while (cursor);

  return stacks;
}
```

## CLI Usage

The Pulumi CLI's `pulumi stack ls` command lists stacks in the current project. It doesn't pass search parameters, so it returns all stacks for the project you're working in.

For more targeted queries, call the API directly as shown above or use the dashboard search.

## How the Search Index Works

Every stack has a `search_vector` column of type `tsvector`. A PostgreSQL trigger automatically recomputes this vector whenever a stack's name, project, or tags change. The vector is indexed with a GIN index, which makes full-text queries fast even across large tables.

The search vector includes:
- Stack name (weighted `A`)
- Project name (weighted `B`)
- Tag names and values (weighted `C`)

The `A/B/C` weighting means a query like `my-app` ranks stacks where the name matches higher than stacks where only a tag matches. PostgreSQL's `ts_rank` function computes the final score.

Tag filtering (`tagName`/`tagValue`) uses a separate JSONB index on the tags column — it's an equality filter, not a full-text match, so it's exact and fast.
