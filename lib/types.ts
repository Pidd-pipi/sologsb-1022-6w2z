export type ViewMode = 'reading' | 'editing' | 'critical';
export type AnchorType = 'chapter' | 'sentence' | 'word';
export type AnnotationKind = 'footnote' | 'variant' | 'background' | 'crossref';
export type AnnotationStatus = 'open' | 'resolved';

export interface TextToken {
  id: string;
  text: string;
}

export interface Sentence {
  id: string;
  order: number;
  text: string;
  tokens: TextToken[];
}

export interface Chapter {
  id: string;
  order: number;
  title: string;
  summary: string;
  sentences: Sentence[];
}

export interface Annotation {
  id: string;
  anchorId: string;
  anchorType: AnchorType;
  kind: AnnotationKind;
  title: string;
  body: string;
  source: string;
  references: string[];
  status: AnnotationStatus;
  tags: string[];
  conflictState: 'open' | 'resolved';
  conflictResolution?: string;
  updatedAt: string;
  originSentenceId?: string;
  originTokenText?: string;
  originTokenIndex?: number;
}

export type MergeDisputeField = 'body' | 'source' | 'title';

export interface MergeDispute {
  id: string;
  type: 'annotation';
  field: MergeDisputeField;
  annotationId: string;
  title: string;
  kind: AnnotationKind;
  anchorId: string;
  anchorType: AnchorType;
  localValue: string;
  incomingValue: string;
  baseValue: string;
  localSource: string;
  incomingSource: string;
  packageId: string;
  deviceId: string;
  createdAt: string;
  status: 'pending';
}

export interface DeletionDispute {
  id: string;
  type: 'deletion';
  annotationId: string;
  annotation: Annotation;
  packageId: string;
  deviceId: string;
  createdAt: string;
  status: 'pending';
}

export interface TextDispute {
  id: string;
  type: 'text';
  sentenceId: string;
  chapterId: string;
  label: string;
  localText: string;
  incomingText: string;
  baseText: string;
  baseTokens: TextToken[];
  packageId: string;
  deviceId: string;
  createdAt: string;
  status: 'pending';
}

export type PendingDispute = MergeDispute | DeletionDispute | TextDispute;

export interface PendingAnchor {
  id: string;
  annotationId: string;
  sentenceId: string;
  tokenText: string;
  tokenIndex: number;
  reason: 'not-found';
  impact: string;
  createdAt: string;
  status: 'pending';
}

export interface MergeBaseSnapshot {
  id: string;
  createdAt: string;
  chapters: Chapter[];
  annotations: Annotation[];
}

export interface AnnotationPackage {
  format: 'sologsb.annotation-package/v1';
  packageId: string;
  deviceId: string;
  exportedAt: string;
  baseId: string;
  base: MergeBaseSnapshot;
  chapters: Chapter[];
  annotations: Annotation[];
  deletedAnnotationIds: string[];
  deletedSentenceIds: string[];
}

export type MergeIssueKind = 'added-annotation' | 'changed-annotation' | 'text' | 'pending-anchor' | 'dispute' | 'deleted-annotation';

export interface MergeIssue {
  kind: MergeIssueKind;
  message: string;
}

export interface MergeResult {
  document: TextDocument;
  applied: boolean;
  duplicate: boolean;
  issues: MergeIssue[];
}

export interface VersionSnapshot {
  id: string;
  label: string;
  note: string;
  createdAt: string;
  chapters: Chapter[];
  annotations: Annotation[];
}

export interface TextDocument {
  id: string;
  title: string;
  author: string;
  edition: string;
  chapters: Chapter[];
  annotations: Annotation[];
  snapshots: VersionSnapshot[];
  bases: MergeBaseSnapshot[];
  baseId: string;
  pendingDisputes: PendingDispute[];
  pendingAnchors: PendingAnchor[];
  appliedPackageIds: string[];
  updatedAt: string;
}

export interface WorkspaceState {
  document: TextDocument;
  mode: ViewMode;
  selectedChapterId: string;
  selectedSentenceId: string;
  selectedAnnotationId: string | null;
  query: string;
  dirty: boolean;
}

export interface EditorState {
  workspace: WorkspaceState;
  past: WorkspaceState[];
  future: WorkspaceState[];
  lastAction: string;
}

export interface SearchResult {
  chapterId: string;
  sentenceId?: string;
  annotationId?: string;
  title: string;
  excerpt: string;
  kind: 'text' | 'annotation';
}

export interface ConflictGroup {
  key: string;
  anchorId: string;
  anchorType: AnchorType;
  kind: AnnotationKind;
  anchorLabel: string;
  annotations: Annotation[];
}
