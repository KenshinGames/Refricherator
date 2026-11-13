import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { boot } from './store.ts';
import './styles.css';

boot();
createRoot(document.getElementById('root')!).render(<App />);
