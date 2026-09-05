import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { createApi, readToken } from './api/client.js';

const root = createRoot(document.getElementById('root')!);

try {
  root.render(<App api={createApi(readToken(window.location.search))} />);
} catch (error) {
  root.render(<p>{error instanceof Error ? error.message : 'failed to start'}</p>);
}
