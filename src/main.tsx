import React from 'react'
import ReactDOM from 'react-dom/client'
import { nativeStore } from './services/nativeStore'
import './index.css'

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(<p style={{ padding: 32, color: 'white' }}>Opening encrypted local wallet…</p>);
nativeStore.initialize().catch(error => {
  nativeStore.openReadOnly(`Wallet could not be opened: ${String(error)}. Existing wallet data has not been replaced.`);
}).then(async () => {
  const { default: App } = await import('./App');
  root.render(<React.StrictMode><App /></React.StrictMode>);
}).catch(error => root.render(<main style={{ padding: 32, color: 'white' }}><h1>DEKXDIS could not load</h1><p>{String(error)}</p></main>));
