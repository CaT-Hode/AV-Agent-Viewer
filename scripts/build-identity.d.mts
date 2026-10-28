export interface BuildIdentity {
  schemaVersion: number;
  buildId: string;
  version: string;
  commit: string;
  builtAt: string;
}
export function writeBuildIdentity(): Promise<void>;
export function assertCurrentBuild(): Promise<BuildIdentity>;
