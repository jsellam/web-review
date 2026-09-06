import './styles/tokens.css';
import './styles/reset.css';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { ThemeProvider } from './theme.js';
import { createApi, readToken } from './api/client.js';

const root = createRoot(document.getElementById('root')!);

try {
  root.render(
    <ThemeProvider>
      <App api={createApi(readToken(window.location.search))} />
    </ThemeProvider>,
  );
} catch (error) {
  root.render(<p>{error instanceof Error ? error.message : 'failed to start'}</p>);
}
