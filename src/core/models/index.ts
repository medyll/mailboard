export interface Message {
  id: string;
  key?: string;
  sourceId?: string;
  date: string;
  subject: string;
  category: string;
  from: string;
  summary?: string;
  [field: string]: unknown;
}
export interface SearchOptions {
  sourceId?: string;
  query?: string;
  category?: string;
  limit?: number;
}
export interface IngestOptions { dry?: boolean; jev?: boolean }
export interface CycleOptions { skipCollect?: boolean; retryFailed?: boolean }
export interface BackfillOptions { dry?: boolean; stale?: boolean; sourceId?: string; limit?: number }
export interface CollectOptions {
  sourceId?: string;
  check?: boolean;
  observe?: boolean;
  dry?: boolean;
  nav?: 'direct' | 'jev';
  windowHours?: number;
  maxItems?: number;
}
