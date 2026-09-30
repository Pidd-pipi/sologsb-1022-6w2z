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
  updatedAt: string;
  mergePending?: MergePendingItem[];
  importedPackages?: ImportedPackageRecord[];
}

export interface AnnotationPackage {
  packageId: string;
  deviceId: string;
  exportedAt: string;
  baseDigest: string;
  baseLabel: string;
  document: TextDocument;
}

export type MergePendingKind = 'annotation-body' | 'annotation-delete' | 'sentence-text' | 'word-citation';
export type MergePendingStatus = 'pending' | 'resolved';
export type MergeResolution = 'local' | 'remote' | 'base' | 'migrate-sentence' | 'keep';

export interface MergePendingItem {
  id: string;
  kind: MergePendingKind;
  status: MergePendingStatus;
  anchorId: string;
  anchorType: AnchorType;
  annotationId?: string;
  sentenceId?: string;
  chapterId?: string;
  targetLabel: string;
  baseValue?: string;
  localValue?: string;
  remoteValue?: string;
  payload?: string;
  impact: string;
  tokenText?: string;
  resolution?: MergeResolution;
  resolvedAt?: string;
  createdAt: string;
}

export interface ImportedPackageRecord {
  packageId: string;
  deviceId: string;
  importedAt: string;
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
