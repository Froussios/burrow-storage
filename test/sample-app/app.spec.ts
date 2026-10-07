// The sample app's own test suite. It knows nothing about Burrow.
import { expect } from "vitest";

type App = typeof import("./app.js");

export const appTests: [string, (app: App) => void | Promise<void>][] = [
  [
    "starts empty",
    (app) => {
      expect(app.loadTodos()).toEqual([]);
      expect(app.getTheme()).toBe("light");
      expect(app.listKeys()).toEqual([]);
      expect(app.hasDraft()).toBe(false);
    },
  ],
  [
    "adds and toggles todos",
    (app) => {
      expect(app.addTodo("milk")).toBe(1);
      expect(app.addTodo("eggs")).toBe(2);
      app.toggleTodo(1);
      expect(app.loadTodos()).toEqual([
        { text: "milk", done: false },
        { text: "eggs", done: true },
      ]);
    },
  ],
  [
    "stores the theme as a property",
    (app) => {
      app.setTheme("dark");
      expect(app.getTheme()).toBe("dark");
    },
  ],
  [
    "coerces numbers to strings",
    (app) => {
      expect(app.countVisit()).toBe("1");
      expect(app.countVisit()).toBe("2");
    },
  ],
  [
    "drafts with bracket access, `in` and `delete`",
    (app) => {
      app.saveDraft("hello");
      expect(app.hasDraft()).toBe(true);
      app.saveDraft("");
      expect(app.hasDraft()).toBe(false);
    },
  ],
  [
    "enumerates keys by index and by Object.keys",
    (app) => {
      app.addTodo("x");
      app.setTheme("dark");
      expect(app.listKeys()).toEqual(["theme", "todos"]);
      expect(app.ownKeys()).toEqual(["theme", "todos"]);
    },
  ],
  [
    "removes and clears",
    (app) => {
      app.addTodo("x");
      app.setTheme("dark");
      app.forget("todos");
      expect(app.listKeys()).toEqual(["theme"]);
      app.reset();
      expect(app.listKeys()).toEqual([]);
      expect(app.getTheme()).toBe("light");
    },
  ],
];
