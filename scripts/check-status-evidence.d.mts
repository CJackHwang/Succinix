export interface EvidenceHeadContext {
  currentHead: string;
  parentHead: string | undefined;
  parentChangedPaths: string[];
}

export declare const REQUIRED_GATE_COMMANDS: readonly string[];

export function validateEvidenceHead(
  evidenceHead: unknown,
  context: EvidenceHeadContext,
): string | undefined;

export const REQUIRED_GATE_COMMANDS: readonly string[];
