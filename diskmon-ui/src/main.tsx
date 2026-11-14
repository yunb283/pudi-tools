import { createRoot } from 'react-dom/client';
import App from './App';
import './style.css';

// 挂载点在主 index.html 的 #page-diskmon 内；主程序 showTab 负责显隐，
// 本子应用通过 MutationObserver 感知可见性并在切入时刷新数据。
const el = document.getElementById('diskmon-root');
if (el) createRoot(el).render(<App />);
