import { createRoot } from 'react-dom/client';
import '@fontsource/noto-sans-sc/400.css';
import '@fontsource/noto-sans-sc/700.css';
import './styles.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<App />);

// Dropping a file on the window must not navigate away from the app.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
