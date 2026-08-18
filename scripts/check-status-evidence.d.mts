export interface EvidenceHeadContext {
  currentHead: string;
  parentHead: string | undefined;
  parentChangedPaths: string[];
}

export function validateEvidenceHead(
  evidenceHead: unknown,
  context: EvidenceHeadContext,
): string | undefined;
