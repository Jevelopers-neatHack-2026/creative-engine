export interface TrustedScope {
  tenant_id: string;
  project_id: string;
  job_id?: string;
  artifact_id?: string;
  design_version_id?: string;
  brief_id?: string;
}
export declare function assertTrustedScope<T extends Record<string, unknown>>(
  candidate: T,
  trustedScope: TrustedScope,
  contract?: string,
): T;
