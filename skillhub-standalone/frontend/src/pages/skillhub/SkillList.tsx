// Skill 列表页面 - 马卡龙生机风格 + 导入弹窗
import { useState, useEffect, useRef } from 'react';
import { Skill, fetchSkills, getDownloadUrl, uploadSkill, deleteSkill, syncFromGitFox } from '../../api';

interface Props {
  onSelect: (skillId: string) => void;
  onRefresh: () => void;
}

// 所有图标汇总到一个池子里，每个 skill 随机分配一个
const EMOJI_POOL = [
  // 森林动物
  '🦊', '🐼', '🦁', '🐺', '🐻', '🐨', '🦄', '🦓', '🦌', '🦬',
  '🦆', '🦅', '🦉', '🦇', '🐸', '🐢', '🦎', '🐍', '🦖', '🦕',
  '🦋', '🐛', '🐝', '🐞', '🦜', '🦩', '🦚', '🦔', '🐾', '🦡',
  // 植物花草
  '🌲', '🌳', '🌴', '🌵', '🌸', '🌺', '🌻', '🌼', '🌷', '🌹',
  '💐', '💮', '🏵️', '🪷', '🪻', '🌾', '🍂', '🍃', '🌱', '🪴',
  '🍀', '🌿', '☘️', '🌈', '✨', '💫', '⭐', '🌟', '💎', '🔮',
  // 自然现象
  '🌧️', '⛈️', '🌩️', '🌪️', '🌈', '🌤️', '⛅', '🌙', '🌛', '🌜️',
  // 工具科技
  '📱', '⌨️', '🖥️',
  '📷', '🎥', '📺', '📻', '🎙️', '🎚️', '🎛️', '🔌',, '🧲',
  // 办公物品
  '📜', '🗃️', '📋',
  '📌', '📍', '✂️', '🖊️', '🖋️', '✏️', '📎',  '🖇️',
  // 容器礼物
   '🎁', '🎀', '🎈', '🎊', '🎉', '🎆', '🎇', '🏆', '🎖️', '🎗️', '🎟️', '🎫', '💰', '🪙', '💎', '💵',
  // 生物相关
  '🤖', '👾', '🕹️', '🎲', '🎯', '🎳',  '🧩', '🃏',
  // 食物
  '🍎', '🍊', '🍋', '🍓', '🍇', '🍉', '🍑', '🍒', '🥝', '🍍',
  '🥥', '🥑', '🥦', '🥬', '🌽', '🌶️', '🍄', '🥜', '🌰', '🍯',
  // 更多装饰
   '🎨', '🎬', '🎤', '🎧', '🎵', '🎶', '🎹', '🎸', '🎺',
  '🎷', '🎻', '🪘', '🎼', '📯',  '💐', '🌺', '🏵️', '🔔',
];

// 根据 skill id 生成稳定的随机索引，同一个 skill 始终显示同一个图标
function getSkillEmoji(skillId: string): string {
  let hash = 0;
  for (let i = 0; i < skillId.length; i++) {
    const char = skillId.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  const index = Math.abs(hash) % EMOJI_POOL.length;
  return EMOJI_POOL[index] || '🌸';
}

// 默认分类选项
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

// 卡片背景渐变色
const CARD_COLORS = [
  'linear-gradient(135deg, #B8E6D4 0%, #D4F1E8 100%)',
  'linear-gradient(135deg, #FFDAB9 0%, #FFE8D6 100%)',
  'linear-gradient(135deg, #E6E6FA 0%, #F0F0FF 100%)',
  'linear-gradient(135deg, #B8E0F0 0%, #D6EEF7 100%)',
  'linear-gradient(135deg, #FFB6C1 0%, #FFDDE4 100%)',
  'linear-gradient(135deg, #FFFACD 0%, #FFFDE7 100%)',
];

function getCardColor(index: number): string {
  return CARD_COLORS[index % CARD_COLORS.length];
}

// 根据 skill 的分类获取对应的默认分类名称
function getCategoryLabel(skillCategory: string): { value: string; label: string } {
  const found = DEFAULT_CATEGORIES.find(c => c.value === skillCategory);
  if (found) return found;
  // 没有找到时返回对应的默认分类（如果 skill 没有分类，默认是 general）
  return DEFAULT_CATEGORIES.find(c => c.value === 'imported') || { value: 'imported', label: '🎁 其他' };
}

// 导入弹窗组件
function UploadModal({
  isOpen,
  onClose,
  onSuccess,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [category, setCategory] = useState('imported');
  const [customCategory, setCustomCategory] = useState('');
  const [useCustom, setUseCustom] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(false); // 加载选择的文件
  const [error, setError] = useState('');
  const [selectedType, setSelectedType] = useState<'file' | 'folder'>('file');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const finalCategory = useCustom ? customCategory.trim() : category;

  async function handleUpload() {
    if (files.length === 0) {
      setError('请选择文件或文件夹');
      return;
    }
    if (useCustom && !customCategory.trim()) {
      setError('请输入自定义分类');
      return;
    }

    setUploading(true);
    setError('');

    try {
      const result = await uploadSkill(files, finalCategory);
      if (result.success) {
        onSuccess();
        onClose();
        setFiles([]);
        setCategory('imported');
        setCustomCategory('');
      } else {
        setError(result.message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }

    setUploading(false);
  }

  function handleFileChange(fileList: FileList | null) {
    if (fileList) {
      setLoading(true);
      setError('');
      // 使用 setTimeout 让 UI 有时间更新
      setTimeout(() => {
        setFiles(Array.from(fileList));
        setLoading(false);
      }, 100);
    }
  }

  function handleFolderChange(e: React.ChangeEvent<HTMLInputElement>) {
    const fileList = e.target.files;
    if (fileList) {
      setLoading(true);
      setError('');
      setTimeout(() => {
        setFiles(Array.from(fileList));
        setLoading(false);
      }, 100);
    }
  }

  function getDisplayText(): string {
    if (loading) {
      return '正在从本地运输skill，请稍等......';
    }
    if (files.length === 0) {
      return selectedType === 'file' ? '点击选择压缩包...' : '点击选择文件夹...';
    }
    if (files.length === 1) {
      return files[0].name;
    }
    return `已选择 ${files.length} 个文件`;
  }

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        {uploading && (
          <div className="modal-upload-overlay">
            <div className="modal-upload-progress">
              <div className="modal-upload-spinner">🌱</div>
              <div className="modal-upload-text">从本地运输 skill 种子中...</div>
              <div className="modal-upload-dots">
                <span></span><span></span><span></span>
              </div>
            </div>
          </div>
        )}
        <h2>✨ 导入 Skill</h2>

        <div className="modal-section">
          <label>选择类型</label>
          <div className="import-type-selector">
            <button
              className={`import-type-btn ${selectedType === 'file' ? 'active' : ''}`}
              onClick={() => { setSelectedType('file'); setFiles([]); }}
            >
              📦 压缩包
            </button>
            <button
              className={`import-type-btn ${selectedType === 'folder' ? 'active' : ''}`}
              onClick={() => { setSelectedType('folder'); setFiles([]); }}
            >
              📁 文件夹
            </button>
          </div>
        </div>

        <div className="modal-section">
          <label>{selectedType === 'file' ? '选择文件' : '选择文件夹'}</label>
          <span className="upload-hint">确认上传文件后需要等待一段时间，请勿离开</span>
          <div className={`file-input-wrapper ${loading ? 'loading' : ''}`}>
            {loading && (
              <div className="file-loading-indicator">
                <span className="file-loading-spinner">📦</span>
                <span className="file-loading-text">正在从本地运输skill，请稍等......</span>
              </div>
            )}
            {selectedType === 'file' ? (
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip,.tar,.tar.gz,.tgz,.tar.bz2,.tar.xz"
                onChange={e => handleFileChange(e.target.files)}
              />
            ) : (
              <input
                ref={folderInputRef}
                type="file"
                {...({ webkitdirectory: 'webkitdirectory' } as React.InputHTMLAttributes<HTMLInputElement>)}
                onChange={handleFolderChange}
              />
            )}
            <span className="file-name">{getDisplayText()}</span>
          </div>
          <p className="hint">{selectedType === 'file' ? '支持 .zip, .tar.gz, .tgz 等格式' : '支持 md/json/py/txt 等常见格式'}</p>
        </div>

        <div className="modal-section">
          <label>选择分类</label>
          <div className="category-options">
            {DEFAULT_CATEGORIES.map(cat => (
              <button
                key={cat.value}
                className={`category-option ${!useCustom && category === cat.value ? 'selected' : ''}`}
                onClick={() => { setCategory(cat.value); setUseCustom(false); }}
                disabled={loading}
              >
                {cat.label}
              </button>
            ))}
          </div>
        </div>

        <div className="modal-section">
          <label>
            <input
              type="checkbox"
              checked={useCustom}
              onChange={e => setUseCustom(e.target.checked)}
              disabled={loading}
            />
            或者创建新分类
          </label>
          {useCustom && (
            <input
              type="text"
              placeholder="输入新分类名称..."
              value={customCategory}
              onChange={e => setCustomCategory(e.target.value)}
              className="custom-category-input"
            />
          )}
        </div>

        {error && <div className="modal-error">{error}</div>}

        <div className="modal-actions">
          <button className="modal-btn cancel" onClick={onClose} disabled={uploading}>取消</button>
          <button
            className="modal-btn confirm"
            onClick={handleUpload}
            disabled={uploading || files.length === 0}
          >
            {uploading ? (
              <span className="upload-loading">
                <span className="upload-spinner">🌀</span>
                导入中，请稍候...
              </span>
            ) : '✨ 确认导入'}
          </button>
        </div>
      </div>
    </div>
  );
}

// 花瓣emoji池
const FLOWER_EMOJIS = ['🌸', '🌺', '🌻', '🌷', '🌼', '💐', '🌹', '🪻', '🌱', '🍀', '✨', '💫'];
// 星星emoji池
const STAR_EMOJIS = ['⭐', '🌟', '✨', '💫', '⭐', '🌟', '✨', '💫'];

interface FlowerParticle {
  id: number;
  emoji: string;
  tx: string;
  ty: string;
  delay: number;
}

interface StarParticle {
  id: number;
  emoji: string;
  tx: string;
  ty: string;
  delay: number;
}

export default function SkillList({ onSelect, onRefresh }: Props) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [categories] = useState<typeof DEFAULT_CATEGORIES>(DEFAULT_CATEGORIES);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [particles, setParticles] = useState<FlowerParticle[]>([]);
  const [starParticles, setStarParticles] = useState<StarParticle[]>([]);
  const [syncing, setSyncing] = useState(false);
  const particleIdRef = useRef<number>(0);
  const starIdRef = useRef<number>(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const starIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    loadData();
  }, [category]);

  // 从 GitFox 同步 Skills
  async function handleSync() {
    if (syncing) return;

    setSyncing(true);
    setUploadMessage(null);

    try {
      const result = await syncFromGitFox();
      if (result.success) {
        setUploadMessage({ type: 'success', text: result.message });
        // 重新加载数据
        await loadData();
        onRefresh?.();
      } else {
        setUploadMessage({ type: 'error', text: result.message || '同步失败' });
      }
    } catch (err) {
      setUploadMessage({ type: 'error', text: `同步失败: ${err}` });
    }

    setSyncing(false);
  }

  // 生成随机方向的粒子
  function spawnParticles(count: number = 3): FlowerParticle[] {
    const newParticles: FlowerParticle[] = [];
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = 60 + Math.random() * 80;
      const tx = `${Math.cos(angle) * distance}px`;
      const ty = `${Math.sin(angle) * distance}px`;
      particleIdRef.current += 1;
      newParticles.push({
        id: particleIdRef.current,
        emoji: FLOWER_EMOJIS[Math.floor(Math.random() * FLOWER_EMOJIS.length)],
        tx,
        ty,
        delay: Math.random() * 0.2,
      });
    }
    return newParticles;
  }

  // 鼠标进入
  function handleMouseEnter() {
    const initial = spawnParticles(8);
    setParticles(prev => [...prev, ...initial]);

    // 持续生成粒子
    intervalRef.current = setInterval(() => {
      setParticles(prev => {
        const spawned = spawnParticles(4);
        // 1.5秒后自动移除旧粒子
        setTimeout(() => {
          setParticles(p => p.filter(pp => !spawned.some(s => s.id === pp.id)));
        }, 1500);
        return [...prev, ...spawned];
      });
    }, 150);
  }

  // 鼠标离开
  function handleMouseLeave() {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    // 延迟清除粒子
    setTimeout(() => setParticles([]), 100);
  }

  // 生成星星粒子
  function spawnStars(count: number = 3): StarParticle[] {
    const newParticles: StarParticle[] = [];
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = 50 + Math.random() * 70;
      const tx = `${Math.cos(angle) * distance}px`;
      const ty = `${Math.sin(angle) * distance}px`;
      starIdRef.current += 1;
      newParticles.push({
        id: starIdRef.current,
        emoji: STAR_EMOJIS[Math.floor(Math.random() * STAR_EMOJIS.length)],
        tx,
        ty,
        delay: Math.random() * 0.15,
      });
    }
    return newParticles;
  }

  // 更新按钮鼠标进入
  function handleStarMouseEnter() {
    const initial = spawnStars(6);
    setStarParticles(prev => [...prev, ...initial]);

    // 持续生成星星
    starIntervalRef.current = setInterval(() => {
      setStarParticles(prev => {
        const spawned = spawnStars(3);
        setTimeout(() => {
          setStarParticles(p => p.filter(pp => !spawned.some(s => s.id === pp.id)));
        }, 1500);
        return [...prev, ...spawned];
      });
    }, 120);
  }

  // 更新按钮鼠标离开
  function handleStarMouseLeave() {
    if (starIntervalRef.current) {
      clearInterval(starIntervalRef.current);
      starIntervalRef.current = null;
    }
    setTimeout(() => setStarParticles([]), 100);
  }

  async function loadData() {
    setLoading(true);
    try {
      const skillsData = await fetchSkills(category || undefined);
      setSkills(skillsData);
    } catch (err) {
      console.error('加载失败:', err);
    }
    setLoading(false);
  }

  const filteredSkills = skills.filter(skill => {
    if (!search) return true;
    const keyword = search.toLowerCase();
    return (
      skill.name.toLowerCase().includes(keyword) ||
      skill.description.toLowerCase().includes(keyword) ||
      skill.tags.some(t => t.toLowerCase().includes(keyword))
    );
  });

  function handleDownload(e: React.MouseEvent, skillId: string) {
    e.stopPropagation();
    window.open(getDownloadUrl(skillId), '_blank');
  }

  async function handleDelete(e: React.MouseEvent, skillId: string, skillName: string) {
    e.stopPropagation();
    if (!confirm(`确定要删除「${skillName}」吗？`)) return;

    setDeleting(skillId);
    try {
      await deleteSkill(skillId);
      setUploadMessage({ type: 'success', text: `✓ 已删除: ${skillName}` });
      loadData();
      onRefresh?.();
    } catch (err) {
      setUploadMessage({ type: 'error', text: `✗ 删除失败: ${err}` });
    }
    setDeleting(null);
  }

  function handleUploadSuccess() {
    setUploadMessage({ type: 'success', text: '✓ 导入成功！' });
    loadData();
    onRefresh?.();
  }

  if (loading) {
    return (
      <div className="loading-container">
        <div className="loading-icon">🌸</div>
        <div className="loading-text">正在加载森林...</div>
        <div className="loading-dots">
          <span></span><span></span><span></span>
        </div>
      </div>
    );
  }

  return (
    <div className="skill-list">
      {/* 浮动装饰 */}
      <div className="floating-decorations">
        <span className="floating-deco deco-1">🌸</span>
        <span className="floating-deco deco-2">🦋</span>
        <span className="floating-deco deco-3">🌿</span>
        <span className="floating-deco deco-4">🌺</span>
        <span className="floating-deco deco-5">🐝</span>
        <span className="floating-deco deco-6">🌻</span>
        <span className="floating-deco deco-7">🍀</span>
        <span className="floating-deco deco-8">🌷</span>
        <span className="floating-deco deco-9">🦔</span>
        <span className="floating-deco deco-10">🌼</span>
        <span className="floating-deco deco-11">🌲</span>
        <span className="floating-deco deco-12">🦊</span>
        <span className="floating-deco deco-13">🌳</span>
        <span className="floating-deco deco-14">🍃</span>
      </div>

      <div className="toolbar">
        <div className="toolbar-top">
          <div className="search-wrapper">
            <input
              type="text"
              placeholder="🌿 搜索森林中的技能..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="search-input"
            />
            <div
              className="flower-burst-container"
              onMouseEnter={handleMouseEnter}
              onMouseLeave={handleMouseLeave}
            >
              {/* 粒子 */}
              {particles.map(p => (
                <span
                  key={p.id}
                  className="flower-particle"
                  style={{
                    '--tx': p.tx,
                    '--ty': p.ty,
                    animationDelay: `${p.delay}s`,
                  } as React.CSSProperties}
                >
                  {p.emoji}
                </span>
              ))}
              <button
                className="upload-btn"
                onClick={() => setShowUploadModal(true)}
                title="导入 Skill"
              >
                <span className="upload-btn-text">
                  <span className="upload-btn-leaf">🍃</span>导入本地skill
                </span>
                <span className="upload-btn-flower">🌸</span>
              </button>
            </div>
          </div>
        </div>
        <div className="category-bar">
          {category && (
            <button
              className="category-chip active back-chip"
              onClick={() => setCategory('')}
            >
              🌿 返回全部
            </button>
          )}
          <button
            className={`category-chip ${category === '' ? 'active' : ''}`}
            onClick={() => setCategory('')}
          >
            🌈 全部
          </button>
          {categories.map(cat => (
            <button
              key={cat.value}
              className={`category-chip ${category === cat.value ? 'active' : ''}`}
              onClick={() => setCategory(cat.value)}
            >
              {getSkillEmoji(cat.value)} {cat.label.replace(/^[^\s]+\s/, '')}
            </button>
          ))}
        </div>
      </div>

      {uploadMessage && (
        <div className={`upload-message ${uploadMessage.type}`}>
          {uploadMessage.text}
        </div>
      )}

      <div className="skills-count">
        <div className="count-group">
          {category && (
            <span className="category-indicator">
              {getSkillEmoji(category)} {category}
            </span>
          )}
          <span className="skills-count-text">
            {category ? `共 ${filteredSkills.length} 个skill` : `共发现 ${filteredSkills.length} 个skill`}
          </span>
          <div
            className="update-btn-wrapper"
            onMouseEnter={handleStarMouseEnter}
            onMouseLeave={handleStarMouseLeave}
          >
            {/* 星星粒子 */}
            {starParticles.map(p => (
              <span
                key={p.id}
                className="star-particle"
                style={{
                  '--tx': p.tx,
                  '--ty': p.ty,
                  animationDelay: `${p.delay}s`,
                } as React.CSSProperties}
              >
                {p.emoji}
              </span>
              ))}
              <button
                className={`update-btn ${syncing ? 'syncing' : ''}`}
                onClick={handleSync}
                disabled={syncing}
              >
                <span className="update-btn-text">{syncing ? '同步中...' : '更新'}</span>
                <span className="update-btn-icon">{syncing ? '⏳' : '🌙'}</span>
              </button>
            </div>
          </div>
        </div>

      <div className="skills-grid">
        {filteredSkills.map((skill, index) => (
          <div
            key={skill.id}
            className="skill-card"
            onClick={() => onSelect(skill.id)}
          >
            <div className="card-top" style={{ background: getCardColor(index) }}>
              <span className="card-bg-emoji">{getSkillEmoji(skill.id)}</span>
              <span className="card-front-emoji">{getSkillEmoji(skill.id)}</span>
            </div>

            <div className="card-content">
              <div className="card-title-row">
                <h3>{skill.name}</h3>
                <span className="version-badge">v{skill.version}</span>
              </div>
              <p className="card-description">{skill.description}</p>
              <div className="card-tags">
                <span className="category-tag">{getSkillEmoji(skill.id)} {getCategoryLabel(skill.category).label.replace(/^[^\s]+\s/, '')}</span>
              </div>
              <div className="card-footer">
                <span className="author">🌸 {skill.author}</span>
                <div className="card-actions">
                  <button
                    className="action-btn delete-btn"
                    onClick={e => handleDelete(e, skill.id, skill.name)}
                    disabled={deleting === skill.id}
                  >
                    {deleting === skill.id ? '...' : '🗑️'}
                  </button>
                  <button
                    className="download-btn"
                    onClick={e => handleDownload(e, skill.id)}
                  >
                    📥 下载
                  </button>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {filteredSkills.length === 0 && (
        <div className="empty">
          <div className="empty-icon">🦔</div>
          <p>森林里没有找到这个技能</p>
          <span>试试导入一个 Skill 吧 🌱</span>
        </div>
      )}

      {/* 导入弹窗 */}
      <UploadModal
        isOpen={showUploadModal}
        onClose={() => setShowUploadModal(false)}
        onSuccess={handleUploadSuccess}
      />
    </div>
  );
}
