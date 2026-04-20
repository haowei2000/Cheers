// Skill 详情页面 - 马卡龙生机风格 + 编辑分类
import { useState, useEffect } from 'react';
import { Skill, fetchSkill, getDownloadUrl, updateSkillCategory } from '../../api';

interface Props {
  skillId: string;
  onBack: () => void;
}

const CATEGORY_EMOJI: Record<string, string> = {
  development: '🦊',
  document: '🦋',
  tool: '🐝',
  knowledge: '🦉',
  ai: '🦄',
  agent: '🦁',
  debug: '🐞',
  imported: '🎁',
};

const DEFAULT_CATEGORIES = [
  { value: 'development', label: '🦊 开发工具' },
  { value: 'document', label: '🦋 文档处理' },
  { value: 'tool', label: '🐝 实用工具' },
  { value: 'knowledge', label: '🦉 知识管理' },
  { value: 'ai', label: '🤖 AI 助手' },
  { value: 'agent', label: '🦁 Agent' },
  { value: 'debug', label: '🐞 调试分析' },
  { value: 'imported', label: '🎁 其他' },
];

function getEmoji(category: string): string {
  return CATEGORY_EMOJI[category] || '🌸';
}

export default function SkillDetail({ skillId, onBack }: Props) {
  const [skill, setSkill] = useState<Skill | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editingCategory, setEditingCategory] = useState(false);
  const [newCategory, setNewCategory] = useState('');
  const [useCustomCategory, setUseCustomCategory] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateMsg, setUpdateMsg] = useState('');

  useEffect(() => {
    loadSkill();
  }, [skillId]);

  async function loadSkill() {
    setLoading(true);
    setError('');
    try {
      const data = await fetchSkill(skillId);
      setSkill(data);
      setNewCategory(data.category);
    } catch {
      setError('加载失败了');
    }
    setLoading(false);
  }

  async function handleUpdateCategory() {
    if (!skill) return;

    const finalCategory = useCustomCategory ? newCategory.trim() : newCategory;
    if (!finalCategory) {
      setUpdateMsg('请选择或输入分类');
      return;
    }

    setUpdating(true);
    setUpdateMsg('');

    try {
      await updateSkillCategory(skill.id, finalCategory);
      setSkill({ ...skill, category: finalCategory });
      setEditingCategory(false);
      setUpdateMsg('✓ 分类已更新');
    } catch (err) {
      setUpdateMsg(`✗ 更新失败: ${err}`);
    }

    setUpdating(false);
  }

  function handleDownload() {
    window.open(getDownloadUrl(skillId), '_blank');
  }

  if (loading) {
    return (
      <div className="loading-container">
        <div className="loading-icon">🦋</div>
        <div className="loading-text">正在打开...</div>
        <div className="loading-dots">
          <span></span><span></span><span></span>
        </div>
      </div>
    );
  }

  if (error) {
    return <div className="error-box">🌸 {error}</div>;
  }

  if (!skill) return null;

  return (
    <div className="skill-detail">
      {/* 顶部彩色 banner */}
      <div className="detail-top-banner">
        <span className="detail-bg-emoji">{getEmoji(skill.category)}</span>
        <span className="detail-front-emoji">{getEmoji(skill.category)}</span>
      </div>

      <button className="back-btn" onClick={onBack}>
        🌿 返回
      </button>

      <div className="detail-title">
        <h1>{skill.name}</h1>
        <div className="detail-badges">
          <span className="detail-version">✨ v{skill.version}</span>

          {/* 分类编辑 */}
          {editingCategory ? (
            <div className="category-edit">
              <select
                value={useCustomCategory ? '__custom__' : newCategory}
                onChange={e => {
                  if (e.target.value === '__custom__') {
                    setUseCustomCategory(true);
                  } else {
                    setUseCustomCategory(false);
                    setNewCategory(e.target.value);
                  }
                }}
                className="category-select-edit"
              >
                <option value="">选择分类...</option>
                {DEFAULT_CATEGORIES.map(cat => (
                  <option key={cat.value} value={cat.value}>{cat.label}</option>
                ))}
                <option value="__custom__">✨ 创建新分类</option>
              </select>

              {useCustomCategory && (
                <input
                  type="text"
                  placeholder="输入新分类..."
                  value={newCategory}
                  onChange={e => setNewCategory(e.target.value)}
                  className="custom-category-input-edit"
                />
              )}

              <button
                className="category-btn confirm"
                onClick={handleUpdateCategory}
                disabled={updating}
              >
                {updating ? '...' : '✓'}
              </button>
              <button
                className="category-btn cancel"
                onClick={() => { setEditingCategory(false); setUpdateMsg(''); }}
              >
                ✗
              </button>
            </div>
          ) : (
            <span
              className="detail-category clickable"
              onClick={() => setEditingCategory(true)}
              title="点击编辑分类"
            >
              {getEmoji(skill.category)} {skill.category} ✏️
            </span>
          )}
        </div>
      </div>

      {updateMsg && (
        <div className={`update-msg ${updateMsg.includes('✓') ? 'success' : 'error'}`}>
          {updateMsg}
        </div>
      )}

      <div className="detail-meta">
        <div className="meta-card">
          <div className="meta-label">🌸 作者</div>
          <div className="meta-value">{skill.author}</div>
        </div>
        <div className="meta-card">
          <div className="meta-label">📅 更新时间</div>
          <div className="meta-value">{skill.update_time}</div>
        </div>
        <div className="meta-card">
          <div className="meta-label">💫 支持版本</div>
          <div className="meta-value">{skill.support_version || '任意版本'}</div>
        </div>
      </div>

      <div className="detail-section">
        <h3>🌟 功能概述</h3>
        <p className="detail-description">{skill.description}</p>
      </div>

      <div className="detail-section">
        <h3>🏷️ 标签</h3>
        <div className="tags-cloud">
          {skill.tags.map((tag, i) => (
            <span key={tag} className="tag-item" style={{ animationDelay: `${i * 0.1}s` }}>
              {['✨', '🌸', '💫', '🌟', '🦋', '🍀'][i % 6]} {tag}
            </span>
          ))}
        </div>
      </div>

      {skill.files && skill.files.length > 0 && (
        <div className="detail-section">
          <h3>📁 包含文件 ({skill.files.length})</h3>
          <ul className="file-list">
            {skill.files.map(file => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        </div>
      )}

      {skill.readme && (
        <div className="detail-section">
          <h3>📖 使用说明</h3>
          <pre className="readme-content">{skill.readme}</pre>
        </div>
      )}

      <button className="download-btn-large" onClick={handleDownload}>
        📥 下载这个技能
      </button>
    </div>
  );
}
