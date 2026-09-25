#!/usr/bin/env node
/**
 * Search tool for evidence gathering in this repository.
 *
 * General web search engines block datacenter egress IPs, so `web_search` is
 * unusable here. These are the no-credential sources that do work: academic
 * indexes, the arXiv API, and Hacker News. Run with no arguments to see usage.
 *
 *   node scripts/research/search.mjs papers "online dating deception detection"
 *   node scripts/research/search.mjs arxiv "romance scam detection"
 *   node scripts/research/search.mjs cited "grooming detection" --min-citations 50
 *   node scripts/research/search.mjs news "AI coding agent" --limit 20
 *
 * Every hit is printed with an identifier that can be passed to `fetch` to pull
 * the record or full text.
 */
import { argv, exit } from 'node:process';

const USAGE = `
Usage: search.mjs <command> <query> [options]

Commands
  papers    <query>   Academic works (OpenAlex). Full-text search.
  arxiv     <query>   Preprints (arXiv API).
  cited     <query>   Academic works, most-cited first. Use --min-citations N.
  news      <query>   Hacker News discussions. Good for practitioner experience.
  fetch     <id>      Print a full record: openalex ID, arXiv ID, or HN object ID.

Options
  --limit N           Results to return (default 10, max 50)
  --min-citations N   For "cited": drop works below this citation count
  --year N            For "papers": only works published in or after this year
  --open              For "papers": restrict to open-access works
Sources
  OpenAlex   https://docs.openalex.org  (no credential required)
  arXiv      https://info.arxiv.org/help/api  (no credential required)
  Hacker News Algolia  https://hn.algolia.com/api  (no credential required)
`.trimStart();

const [command, ...rest] = argv.slice(2);

function parseFlags(args) {
  const flags = { limit: 10, minCitations: 0, year: 0, open: false, positional: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--limit') flags.limit = Number(args[++i]);
    else if (arg === '--min-citations') flags.minCitations = Number(args[++i]);
    else if (arg === '--year') flags.year = Number(args[++i]);
    else if (arg === '--open') flags.open = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else flags.positional.push(arg);
  }
  return flags;
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'been-there-research/0.1 (repo research script)' },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }
  return response.json();
}

async function openAlex(query, flags, sort) {
  const filters = [`fulltext.search:${query}`];
  if (flags.year) filters.push(`from_publication_date:${flags.year}-01-01`);
  if (flags.open) filters.push('is_oa:true');
  if (flags.minCitations) filters.push(`cited_by_count:>${flags.minCitations}`);
  const params = new URLSearchParams({
    search: query,
    per_page: String(Math.min(flags.limit, 50)),
    sort,
    select: 'id,display_name,publication_year,doi,cited_by_count,type,primary_location,open_access',
  });
  if (filters.length > 1) params.set('filter', filters.join(','));
  const data = await getJson(`https://api.openalex.org/works?${params}`);
  return data.results.map((work) => ({
    id: work.id,
    title: work.display_name,
    year: work.publication_year,
    citations: work.cited_by_count,
    type: work.type,
    doi: work.doi,
    oa: work.open_access?.is_oa ?? false,
    url: work.primary_location?.landing_page_url ?? work.doi,
  }));
}

async function arxiv(query, flags) {
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(
    `"${query}"`,
  )}&start=0&max_results=${Math.min(flags.limit, 50)}&sortBy=relevance`;
  const xml = await (
    await fetch(url, { headers: { 'User-Agent': 'been-there-research/0.1' } })
  ).text();
  const entries = xml.split('<entry>').slice(1);
  return entries.map((entry) => {
    const pick = (tag) => (entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) ?? [, ''])[1].trim();
    return {
      id: pick('id'),
      title: pick('title').replace(/\s+/g, ' '),
      authors: (pick('author').match(/<name>([^<]*)<\/name>/g) ?? []).length,
      published: pick('published').slice(0, 10),
      summary: pick('summary').replace(/\s+/g, ' ').slice(0, 400),
    };
  });
}

async function hn(query, flags) {
  const data = await getJson(
    `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${Math.min(
      flags.limit,
      50,
    )}`,
  );
  return data.hits.map((hit) => ({
    id: hit.objectID,
    title: hit.title ?? hit.story_title,
    points: hit.points,
    comments: hit.num_comments,
    created: hit.created_at?.slice(0, 10),
    url: hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
  }));
}

async function fetchRecord(id) {
  if (id.includes('openalex.org/works/')) {
    const slug = id.split('/works/')[1];
    return getJson(`https://api.openalex.org/works/${slug}`);
  }
  if (id.includes('arxiv.org/abs/')) {
    return arxiv(id.split('/abs/')[1], { limit: 1 });
  }
  return getJson(`https://hn.algolia.com/api/v1/items/${id}`);
}

const COMMANDS = {
  papers: (q, f) => openAlex(q, f, 'relevance_score:desc'),
  cited: (q, f) => openAlex(q, f, 'cited_by_count:desc'),
  arxiv: (query, flags) => arxiv(query, flags),
  news: (query, flags) => hn(query, flags),
};

if (!command || command === 'help' || command === '--help' || command === '-h') {
  console.log(USAGE);
  exit(0);
}

const flags = parseFlags(rest);
if (flags.help) {
  console.log(USAGE);
  exit(0);
}

if (command === 'fetch') {
  const [id] = flags.positional;
  if (!id) {
    console.error('fetch requires an id: an OpenAlex work URL, an arXiv abs URL, or an HN object id.');
    exit(1);
  }
  console.log(JSON.stringify(await fetchRecord(id), null, 2));
  exit(0);
}

const handler = COMMANDS[command];
if (!handler) {
  console.error(`Unknown command '${command}'. Run with --help for usage.`);
  exit(1);
}

const query = flags.positional.join(' ').trim();
if (query === '') {
  console.error(`'${command}' requires a query.`);
  exit(1);
}

try {
  const results = await handler(query, flags);
  if (results.length === 0) {
    console.error(`No results for '${query}' via ${command}.`);
    exit(1);
  }
  console.log(`# ${results.length} result(s) for '${query}' via ${command}\n`);
  for (const [index, result] of results.entries()) {
    console.log(`${index + 1}. ${JSON.stringify(result, null, 2).replace(/\n/g, '\n   ')}`);
    console.log('');
  }
} catch (error) {
  console.error(`Search failed: ${error.message}`);
  exit(1);
}
