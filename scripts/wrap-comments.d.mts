export interface WrapProblem {
  /** 1-based line in the input. */
  line: number;
  message: string;
  /** True when the problem cannot be fixed automatically. */
  fatal: boolean;
}

export function wrapComments(
  text: string,
  options?: { width?: number; fileName?: string },
): { text: string; problems: WrapProblem[] };
