// Shared domain types. Field names match the camelCase serde output from the
// Rust storage commands (src-tauri/src/commands/projects.rs).

export interface Project {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
  sessionId: string | null;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface ProjectMeta {
  id: string;
  name: string;
  slug: string;
  updatedAt: string;
}
