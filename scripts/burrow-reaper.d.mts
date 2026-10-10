export const RETENTION_MS: number;
export class ReaperError extends Error {
  readonly code: string;
}
export interface ReaperOptions {
  apply: boolean;
  contentOnly: boolean;
  pageSize: number;
  maxReads: number;
  maxWrites: number;
  state: string;
  project: string;
  database: string;
  collection: string;
}
export type Request = (path: string, init?: RequestInit) => Promise<Response>;
export interface StubWrite {
  update: { name: string; fields: Record<string, unknown> };
  currentDocument: { updateTime: string };
}
export function parseArgs(args: string[]): ReaperOptions;
export function quotaDay(now: number): string;
export function expiryCandidate(
  doc: { name?: string; fields?: Record<string, any>; updateTime?: unknown },
  prefix: string,
  now: number,
): "stub" | "refused" | "active" | StubWrite;
export function conditionalStub(
  request: Request,
  databasePath: string,
  write: StubWrite,
): Promise<boolean>;
export function reap(
  options: ReaperOptions,
  dependencies: { request: Request; now?: () => number },
): Promise<{
  scanned: number;
  eligible: number;
  stubbed: number;
  changed: number;
  active: number;
  stubs: number;
  refused: number;
  budgetStopped: boolean;
}>;
