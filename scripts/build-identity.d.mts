export interface BuildIdentity {
  schemaVersion: number;
  version: string;
  commit: string;
  builtAt: string;
  sourceDigest: string;
  outputDigest: string;
}
export function writeBuildIdentity(): Promise<void>;
export function assertCurrentBuild(): Promise<BuildIdentity>;
