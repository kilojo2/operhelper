/**
 * Безопасный мост между renderer (интерфейсом) и main-процессом.
 * Никакого прямого доступа к Node из интерфейса — только эти методы.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Запрос к DeepSeek: { apiKey, model, temperature, messages, maxTokens }
  chat: (payload) => ipcRenderer.invoke('deepseek:chat', payload),

  // Проверка API-ключа
  testKey: (payload) => ipcRenderer.invoke('deepseek:test', payload),

  // Конфиг (ключ, профиль модели и т.д.)
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),

  // Данные из папки data/ (заготовки привата, тип-меню)
  getData: () => ipcRenderer.invoke('data:get'),

  // Открыть ссылку в системном браузере (музыка)
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // Режим «поверх всех окон»
  setOnTop: (flag) => ipcRenderer.invoke('window:setOnTop', flag),

  // База опыта (обучение на чатах, Фаза 1)
  expSave: (payload) => ipcRenderer.invoke('exp:save', payload),
  expOutcome: (payload) => ipcRenderer.invoke('exp:outcome', payload),
  expStats: () => ipcRenderer.invoke('exp:stats'),

  // Подбор примеров из опыта (Фаза 2)
  expExamples: (payload) => ipcRenderer.invoke('exp:examples', payload)
});
