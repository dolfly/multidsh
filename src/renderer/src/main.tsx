import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import AboutDialog from './components/AboutDialog'
import { isAboutWindow } from './lib/window-mode'
import './styles.css'

// 「关于」窗口:只渲染对话框;背景必须透明才能透出下层宿主窗口与工作区。
if (isAboutWindow) {
  document.documentElement.dataset.window = 'about'
  const savedTheme = localStorage.getItem('dshhub-theme')
  document.documentElement.dataset.theme =
    savedTheme === 'light' || savedTheme === 'dark'
      ? savedTheme
      : window.matchMedia?.('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>{isAboutWindow ? <AboutDialog /> : <App />}</React.StrictMode>
)
