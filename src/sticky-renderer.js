// Personal/sticky-board/src/renderer.js

const GROUP_COLORS = [
  '#6ee0ff', '#ffd166', '#b9f1c0', '#ce9bff',
  '#7af1c5', '#ff9f7f', '#ff6b9d', '#a8d8ff'
];

let state = { groups: [] };

function uuid() {
  return crypto.randomUUID();
}

function fitGroupName(el) {
  // Scale font size so the title fills its container without overflowing.
  const parent = el.parentElement;
  if (!parent) return;
  requestAnimationFrame(() => {
    const maxW = parent.clientWidth - 12;
    const maxH = parent.clientHeight - 10;
    if (maxW <= 0 || maxH <= 0) return;
    let size = 28;
    el.style.fontSize = size + 'px';
    while (size > 8 && (el.scrollWidth > maxW || el.scrollHeight > maxH)) {
      size -= 1;
      el.style.fontSize = size + 'px';
    }
  });
}

async function loadState() {
  state = await window.board.load();
  if (!state || !Array.isArray(state.groups)) state = { groups: [] };
  renderBoard();
}

function saveState() {
  window.board.save(state);
}

function renderBoard() {
  const boardEl = document.getElementById('board');
  // Destroy existing Sortable instances before clearing DOM
  if (typeof Sortable !== 'undefined') {
    boardEl.querySelectorAll('.task-list').forEach(list => Sortable.get(list)?.destroy());
    Sortable.get(boardEl)?.destroy();
  }
  boardEl.innerHTML = '';
  state.groups.forEach(group => boardEl.appendChild(renderGroup(group)));
  boardEl.appendChild(renderGroupGhost());
  initGroupSortable(boardEl);
}

function renderGroupGhost() {
  const ghost = document.createElement('div');
  ghost.className = 'group-ghost';
  ghost.tabIndex = 0;
  ghost.title = 'Press Enter to add a group';
  ghost.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addGroup(); }
  });
  ghost.addEventListener('click', addGroup);
  return ghost;
}

function renderTaskGhost(groupId) {
  const ghost = document.createElement('div');
  ghost.className = 'task-ghost';
  ghost.tabIndex = 0;
  ghost.dataset.groupId = groupId;
  ghost.title = 'Press Enter to add a note';
  ghost.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addTask(groupId); }
  });
  ghost.addEventListener('click', () => addTask(groupId));
  return ghost;
}

function updateNoteSize() {
  const wrap = document.getElementById('board-wrap');
  if (!wrap) return;
  const cs = getComputedStyle(wrap);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const boardGap = parseFloat(getComputedStyle(document.getElementById('board')).gap) || 8;
  const noteGap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--note-gap')) || 7;
  const inner = wrap.clientWidth - padX;
  const groups = 3;
  const groupW = (inner - (groups - 1) * boardGap) / groups;
  let noteSize = Math.floor((groupW - noteGap) / 2);
  noteSize = Math.max(56, Math.min(140, noteSize));
  document.documentElement.style.setProperty('--note-size', noteSize + 'px');
  document.querySelectorAll('.group-name').forEach(fitGroupName);
  document.querySelectorAll('.task-textarea').forEach(t => {
    t.style.height = 'auto';
    t.style.height = t.scrollHeight + 'px';
  });
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-archive-close').addEventListener('click', toggleArchive);
  document.addEventListener('keydown', handleViewSwitchKey);
  document.addEventListener('keydown', handleNavKey);
  document.addEventListener('keydown', handleLifecycleKey);
  document.addEventListener('keydown', handleMoveKey);
  window.addEventListener('resize', updateNoteSize);
  loadState().then(() => updateNoteSize());
  initNotesView();
});

function handleViewSwitchKey(e) {
  if (!e.ctrlKey || e.shiftKey || e.altKey) return;
  if (e.key === 'b' || e.key === 'B') { e.preventDefault(); setView('board'); }
  else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); setView('notes'); }
  else if (e.key === 'j' || e.key === 'J') { e.preventDefault(); setView('jarvis'); }
}

function setView(view) {
  const root = document.getElementById('sticky-root');
  document.body.dataset.view = view;
  if (view === 'jarvis') {
    return;
  }
  root.classList.remove('view-board', 'view-notes');
  root.classList.add('view-' + view);
  if (view === 'notes') {
    loadNotesIndex();
  } else {
    updateNoteSize();
  }
}

function renderGroup(group) {
  const col = document.createElement('div');
  col.className = 'group-col';
  col.dataset.groupId = group.id;
  col.style.setProperty('--group-color', group.color);

  const header = document.createElement('div');
  header.className = 'group-header';

  const dot = document.createElement('span');
  dot.className = 'group-color-dot';
  dot.addEventListener('click', (e) => { e.stopPropagation(); openColorPicker(e, group); });

  const nameEl = document.createElement('span');
  nameEl.className = 'group-name';
  nameEl.textContent = group.name;
  nameEl.tabIndex = 0;
  nameEl.addEventListener('click', (e) => { e.stopPropagation(); startRename(nameEl, group); });
  nameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.ctrlKey) { e.preventDefault(); startRename(nameEl, group); }
  });
  fitGroupName(nameEl);

  const addBtn = document.createElement('button');
  addBtn.className = 'group-add-btn';
  addBtn.textContent = '+';
  addBtn.title = 'Add task';
  addBtn.addEventListener('click', (e) => { e.stopPropagation(); addTask(group.id); });

  const delBtn = document.createElement('button');
  delBtn.className = 'group-delete-btn';
  delBtn.textContent = '✕';
  delBtn.title = 'Delete group';
  delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteGroup(group.id); });

  header.appendChild(dot);
  header.appendChild(nameEl);
  header.appendChild(addBtn);
  header.appendChild(delBtn);
  col.appendChild(header);

  const taskList = document.createElement('div');
  taskList.className = 'task-list';
  taskList.dataset.groupId = group.id;
  group.tasks.filter(t => !t.archived).forEach(task => {
    taskList.appendChild(renderTask(task, group));
  });
  taskList.appendChild(renderTaskGhost(group.id));
  col.appendChild(taskList);

  initTaskSortable(taskList);

  return col;
}

function renderTask(task, group) {
  const card = document.createElement('div');
  card.className = 'task-card' + (task.done ? ' done' : '');
  card.dataset.taskId = task.id;

  const textarea = document.createElement('textarea');
  textarea.className = 'task-textarea';
  textarea.value = task.text;
  textarea.rows = 1;
  textarea.addEventListener('input', () => {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
    task.text = textarea.value;
    saveState();
  });
  requestAnimationFrame(() => {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  });

  const actions = document.createElement('div');
  actions.className = 'task-actions';

  const tickBtn = document.createElement('button');
  tickBtn.className = 'btn-tick';
  tickBtn.textContent = '✓';
  tickBtn.title = task.done ? 'Uncheck' : 'Mark done';
  tickBtn.addEventListener('click', () => tickTask(task, card));

  const archiveBtn = document.createElement('button');
  archiveBtn.className = 'btn-archive-task';
  archiveBtn.textContent = '⊠';
  archiveBtn.title = 'Archive';
  archiveBtn.addEventListener('click', () => archiveTask(task.id, group.id));

  actions.appendChild(tickBtn);
  actions.appendChild(archiveBtn);
  card.appendChild(textarea);
  card.appendChild(actions);

  return card;
}

function addGroup() {
  const color = GROUP_COLORS[state.groups.length % GROUP_COLORS.length];
  const newGroup = { id: uuid(), name: 'New Group', color, tasks: [] };
  state.groups.push(newGroup);
  saveState();
  renderBoard();
  const col = document.querySelector(`.group-col[data-group-id="${newGroup.id}"]`);
  const nameEl = col?.querySelector('.group-name');
  if (nameEl) startRename(nameEl, newGroup);
}

function deleteGroup(groupId) {
  if (!confirm('Delete this group and all its tasks?')) return;
  state.groups = state.groups.filter(g => g.id !== groupId);
  saveState();
  renderBoard();
}

function addTask(groupId) {
  const group = state.groups.find(g => g.id === groupId);
  if (!group) return;
  const task = { id: uuid(), text: '', done: false, archived: false };
  group.tasks.push(task);
  saveState();
  const taskList = document.querySelector(`.task-list[data-group-id="${groupId}"]`);
  if (taskList) {
    const card = renderTask(task, group);
    const ghost = taskList.querySelector('.task-ghost');
    taskList.insertBefore(card, ghost);
    card.querySelector('textarea').focus();
  }
}

function tickTask(task, cardEl) {
  task.done = !task.done;
  saveState();
  cardEl.classList.toggle('done', task.done);
  cardEl.querySelector('.btn-tick').title = task.done ? 'Uncheck' : 'Mark done';
}

function archiveTask(taskId, groupId) {
  const group = state.groups.find(g => g.id === groupId);
  if (!group) return;
  const task = group.tasks.find(t => t.id === taskId);
  if (!task) return;
  task.archived = true;
  saveState();
  const card = document.querySelector(`.task-card[data-task-id="${taskId}"]`);
  if (card) card.remove();
  if (document.getElementById('archive-panel').classList.contains('open')) {
    renderArchivePanel();
  }
}

function toggleArchive() {
  const panel = document.getElementById('archive-panel');
  panel.classList.toggle('open');
  if (panel.classList.contains('open')) renderArchivePanel();
}

function renderArchivePanel() {
  const content = document.getElementById('archive-content');
  content.innerHTML = '';

  const sections = state.groups
    .map(g => ({ ...g, archived: g.tasks.filter(t => t.archived) }))
    .filter(g => g.archived.length > 0);

  if (sections.length === 0) {
    content.innerHTML = '<p style="color:var(--muted);font-size:12px;text-align:center;padding:24px 0">Nothing archived yet.</p>';
    return;
  }

  sections.forEach(({ id: groupId, name, color, archived }) => {
    const section = document.createElement('div');
    section.className = 'archive-group-section';

    const h4 = document.createElement('h4');
    h4.textContent = name;
    h4.style.borderBottomColor = color;
    section.appendChild(h4);

    archived.forEach(task => {
      const row = document.createElement('div');
      row.className = 'archive-task-row';
      row.tabIndex = 0;
      row.dataset.taskId = task.id;
      row.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.key === 'Backspace') {
          e.preventDefault();
          unarchiveTask(task.id, true);
        }
      });

      const text = document.createElement('span');
      text.className = 'archive-task-text';
      text.textContent = task.text || '(empty)';

      const btn = document.createElement('button');
      btn.className = 'btn-unarchive';
      btn.textContent = 'Restore';
      btn.addEventListener('click', () => unarchiveTask(task.id));

      row.appendChild(text);
      row.appendChild(btn);
      section.appendChild(row);
    });

    content.appendChild(section);
  });
}

function unarchiveTask(taskId, restoreDone = false) {
  for (const g of state.groups) {
    const task = g.tasks.find(t => t.id === taskId);
    if (task) {
      task.done = restoreDone;
      task.archived = false;
      break;
    }
  }
  saveState();
  renderBoard();
  if (document.getElementById('archive-panel').classList.contains('open')) {
    renderArchivePanel();
  }
}

function initGroupSortable(boardEl) {
  Sortable.create(boardEl, {
    animation: 150,
    handle: '.group-header',
    direction: 'horizontal',
    draggable: '.group-col',
    filter: '.group-ghost',
    ghostClass: 'sortable-ghost',
    dragClass: 'sortable-drag',
    onEnd(evt) {
      const moved = state.groups.splice(evt.oldIndex, 1)[0];
      state.groups.splice(evt.newIndex, 0, moved);
      saveState();
    }
  });
}

function initTaskSortable(taskListEl) {
  Sortable.create(taskListEl, {
    group: 'tasks',
    animation: 150,
    draggable: '.task-card',
    filter: '.task-ghost',
    ghostClass: 'sortable-ghost',
    dragClass: 'sortable-drag',
    onEnd(evt) {
      const fromGroupId = evt.from.dataset.groupId;
      const toGroupId = evt.to.dataset.groupId;

      // Sync task order for affected groups from DOM
      [evt.from, evt.to].forEach(listEl => {
        const gId = listEl.dataset.groupId;
        const group = state.groups.find(g => g.id === gId);
        if (!group) return;
        const domIds = [...listEl.querySelectorAll('.task-card')].map(c => c.dataset.taskId);
        const archived = group.tasks.filter(t => t.archived);
        const nonArchived = domIds.map(id => group.tasks.find(t => t.id === id)).filter(Boolean);
        group.tasks = [...nonArchived, ...archived];
      });

      saveState();

      // Color flows from parent .group-col via --group-color; nothing to update on the card itself.
    }
  });
}

let activePickerCleanup = null;

function openColorPicker(e, group) {
  if (activePickerCleanup) activePickerCleanup();

  const popup = document.createElement('div');
  popup.className = 'color-picker-popup';

  const dotRect = e.target.getBoundingClientRect();
  popup.style.top = (dotRect.bottom + 6) + 'px';
  popup.style.left = dotRect.left + 'px';

  GROUP_COLORS.forEach(color => {
    const swatch = document.createElement('div');
    swatch.className = 'color-swatch' + (color === group.color ? ' active' : '');
    swatch.style.background = color;
    swatch.addEventListener('click', (ev) => {
      ev.stopPropagation();
      setGroupColor(group.id, color);
      cleanup();
    });
    popup.appendChild(swatch);
  });

  document.getElementById('sticky-root').appendChild(popup);

  function cleanup() {
    popup.remove();
    document.removeEventListener('click', cleanup);
    activePickerCleanup = null;
  }

  activePickerCleanup = cleanup;
  setTimeout(() => document.addEventListener('click', cleanup), 0);
}

function setGroupColor(groupId, color) {
  const group = state.groups.find(g => g.id === groupId);
  if (!group) return;
  group.color = color;
  saveState();
  const col = document.querySelector(`.group-col[data-group-id="${groupId}"]`);
  if (!col) return;
  col.style.setProperty('--group-color', color);
}

const NAV_DIRS = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down'
};

function handleNavKey(e) {
  if (!e.ctrlKey || e.shiftKey) return;
  const dir = NAV_DIRS[e.key];
  if (!dir) return;
  const all = [...document.querySelectorAll('.task-textarea, .group-name, .task-ghost, .group-ghost')];
  if (all.length === 0) return;

  const active = document.activeElement;
  const navClasses = ['task-textarea', 'group-name', 'task-ghost', 'group-ghost'];
  const isOnTarget = active && navClasses.some(c => active.classList.contains(c));
  e.preventDefault();

  if (!isOnTarget) {
    focusNavTarget(all[0]);
    return;
  }

  const ar = active.getBoundingClientRect();
  const ax = ar.left + ar.width / 2;
  const ay = ar.top + ar.height / 2;

  let best = null;
  let bestScore = Infinity;
  for (const el of all) {
    if (el === active) continue;
    const r = el.getBoundingClientRect();
    const dx = (r.left + r.width / 2) - ax;
    const dy = (r.top + r.height / 2) - ay;
    let primary, secondary;
    if (dir === 'left')      { if (dx >= -2) continue; primary = -dx; secondary = Math.abs(dy); }
    else if (dir === 'right'){ if (dx <=  2) continue; primary =  dx; secondary = Math.abs(dy); }
    else if (dir === 'up')   { if (dy >= -2) continue; primary = -dy; secondary = Math.abs(dx); }
    else                     { if (dy <=  2) continue; primary =  dy; secondary = Math.abs(dx); }
    const score = primary + secondary * 2;
    if (score < bestScore) { bestScore = score; best = el; }
  }

  if (best) focusNavTarget(best);
}

function handleMoveKey(e) {
  if (!e.ctrlKey || !e.shiftKey) return;
  if (!NAV_DIRS[e.key]) return;
  const active = document.activeElement;
  if (!active || !active.classList.contains('task-textarea')) return;
  const card = active.closest('.task-card');
  if (!card) return;
  const taskId = card.dataset.taskId;
  const groupId = card.closest('.task-list')?.dataset.groupId;
  const gIdx = state.groups.findIndex(g => g.id === groupId);
  if (gIdx < 0) return;
  const group = state.groups[gIdx];
  const nonArchived = group.tasks.filter(t => !t.archived);
  const localIdx = nonArchived.findIndex(t => t.id === taskId);
  if (localIdx < 0) return;
  e.preventDefault();
  const dir = NAV_DIRS[e.key];
  const task = nonArchived[localIdx];

  if (dir === 'up' || dir === 'down') {
    const swapIdx = dir === 'up' ? localIdx - 1 : localIdx + 1;
    if (swapIdx < 0 || swapIdx >= nonArchived.length) return;
    const other = nonArchived[swapIdx];
    const absA = group.tasks.indexOf(task);
    const absB = group.tasks.indexOf(other);
    [group.tasks[absA], group.tasks[absB]] = [group.tasks[absB], group.tasks[absA]];
  } else {
    const targetGIdx = dir === 'left' ? gIdx - 1 : gIdx + 1;
    if (targetGIdx < 0 || targetGIdx >= state.groups.length) return;
    group.tasks = group.tasks.filter(t => t.id !== taskId);
    const target = state.groups[targetGIdx];
    const targetNon = target.tasks.filter(t => !t.archived);
    const insertAt = Math.min(localIdx, targetNon.length);
    const beforeId = targetNon[insertAt]?.id;
    const absInsert = beforeId
      ? target.tasks.findIndex(t => t.id === beforeId)
      : target.tasks.length - target.tasks.filter(t => t.archived).length;
    target.tasks.splice(absInsert, 0, task);
  }

  saveState();
  renderBoard();
  requestAnimationFrame(() => {
    const newCard = document.querySelector(`.task-card[data-task-id="${taskId}"]`);
    const ta = newCard?.querySelector('.task-textarea');
    if (ta) focusNavTarget(ta);
  });
}

function handleLifecycleKey(e) {
  if (!e.ctrlKey) return;
  if (e.key !== 'Enter' && e.key !== 'Backspace') return;
  const active = document.activeElement;
  if (!active || !active.classList.contains('task-textarea')) return;
  const card = active.closest('.task-card');
  if (!card) return;
  const taskId = card.dataset.taskId;
  const groupId = card.closest('.task-list')?.dataset.groupId;
  const group = state.groups.find(g => g.id === groupId);
  const task = group?.tasks.find(t => t.id === taskId);
  if (!task) return;
  e.preventDefault();
  if (e.key === 'Enter') {
    if (!task.done) {
      tickTask(task, card);
    } else {
      archiveTask(taskId, groupId);
    }
  } else {
    if (task.done) tickTask(task, card);
  }
}

function focusNavTarget(el) {
  el.focus();
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (el.tagName === 'TEXTAREA') {
    const len = el.value.length;
    el.setSelectionRange(len, len);
  }
}

function startRename(nameEl, group) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'group-name-input';
  input.value = group.name;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  function commit() {
    const newName = input.value.trim() || group.name;
    group.name = newName;
    saveState();
    const span = document.createElement('span');
    span.className = 'group-name';
    span.textContent = newName;
    span.tabIndex = 0;
    span.addEventListener('click', (e) => { e.stopPropagation(); startRename(span, group); });
    span.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.ctrlKey) { e.preventDefault(); startRename(span, group); }
    });
    input.replaceWith(span);
    fitGroupName(span);
    span.focus();
  }

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = group.name; input.blur(); }
  });
}

// ── Notes view ────────────────────────────────────────────────────────

let notesState = { groups: [] };
let notesLoaded = false;
let activeNoteId = null;
let activeNoteGroupId = null;
let noteBodyDirty = false;
let noteBodySaveTimer = null;

function initNotesView() {
  document.getElementById('btn-add-notes-group').addEventListener('click', addNotesGroup);
  document.addEventListener('keydown', handleNotesSidebarKey);

  const titleEl = document.getElementById('note-title');
  const bodyEl = document.getElementById('note-body');

  titleEl.addEventListener('input', () => {
    const note = findActiveNote();
    if (!note) return;
    note.title = titleEl.value;
    saveNotesIndex();
    const itemTitle = document.querySelector(
      `.notes-item[data-note-id="${activeNoteId}"] .notes-item-title`
    );
    if (itemTitle) itemTitle.textContent = note.title || '(untitled)';
  });

  bodyEl.addEventListener('input', () => {
    noteBodyDirty = true;
    clearTimeout(noteBodySaveTimer);
    noteBodySaveTimer = setTimeout(flushActiveNoteBody, 400);
  });
  bodyEl.addEventListener('blur', flushActiveNoteBody);
}

async function loadNotesIndex() {
  if (notesLoaded) return;
  notesState = await window.notes.loadIndex();
  if (!notesState || !Array.isArray(notesState.groups)) notesState = { groups: [] };
  notesLoaded = true;
  renderNotesSidebar();
  updateEditorEmpty();
}

function saveNotesIndex() {
  window.notes.saveIndex(notesState);
}

function flushActiveNoteBody() {
  if (!noteBodyDirty || !activeNoteId) return;
  const body = document.getElementById('note-body').value;
  noteBodyDirty = false;
  clearTimeout(noteBodySaveTimer);
  window.notes.write(activeNoteId, body);
}

function findActiveNote() {
  if (!activeNoteId || !activeNoteGroupId) return null;
  const g = notesState.groups.find(g => g.id === activeNoteGroupId);
  return g?.notes.find(n => n.id === activeNoteId) || null;
}

function renderNotesSidebar() {
  const container = document.getElementById('notes-groups');
  container.innerHTML = '';
  notesState.groups.forEach(group => container.appendChild(renderNotesGroup(group)));
}

function renderNotesGroup(group) {
  const wrap = document.createElement('div');
  wrap.className = 'notes-group';
  wrap.dataset.groupId = group.id;

  const header = document.createElement('div');
  header.className = 'notes-group-header';

  const dot = document.createElement('span');
  dot.className = 'notes-group-dot';
  dot.style.background = group.color || '#6ee0ff';

  const nameInput = document.createElement('input');
  nameInput.className = 'notes-group-name';
  nameInput.value = group.name;
  nameInput.addEventListener('input', () => {
    group.name = nameInput.value;
    saveNotesIndex();
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'notes-group-add';
  addBtn.textContent = '+';
  addBtn.title = 'Add note';
  addBtn.addEventListener('click', (e) => { e.stopPropagation(); addNote(group.id); });

  const delBtn = document.createElement('button');
  delBtn.className = 'notes-group-del';
  delBtn.textContent = '✕';
  delBtn.title = 'Delete group';
  delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteNotesGroup(group.id); });

  header.appendChild(dot);
  header.appendChild(nameInput);
  header.appendChild(addBtn);
  header.appendChild(delBtn);
  wrap.appendChild(header);

  const list = document.createElement('div');
  list.className = 'notes-list';
  group.notes.forEach(note => list.appendChild(renderNotesItem(note, group)));
  wrap.appendChild(list);

  return wrap;
}

function renderNotesItem(note, group) {
  const item = document.createElement('div');
  item.className = 'notes-item' + (note.id === activeNoteId ? ' active' : '');
  item.dataset.noteId = note.id;
  item.tabIndex = 0;

  const title = document.createElement('span');
  title.className = 'notes-item-title';
  title.textContent = note.title || '(untitled)';

  const del = document.createElement('button');
  del.className = 'notes-item-del';
  del.textContent = '✕';
  del.title = 'Delete note';
  del.addEventListener('click', (e) => { e.stopPropagation(); deleteNote(note.id, group.id); });

  item.appendChild(title);
  item.appendChild(del);

  item.addEventListener('click', () => selectNote(note.id, group.id));
  item.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); selectNote(note.id, group.id); }
  });

  return item;
}

function addNotesGroup() {
  const color = GROUP_COLORS[notesState.groups.length % GROUP_COLORS.length];
  const group = { id: uuid(), name: 'New Group', color, notes: [] };
  notesState.groups.push(group);
  saveNotesIndex();
  renderNotesSidebar();
  const input = document.querySelector(
    `.notes-group[data-group-id="${group.id}"] .notes-group-name`
  );
  input?.focus();
  input?.select();
}

function deleteNotesGroup(groupId) {
  const group = notesState.groups.find(g => g.id === groupId);
  if (!group) return;
  if (!confirm(`Delete group "${group.name}" and its ${group.notes.length} note(s)?`)) return;
  group.notes.forEach(n => window.notes.delete(n.id));
  if (activeNoteGroupId === groupId) clearActiveNote();
  notesState.groups = notesState.groups.filter(g => g.id !== groupId);
  saveNotesIndex();
  renderNotesSidebar();
  updateEditorEmpty();
}

function addNote(groupId) {
  const group = notesState.groups.find(g => g.id === groupId);
  if (!group) return;
  const note = { id: uuid(), title: 'New note' };
  group.notes.push(note);
  saveNotesIndex();
  window.notes.write(note.id, '');
  renderNotesSidebar();
  selectNote(note.id, groupId, { focusTitle: true });
}

async function deleteNote(noteId, groupId) {
  const group = notesState.groups.find(g => g.id === groupId);
  if (!group) return;
  const note = group.notes.find(n => n.id === noteId);
  if (!note) return;
  if (!confirm(`Delete note "${note.title || '(untitled)'}"?`)) return;
  group.notes = group.notes.filter(n => n.id !== noteId);
  await window.notes.delete(noteId);
  saveNotesIndex();
  if (activeNoteId === noteId) clearActiveNote();
  renderNotesSidebar();
  updateEditorEmpty();
}

async function selectNote(noteId, groupId, { focusTitle = false } = {}) {
  flushActiveNoteBody();
  activeNoteId = noteId;
  activeNoteGroupId = groupId;
  const note = findActiveNote();
  if (!note) { clearActiveNote(); updateEditorEmpty(); return; }

  document.querySelectorAll('.notes-item').forEach(el => {
    el.classList.toggle('active', el.dataset.noteId === noteId);
  });

  const titleEl = document.getElementById('note-title');
  const bodyEl = document.getElementById('note-body');
  titleEl.disabled = false;
  bodyEl.disabled = false;
  titleEl.value = note.title || '';
  bodyEl.value = '';
  bodyEl.placeholder = 'Loading…';
  const body = await window.notes.read(noteId);
  if (activeNoteId === noteId) {
    bodyEl.value = body;
    bodyEl.placeholder = 'Start typing…';
    noteBodyDirty = false;
    updateEditorEmpty();
    if (focusTitle) { titleEl.focus(); titleEl.select(); }
    else bodyEl.focus();
  }
}

function clearActiveNote() {
  activeNoteId = null;
  activeNoteGroupId = null;
  const titleEl = document.getElementById('note-title');
  const bodyEl = document.getElementById('note-body');
  titleEl.value = '';
  bodyEl.value = '';
  titleEl.disabled = true;
  bodyEl.disabled = true;
}

function updateEditorEmpty() {
  document.getElementById('view-notes').classList.toggle('empty', !activeNoteId);
}

function collectNotesNavTargets() {
  const targets = [];
  document.querySelectorAll('#notes-groups .notes-group').forEach(groupEl => {
    const groupId = groupEl.dataset.groupId;
    const nameEl = groupEl.querySelector('.notes-group-name');
    if (nameEl) targets.push({ el: nameEl, type: 'group', groupId });
    groupEl.querySelectorAll('.notes-item').forEach(itemEl => {
      targets.push({ el: itemEl, type: 'note', groupId, noteId: itemEl.dataset.noteId });
    });
  });
  const addBtn = document.getElementById('btn-add-notes-group');
  if (addBtn) targets.push({ el: addBtn, type: 'addGroup' });
  return targets;
}

function focusNotesTarget(t) {
  if (!t) return;
  t.el.focus();
  if (t.el.tagName === 'INPUT') t.el.select();
}

function handleNotesSidebarKey(e) {
  if (!document.getElementById('sticky-root').classList.contains('view-notes')) return;
  if (e.altKey || e.metaKey) return;
  const isArrow = e.key.startsWith('Arrow');
  const isEnter = e.key === 'Enter';
  if (!isArrow && !isEnter) return;
  if (isArrow && !e.ctrlKey) return;
  if (isEnter && e.ctrlKey) return;

  const active = document.activeElement;
  const titleEl = document.getElementById('note-title');
  const bodyEl = document.getElementById('note-body');

  if (isArrow && (active === titleEl || active === bodyEl)) {
    if (active === bodyEl && e.key === 'ArrowUp' && !titleEl.disabled) {
      e.preventDefault(); titleEl.focus(); titleEl.select(); return;
    }
    if (active === titleEl && e.key === 'ArrowDown' && !bodyEl.disabled) {
      e.preventDefault(); bodyEl.focus(); return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault(); focusNotesSidebar(); return;
    }
    return;
  }

  const targets = collectNotesNavTargets();
  if (targets.length === 0) return;
  const idx = targets.findIndex(t => t.el === active);

  if (idx < 0) {
    if (isArrow) {
      e.preventDefault();
      focusNotesTarget(targets[0]);
    }
    return;
  }
  const current = targets[idx];

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (idx < targets.length - 1) focusNotesTarget(targets[idx + 1]);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (idx > 0) focusNotesTarget(targets[idx - 1]);
  } else if (e.key === 'ArrowRight' && current.type === 'group') {
    const firstNote = targets.find((t, i) => i > idx && t.type === 'note' && t.groupId === current.groupId);
    if (firstNote) { e.preventDefault(); focusNotesTarget(firstNote); }
    else if (!titleEl.disabled) { e.preventDefault(); titleEl.focus(); titleEl.select(); }
  } else if (e.key === 'ArrowRight' && current.type === 'note') {
    if (!bodyEl.disabled) { e.preventDefault(); bodyEl.focus(); }
  } else if (e.key === 'ArrowLeft' && current.type === 'note') {
    const groupTarget = targets.find(t => t.type === 'group' && t.groupId === current.groupId);
    if (groupTarget) { e.preventDefault(); focusNotesTarget(groupTarget); }
  } else if (isEnter) {
    if (current.type === 'group') {
      e.preventDefault();
      addNote(current.groupId);
    } else if (current.type === 'addGroup') {
      e.preventDefault();
      addNotesGroup();
    }
  }
}

function focusNotesSidebar() {
  const targets = collectNotesNavTargets();
  if (targets.length === 0) return;
  const activeItem = document.querySelector('.notes-item.active');
  const preferred = activeItem && targets.find(t => t.el === activeItem);
  focusNotesTarget(preferred || targets[0]);
}
