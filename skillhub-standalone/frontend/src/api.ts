// SkillHub API 服务
const API_BASE = '/api/v1/skillhub';

export interface Skill {
  id: string;
  name: string;
  version: string;
  description: string;
  category: string;
  author: string;
  support_version: string;
  update_time: string;
  tags: string[];
  files: string[];
  readme?: string;
}

export interface SkillListResponse {
  skills: Skill[];
  total: number;
}

export interface ImportResult {
  success: boolean;
  skill_id?: string;
  message: string;
}

export async function fetchSkills(category?: string, search?: string): Promise<Skill[]> {
  const params = new URLSearchParams();
  if (category) params.set('category', category);
  if (search) params.set('search', search);
  const url = `${API_BASE}/skills${params.toString() ? '?' + params.toString() : ''}`;
  const resp = await fetch(url);
  const data: SkillListResponse = await resp.json();
  return data.skills;
}

export async function fetchSkill(skillId: string): Promise<Skill> {
  const resp = await fetch(`${API_BASE}/skills/${skillId}`);
  if (!resp.ok) throw new Error('Skill not found');
  return resp.json();
}

export async function fetchCategories(): Promise<string[]> {
  const resp = await fetch(`${API_BASE}/categories`);
  const data = await resp.json();
  return data.categories || [];
}

export function getDownloadUrl(skillId: string): string {
  return `${API_BASE}/skills/${skillId}/download`;
}

export async function uploadSkill(file: File | File[], category: string): Promise<ImportResult> {
  const formData = new FormData();

  // 统一使用 'file' 字段发送
  if (Array.isArray(file)) {
    for (const f of file) {
      formData.append('file', f);
    }
  } else {
    formData.append('file', file);
  }

  const url = `${API_BASE}/skills/upload?category=${encodeURIComponent(category)}`;
  const resp = await fetch(url, {
    method: 'POST',
    body: formData,
  });

  // 先获取文本，再尝试解析 JSON
  const text = await resp.text();
  if (!resp.ok) {
    // 尝试解析为 JSON，如果失败则使用原始文本
    try {
      const errorData = JSON.parse(text);
      throw new Error(errorData.detail || errorData.message || text || 'Upload failed');
    } catch {
      throw new Error(text || 'Upload failed');
    }
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Invalid response from server');
  }
}

export async function updateSkillCategory(skillId: string, category: string): Promise<ImportResult> {
  const resp = await fetch(`${API_BASE}/skills/${skillId}/category?category=${encodeURIComponent(category)}`, {
    method: 'PUT',
  });

  if (!resp.ok) {
    const error = await resp.json().catch(() => ({ detail: 'Update failed' }));
    throw new Error(error.detail || 'Update failed');
  }

  return resp.json();
}

export async function deleteSkill(skillId: string): Promise<ImportResult> {
  const resp = await fetch(`${API_BASE}/skills/${skillId}`, {
    method: 'DELETE',
  });

  if (!resp.ok) {
    const error = await resp.json().catch(() => ({ detail: 'Delete failed' }));
    throw new Error(error.detail || 'Delete failed');
  }

  return resp.json();
}

export interface SyncResult {
  success: boolean;
  message: string;
  sync_count: number;
  conflict_files: string[];
  timestamp: string;
}

export async function syncFromGitFox(): Promise<SyncResult> {
  const resp = await fetch(`${API_BASE}/update`);
  const data = await resp.json();

  if (!resp.ok) {
    throw new Error(data.message || 'Sync failed');
  }

  return data;
}
