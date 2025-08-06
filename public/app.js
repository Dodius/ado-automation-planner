// -------------------------------------------------------------
// public/app.js
// Front-end logic for Azure DevOps Gantt dashboard.
// -------------------------------------------------------------

function $id(id) {
  return document.getElementById(id);
}

const teamPicker     = $id('teamPicker');
const locationPicker = $id('locationPicker');
const projectPicker  = $id('projectPicker');
const zoomPicker     = $id('zoomPicker');
const phaseToggle    = $id('phaseToggle');
const summaryDiv     = $id('summary');

let allRows = [];
let filteredRowsCached = [];
let currentRootId = new URLSearchParams(location.search).get('id') || '14681';

let ganttInited = false;
// All dates are shown in European format for readability
// Include time to avoid truncating short tasks
const DATE_FMT = 'DD.MM.YYYY HH:mm';

// Helper: return up to two-character initials for the assignee column
function getInitials(name = '') {
  return name
    .split(/\s+/)
    .map(w => w[0])
    .join('')
    .substring(0, 2)
    .toUpperCase();
}

// --- task editor elements ----------------------------------------------------
const taskEditor        = $id('taskEditor');
const taskIdInput       = $id('taskId');
const taskTitleInput    = $id('taskTitle');
const taskDueInput      = $id('taskDue');
const taskEstInput      = $id('taskEst');
const taskBillableInput = $id('taskBillable');
const taskDoneInput     = $id('taskDone');
const taskSaveBtn       = $id('taskSave');
const taskCloseBtn      = $id('taskClose');

function isEditable() {
  return document.getElementById('editableCheckbox')?.checked;
}

function normalizeBool(v) {
  if (typeof v === 'string') {
    return ['yes', 'true'].includes(v.toLowerCase());
  }
  return !!v;
}

const IS_PHASE = name => /^P[1-9]/i.test(name);
const PHASE_CLASS = p =>
  /^P1/i.test(p) ? 'phase-1 phase-line' :
  /^P2/i.test(p) ? 'phase-2 phase-line' :
  /^P3/i.test(p) ? 'phase-3 phase-line' :
  /^P4/i.test(p) ? 'phase-4 phase-line' :
  /^P5/i.test(p) ? 'phase-5 phase-line' :
  /^P6/i.test(p) ? 'phase-6 phase-line' :
  /^P7/i.test(p) ? 'phase-7 phase-line' :
  /^P8/i.test(p) ? 'phase-8 phase-line' :
  /^P9/i.test(p) ? 'phase-9 phase-line' : 'phase-x';

function mapRowsToTasks(rows) {
  // Convert backend rows to the shape expected by dhtmlxGantt
  const childCounts = rows.reduce((acc, r) => {
    if (r.parent) acc[r.parent] = (acc[r.parent] || 0) + 1;
    return acc;
  }, {});

  return rows.map(r => {
    const progress = r.est ? Math.min(1, (r.done / r.est)) : 0;
    const isPhase = IS_PHASE(r.name);
    const hasChildren = !!childCounts[r.id];
    const missing = r.missing || {};
      const missingAny =
      r.type === 'Task' && !hasChildren &&
      (missing.dueDate || missing.effort || missing.billable);
      const task = {
      id: r.id,
      text: r.name,
      // Convert dates from API (ISO) ➜ UI with time component
      start_date: r.start ? moment(r.start).format(DATE_FMT) : null,
      end_date: r.finish ? moment(r.finish).format(DATE_FMT) : null,
      progress,
      parent: r.parent || 0,
      open: true,
      type: (isPhase || hasChildren) ? gantt.config.types.project : gantt.config.types.task,
      css: isPhase ? PHASE_CLASS(r.name) : '',
      est: r.est,
      done: r.done,
      doneWeek: r.doneWeek || 0,
      billable: r.billable == null ? null : normalizeBool(r.billable),
      assignedTo: r.assignedTo || '',
      missing,
      missingAny
    };
    console.debug('[mapRowsToTasks] mapped', task.id, task.text, {
      parent: task.parent,
      start: task.start_date,
      end: task.end_date,
      isPhase
    });
    return task;
  });
}

function setScale(fmt) {
  const dayFmt = gantt.date.date_to_str('%d.%m');
  switch (fmt) {
    case 'Day':
      gantt.config.scales = [
        { unit: 'day', step: 1, format: gantt.date.date_to_str('%d.%m.%Y') },
        { unit: 'hour', step: 1, format: '%H:%i' }
      ];
      break;
    case 'Month':
      gantt.config.scales = [
        { unit: 'month', step: 1, format: '%F %Y' },
        { unit: 'week', step: 1, format: '#%W' }
      ];
      break;
    case 'Week':
    default:
      gantt.config.scales = [
        { unit: 'week', step: 1, format: 'Week #%W' },
        { unit: 'day', step: 1, format: dayFmt }
      ];
  }
}

function drawGantt(tasks) {
  const fmt = (zoomPicker?.value || 'Week');
  console.log('[drawGantt] rendering', tasks.length, 'tasks in', fmt, 'format');

  if (!ganttInited) {
    // Base chart configuration
    gantt.config.date_format = '%d.%m.%Y %H:%i';
    gantt.config.row_height = 24;
    gantt.config.task_height = 18;
    gantt.config.autosize = 'y';
    gantt.config.columns_resize = true;
    // Visual tweaks
    gantt.templates.task_class = (s, e, task) => task.css || '';
    gantt.templates.task_text = (_s, _e, t) => t.text;
    gantt.templates.timeline_cell_class = (_task, date) => {
      const day = date.getDay();
      //return day >= 1 && day <= 5 ? 'weekday' : '';
      return day === 0 || day === 6 ? 'weekend' : '';
    };
    gantt.templates.scale_cell_class = date => {
      const day = date.getDay();
      //return day >= 1 && day <= 5 ? 'weekday' : '';
      return day === 0 || day === 6 ? 'weekend' : '';
    };
    // Helper to wrap cell text when any mandatory field is missing
    // const wrapMissing = (txt, t) =>
    //   t.missingAny ? `<span class="missing-data">${txt}</span>` : txt;
        // Build a human readable tooltip of missing fields for a task
    const missingTooltip = t => {
      const fieldNames = {
        dueDate: 'due date',
        effort: 'effort',
        billable: 'billable'
      };
      return Object.entries(t.missing || {})
        .filter(([, absent]) => absent)
        .map(([key]) => fieldNames[key] || key)
        .join(', ');
    };

    // Helper to wrap cell text when any mandatory field is missing
    const wrapMissing = (txt, t) => {
      if (!t.missingAny) return txt;
      const tooltip = missingTooltip(t);
      const titleAttr = tooltip ? ` title="Missing: ${tooltip}"` : '';
      return `<span class="missing-data"${titleAttr}>${txt}</span>`;
    };
    // Grid columns (Title + task card fields)
    gantt.config.columns = [
      { name: 'text', label: 'Title', tree: true, width: 300, resize: true, template: t => wrapMissing(t.text, t) },
      {
        name: 'dueDate',
        label: 'Due',
        align: 'center',
        width: 60,
        template: t => wrapMissing(t.end_date ? moment(t.end_date).format('DD.MM') : '', t)
      },
      {
        name: 'est',
        label: 'Orig Est',
        align: 'center',
        width: 70,
        template: t => wrapMissing(t.est ? t.est : '', t)
      },
      {
        name: 'billable',
        label: 'Billable',
        align: 'center',
        width: 70,
        template: t => {
          const b = normalizeBool(t.billable);
          return wrapMissing(t.billable == null ? '' : (b ? 'Yes' : 'No'), t);
        }
      },
      {
        name: 'done',
        label: 'Completed',
        align: 'center',
        width: 80,
        template: t => t.done || 0
      },
      {
        name: 'doneWeek',
        label: 'This Week',
        align: 'center',
        width: 90,
        template: t => t.doneWeek || 0
      }
    ];
    // Log and forward client edits to the backend
    gantt.attachEvent('onAfterTaskUpdate', async (id, item) => {
      console.log('[taskupdate]', id, item);
      const patch = buildPatch(item);
      if (!patch.length) return;
      try {
        const r = await fetch(`/api/task/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json-patch+json' },
          body: JSON.stringify(patch)
        });
        if (!r.ok) throw new Error(r.statusText);
        console.log('✅ DevOps updated');
      } catch (e) {
        console.error('❌ PATCH failed', e);
      }
    });
    gantt.attachEvent('onTaskClick', function (id, e) {
      const task = gantt.getTask(id);
      taskIdInput.value = task.id;
      taskTitleInput.value = task.text;
      taskDueInput.value = task.end_date ? moment(task.end_date, DATE_FMT).format('YYYY-MM-DD') : '';
      taskEstInput.value = task.est || 0;
      taskBillableInput.checked = normalizeBool(task.billable);
      taskDoneInput.value = task.done || 0;
      taskEditor.style.display = 'block';
      return false;
    });
    gantt.init('GanttChartDIV');
    ganttInited = true;
  }

  gantt.clearAll();
  gantt.config.readonly = !isEditable();
  setScale(fmt);
  gantt.parse({ data: tasks });
  tasks.filter(t => IS_PHASE(t.text)).forEach(p => {
    const childCount = tasks.filter(t => t.parent === p.id).length;
    console.debug('[drawGantt] phase', p.id, p.text, {
      start: p.start_date,
      end: p.end_date,
      childCount
    });
  });
  // ensure the chart keeps the full width after filtering
  gantt.setSizes();
}

function updateSummary(rows) {
  if (!summaryDiv) return;
  const sold = rows.find(r => r.type === 'ITDemand')?.est || 0;
  const totalEst = rows
    .filter(r => r.type === 'Task')
    .reduce((s, r) => s + (r.est || 0), 0);
  const totalDone = rows
    .filter(r => r.type === 'Task')
    .reduce((s, r) => s + (r.done || 0), 0);
  const totalWeek = rows
    .filter(r => r.type === 'Task')
    .reduce((s, r) => s + (r.doneWeek || 0), 0);
  summaryDiv.textContent =
    `Sold: ${sold}h | Est: ${totalEst}h | Done: ${totalDone}h | This Week: ${totalWeek}h`;
}

function buildPatch(task) {
  const patch = [];
  // Convert dates back to ISO for the backend update call
  if (task.start_date) {
    patch.push({ op: 'replace', path: '/fields/StartDate', value: moment(task.start_date, DATE_FMT).format('YYYY-MM-DD') });
  }
  if (task.end_date) {
    patch.push({ op: 'replace', path: '/fields/FinishDate', value: moment(task.end_date, DATE_FMT).format('YYYY-MM-DD') });
  }
  if (task.text) {
    patch.push({ op: 'replace', path: '/fields/System.Title', value: task.text });
  }
  if (task.assignedTo) {
    patch.push({ op: 'replace', path: '/fields/System.AssignedTo', value: task.assignedTo });
  }
  if (task.billable != null) {
    patch.push({ op: 'replace', path: '/fields/Custom.Billable', value: normalizeBool(task.billable) });
  }
  return patch;
}


function toggleEditable() {
  console.log('[toggleEditable] editable =', isEditable());
  drawGantt(mapRowsToTasks(filteredRowsCached));
}

zoomPicker?.addEventListener('change', () =>
  drawGantt(mapRowsToTasks(filteredRowsCached))
);

phaseToggle?.addEventListener('change', () => {
  const filtered = phaseToggle.checked
    ? allRows.filter(r => !r.parent || IS_PHASE(r.name))
    : allRows;
  filteredRowsCached = filtered;
  drawGantt(mapRowsToTasks(filteredRowsCached));
});

function resetTaskEditor() {
  taskIdInput.value = '';
  taskTitleInput.value = '';
  taskDueInput.value = '';
  taskEstInput.value = '';
  taskBillableInput.checked = false;
  taskDoneInput.value = '';
  taskEditor.style.display = 'none';
}

taskSaveBtn?.addEventListener('click', async () => {
  const id = taskIdInput.value;
  if (!id) return;

    const task = gantt.getTask(id);
  if (taskTitleInput.value) task.text = taskTitleInput.value;
  if (taskDueInput.value) {
    task.end_date = moment(taskDueInput.value).format(DATE_FMT);
  }

  const duration = Number(taskEstInput.value);
  if (duration) task.est = duration;

  task.billable = taskBillableInput.checked;

  const patch = buildPatch(task);
  if (duration) {
    patch.push({
      op: 'replace',
      path: '/fields/Microsoft.VSTS.Scheduling.OriginalEstimate',
      value: duration
    });
  }
  console.log('[taskSave] sending PATCH payload', patch);
  if (!patch.length) {
    resetTaskEditor();
    return;
  }

  try {
    const res = await fetch(`/api/task/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json-patch+json' },
      body: JSON.stringify(patch)
    });
    const data = await res.json().catch(() => ({}));
    console.log('[taskSave] response', res.status, data);
  } catch (err) {
    console.error('[taskSave] network error', err);
  }

  loadGantt(currentRootId);
  resetTaskEditor();
});

taskCloseBtn?.addEventListener('click', resetTaskEditor);

// Close the editor when clicking outside of it
document.addEventListener('click', e => {
  if (
    taskEditor.style.display === 'block' &&
    !taskEditor.contains(e.target) &&
    !e.target.closest('.gantt_task_line, .gantt_row')
  ) {
    resetTaskEditor();
  }
});

async function loadGantt(rootId) {
  console.log('[loadGantt] rootId=', rootId);
  const res = await fetch(`/api/gantt/${rootId}`);
  console.log('[loadGantt] status', res.status);
  const rows = await res.json();
  console.log('[loadGantt] received', rows.length, 'rows');
  allRows = rows;
  const filtered = phaseToggle.checked
    ? rows.filter(r => !r.parent || IS_PHASE(r.name))
    : rows;
  filteredRowsCached = filtered;
  drawGantt(mapRowsToTasks(filteredRowsCached));
  updateSummary(rows);
}

async function populateProjects(location, team) {
  if (!location || !team) return;
  console.log('[populateProjects] location=', location, 'team=', team);
  const res = await fetch(`/api/projects?location=${encodeURIComponent(location)}&team=${encodeURIComponent(team)}`);
  console.log('[populateProjects] status', res.status);
  const list = await res.json();
  console.log('[populateProjects] items', list.length);
  projectPicker.innerHTML = '';
  if (!Array.isArray(list) || !list.length) {
    projectPicker.innerHTML = '<option disabled>(No projects found)</option>';
    return;
  }
  for (const p of list) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.title} (${p.done}/${p.est}h)`;
    projectPicker.appendChild(opt);
  }
  projectPicker.selectedIndex = 0;
  loadGantt(projectPicker.value);
}

async function populateLocations(team) {
  if (!team) return;
  console.log('[populateLocations] team=', team);
  const res = await fetch(`/api/locations?team=${encodeURIComponent(team)}`);
  console.log('[populateLocations] status', res.status);
  const list = await res.json();
  console.log('[populateLocations] items', list.length);
  locationPicker.innerHTML = '';
  if (!Array.isArray(list) || !list.length) {
    locationPicker.innerHTML = '<option disabled>(No locations)</option>';
    return;
  }
  for (const loc of list) {
    const opt = document.createElement('option');
    opt.value = loc.title;
    opt.textContent = loc.title;
    locationPicker.appendChild(opt);
  }
  locationPicker.selectedIndex = 0;
  populateProjects(list[0].title, team);
}

function init() {
  projectPicker.addEventListener('change', () => loadGantt(projectPicker.value));
  teamPicker.addEventListener('change', () => populateLocations(teamPicker.value));
  locationPicker.addEventListener('change', () =>
    populateProjects(locationPicker.value, teamPicker.value)
  );

  if (teamPicker.value) {
    populateLocations(teamPicker.value);
  } else {
    loadGantt(currentRootId);
  }
}

document.addEventListener('DOMContentLoaded', init);

