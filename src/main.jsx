import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import '@xterm/xterm/css/xterm.css'
import { App } from './App.jsx'
import { AuthProvider } from './auth/AuthProvider.jsx'
import { ThemeProvider } from './theme/ThemeProvider.jsx'
import { SpeechProvider } from './speech/SpeechProvider.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ThemeProvider>
      <SpeechProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </SpeechProvider>
    </ThemeProvider>
  </StrictMode>,
)
