// SkillHub main app with the macaron vitality style.
import { useState } from 'react';
import SkillList from './pages/skillhub/SkillList';
import SkillDetail from './pages/skillhub/SkillDetail';
import './App.css';

export default function App() {
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  function handleRefresh() {
    setRefreshKey(k => k + 1);
  }

  return (
    <div className="app">
      <header className="header">
        <h1>SkillHub 🌻</h1>
        <p>在skill森林里栽种或收获吧！</p>
      </header>

      <main className="main">
        {selectedSkill ? (
          <SkillDetail
            skillId={selectedSkill}
            onBack={() => setSelectedSkill(null)}
          />
        ) : (
          <SkillList
            onSelect={setSelectedSkill}
            onRefresh={handleRefresh}
            key={refreshKey}
          />
        )}
      </main>

      <footer className="footer">
        🌸 SkillHub v1.0.0 | 充满生机
      </footer>
    </div>
  );
}
