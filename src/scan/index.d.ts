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
  /** The file alone: its scopes that have a reason. The only list Valu enforces. */
  declared: string[];
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
export function declaredScopes(file: { permissions?: DeclaredPermission[] } | null): string[];
export const SCOPE_PATTERN: RegExp;
export const WHY_MAX: number;

export const SCOPE_DESCRIPTIONS: Readonly<Record<string, string>>;
export const SCOPE_WORDING: Readonly<Record<string, string>>;
export function describeScope(scope: string): string | null;

export const TIER_OF: Readonly<Record<string, ScopeTier>>;
export function tierOf(scope: string): ScopeTier | null;

// --- the privacy audit's deterministic scan (docs/privacy-audit.md) ---------

export interface EgressFinding {
  rule: string;
  result: 'fail' | 'concern' | 'info';
  file: string;
  /** 0 for a finding about a whole file (a package in package.json). */
  line: number;
  detail: string;
  host?: string;
  /** The source line, trimmed, at most 160 characters. Never published. */
  snippet?: string;
}

export interface EgressScan {
  rulesVersion: string;
  findings: EgressFinding[];
  inventory: { storage: EgressFinding[]; sends: EgressFinding[]; deps: string[]; tables: string[] };
}

export interface EgressInput {
  source?: ReadonlyArray<{ path: string; text: string | null | undefined }>;
  built?: ReadonlyArray<{ path: string; text: string | null | undefined }>;
  packageJson?: string | null;
  lockfile?: string | null;
  migrations?: ReadonlyArray<{ path: string; text: string | null | undefined }>;
}

export function detectEgress(input: EgressInput, opts?: { siteOrigin?: string; extraOrigins?: readonly string[] }): EgressScan;
export const EGRESS_RULES: ReadonlyArray<{ id: string; result: 'fail' | 'concern' | 'info'; title: string }>;
export const EGRESS_RULES_VERSION: string;
export const TELEMETRY_PACKAGES: readonly string[];
export const ONWARD_PATHS: readonly string[];
export const SENDS_TO_OTHERS: readonly string[];

export const VALU_ORIGINS: ReadonlyArray<{ origin: string; path?: string; why: string }>;
export function isValuUrl(url: string, opts?: { siteOrigin?: string }): boolean;
export function hostOf(url: string): string | null;
