// Skill detail page with the macaron vitality style and category editing.
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
  { value: 'development', label: '🦊 Development Tools' },
  { value: 'document', label: '🦋 Document Processing' },
  { value: 'tool', label: '🐝 Utilities' },
  { value: 'knowledge', label: '🦉 Knowledge Management' },
  { value: 'ai', label: '🤖 AI Assistants' },
  { value: 'agent', label: '🦁 Agent' },
  { value: 'debug', label: '🐞 Debugging & Analysis' },
  { value: 'imported', label: '🎁 Other' },
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
      setError('Failed to load');
    }
    setLoading(false);
  }

  async function handleUpdateCategory() {
    if (!skill) return;

    const finalCategory = useCustomCategory ? newCategory.trim() : newCategory;
    if (!finalCategory) {
      setUpdateMsg('Choose or enter a category');
      return;
    }

    setUpdating(true);
    setUpdateMsg('');

    try {
      await updateSkillCategory(skill.id, finalCategory);
      setSkill({ ...skill, category: finalCategory });
      setEditingCategory(false);
      setUpdateMsg('✓ Category updated');
    } catch (err) {
      setUpdateMsg(`✗ Update failed: ${err}`);
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
        <div className="loading-text">Opening...</div>
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
      {/* Top color banner. */}
      <div className="detail-top-banner">
        <span className="detail-bg-emoji">{getEmoji(skill.category)}</span>
        <span className="detail-front-emoji">{getEmoji(skill.category)}</span>
      </div>

      <button className="back-btn" onClick={onBack}>
        🌿 Back
      </button>

      <div className="detail-title">
        <h1>{skill.name}</h1>
        <div className="detail-badges">
          <span className="detail-version">✨ v{skill.version}</span>

          {/* Category editing. */}
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
                <option value="">Category...</option>
                {DEFAULT_CATEGORIES.map(cat => (
                  <option key={cat.value} value={cat.value}>{cat.label}</option>
                ))}
                <option value="__custom__">✨ Create New Category</option>
              </select>

              {useCustomCategory && (
                <input
                  type="text"
                  placeholder="Enter a new category..."
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
              title="Edit category"
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
          <div className="meta-label">🌸 Author</div>
          <div className="meta-value">{skill.author}</div>
        </div>
        <div className="meta-card">
          <div className="meta-label">📅 Updated</div>
          <div className="meta-value">{skill.update_time}</div>
        </div>
        <div className="meta-card">
          <div className="meta-label">💫 Supported Version</div>
          <div className="meta-value">{skill.support_version || 'Any version'}</div>
        </div>
      </div>

      <div className="detail-section">
        <h3>🌟 Overview</h3>
        <p className="detail-description">{skill.description}</p>
      </div>

      <div className="detail-section">
        <h3>🏷️ Tags</h3>
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
          <h3>📁 Files ({skill.files.length})</h3>
          <ul className="file-list">
            {skill.files.map(file => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        </div>
      )}

      {skill.readme && (
        <div className="detail-section">
          <h3>📖 Usage</h3>
          <pre className="readme-content">{skill.readme}</pre>
        </div>
      )}

      <button className="download-btn-large" onClick={handleDownload}>
        📥 Download This Skill
      </button>
    </div>
  );
}
