import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { Project, ProjectMeta } from '../types';

interface ProjectState {
  projects: ProjectMeta[];
  activeProject: Project | null;
  isLoading: boolean;

  loadProjects: () => Promise<void>;
  createProject: (name: string) => Promise<Project>;
  openProject: (slug: string) => Promise<Project>;
  deleteProject: (slug: string) => Promise<void>;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  activeProject: null,
  isLoading: false,

  loadProjects: async () => {
    set({ isLoading: true });
    try {
      const projects = await invoke<ProjectMeta[]>('list_projects');
      set({ projects });
    } finally {
      set({ isLoading: false });
    }
  },

  createProject: async (name: string) => {
    set({ isLoading: true });
    try {
      const project = await invoke<Project>('create_project', { name });
      set({ activeProject: project });
      await get().loadProjects();
      return project;
    } finally {
      set({ isLoading: false });
    }
  },

  openProject: async (slug: string) => {
    set({ isLoading: true });
    try {
      const project = await invoke<Project>('open_project', { slug });
      set({ activeProject: project });
      return project;
    } finally {
      set({ isLoading: false });
    }
  },

  deleteProject: async (slug: string) => {
    set({ isLoading: true });
    try {
      await invoke('delete_project', { slug });
      // Clear the active project if it was the one removed.
      if (get().activeProject?.slug === slug) {
        set({ activeProject: null });
      }
      await get().loadProjects();
    } finally {
      set({ isLoading: false });
    }
  },
}));
