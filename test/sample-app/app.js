// A small, idiomatic localStorage app (todos, a theme, a visit counter, a
// draft). The acceptance test renames the storage identifier by
// find-and-replace and changes nothing else.

export function loadTodos() {
  return JSON.parse(localStorage.getItem("todos") || "[]");
}

export function addTodo(text) {
  const todos = loadTodos();
  todos.push({ text, done: false });
  localStorage.setItem("todos", JSON.stringify(todos));
  return todos.length;
}

export function toggleTodo(index) {
  const todos = loadTodos();
  todos[index].done = !todos[index].done;
  localStorage.setItem("todos", JSON.stringify(todos));
}

export function setTheme(theme) {
  localStorage.theme = theme;
}

export function getTheme() {
  return localStorage.theme || "light";
}

export function countVisit() {
  const n = Number(localStorage.getItem("visits")) + 1;
  localStorage.setItem("visits", n);
  return localStorage.getItem("visits");
}

export function saveDraft(text) {
  if (text) localStorage["draft"] = text;
  else delete localStorage["draft"];
}

export function hasDraft() {
  return "draft" in localStorage;
}

export function listKeys() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
  return keys.sort();
}

export function ownKeys() {
  return Object.keys(localStorage).sort();
}

export function forget(key) {
  localStorage.removeItem(key);
}

export function reset() {
  localStorage.clear();
}
