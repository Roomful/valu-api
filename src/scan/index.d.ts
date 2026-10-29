// Types for `@arkeytyp/valu-api/src/scan/index.js` (TypeScript finds this file
// beside the module it describes).

export type ScopeTier = 'basic' | 'consent' | 'local' | 'forbidden';

export interface ScopeFinding {
  /** The scope the call needs; null for a Valu Social bridge call, which has none. */
  scope: string | null;
  /** The call as the catalogue names it (`Rooms.search-my-rooms`), the intent, the scope asked for, or the bridge call. */
  call: string;
  kind: 'function' | 'intent' | 'asked' | 'bridge';
  file: string;
  line: number;
}

export interface UnresolvedCall {
  file: string;
  line: number;
  /** The source line, trimmed, at most 120 characters. */
  text: string;
}

export interface ScopeScan {
  /** Every scope the code needs, sorted. Never capped. */
  scopes: string[];
  findings: ScopeFinding[];
  bridge: ScopeFinding[];
  unresolved: UnresolvedCall[];
  /** True when evidence was cut to the caps (3 per call name, 200 in all). */
  truncated: boolean;
}

export interface DeclaredPermission {
  scope: string;
  why: string;
}

export interface PermissionsFile {
  present: boolean;
  error: string | null;
  permissions: DeclaredPermission[];
}

export interface PermissionsComparison {
  required: string[];
  missingFromFile: string[];
  unusedInFile: string[];
  unknown: string[];
  noReason: string[];
}

export function detectScopes(files: ReadonlyArray<{ path: string; text: string }>): ScopeScan;
export function stripComments(text: string): string;
export const FINDINGS_PER_CALL: number;
export const FINDINGS_MAX: number;

export function parsePermissionsFile(text: string | null | undefined): PermissionsFile;
export function comparePermissions(
  file: { permissions?: DeclaredPermission[] } | null,
  detectedScopes: readonly string[],
  knownScopes?: Iterable<string>,
): PermissionsComparison;
export const SCOPE_PATTERN: RegExp;
export const WHY_MAX: number;

export const SCOPE_DESCRIPTIONS: Readonly<Record<string, string>>;
export const SCOPE_WORDING: Readonly<Record<string, string>>;
export function describeScope(scope: string): string | null;

export const TIER_OF: Readonly<Record<string, ScopeTier>>;
export function tierOf(scope: string): ScopeTier | null;
