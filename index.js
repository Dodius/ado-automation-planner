// -------------------------------------------------------------
// index.js - Express server for Azure DevOps Gantt dashboard
// -------------------------------------------------------------
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

// --- environment --------------------------------------------------------------
const {
  ADO_ORG = 'olsom-net',
  ADO_PROJECT = 'POL',
  ADO_PAT,
  ROOT_ID = 14681,
  PORT = 3000
} = process.env;

if (!ADO_PAT) {
  console.error('❌  ADO_PAT missing – copy .env.example ➜ .env and fill in your token');
  process.exit(1);
}

// --- Axios client for Azure DevOps REST API ----------------------------------
const ado = axios.create({
  baseURL: `https://dev.azure.com/${ADO_ORG}/_apis/`,
  auth: { username: '', password: ADO_PAT },
  headers: { 'Content-Type': 'application/json' },
  params: { 'api-version': '7.0' }
});

// --- Express setup -----------------------------------------------------------
const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Simple timestamped logger used for verbose tracing
function trace(...args) {
  console.log(new Date().toISOString(), ...args);
}

// --- helpers -----------------------------------------------------------------
/** Run WIQL query and return raw result */
async function runWiql(query) {
  trace('[runWiql] query', query);
  const { data } = await ado.post('wit/wiql', { query });
  trace('[runWiql] returned',
    data?.workItems?.length || data?.workItemRelations?.length || 0,
    'items');
  return data;
}

/** Batch read work items by id */
async function readWorkItems(ids, fields) {
  trace('[readWorkItems] ids', ids.length, 'fields', fields);
  const { data } = await ado.post('wit/workitemsbatch', { ids, fields });
  trace('[readWorkItems] received', data.value.length, 'items');
  return data.value;
}

/** Map ADO work item to front-end friendly shape */
function mapWorkItem(wi) {
  const f = wi.fields;
  trace('[mapWorkItem]', wi.id, f['System.Title'], {
    parent: f['System.Parent'],
    start: f['Microsoft.VSTS.Scheduling.StartDate'],
    finish: f['Microsoft.VSTS.Scheduling.FinishDate']
  });
  return {
    id: wi.id,
    name: f['System.Title'],
    type: f['System.WorkItemType'],
    parent: undefined,                 // will be filled from link table
    start: f['Microsoft.VSTS.Scheduling.StartDate'],

    est: f['Microsoft.VSTS.Scheduling.OriginalEstimate'] ?? 0,
    done: f['Microsoft.VSTS.Scheduling.CompletedWork'] ?? 0,
    state: f['System.State'],
    ...calcDates(f)
  };
}

/**
 * Fetch work item revision history and return hours completed in the last 7 days.
 * @param {number} id - Work item id.
 * @param {number} totalDone - Current CompletedWork value.
 */
async function completedWorkThisWeek(id, totalDone = 0) {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  try {
    const { data } = await ado.get(`wit/workitems/${id}/updates`, {
      params: { '$top': 200 }
    });
    let before = 0;
    for (const u of data.value || []) {
      const cw = u.fields?.['Microsoft.VSTS.Scheduling.CompletedWork'];
      if (!cw) continue;
      const d = new Date(u.revisedDate);
      if (d < weekAgo) {
        before = cw.newValue ?? cw.oldValue ?? before;
      }
    }
    return Math.max(0, (totalDone || 0) - before);
  } catch (err) {
    trace('[completedWorkThisWeek] failed', id, err.message || err);
    return 0;
  }
}

// --- routes ------------------------------------------------------------------
// GET /api/gantt/:rootId - flattened work item tree for a project
// GET /api/gantt/:rootId  – flattened tree for a project (phase → tasks)
/* -----------------------------------------------------------
   GET /api/gantt/:rootId
   ----------------------------------------------------------- */
app.get('/api/gantt/:rootId', async (req, res) => {
  const rootId = Number(req.params.rootId);
  trace('[gantt] rootId', rootId);

  try {
    /* 1️⃣ fetch hierarchy links */
    const wiqlText = `
      SELECT [System.Id]
      FROM WorkItemLinks
      WHERE
        [Source].[System.Id] = ${rootId}
        AND [System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward'
        AND [Target].[System.WorkItemType] IN ('Project','ITDemand','Task')
      MODE (Recursive)`;

    const { data: linkRes } = await ado.post('wit/wiql', { query: wiqlText });
    trace('[gantt] link relations', (linkRes.workItemRelations || []).length);
    const ids = [rootId, ...linkRes.workItemRelations
      .filter(r => r.target)
      .map(r => r.target.id)];

    trace('[gantt] linkIds', ids.length);

    if (!ids.length) return res.json([]);

    /* 2️⃣ batch-read ≤200 per call */
    const all = [];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      trace('[gantt] reading batch', i / 200 + 1, chunk.length, 'ids');

      const { data: batch } = await ado.post(
        'wit/workitemsbatch?api-version=7.0',
        {
          ids: chunk,
          fields: [
            'System.Id',
            'System.Title',
            'System.WorkItemType',
            'System.State',
            'System.Parent',
            'System.AssignedTo',
            'Microsoft.VSTS.Scheduling.OriginalEstimate',
            'Microsoft.VSTS.Scheduling.CompletedWork',
            'Microsoft.VSTS.Scheduling.DueDate',
            'Microsoft.VSTS.Scheduling.FinishDate',
            'Custom.Billable'
          ]
        },
        { headers: { 'Content-Type': 'application/json' } }
      );

      trace('[gantt] batch received', batch.value.length, 'items');
      all.push(...batch.value);
    }

    /* 3️⃣ map + parent lookup */
    // some rows have only source (no target) – guard against nulls
    const pLookup = new Map(
      (linkRes.workItemRelations || [])
        .filter(r => r.target && r.source)          // 👈 extra safety
        .map(r => [r.target.id, r.source.id])
    );

    const SIX_H = 6 * 60 * 60 * 1000;

    const rows = all.map(w => {
      const f = w.fields;
      const finish = new Date(
        f['Microsoft.VSTS.Scheduling.FinishDate'] ||
        f['Microsoft.VSTS.Scheduling.DueDate']    ||
        Date.now()
      );
      const estMs = (f['Microsoft.VSTS.Scheduling.OriginalEstimate'] || 0) * SIX_H;
      const start = new Date(finish.getTime() - estMs);

      const rawBillable = f['Custom.Billable'];
      const missing = {
        dueDate: !f['Microsoft.VSTS.Scheduling.DueDate'] && !f['Microsoft.VSTS.Scheduling.FinishDate'],
        effort: !(f['Microsoft.VSTS.Scheduling.OriginalEstimate'] > 0),
        billable: rawBillable == null
      };

      const row = {
        id: w.id,
        name: f['System.Title'],
        type: f['System.WorkItemType'],
        state: f['System.State'],
        parent: pLookup.get(w.id) ?? null,
        assignedTo: f['System.AssignedTo']?.displayName || f['System.AssignedTo'] || '',
        start, finish,
        est: f['Microsoft.VSTS.Scheduling.OriginalEstimate'] || 0,
        done: f['Microsoft.VSTS.Scheduling.CompletedWork']   || 0,
        billable: rawBillable == null
          ? null
          : (typeof rawBillable === 'string'
            ? ['yes', 'true'].includes(rawBillable.toLowerCase())
            : !!rawBillable),
        missing
      };
      trace('[gantt] row', row.id, row.name, 'parent', row.parent, 'start', row.start, 'finish', row.finish);
      return row;
    });
    // --- compute weekly completed hours --------------------------------------
    const taskRows = rows.filter(r => r.type === 'Task');
    await Promise.all(taskRows.map(async r => {
      r.doneWeek = await completedWorkThisWeek(r.id, r.done);
    }));

    // --- aggregate phase dates ----------------------------------------------
    const phaseRe = /^P[1-9]\./i;
    for (const phase of rows.filter(r => phaseRe.test(r.name))) {
      const children = rows.filter(t => t.parent === phase.id);
      if (!children.length) continue;
      phase.start = new Date(Math.min(...children.map(c => c.start?.getTime())));
      phase.finish = new Date(Math.max(...children.map(c => c.finish?.getTime())));
      trace('[gantt] phase aggregated', phase.id, phase.name, 'start', phase.start, 'finish', phase.finish, 'children', children.length);
    }

    /* 4️⃣ depth-first order */
    const bucket = {};
    rows.forEach(r => (bucket[r.parent ?? 'root'] ??= []).push(r));

    // parent rows shouldn't report missing info if they have children
    for (const [pid, kids] of Object.entries(bucket)) {
      if (pid === 'root' || !kids.length) continue;
      const parent = rows.find(r => r.id === Number(pid));
      if (parent) parent.missing = { dueDate: false, effort: false, billable: false };
    }

    function dfs(pid, out = [], d = 0) {
      (bucket[pid] || []).forEach(r => { r.depth = d; out.push(r); dfs(r.id, out, d + 1); });
      return out;
    }

    const ordered = dfs('root');
    trace('[gantt] returning', ordered.length, 'rows');
    res.json(ordered);

  } catch (err) {
    console.error('[gantt] AXIOS error\n', err.toJSON?.() || err);
    res.status(500).json({ error: 'Azure DevOps fetch failed', detail: err.message });
  }
});



// GET /api/locations?team=xxx - list of Location work items
app.get('/api/locations', async (req, res) => {
  const team = req.query.team || ADO_PROJECT;
  trace('[GET /api/locations] team', team);

  try {
    const wiql = `
      SELECT [System.Id], [System.Title]
      FROM WorkItems
      WHERE [System.WorkItemType] = 'Location'
        AND [System.TeamProject] = '${team}'
        AND [System.State] <> 'Closed'`;

    const result = await runWiql(wiql);
    trace('[GET /api/locations] WIQL returned', result.workItems.length, 'items');
    const ids = result.workItems.map(w => w.id);
    const batch = await readWorkItems(ids, ['System.Id', 'System.Title']);
    trace('[GET /api/locations] batch returned', batch.length, 'items');
    const list = batch.map(w => ({ id: w.id.toString(), title: w.fields['System.Title'] }));
    res.json(list);
  } catch (err) {
    console.error('[/api/locations] ERROR', err?.response?.data || err.message || err);
    res.status(500).json({ error: 'location list failed' });
  }
});

// GET /api/projects?location=xxx&team=yyy - list of Project work items
app.get('/api/projects', async (req, res) => {
  const locationTitle = req.query.location;
  const team = req.query.team;
  if (!locationTitle || !team) {
    return res.status(400).json({ error: 'Missing location or team' });
  }
  trace('[GET /api/projects] team', team, 'location', locationTitle);

  try {
    const wiql = `
      SELECT [System.Id]
      FROM WorkItemLinks
      WHERE [Source].[System.WorkItemType] = 'Location'
        AND [Source].[System.Title] = '${locationTitle}'
        AND [System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward'
      MODE (Recursive)`;

    const linkResult = await runWiql(wiql);
    trace('[GET /api/projects] link relations', (linkResult.workItemRelations || []).length);
    const ids = (linkResult.workItemRelations || [])
      .map(link => link.target?.id)
      .filter(Boolean);

    if (!ids.length) return res.json([]);

    const allResults = [];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      trace('[GET /api/projects] reading batch', i / 200 + 1, chunk.length);
      const batch = await readWorkItems(chunk, [
        'System.Id',
        'System.Title',
        'System.State',
        'System.WorkItemType',
        'Microsoft.VSTS.Scheduling.OriginalEstimate',
        'Microsoft.VSTS.Scheduling.CompletedWork'
      ]);
      trace('[GET /api/projects] batch returned', batch.length);
      allResults.push(...batch);
    }

    const list = allResults
      .filter(w => w.fields['System.WorkItemType'] === 'Project')
      .map(w => {
        const f = w.fields;
        return {
          id: w.id.toString(),
          title: f['System.Title'],
          state: f['System.State'],
          est: f['Microsoft.VSTS.Scheduling.OriginalEstimate'] || 0,
          done: f['Microsoft.VSTS.Scheduling.CompletedWork'] || 0
        };
      });

    trace('[GET /api/projects] returning', list.length, 'projects');
    res.json(list);
  } catch (err) {
    console.error('[/api/projects] Caught error:', err?.response?.data || err.message || err);
    if (!res.headersSent) res.status(500).json({ error: 'project list failed' });
  }
});

// PATCH /api/task/:id - update a single work item
app.patch('/api/task/:id', async (req, res) => {
  const id = req.params.id;
  trace('[/api/task] incoming PATCH', { id, body: req.body });

  try {
    let ops = [];
    if (Array.isArray(req.body)) {
      ops = req.body;
    } else {
      const { name, dueDate, duration, assignedTo, parent, billable } =
        req.body || {};

      if (name) {
        ops.push({ op: 'add', path: '/fields/System.Title', value: name });
      }

      const finishIso = dueDate ? new Date(dueDate).toISOString() : null;
      if (finishIso) {
        ops.push({
          op: 'add',
          path: '/fields/Microsoft.VSTS.Scheduling.DueDate',
          value: finishIso
        });
        ops.push({
          op: 'add',
          path: '/fields/Microsoft.VSTS.Scheduling.FinishDate',
          value: finishIso
        });
      }

      if (typeof duration === 'number') {
        ops.push({
          op: 'add',
          path: '/fields/Microsoft.VSTS.Scheduling.OriginalEstimate',
          value: duration
        });
        if (finishIso) {
          const startIso = new Date(
            new Date(finishIso).getTime() - duration * SIX_HOURS_MS
          ).toISOString();
          ops.push({
            op: 'add',
            path: '/fields/Microsoft.VSTS.Scheduling.StartDate',
            value: startIso
          });
        }
      }

      if (assignedTo) {
        ops.push({
          op: 'add',
          path: '/fields/System.AssignedTo',
          value: assignedTo
        });
      }

      if (parent) {
        ops.push({
          op: 'add',
          path: '/fields/System.Parent',
          value: Number(parent)
        });
      }

      if (billable != null) {
        ops.push({ op: 'add', path: '/fields/Custom.Billable', value: billable });
      }
    }

    trace('[/api/task] JSON-Patch operations', ops);

    if (!ops.length) {
      trace('[/api/task] no changes detected, returning early');
      return res.json({ ok: true });
    }

    const url = `wit/workitems/${id}?api-version=7.0`;
    trace('[/api/task] PATCH', url);

    const { data } = await ado.patch(url, ops, {
      headers: { 'Content-Type': 'application/json-patch+json' }
    });

    trace('[/api/task] Azure DevOps responded with id', data.id);
    res.json({ ok: true, id: data.id });
  } catch (err) {
    console.error(
      '[/api/task] update failed',
      err?.response?.data || err.message || err
    );
    res.status(500).json({ error: 'update failed' });
  }
});

function calcDates(f) {
  // 1️⃣ pick a finish date
  const finish = new Date(
    f['Microsoft.VSTS.Scheduling.FinishDate'] ||
    f['Microsoft.VSTS.Scheduling.DueDate']    ||
    Date.now()
  );

  // 2️⃣ estimate duration (hrs ➜ ms)
  const estHrs = f['Microsoft.VSTS.Scheduling.OriginalEstimate'] || 0;
  const durationMs = estHrs * SIX_HOURS_MS;

  // 3️⃣ synthetic start = finish - duration
  const start = new Date(finish.getTime() - durationMs);
  trace('[calcDates]', { estHrs, start, finish });
  return { start, finish };
}



// catch-all 404 for api routes
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// start server
app.listen(PORT, () => console.log(`🚀  http://localhost:${PORT}`));
